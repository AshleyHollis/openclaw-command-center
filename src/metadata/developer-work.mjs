import { randomUUID } from 'node:crypto';
import { developerEventDigest, normalizeDeveloperEvent } from '../developer-work/contract.mjs';

const MAX_PENDING_RECEIPTS = 500;
const MAX_WATERMARK_LEAD = 500;
const terminalTypes = new Set(['request_resolved', 'request_withdrawn']);
const requestOpeningTypes = new Set(['human_input_required', 'product_decision_required', 'approval_required', 'feature_ready_for_review', 'production_deployment_failed']);

export const developerWorkTablesSql = `
CREATE TABLE developer_work_cursors (
  producer_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (producer_id, work_id)
) STRICT;

CREATE TABLE developer_work_requests (
  producer_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'product-decision', 'approval', 'review', 'deployment-incident')),
  deployment_id TEXT UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'resolved', 'withdrawn')),
  last_event_id TEXT NOT NULL,
  CHECK ((kind = 'deployment-incident') = (deployment_id IS NOT NULL)),
  PRIMARY KEY (producer_id, work_id, request_id),
  FOREIGN KEY (producer_id, work_id) REFERENCES developer_work_cursors(producer_id, work_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE developer_work_receipts (
  producer_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL CHECK (work_revision >= 1),
  event_digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  projection_state TEXT NOT NULL CHECK (projection_state IN ('pending', 'projected')),
  accepted_at TEXT NOT NULL,
  projected_at TEXT,
  PRIMARY KEY (producer_id, event_id),
  UNIQUE (producer_id, work_id, work_revision),
  FOREIGN KEY (producer_id, work_id) REFERENCES developer_work_cursors(producer_id, work_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE developer_work_producer_cursors (
  producer_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (producer_id, work_id)
) STRICT;

CREATE TABLE developer_work_producer_requests (
  producer_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'product-decision', 'approval', 'review', 'deployment-incident')),
  deployment_id TEXT UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'resolved', 'withdrawn')),
  last_event_id TEXT NOT NULL,
  CHECK ((kind = 'deployment-incident') = (deployment_id IS NOT NULL)),
  PRIMARY KEY (producer_id, work_id, request_id),
  FOREIGN KEY (producer_id, work_id) REFERENCES developer_work_producer_cursors(producer_id, work_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE developer_work_outbox (
  producer_id TEXT NOT NULL,
  logical_operation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL CHECK (work_revision >= 1),
  intent_digest TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivered')),
  receiver_receipt_json TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (producer_id, logical_operation_id),
  UNIQUE (producer_id, event_id),
  UNIQUE (producer_id, work_id, work_revision),
  FOREIGN KEY (producer_id, work_id) REFERENCES developer_work_producer_cursors(producer_id, work_id) ON DELETE RESTRICT
) STRICT;
`;

export const developerWorkWatermarksSql = `
CREATE TABLE developer_work_watermarks (
  producer_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  announced_revision INTEGER NOT NULL CHECK (announced_revision >= 1),
  PRIMARY KEY (producer_id, work_id),
  FOREIGN KEY (producer_id, work_id) REFERENCES developer_work_cursors(producer_id, work_id) ON DELETE RESTRICT
) STRICT;
`;

function receipt(row, duplicate = false) {
  return Object.freeze({
    schemaVersion: 1,
    producerId: row.producer_id,
    eventId: row.event_id,
    workId: row.work_id,
    workRevision: row.work_revision,
    eventDigest: row.event_digest,
    projectionState: row.projection_state,
    acceptedAt: row.accepted_at,
    ...(row.projected_at ? { projectedAt: row.projected_at } : {}),
    duplicate
  });
}

export function installDeveloperWorkMetadata(service, { mutate, inspect, ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  const readReceipt = (db, producerId, eventId) => db.prepare('SELECT * FROM developer_work_receipts WHERE producer_id = ? AND event_id = ?').get(producerId, eventId);

  service.acceptDeveloperEvent = ({ producerId, event, watermark, acceptedAt = new Date().toISOString() } = {}) => {
    if (typeof producerId !== 'string' || !producerId.trim() || !event || event.schemaVersion !== 1 || typeof event.eventId !== 'string' || typeof event.workId !== 'string' || !Number.isSafeInteger(event.workRevision) || event.workRevision < 1 || typeof acceptedAt !== 'string' || Number.isNaN(Date.parse(acceptedAt))) fail('developer-event-invalid');
    if (watermark !== undefined && (!Number.isSafeInteger(watermark) || watermark < event.workRevision)) fail('delivery-watermark-invalid');
    const eventDigest = developerEventDigest(event);
    const eventJson = JSON.stringify(event);
    return mutate(null, db => {
      const announceWatermark = () => {
        if (watermark === undefined) return;
        const cursor = db.prepare('SELECT revision FROM developer_work_cursors WHERE producer_id = ? AND work_id = ?').get(producerId, event.workId);
        if (!cursor || watermark > Math.max(cursor.revision, event.workRevision) + MAX_WATERMARK_LEAD) fail('delivery-watermark-invalid');
        db.prepare(`INSERT INTO developer_work_watermarks (producer_id, work_id, announced_revision) VALUES (?, ?, ?)
          ON CONFLICT (producer_id, work_id) DO UPDATE SET announced_revision = MAX(announced_revision, excluded.announced_revision)`).run(producerId, event.workId, watermark);
      };
      const old = readReceipt(db, producerId, event.eventId);
      if (old) {
        if (old.event_digest !== eventDigest) fail('developer-event-conflict', 'An event ID was replayed with changed evidence.');
        announceWatermark();
        return receipt(old, true);
      }
      const cursor = db.prepare('SELECT revision FROM developer_work_cursors WHERE producer_id = ? AND work_id = ?').get(producerId, event.workId);
      const expected = (cursor?.revision ?? 0) + 1;
      if (event.workRevision !== expected) fail(event.workRevision < expected ? 'developer-event-stale' : 'developer-event-gap', `Expected work revision ${expected}.`);
      if (db.prepare("SELECT count(*) AS pending FROM developer_work_receipts WHERE producer_id = ? AND projection_state = 'pending'").get(producerId).pending >= MAX_PENDING_RECEIPTS) fail('developer-event-backpressure', 'Pending Developer Work projections must be drained before more evidence is accepted.');
      db.prepare(`INSERT INTO developer_work_cursors (producer_id, work_id, revision) VALUES (?, ?, ?)
        ON CONFLICT (producer_id, work_id) DO UPDATE SET revision = excluded.revision`).run(producerId, event.workId, event.workRevision);
      if (event.request) {
        const current = db.prepare('SELECT * FROM developer_work_requests WHERE producer_id = ? AND work_id = ? AND request_id = ?').get(producerId, event.workId, event.request.requestId);
        const deploymentId = event.request.kind === 'deployment-incident' ? event.context?.deploymentId : null;
        if (event.request.kind === 'deployment-incident' && (!deploymentId || event.outcome?.deploymentId !== deploymentId)) fail('developer-request-conflict', 'Deployment incident identity is incomplete.');
        if ((current?.revision ?? 0) !== event.request.expectedRequestRevision) fail('developer-request-stale', 'The exact request revision changed.');
        if (current && current.kind !== event.request.kind) fail('developer-request-conflict', 'A request cannot change its kind.');
        if (current && current.deployment_id !== deploymentId) fail('developer-request-conflict', 'A request cannot change its deployment.');
        if (current && current.state !== 'active') fail('developer-request-terminal', 'A terminal request cannot be reopened.');
        if (!current && !requestOpeningTypes.has(event.eventType)) fail('developer-request-missing', 'A request transition requires an existing request.');
        if (current && requestOpeningTypes.has(event.eventType) && event.request.expectedRequestRevision === 0) fail('developer-request-conflict');
        if (deploymentId && !current && db.prepare('SELECT 1 FROM developer_work_requests WHERE deployment_id = ?').get(deploymentId)) fail('developer-request-conflict', 'A deployment already has an incident.');
        const state = terminalTypes.has(event.eventType) ? event.eventType === 'request_resolved' ? 'resolved' : 'withdrawn' : 'active';
        db.prepare(`INSERT INTO developer_work_requests (producer_id, work_id, request_id, kind, deployment_id, revision, state, last_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (producer_id, work_id, request_id) DO UPDATE SET revision = excluded.revision, state = excluded.state, last_event_id = excluded.last_event_id`).run(producerId, event.workId, event.request.requestId, event.request.kind, deploymentId, event.workRevision, state, event.eventId);
      }
      db.prepare(`INSERT INTO developer_work_receipts (producer_id, event_id, work_id, work_revision, event_digest, event_json, projection_state, accepted_at, projected_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`).run(producerId, event.eventId, event.workId, event.workRevision, eventDigest, eventJson, acceptedAt);
      announceWatermark();
      return receipt(readReceipt(db, producerId, event.eventId));
    });
  };

  service.isDeveloperWorkNotificationReady = ({ producerId, workId } = {}) => {
    if (typeof producerId !== 'string' || !producerId.trim() || typeof workId !== 'string' || !workId.trim()) fail('developer-event-invalid');
    return inspect(db => {
      const state = db.prepare(`SELECT c.revision AS accepted_revision, w.announced_revision,
        EXISTS (SELECT 1 FROM developer_work_receipts r WHERE r.producer_id = c.producer_id AND r.work_id = c.work_id AND r.projection_state = 'pending') AS projection_pending
        FROM developer_work_cursors c LEFT JOIN developer_work_watermarks w
          ON w.producer_id = c.producer_id AND w.work_id = c.work_id
        WHERE c.producer_id = ? AND c.work_id = ?`).get(producerId, workId);
      return Boolean(state && state.announced_revision === state.accepted_revision && state.projection_pending === 0);
    });
  };

  service.listPendingDeveloperEvents = ({ limit = 100 } = {}) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('developer-event-invalid');
    return inspect(db => Object.freeze(db.prepare(`SELECT * FROM developer_work_receipts WHERE projection_state = 'pending'
      ORDER BY producer_id, work_id, work_revision LIMIT ?`).all(limit).map(row => Object.freeze({ receipt: receipt(row), event: Object.freeze(JSON.parse(row.event_json)) }))));
  };

  service.getDeveloperReceipt = ({ producerId, eventId } = {}) => {
    if (typeof producerId !== 'string' || typeof eventId !== 'string') fail('developer-event-invalid');
    return inspect(db => {
      const row = readReceipt(db, producerId, eventId);
      return row ? receipt(row) : null;
    });
  };

  service.markDeveloperEventProjected = ({ producerId, eventId, eventDigest, projectedAt = new Date().toISOString() } = {}) => {
    if (typeof producerId !== 'string' || typeof eventId !== 'string' || typeof eventDigest !== 'string' || typeof projectedAt !== 'string' || Number.isNaN(Date.parse(projectedAt))) fail('developer-event-invalid');
    return mutate(null, db => {
      const row = readReceipt(db, producerId, eventId);
      if (!row) fail('developer-event-missing');
      if (row.event_digest !== eventDigest) fail('developer-event-conflict');
      if (row.projection_state === 'projected') return receipt(row, true);
      const earlier = db.prepare("SELECT event_id FROM developer_work_receipts WHERE producer_id = ? AND work_id = ? AND work_revision < ? AND projection_state = 'pending' LIMIT 1").get(producerId, row.work_id, row.work_revision);
      if (earlier) fail('developer-projection-order', 'Earlier evidence for this work has not been projected.');
      db.prepare("UPDATE developer_work_receipts SET projection_state = 'projected', projected_at = ? WHERE producer_id = ? AND event_id = ?").run(projectedAt, producerId, eventId);
      return receipt(readReceipt(db, producerId, eventId));
    });
  };

  service.getDeveloperRequest = ({ producerId, workId, requestId } = {}) => inspect(db => {
    const row = db.prepare('SELECT * FROM developer_work_requests WHERE producer_id = ? AND work_id = ? AND request_id = ?').get(producerId, workId, requestId);
    return row ? Object.freeze({ schemaVersion: 1, producerId: row.producer_id, workId: row.work_id, requestId: row.request_id, kind: row.kind, revision: row.revision, state: row.state, lastEventId: row.last_event_id }) : null;
  });

  const producerRow = row => row && Object.freeze({
    producerId: row.producer_id,
    logicalOperationId: row.logical_operation_id,
    eventId: row.event_id,
    workId: row.work_id,
    workRevision: row.work_revision,
    eventDigest: row.event_digest,
    deliveryState: row.delivery_state,
    event: Object.freeze(JSON.parse(row.event_json)),
    receiverReceipt: row.receiver_receipt_json ? Object.freeze(JSON.parse(row.receiver_receipt_json)) : null
  });

  service.submitDeveloperWork = ({ authority, logicalOperationId, draft, assertSourceCurrent } = {}) => {
    if (!authority || typeof authority.producerId !== 'string' || !['worker', 'controller'].includes(authority.role) || !Array.isArray(authority.allowedProjects) || typeof logicalOperationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(logicalOperationId)) fail('developer-producer-invalid');
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).some(key => !['schemaVersion', 'workId', 'eventType', 'occurredAt', 'context', 'session', 'request', 'outcome'].includes(key)) || draft.schemaVersion !== 1 || typeof draft.workId !== 'string' || !draft.workId.trim()) fail('developer-producer-invalid');
    const intentDigest = developerEventDigest({ producerId: authority.producerId, draft });
    return mutate(null, db => {
      const old = db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND logical_operation_id = ?').get(authority.producerId, logicalOperationId);
      if (old) {
        if (old.intent_digest !== intentDigest) fail('developer-producer-conflict', 'Logical operation ID was reused with changed intent.');
        return producerRow(old);
      }
      if (db.prepare("SELECT count(*) AS pending FROM developer_work_outbox WHERE producer_id = ? AND delivery_state = 'pending'").get(authority.producerId).pending >= MAX_PENDING_RECEIPTS) fail('developer-producer-backpressure');
      const current = db.prepare('SELECT revision FROM developer_work_producer_cursors WHERE producer_id = ? AND work_id = ?').get(authority.producerId, draft.workId);
      const revision = (current?.revision ?? 0) + 1;
      const event = normalizeDeveloperEvent({ ...draft, occurredAt: draft.occurredAt ?? new Date().toISOString(), eventId: randomUUID(), workRevision: revision }, authority);
      if (event.session && assertSourceCurrent) {
        if (typeof assertSourceCurrent !== 'function') fail('developer-producer-invalid');
        assertSourceCurrent(event.session);
      }
      if (event.request) {
        const request = db.prepare('SELECT * FROM developer_work_producer_requests WHERE producer_id = ? AND work_id = ? AND request_id = ?').get(authority.producerId, event.workId, event.request.requestId);
        const deploymentId = event.request.kind === 'deployment-incident' ? event.context.deploymentId : null;
        if ((request?.revision ?? 0) !== event.request.expectedRequestRevision) fail('developer-request-stale', 'The exact request revision changed.');
        if (request && request.kind !== event.request.kind) fail('developer-request-conflict', 'A request cannot change kind.');
        if (request && request.deployment_id !== deploymentId) fail('developer-request-conflict', 'A request cannot change its deployment.');
        if (request && request.state !== 'active') fail('developer-request-terminal', 'A terminal request cannot reopen.');
        if (!request && !requestOpeningTypes.has(event.eventType)) fail('developer-request-missing');
        if (deploymentId && !request && db.prepare('SELECT 1 FROM developer_work_producer_requests WHERE deployment_id = ?').get(deploymentId)) fail('developer-request-conflict', 'A deployment already has an incident.');
      }
      db.prepare(`INSERT INTO developer_work_producer_cursors (producer_id, work_id, revision) VALUES (?, ?, ?)
        ON CONFLICT (producer_id, work_id) DO UPDATE SET revision = excluded.revision`).run(authority.producerId, event.workId, revision);
      if (event.request) {
        const state = terminalTypes.has(event.eventType) ? event.eventType === 'request_resolved' ? 'resolved' : 'withdrawn' : 'active';
        const deploymentId = event.request.kind === 'deployment-incident' ? event.context.deploymentId : null;
        db.prepare(`INSERT INTO developer_work_producer_requests (producer_id, work_id, request_id, kind, deployment_id, revision, state, last_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (producer_id, work_id, request_id) DO UPDATE SET revision = excluded.revision, state = excluded.state, last_event_id = excluded.last_event_id`).run(authority.producerId, event.workId, event.request.requestId, event.request.kind, deploymentId, revision, state, event.eventId);
      }
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO developer_work_outbox (producer_id, logical_operation_id, event_id, work_id, work_revision, intent_digest, event_digest, event_json, delivery_state, receiver_receipt_json, created_at, delivered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`).run(authority.producerId, logicalOperationId, event.eventId, event.workId, revision, intentDigest, developerEventDigest(event), JSON.stringify(event), createdAt);
      return producerRow(db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND logical_operation_id = ?').get(authority.producerId, logicalOperationId));
    });
  };

  service.listPendingDeveloperDeliveries = ({ producerId, limit = 100 } = {}) => {
    if (typeof producerId !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('developer-producer-invalid');
    return inspect(db => Object.freeze(db.prepare("SELECT * FROM developer_work_outbox WHERE producer_id = ? AND delivery_state = 'pending' ORDER BY work_id, work_revision LIMIT ?").all(producerId, limit).map(producerRow)));
  };

  service.getDeveloperProducerEvent = ({ producerId, logicalOperationId } = {}) => {
    if (typeof producerId !== 'string' || typeof logicalOperationId !== 'string') fail('developer-producer-invalid');
    return inspect(db => producerRow(db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND logical_operation_id = ?').get(producerId, logicalOperationId)));
  };

  service.markDeveloperDelivery = ({ producerId, eventId, receiverReceipt } = {}) => {
    if (typeof producerId !== 'string' || typeof eventId !== 'string' || !receiverReceipt || typeof receiverReceipt !== 'object' || Array.isArray(receiverReceipt) || Object.keys(receiverReceipt).some(key => !['schemaVersion', 'producerId', 'eventId', 'workId', 'workRevision', 'eventDigest', 'projectionState', 'acceptedAt', 'projectedAt', 'duplicate'].includes(key)) || JSON.stringify(receiverReceipt).length > 4096) fail('developer-producer-invalid');
    return mutate(null, db => {
      const row = db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND event_id = ?').get(producerId, eventId);
      if (!row) fail('developer-event-missing');
      if (receiverReceipt.schemaVersion !== 1 || receiverReceipt.producerId !== producerId || receiverReceipt.eventId !== eventId || receiverReceipt.workId !== row.work_id || receiverReceipt.workRevision !== row.work_revision || receiverReceipt.eventDigest !== row.event_digest || !['pending', 'projected'].includes(receiverReceipt.projectionState) || typeof receiverReceipt.acceptedAt !== 'string' || Number.isNaN(Date.parse(receiverReceipt.acceptedAt))) fail('developer-receipt-conflict');
      if (row.delivery_state === 'delivered') {
        const prior = JSON.parse(row.receiver_receipt_json);
        if (prior.producerId !== receiverReceipt.producerId || prior.eventId !== receiverReceipt.eventId || prior.eventDigest !== receiverReceipt.eventDigest) fail('developer-receipt-conflict');
        return producerRow(row);
      }
      db.prepare("UPDATE developer_work_outbox SET delivery_state = 'delivered', receiver_receipt_json = ?, delivered_at = ? WHERE producer_id = ? AND event_id = ?").run(JSON.stringify(receiverReceipt), new Date().toISOString(), producerId, eventId);
      return producerRow(db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND event_id = ?').get(producerId, eventId));
    });
  };

  service.getDeveloperProducerRequest = ({ producerId, workId, requestId } = {}) => inspect(db => {
    const row = db.prepare(`SELECT r.*, e.event_json FROM developer_work_producer_requests r
      JOIN developer_work_outbox e ON e.producer_id = r.producer_id AND e.event_id = r.last_event_id
      WHERE r.producer_id = ? AND r.work_id = ? AND r.request_id = ?`).get(producerId, workId, requestId);
    return row ? Object.freeze({ producerId: row.producer_id, workId: row.work_id, requestId: row.request_id, kind: row.kind, revision: row.revision, state: row.state, lastEventId: row.last_event_id, event: Object.freeze(JSON.parse(row.event_json)) }) : null;
  });

  service.listDeveloperProducerRequests = ({ producerId, workId } = {}) => {
    if (typeof producerId !== 'string' || typeof workId !== 'string') fail('developer-producer-invalid');
    return inspect(db => Object.freeze(db.prepare(`SELECT r.*, e.event_json FROM developer_work_producer_requests r
      JOIN developer_work_outbox e ON e.producer_id = r.producer_id AND e.event_id = r.last_event_id
      WHERE r.producer_id = ? AND r.work_id = ? AND r.state = 'active' ORDER BY r.request_id LIMIT 50`).all(producerId, workId).map(row => Object.freeze({ producerId: row.producer_id, workId: row.work_id, requestId: row.request_id, kind: row.kind, revision: row.revision, state: row.state, lastEventId: row.last_event_id, event: Object.freeze(JSON.parse(row.event_json)) }))));
  };
}
