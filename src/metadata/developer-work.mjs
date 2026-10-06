import { createHash, randomUUID } from 'node:crypto';
import { developerEventDigest, normalizeDeveloperEvent } from '../developer-work/contract.mjs';

const MAX_PENDING_RECEIPTS = 500;
const MAX_WATERMARK_LEAD = 500;
const expiryDispositionId = (producerId, eventId) => 'developer-expiry:' + createHash('sha256').update(producerId + '\u0000' + eventId).digest('hex');
const terminalTypes = new Set(['request_resolved', 'request_withdrawn']);
const requestOpeningTypes = new Set(['human_input_required', 'product_decision_required', 'approval_required', 'feature_ready_for_review', 'production_deployment_failed']);
const activeUpdateTypes = new Set(['human_input_required', 'product_decision_required', 'approval_required', 'feature_ready_for_review', 'production_rollback', 'production_recovered']);
const incidentUpdateTypes = new Set(['production_rollback', 'production_recovered']);
const deliveryDiagnosticId = (producerId, eventId) => `developer-delivery:${createHash('sha256').update(`${producerId}\u0000${eventId}`).digest('hex')}`;
const deliveryDiagnostic = (db, row) => {
  const entry = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(deliveryDiagnosticId(row.producer_id, row.event_id));
  if (!entry) return null;
  if (entry.operation_kind !== 'developer-work.delivery.v1' || entry.intent_digest !== row.event_digest || entry.transport_request_id !== row.event_id) throw new Error('Developer Work delivery diagnostic identity differs.');
  return Object.freeze(JSON.parse(entry.result_identity));
};

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

function receipt(row, duplicate = false, disposition = null) {
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
    ...(disposition ? { disposition: 'expired', dispositionReason: disposition.reason } : {}),
    duplicate
  });
}

export function installDeveloperWorkMetadata(service, { mutate, inspect, ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  const readReceipt = (db, producerId, eventId) => db.prepare('SELECT * FROM developer_work_receipts WHERE producer_id = ? AND event_id = ?').get(producerId, eventId);
  const disposition = (db, producerId, eventId, digest) => {
    const row = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(expiryDispositionId(producerId, eventId));
    if (!row) return null;
    if (row.operation_kind !== 'developer-work.expiry-disposition.v1' || row.transport_request_id !== eventId || row.intent_digest !== digest || row.state !== 'applied' || row.result_status !== 'expired') fail('developer-event-conflict');
    const result = JSON.parse(row.result_identity);
    if (result.producerId !== producerId || result.eventId !== eventId || result.eventDigest !== digest || !['request-expired', 'expired-dependency', 'expired-active-update'].includes(result.reason)) fail('developer-event-conflict');
    const eventRow = readReceipt(db, producerId, eventId);
    const event = eventRow && JSON.parse(eventRow.event_json);
    const incidentProjection = result.reason === 'expired-active-update' && incidentUpdateTypes.has(event?.eventType);
    const projected = eventRow?.projection_state === 'projected' && typeof eventRow.projected_at === 'string' && !Number.isNaN(Date.parse(eventRow.projected_at)) && (incidentProjection || eventRow.projected_at === result.acceptedAt);
    const pending = incidentProjection && eventRow?.projection_state === 'pending' && eventRow.projected_at === null;
    if (!eventRow || eventRow.event_digest !== digest || eventRow.work_id !== result.workId || eventRow.work_revision !== result.workRevision || eventRow.accepted_at !== result.acceptedAt || !(projected || pending) || row.observed_revision !== String(result.workRevision)) fail('developer-event-conflict');
    return result;
  };
  const disposedPredecessor = (db, producerId, event) => {
    if (!event.request || event.request.expectedRequestRevision < 1) return false;
    const previous = db.prepare('SELECT * FROM developer_work_receipts WHERE producer_id = ? AND work_id = ? AND work_revision = ?').get(producerId, event.workId, event.request.expectedRequestRevision);
    if (!previous) return false;
    const prior = disposition(db, producerId, previous.event_id, previous.event_digest);
    if (!prior || prior.reason === 'expired-active-update' || prior.workId !== previous.work_id || prior.workRevision !== previous.work_revision) return false;
    const request = JSON.parse(previous.event_json).request;
    return request?.requestId === event.request.requestId && request.kind === event.request.kind;
  };

  service.acceptDeveloperEvent = ({ producerId, event, watermark, assertAuthorityCurrent, now = () => Date.now() } = {}) => {
    if (typeof producerId !== 'string' || !producerId.trim() || !event || event.schemaVersion !== 1 || typeof event.eventId !== 'string' || typeof event.workId !== 'string' || !Number.isSafeInteger(event.workRevision) || event.workRevision < 1 || typeof now !== 'function') fail('developer-event-invalid');
    if (watermark !== undefined && (!Number.isSafeInteger(watermark) || watermark < event.workRevision)) fail('delivery-watermark-invalid');
    const eventDigest = developerEventDigest(event);
    const eventJson = JSON.stringify(event);
    return mutate(null, db => {
      if (assertAuthorityCurrent !== undefined) {
        if (typeof assertAuthorityCurrent !== 'function') fail('developer-event-invalid');
        assertAuthorityCurrent();
      }
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
        return receipt(old, true, disposition(db, producerId, event.eventId, eventDigest));
      }
      // Snapshot acceptance time after SQLite obtains the write lock. An
      // admission waiting for another writer cannot carry a pre-lock clock.
      const clock = new Date(now()).toISOString();
      // A previously accepted receipt remains replayable after its deadline.
      // Expired evidence may close only its exact already-active request;
      // opening or refreshing an active request remains forbidden.
      if (event.request?.expiresAt !== undefined) {
        const expiresAtMs = typeof event.request.expiresAt === 'string' ? Date.parse(event.request.expiresAt) : NaN;
        if (!Number.isFinite(expiresAtMs)) fail('developer-event-invalid');
        if (expiresAtMs <= Date.parse(clock)) {
          const current = db.prepare('SELECT * FROM developer_work_requests WHERE producer_id = ? AND work_id = ? AND request_id = ?').get(producerId, event.workId, event.request.requestId);
          const deploymentId = event.request.kind === 'deployment-incident' ? event.context?.deploymentId : null;
          const exactClosure = terminalTypes.has(event.eventType) && current?.state === 'active' && current.kind === event.request.kind && current.revision === event.request.expectedRequestRevision && current.deployment_id === deploymentId && event.outcome?.requestId === event.request.requestId && (event.request.kind !== 'deployment-incident' || event.outcome?.deploymentId === deploymentId);
          if (!exactClosure) fail('developer-request-expired', 'Only an exact active terminal request can close after its deadline.');
        }
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
        if ((current?.revision ?? 0) !== event.request.expectedRequestRevision) fail(!current && disposedPredecessor(db, producerId, event) ? 'developer-request-expired-dependency' : 'developer-request-stale', 'The exact request revision changed.');
        if (current && current.kind !== event.request.kind) fail('developer-request-conflict', 'A request cannot change its kind.');
        if (current && current.deployment_id !== deploymentId) fail('developer-request-conflict', 'A request cannot change its deployment.');
        if (current && current.state !== 'active') fail('developer-request-terminal', 'A terminal request cannot be reopened.');
        if (!current && !requestOpeningTypes.has(event.eventType)) fail(disposedPredecessor(db, producerId, event) ? 'developer-request-expired-dependency' : 'developer-request-missing', 'A request transition requires an existing request.');
        if (current && requestOpeningTypes.has(event.eventType) && event.request.expectedRequestRevision === 0) fail('developer-request-conflict');
        if (deploymentId && !current && db.prepare('SELECT 1 FROM developer_work_requests WHERE deployment_id = ?').get(deploymentId)) fail('developer-request-conflict', 'A deployment already has an incident.');
        const state = terminalTypes.has(event.eventType) ? event.eventType === 'request_resolved' ? 'resolved' : 'withdrawn' : 'active';
        db.prepare(`INSERT INTO developer_work_requests (producer_id, work_id, request_id, kind, deployment_id, revision, state, last_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (producer_id, work_id, request_id) DO UPDATE SET revision = excluded.revision, state = excluded.state, last_event_id = excluded.last_event_id`).run(producerId, event.workId, event.request.requestId, event.request.kind, deploymentId, event.workRevision, state, event.eventId);
      }
      db.prepare(`INSERT INTO developer_work_receipts (producer_id, event_id, work_id, work_revision, event_digest, event_json, projection_state, accepted_at, projected_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`).run(producerId, event.eventId, event.workId, event.workRevision, eventDigest, eventJson, clock);
      announceWatermark();
      return receipt(readReceipt(db, producerId, event.eventId));
    });
  };

  // Explicit expiry disposition is a separate machine-authenticated command.
  // The ordinary ingress keeps refusing expired active request content.
  service.disposeExpiredDeveloperEvent = ({ producerId, event, watermark, assertAuthorityCurrent, now = () => Date.now() } = {}) => {
    if (typeof producerId !== 'string' || !producerId.trim() || !event || event.schemaVersion !== 1 || typeof event.eventId !== 'string' || typeof event.workId !== 'string' || !Number.isSafeInteger(event.workRevision) || event.workRevision < 1 || !event.request || typeof now !== 'function') fail('developer-event-invalid');
    if (watermark !== undefined && (!Number.isSafeInteger(watermark) || watermark < event.workRevision)) fail('delivery-watermark-invalid');
    const digest = developerEventDigest(event);
    return mutate(null, db => {
      if (typeof assertAuthorityCurrent !== 'function') fail('unauthorized');
      assertAuthorityCurrent();
      const announceWatermark = () => {
        if (watermark === undefined) return;
        const cursor = db.prepare('SELECT revision FROM developer_work_cursors WHERE producer_id = ? AND work_id = ?').get(producerId, event.workId);
        if (!cursor || watermark > Math.max(cursor.revision, event.workRevision) + MAX_WATERMARK_LEAD) fail('delivery-watermark-invalid');
        db.prepare('INSERT INTO developer_work_watermarks (producer_id, work_id, announced_revision) VALUES (?, ?, ?) ON CONFLICT (producer_id, work_id) DO UPDATE SET announced_revision = MAX(announced_revision, excluded.announced_revision)').run(producerId, event.workId, watermark);
      };
      const old = readReceipt(db, producerId, event.eventId);
      if (old) {
        if (old.event_digest !== digest) fail('developer-event-conflict');
        const prior = disposition(db, producerId, event.eventId, digest);
        if (!prior || prior.workId !== event.workId || prior.workRevision !== event.workRevision) fail('developer-event-conflict', 'Accepted evidence cannot be reclassified.');
        announceWatermark();
        return receipt(old, true, prior);
      }
      const clock = new Date(now()).toISOString();
      const cursor = db.prepare('SELECT revision FROM developer_work_cursors WHERE producer_id = ? AND work_id = ?').get(producerId, event.workId);
      const expected = (cursor?.revision ?? 0) + 1;
      if (event.workRevision !== expected) fail(event.workRevision < expected ? 'developer-event-stale' : 'developer-event-gap');
      const current = db.prepare('SELECT * FROM developer_work_requests WHERE producer_id = ? AND work_id = ? AND request_id = ?').get(producerId, event.workId, event.request.requestId);
      const expiresAt = event.request.expiresAt === undefined ? NaN : Date.parse(event.request.expiresAt);
      const predecessor = disposedPredecessor(db, producerId, event);
      const expired = Number.isFinite(expiresAt) && expiresAt <= Date.parse(clock);
      // No Attention content is projected. The exact active request retains
      // its identity and active state, but tracks the producer's new revision
      // so a later source-owned transition can close or refresh it normally.
      const deploymentId = event.request.kind === 'deployment-incident' ? event.context?.deploymentId : null;
      const activeUpdate = Boolean(current && expired && activeUpdateTypes.has(event.eventType) && current.state === 'active' && current.revision === event.request.expectedRequestRevision && current.kind === event.request.kind && current.deployment_id === deploymentId && (event.request.kind !== 'deployment-incident' || event.outcome?.deploymentId === deploymentId));
      if (current && !activeUpdate) fail('developer-request-conflict', 'An existing request cannot be suppressed by disposition.');
      if (!current && (expired && event.request.expectedRequestRevision > 0 && !predecessor || !expired && !predecessor)) fail('developer-request-disposition-invalid');
      const reason = activeUpdate ? 'expired-active-update' : expired ? 'request-expired' : 'expired-dependency';
      const activityPending = activeUpdate && incidentUpdateTypes.has(event.eventType);
      db.prepare('INSERT INTO developer_work_cursors (producer_id, work_id, revision) VALUES (?, ?, ?) ON CONFLICT (producer_id, work_id) DO UPDATE SET revision = excluded.revision').run(producerId, event.workId, event.workRevision);
      if (activeUpdate) {
        const updated = db.prepare("UPDATE developer_work_requests SET revision = ?, last_event_id = ? WHERE producer_id = ? AND work_id = ? AND request_id = ? AND revision = ? AND state = 'active'").run(event.workRevision, event.eventId, producerId, event.workId, event.request.requestId, event.request.expectedRequestRevision);
        if (updated.changes !== 1) fail('developer-request-stale');
      }
      db.prepare(`INSERT INTO developer_work_receipts (producer_id, event_id, work_id, work_revision, event_digest, event_json, projection_state, accepted_at, projected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(producerId, event.eventId, event.workId, event.workRevision, digest, JSON.stringify(event), activityPending ? 'pending' : 'projected', clock, activityPending ? null : clock);
      const identity = { producerId, eventId: event.eventId, workId: event.workId, workRevision: event.workRevision, eventDigest: digest, reason, acceptedAt: clock };
      db.prepare(`INSERT INTO operation_journal (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at)
        VALUES (?, ?, ?, 'developer-work.expiry-disposition.v1', 'applied', 'expired', ?, ?, ?, ?)`).run(expiryDispositionId(producerId, event.eventId), event.eventId, digest, JSON.stringify(identity), String(event.workRevision), clock, clock);
      announceWatermark();
      return receipt(readReceipt(db, producerId, event.eventId), false, identity);
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
      return row ? receipt(row, false, disposition(db, producerId, eventId, row.event_digest)) : null;
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

  const producerRow = (row, db) => row && Object.freeze({
    producerId: row.producer_id,
    logicalOperationId: row.logical_operation_id,
    eventId: row.event_id,
    workId: row.work_id,
    workRevision: row.work_revision,
    eventDigest: row.event_digest,
    deliveryState: row.delivery_state,
    event: Object.freeze(JSON.parse(row.event_json)),
    receiverReceipt: row.receiver_receipt_json ? Object.freeze(JSON.parse(row.receiver_receipt_json)) : null,
    deliveryDiagnostic: db ? deliveryDiagnostic(db, row) : null
  });

  const producerIntent = (producerId, logicalOperationId, draft) => {
    if (typeof producerId !== 'string' || !producerId.trim() ||
        typeof logicalOperationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(logicalOperationId) ||
        !draft || typeof draft !== 'object' || Array.isArray(draft) ||
        Object.keys(draft).some(key => !['schemaVersion', 'workId', 'eventType', 'occurredAt', 'context', 'session', 'request', 'outcome'].includes(key)) ||
        draft.schemaVersion !== 1 || typeof draft.workId !== 'string' || !draft.workId.trim()) fail('developer-producer-invalid');
    return developerEventDigest({ producerId, draft });
  };

  service.submitDeveloperWork = ({ authority, logicalOperationId, draft, assertSourceCurrent } = {}) => {
    if (!authority || !['worker', 'controller'].includes(authority.role) || !Array.isArray(authority.allowedProjects)) fail('developer-producer-invalid');
    const intentDigest = producerIntent(authority.producerId, logicalOperationId, draft);
    return mutate(null, db => {
      const old = db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND logical_operation_id = ?').get(authority.producerId, logicalOperationId);
      if (old) {
        if (old.intent_digest !== intentDigest) fail('developer-producer-conflict', 'Logical operation ID was reused with changed intent.');
        return producerRow(old, db);
      }
      if (db.prepare("SELECT count(*) AS pending FROM developer_work_outbox WHERE producer_id = ? AND delivery_state = 'pending'").get(authority.producerId).pending >= MAX_PENDING_RECEIPTS) fail('developer-producer-backpressure');
      const current = db.prepare('SELECT revision FROM developer_work_producer_cursors WHERE producer_id = ? AND work_id = ?').get(authority.producerId, draft.workId);
      const revision = (current?.revision ?? 0) + 1;
      const event = normalizeDeveloperEvent({ ...draft, occurredAt: draft.occurredAt ?? new Date().toISOString(), eventId: randomUUID(), workRevision: revision }, authority);
      if (event.session) {
        if (typeof assertSourceCurrent !== 'function') fail('source-admission-required', 'Bound work requires synchronous source admission.');
        const sourceCheck = assertSourceCurrent(event.session);
        // SQLite mutate is synchronous: a Promise cannot certify the source at commit.
        if (sourceCheck !== null && (typeof sourceCheck === 'object' || typeof sourceCheck === 'function') && typeof sourceCheck.then === 'function') fail('developer-producer-invalid', 'Source check must complete synchronously before commit.');
        if (sourceCheck === false) fail('developer-producer-invalid', 'The source did not certify this session.');
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
      return producerRow(db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND logical_operation_id = ?').get(authority.producerId, logicalOperationId), db);
    });
  };

  service.listPendingDeveloperDeliveries = ({ producerId, limit = 100 } = {}) => {
    if (typeof producerId !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('developer-producer-invalid');
    return inspect(db => Object.freeze(db.prepare("SELECT * FROM developer_work_outbox WHERE producer_id = ? AND delivery_state = 'pending' ORDER BY work_id, work_revision LIMIT ?").all(producerId, limit).map(row => producerRow(row, db))));
  };

  service.getDeveloperProducerEvent = ({ producerId, logicalOperationId } = {}) => {
    if (typeof producerId !== 'string' || typeof logicalOperationId !== 'string') fail('developer-producer-invalid');
    return inspect(db => producerRow(db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND logical_operation_id = ?').get(producerId, logicalOperationId), db));
  };

  // A lost result is not permission to execute again. This is a read-only
  // exact-intent query; absence never falls through to a write.
  service.reconcileDeveloperProducerEvent = ({ producerId, logicalOperationId, draft } = {}) => {
    const intentDigest = producerIntent(producerId, logicalOperationId, draft);
    return inspect(db => {
      const row = db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND logical_operation_id = ?').get(producerId, logicalOperationId);
      if (!row) return null;
      if (row.intent_digest !== intentDigest) fail('developer-producer-conflict', 'Logical operation ID was reused with changed intent.');
      return producerRow(row, db);
    });
  };

  service.recordDeveloperDeliveryFailure = ({ producerId, eventId, code, paused = false, observedAtMs = Date.now() } = {}) => {
    if (typeof producerId !== 'string' || typeof eventId !== 'string' || typeof code !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(code) || typeof paused !== 'boolean' || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0) fail('developer-producer-invalid');
    return mutate(null, db => {
      const row = db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND event_id = ?').get(producerId, eventId);
      if (!row) fail('developer-event-missing');
      if (row.delivery_state === 'delivered') return producerRow(row, db);
      const previous = deliveryDiagnostic(db, row);
      const attemptCount = Math.min(1000, (previous?.attemptCount ?? 0) + 1);
      const baseMs = Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(attemptCount - 1, 8));
      const jitter = createHash('sha256').update(`${producerId}\u0000${eventId}\u0000${attemptCount}`).digest().readUInt32BE(0) % Math.max(1, Math.floor(baseMs / 5));
      const diagnostic = { attemptCount, lastErrorCode: code, paused, nextAttemptAtMs: paused ? null : observedAtMs + baseMs + jitter, updatedAtMs: observedAtMs };
      const id = deliveryDiagnosticId(producerId, eventId);
      const timestamp = new Date(observedAtMs).toISOString();
      db.prepare(`INSERT INTO operation_journal (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at)
        VALUES (?, ?, ?, 'developer-work.delivery.v1', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(logical_operation_id) DO UPDATE SET state = excluded.state, result_status = excluded.result_status, result_identity = excluded.result_identity, observed_revision = excluded.observed_revision, updated_at = excluded.updated_at`).run(id, eventId, row.event_digest, paused ? 'conflict' : 'unknown', paused ? 'paused' : 'retry-wait', JSON.stringify(diagnostic), String(attemptCount), timestamp, timestamp);
      return producerRow(row, db);
    });
  };

  service.resumeDeveloperDelivery = ({ producerId, eventId, observedAtMs = Date.now() } = {}) => {
    if (typeof producerId !== 'string' || typeof eventId !== 'string' || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0) fail('developer-producer-invalid');
    return mutate(null, db => {
      const row = db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND event_id = ?').get(producerId, eventId);
      if (!row) fail('developer-event-missing');
      const current = deliveryDiagnostic(db, row);
      if (row.delivery_state !== 'pending' || !current?.paused) return producerRow(row, db);
      const diagnostic = { ...current, paused: false, nextAttemptAtMs: observedAtMs, updatedAtMs: observedAtMs };
      db.prepare("UPDATE operation_journal SET state = 'unknown', result_status = 'manual-retry', result_identity = ?, updated_at = ? WHERE logical_operation_id = ? AND operation_kind = 'developer-work.delivery.v1'").run(JSON.stringify(diagnostic), new Date(observedAtMs).toISOString(), deliveryDiagnosticId(producerId, eventId));
      return producerRow(row, db);
    });
  };

  service.markDeveloperDelivery = ({ producerId, eventId, receiverReceipt } = {}) => {
    if (typeof producerId !== 'string' || typeof eventId !== 'string' || !receiverReceipt || typeof receiverReceipt !== 'object' || Array.isArray(receiverReceipt) || Object.keys(receiverReceipt).some(key => !['schemaVersion', 'producerId', 'eventId', 'workId', 'workRevision', 'eventDigest', 'projectionState', 'acceptedAt', 'projectedAt', 'duplicate', 'disposition', 'dispositionReason'].includes(key)) || JSON.stringify(receiverReceipt).length > 4096) fail('developer-producer-invalid');
    return mutate(null, db => {
      const row = db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND event_id = ?').get(producerId, eventId);
      if (!row) fail('developer-event-missing');
      if (receiverReceipt.schemaVersion !== 1 || receiverReceipt.producerId !== producerId || receiverReceipt.eventId !== eventId || receiverReceipt.workId !== row.work_id || receiverReceipt.workRevision !== row.work_revision || receiverReceipt.eventDigest !== row.event_digest || !['pending', 'projected'].includes(receiverReceipt.projectionState) || typeof receiverReceipt.acceptedAt !== 'string' || Number.isNaN(Date.parse(receiverReceipt.acceptedAt))) fail('developer-receipt-conflict');
      const incidentProjection = receiverReceipt.dispositionReason === 'expired-active-update' && incidentUpdateTypes.has(JSON.parse(row.event_json).eventType);
      const projectedTimeValid = incidentProjection ? typeof receiverReceipt.projectedAt === 'string' && !Number.isNaN(Date.parse(receiverReceipt.projectedAt)) : receiverReceipt.projectedAt === receiverReceipt.acceptedAt;
      if (receiverReceipt.disposition !== undefined && (receiverReceipt.disposition !== 'expired' || !['request-expired', 'expired-dependency', 'expired-active-update'].includes(receiverReceipt.dispositionReason) || receiverReceipt.projectionState !== 'projected' || !projectedTimeValid || !JSON.parse(row.event_json).request)) fail('developer-receipt-conflict');
      if (receiverReceipt.disposition === undefined && receiverReceipt.dispositionReason !== undefined) fail('developer-receipt-conflict');
      const event = JSON.parse(row.event_json);
      const request = event.request;
      if (['request-expired', 'expired-active-update'].includes(receiverReceipt.dispositionReason) && !(Date.parse(request.expiresAt) <= Date.parse(receiverReceipt.acceptedAt))) fail('developer-receipt-conflict');
      if (receiverReceipt.dispositionReason === 'expired-active-update' && (!activeUpdateTypes.has(event.eventType) || request.expectedRequestRevision < 1)) fail('developer-receipt-conflict');
      if (receiverReceipt.disposition === 'expired' && request.expectedRequestRevision > 0) {
        const previous = db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND work_id = ? AND work_revision = ?').get(producerId, row.work_id, request.expectedRequestRevision);
        const priorRequest = previous && JSON.parse(previous.event_json).request;
        const previousReceipt = previous?.receiver_receipt_json ? JSON.parse(previous.receiver_receipt_json) : null;
        const validPredecessor = receiverReceipt.dispositionReason === 'expired-active-update'
          ? previousReceipt && (previousReceipt.disposition === undefined || previousReceipt.dispositionReason === 'expired-active-update')
          : previousReceipt?.disposition === 'expired' && previousReceipt.dispositionReason !== 'expired-active-update';
        if (previous?.delivery_state !== 'delivered' || !validPredecessor || priorRequest?.requestId !== request.requestId || priorRequest.kind !== request.kind) fail('developer-receipt-conflict');
      }
      if (receiverReceipt.dispositionReason === 'expired-dependency' && request.expectedRequestRevision === 0) fail('developer-receipt-conflict');
      if (row.delivery_state === 'delivered') {
        const prior = JSON.parse(row.receiver_receipt_json);
        if (prior.producerId !== receiverReceipt.producerId || prior.eventId !== receiverReceipt.eventId || prior.eventDigest !== receiverReceipt.eventDigest || prior.disposition !== receiverReceipt.disposition || prior.dispositionReason !== receiverReceipt.dispositionReason) fail('developer-receipt-conflict');
        return producerRow(row, db);
      }
      const deliveredAt = new Date().toISOString();
      db.prepare("UPDATE developer_work_outbox SET delivery_state = 'delivered', receiver_receipt_json = ?, delivered_at = ? WHERE producer_id = ? AND event_id = ?").run(JSON.stringify(receiverReceipt), deliveredAt, producerId, eventId);
      const priorDiagnostic = deliveryDiagnostic(db, row);
      if (priorDiagnostic) {
        const diagnostic = { ...priorDiagnostic, deliveryState: 'delivered', paused: false, nextAttemptAtMs: null, deliveredAtMs: Date.parse(deliveredAt), updatedAtMs: Date.parse(deliveredAt) };
        db.prepare("UPDATE operation_journal SET state = 'applied', result_status = 'delivered', result_identity = ?, updated_at = ? WHERE logical_operation_id = ? AND operation_kind = 'developer-work.delivery.v1'").run(JSON.stringify(diagnostic), deliveredAt, deliveryDiagnosticId(producerId, eventId));
      }
      return producerRow(db.prepare('SELECT * FROM developer_work_outbox WHERE producer_id = ? AND event_id = ?').get(producerId, eventId), db);
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
