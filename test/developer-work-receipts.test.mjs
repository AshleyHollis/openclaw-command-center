import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { normalizeDeveloperEvent } from '../src/developer-work/contract.mjs';
import { developerWorkTablesSql, installDeveloperWorkMetadata } from '../src/metadata/developer-work.mjs';

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
function owner(db) {
  const service = {};
  installDeveloperWorkMetadata(service, {
    ErrorType: MetadataError,
    inspect: operation => operation(db),
    mutate: (_capability, operation) => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = operation(db); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  });
  return service;
}

test('durable receipts preserve exact replay, independent requests and terminal state', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(developerWorkTablesSql);
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

test('a deployment has one durable incident identity across outcome updates', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(developerWorkTablesSql);
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
