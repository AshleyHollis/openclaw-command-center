import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { normalizeDeveloperEvent } from '../src/developer-work/contract.mjs';
import { createDeveloperWorkService } from '../src/developer-work/service.mjs';
import { developerWorkTablesSql, developerWorkWatermarksSql, installDeveloperWorkMetadata } from '../src/metadata/developer-work.mjs';

class MetadataError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const authority = { producerId: 'fictional-dev', role: 'worker', allowedProjects: ['sample-project'] };
const session = { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'incarnation-1', lifecycleRevision: 'reset-1' };
function event(revision, eventId, requestId, expectedRequestRevision = 0, eventType = 'feature_ready_for_review') {
  return normalizeDeveloperEvent({
    schemaVersion: 1, eventId, workId: 'feature-7', workRevision: revision, eventType,
    occurredAt: '2026-09-26T10:00:00.000Z', context: { projectAlias: 'sample-project', phase: 'reviewing' }, session,
    request: { requestId, kind: 'review', expectedRequestRevision, summary: `Review ${requestId}`, question: 'Is this ready for release?' },
    ...(eventType === 'request_resolved' ? { outcome: { code: 'reviewed', requestId } } : {})
  }, authority);
}
function owner(db, { beforeBegin = () => {}, afterBegin = () => {} } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS operation_journal (
    logical_operation_id TEXT PRIMARY KEY, transport_request_id TEXT NOT NULL,
    intent_digest TEXT NOT NULL, operation_kind TEXT NOT NULL, state TEXT NOT NULL,
    result_status TEXT, result_identity TEXT, observed_revision TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;`);
  const service = {};
  installDeveloperWorkMetadata(service, {
    ErrorType: MetadataError,
    inspect: operation => operation(db),
    mutate: (_capability, operation) => {
      beforeBegin();
      db.exec('BEGIN IMMEDIATE');
      try { afterBegin(); const result = operation(db); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  });
  return service;
}

test('durable receipts preserve exact replay, independent requests and terminal state', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(developerWorkTablesSql + developerWorkWatermarksSql);
  const first = owner(db);
  const a = event(1, 'a3c429e9-c12f-4301-a799-622852499da1', 'review-a');
  const b = event(2, 'a3c429e9-c12f-4301-a799-622852499da2', 'review-b');
  const resolvedA = event(3, 'a3c429e9-c12f-4301-a799-622852499da3', 'review-a', 1, 'request_resolved');
  assert.equal(first.acceptDeveloperEvent({ producerId: authority.producerId, event: a }).projectionState, 'pending');
  assert.equal(owner(db).acceptDeveloperEvent({ producerId: authority.producerId, event: a }).duplicate, true);
  assert.throws(() => first.acceptDeveloperEvent({ producerId: authority.producerId, event: { ...a, occurredAt: '2026-09-26T10:00:01Z' } }), { code: 'developer-event-conflict' });
  assert.throws(() => first.acceptDeveloperEvent({ producerId: authority.producerId, event: resolvedA }), { code: 'developer-event-gap' });
  first.acceptDeveloperEvent({ producerId: authority.producerId, event: b });
  first.acceptDeveloperEvent({ producerId: authority.producerId, event: resolvedA });
  assert.equal(first.getDeveloperRequest({ producerId: authority.producerId, workId: 'feature-7', requestId: 'review-a' }).state, 'resolved');
  assert.equal(first.getDeveloperRequest({ producerId: authority.producerId, workId: 'feature-7', requestId: 'review-b' }).state, 'active');
  assert.throws(() => first.acceptDeveloperEvent({ producerId: authority.producerId, event: event(4, 'a3c429e9-c12f-4301-a799-622852499da4', 'review-a', 3) }), { code: 'developer-request-terminal' });
  assert.equal(first.listPendingDeveloperEvents({}).length, 3);
  assert.throws(() => first.markDeveloperEventProjected({ producerId: authority.producerId, eventId: b.eventId, eventDigest: first.listPendingDeveloperEvents({})[1].receipt.eventDigest }), { code: 'developer-projection-order' });
  for (const item of first.listPendingDeveloperEvents({})) first.markDeveloperEventProjected({ producerId: authority.producerId, eventId: item.receipt.eventId, eventDigest: item.receipt.eventDigest });
  assert.equal(owner(db).listPendingDeveloperEvents({}).length, 0);
  db.close();
});

test('delivery watermark is monotonic across duplicate receipts and waits for contiguous projection', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(developerWorkTablesSql + developerWorkWatermarksSql);
  const metadata = owner(db);
  const a = event(1, randomUUID(), 'review-a');
  const b = event(2, randomUUID(), 'review-b');
  const resolvedA = event(3, randomUUID(), 'review-a', 1, 'request_resolved');
  const ready = () => owner(db).isDeveloperWorkNotificationReady({ producerId: authority.producerId, workId: a.workId });
  try {
    assert.equal(ready(), false);
    metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: a, watermark: 3 });
    assert.equal(ready(), false);
    assert.equal(metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: a, watermark: 3 }).duplicate, true);
    assert.throws(() => metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: a, watermark: 502 }), { code: 'delivery-watermark-invalid' });
    metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: b, watermark: 2 });
    metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: resolvedA, watermark: 3 });
    assert.equal(db.prepare('SELECT announced_revision FROM developer_work_watermarks').get().announced_revision, 3);
    for (const item of metadata.listPendingDeveloperEvents({})) {
      metadata.markDeveloperEventProjected({ producerId: authority.producerId, eventId: item.receipt.eventId, eventDigest: item.receipt.eventDigest });
      assert.equal(ready(), item.receipt.workRevision === 3);
    }
    assert.equal(metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: a, watermark: 2 }).duplicate, true);
    assert.equal(ready(), true);
  } finally { db.close(); }
});

test('receiver refuses an already expired request atomically, but preserves exact receipt replay', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(developerWorkTablesSql + developerWorkWatermarksSql);
  const metadata = owner(db);
  const original = event(1, randomUUID(), 'review-expiring');
  const expiring = normalizeDeveloperEvent({ ...original, request: { ...original.request, expiresAt: '2026-09-26T10:01:00Z' } }, authority);
  try {
    for (const acceptedAt of ['2026-09-26T10:01:00Z', '2026-09-26T10:01:01Z']) {
      assert.throws(() => metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: expiring, watermark: 1, now: () => Date.parse(acceptedAt) }), { code: 'developer-request-expired' });
      for (const table of ['developer_work_cursors', 'developer_work_requests', 'developer_work_receipts', 'developer_work_watermarks']) assert.equal(db.prepare('SELECT count(*) AS count FROM ' + table).get().count, 0, table);
    }
    const accepted = metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: expiring, watermark: 1, now: () => Date.parse('2026-09-26T10:00:59Z') });
    assert.equal(accepted.workRevision, 1);
    assert.equal(metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: expiring, now: () => Date.parse('2026-09-26T10:01:01Z') }).duplicate, true, 'already accepted evidence remains replayable');
    assert.throws(() => metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: { ...expiring, occurredAt: '2026-09-26T10:00:01Z' }, now: () => Date.parse('2026-09-26T10:01:01Z') }), { code: 'developer-event-conflict' });
    assert.equal(db.prepare('SELECT count(*) AS count FROM developer_work_receipts').get().count, 1);
  } finally { db.close(); }
});

test('queued acceptance crossing the expiry deadline samples the clock only after the write lock', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(developerWorkTablesSql + developerWorkWatermarksSql);
  const deadline = Date.parse('2026-09-26T10:01:00Z');
  let clock = deadline - 1;
  let lockHeld = false;
  let entered = 0;
  // Model a contended BEGIN IMMEDIATE: time advances while waiting for the
  // lock, and the clock callback must not run until the transaction owns it.
  const metadata = owner(db, { beforeBegin() { clock = deadline; lockHeld = false; }, afterBegin() { entered++; lockHeld = true; } });
  const developer = createDeveloperWorkService({ metadata, attention: { registerSourceCapability() {}, async ingest() { throw new Error('Expired request must not project.'); } }, now: () => { assert.equal(lockHeld, true); return clock; } });
  const original = event(1, randomUUID(), 'review-contended');
  const expiring = { ...original, request: { ...original.request, expiresAt: new Date(deadline).toISOString() } };
  try {
    await assert.rejects(() => developer.accept({ ...authority, event: expiring }), { code: 'developer-request-expired' });
    assert.equal(entered, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM developer_work_cursors').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM developer_work_receipts').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM developer_work_requests').get().count, 0);
    clock = deadline - 1;
    const accepted = await developer.accept({ ...authority, event: { ...original, request: { ...original.request, expiresAt: new Date(deadline + 1000).toISOString() } } });
    assert.equal(accepted.acceptedAt, new Date(deadline).toISOString(), 'receipt and expiry use one post-lock instant');
  } finally { developer.close(); db.close(); }
});

test('a deployment has one durable incident identity across outcome updates', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(developerWorkTablesSql + developerWorkWatermarksSql);
  const metadata = owner(db);
  const controller = { producerId: 'fictional-controller', role: 'controller', allowedProjects: ['sample-project'] };
  const incident = (revision, eventType, requestId, deploymentId, expectedRequestRevision, code) => normalizeDeveloperEvent({
    schemaVersion: 1, eventId: randomUUID(), workId: 'deployment-work', workRevision: revision, eventType,
    occurredAt: '2026-09-26T10:00:00.000Z', context: { projectAlias: 'sample-project', deploymentId },
    request: { requestId, kind: 'deployment-incident', expectedRequestRevision, summary: 'Deployment needs review' },
    outcome: { code, deploymentId }
  }, controller);
  const first = incident(1, 'production_deployment_failed', 'incident-1', 'deployment-1', 0, 'failed');
  metadata.acceptDeveloperEvent({ producerId: controller.producerId, event: first });
  assert.throws(() => metadata.acceptDeveloperEvent({ producerId: controller.producerId, event: incident(2, 'production_rollback', 'incident-1', 'deployment-2', 1, 'rolled-back') }), { code: 'developer-request-conflict' });
  assert.throws(() => metadata.acceptDeveloperEvent({ producerId: controller.producerId, event: incident(2, 'production_deployment_failed', 'incident-2', 'deployment-1', 0, 'failed') }), { code: 'developer-request-conflict' });
  metadata.acceptDeveloperEvent({ producerId: controller.producerId, event: incident(2, 'production_rollback', 'incident-1', 'deployment-1', 1, 'rolled-back') });
  metadata.acceptDeveloperEvent({ producerId: controller.producerId, event: incident(3, 'production_recovered', 'incident-1', 'deployment-1', 2, 'recovered') });
  assert.equal(metadata.getDeveloperRequest({ producerId: controller.producerId, workId: 'deployment-work', requestId: 'incident-1' }).revision, 3);
  assert.equal(metadata.listPendingDeveloperEvents({}).length, 3);
  db.close();
});
