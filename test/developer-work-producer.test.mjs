import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createDeveloperWorkProducer } from '../src/developer-work/producer.mjs';
import { developerWorkToolFactory } from '../src/developer-work/producer-tool.mjs';
import { validateBridgeRequest, BRIDGE_CONTRACTS } from '../src/bridge/contracts.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';

const authority = { producerId: 'sample-dev', role: 'worker', allowedProjects: ['sample-project'] };
const session = { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'session-1', lifecycleRevision: 'lifecycle-1' };
const capabilities = { notes: false, sessions: false, scheduler: false, activity: true, analysis: false, attention: true, search: false };
// Fictional test admission: only an exact fixture session may be committed.
const admittedSubmit = (metadata, input) => metadata.submitDeveloperWork({ ...input, assertSourceCurrent: input.assertSourceCurrent ?? (expected => assert.deepEqual(expected, session)) });

test('DEV resolver is a closed operator.read bridge command', async () => {
  const method = 'command-center.v1.developer-work.resolve';
  const params = { schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' };
  assert.equal(BRIDGE_CONTRACTS[method].scope, 'operator.read');
  validateBridgeRequest(method, params);
  assert.throws(() => validateBridgeRequest(method, { ...params, sessionKey: session.sessionKey }), /unsupported|additional|invalid/iu);
  const result = await invokeBridgeMethod({ developerWorkResolve: input => ({ schemaVersion: 1, status: 'stale', workId: input.workId, requestId: input.requestId, reason: 'request-ended' }) }, method, params, 'rpc-correlation');
  assert.equal(result.status, 'stale');
  assert.equal(result.requestId, params.requestId, 'The RPC envelope ID must not replace the DEV request ID');
});

function draft(requestId, expectedRequestRevision = 0, eventType = 'feature_ready_for_review') {
  return {
    schemaVersion: 1, workId: 'feature-1', eventType, occurredAt: '2026-09-26T10:00:00.000Z',
    context: { projectAlias: 'sample-project', phase: 'reviewing' }, session,
    request: { requestId, kind: 'review', expectedRequestRevision, summary: `Review ${requestId}`, question: 'Is this ready?' },
    ...(eventType === 'request_resolved' ? { outcome: { code: 'reviewed', requestId } } : {})
  };
}

test('DEV owner assigns one durable event per operation and preserves request incarnations', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  try {
    let metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    const operationId = randomUUID();
    const firstDraft = draft('review-a');
    const first = admittedSubmit(metadata, { authority, logicalOperationId: operationId, draft: firstDraft });
    assert.equal(first.workRevision, 1);
    assert.equal(first.deliveryState, 'pending');
    assert.deepEqual(admittedSubmit(metadata, { authority, logicalOperationId: operationId, draft: firstDraft }), first);
    assert.throws(() => admittedSubmit(metadata, { authority, logicalOperationId: operationId, draft: { ...firstDraft, occurredAt: '2026-09-26T10:00:01.000Z' } }), { code: 'developer-producer-conflict' });
    const second = admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-b') });
    const resolved = admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-a', 1, 'request_resolved') });
    assert.deepEqual([second.workRevision, resolved.workRevision], [2, 3]);
    assert.equal(metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId: 'feature-1', requestId: 'review-a' }).state, 'resolved');
    assert.equal(metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId: 'feature-1', requestId: 'review-b' }).state, 'active');
    assert.throws(() => admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-a', 1) }), { code: 'developer-request-stale' });
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    try {
      const pending = metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId });
      assert.deepEqual(pending.map(row => row.eventId), [first.eventId, second.eventId, resolved.eventId]);
      const receipt = { schemaVersion: 1, producerId: authority.producerId, eventId: first.eventId, workId: first.workId, workRevision: first.workRevision, eventDigest: first.eventDigest, projectionState: 'pending', acceptedAt: '2026-09-26T10:01:00.000Z', duplicate: false };
      const delivered = metadata.markDeveloperDelivery({ producerId: authority.producerId, eventId: first.eventId, receiverReceipt: receipt });
      assert.equal(delivered.deliveryState, 'delivered');
      assert.equal(metadata.markDeveloperDelivery({ producerId: authority.producerId, eventId: first.eventId, receiverReceipt: { ...receipt, duplicate: true } }).deliveryState, 'delivered');
      assert.throws(() => metadata.markDeveloperDelivery({ producerId: authority.producerId, eventId: second.eventId, receiverReceipt: receipt }), { code: 'developer-receipt-conflict' });
      assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).map(row => row.eventId), [second.eventId, resolved.eventId]);
    } finally { metadata.close(); }
  } finally {
    if (path.dirname(stateDir) !== os.tmpdir() || !path.basename(stateDir).startsWith('cc-developer-producer-')) throw new Error('Refusing unsafe test cleanup path');
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('producer rejects asynchronous source checks before any durable event, request or cursor', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  try {
    const evidence = draft('review-a');
    for (const assertSourceCurrent of [async () => {}, () => ({ then() {} })]) {
      const logicalOperationId = randomUUID();
      assert.throws(() => metadata.submitDeveloperWork({ authority, logicalOperationId, draft: evidence, assertSourceCurrent }), { code: 'developer-producer-invalid' });
      assert.equal(metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId }) ?? null, null);
      assert.equal(metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId: evidence.workId, requestId: evidence.request.requestId }), null);
      assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }), []);
    }
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    let checked = 0;
    const accepted = metadata.submitDeveloperWork({ authority, logicalOperationId: randomUUID(), draft: evidence,
      assertSourceCurrent(expected) { assert.deepEqual(expected, session); checked++; } });
    assert.equal(checked, 1);
    assert.equal(accepted.workRevision, 1, 'rejected source checks must not advance the durable cursor');
    assert.equal(metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId: evidence.workId, requestId: evidence.request.requestId }).lastEventId, accepted.eventId);
    assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).map(item => item.eventId), [accepted.eventId]);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('metadata owner refuses absent, stale and negative source admission without writes, but replays exact intent', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const evidence = draft('review-a');
  const logicalOperationId = randomUUID();
  const snapshot = () => ({
    operation: metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId }) ?? null,
    request: metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId: evidence.workId, requestId: evidence.request.requestId }),
    outbox: metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId })
  });
  try {
    const input = { authority, logicalOperationId, draft: evidence };
    assert.throws(() => metadata.submitDeveloperWork(input), { code: 'source-admission-required' });
    assert.deepEqual(snapshot(), { operation: null, request: null, outbox: [] });
    for (const assertSourceCurrent of [() => { throw Object.assign(new Error('replaced'), { code: 'session-stale' }); }, () => false]) {
      assert.throws(() => metadata.submitDeveloperWork({ ...input, assertSourceCurrent }));
      assert.deepEqual(snapshot(), { operation: null, request: null, outbox: [] });
    }
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    const first = metadata.submitDeveloperWork({ ...input, assertSourceCurrent: expected => { assert.deepEqual(expected, session); } });
    assert.equal(first.workRevision, 1, 'no rejected admission advanced the cursor');
    assert.deepEqual(metadata.submitDeveloperWork(input), first, 'lost reply replays without rechecking a now-unavailable source');
    assert.throws(() => metadata.submitDeveloperWork({ ...input, draft: { ...evidence, occurredAt: '2026-09-26T10:00:01Z' } }), { code: 'developer-producer-conflict' });
    assert.deepEqual(snapshot().outbox.map(row => row.eventId), [first.eventId]);
    assert.equal(metadata.submitDeveloperWork({ ...input, logicalOperationId: randomUUID(), draft: draft('review-b'), assertSourceCurrent: () => {} }).workRevision, 2);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('controller producer keeps one incident per deployment and rejects changed identity', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const controller = { producerId: 'sample-controller', role: 'controller', allowedProjects: ['sample-project'] };
  const incident = (eventType, requestId, deploymentId, expectedRequestRevision, code) => ({
    schemaVersion: 1, workId: 'deployment-work', eventType, occurredAt: '2026-09-26T10:00:00.000Z',
    context: { projectAlias: 'sample-project', deploymentId },
    request: { requestId, kind: 'deployment-incident', expectedRequestRevision, summary: 'Deployment needs review' },
    outcome: { code, deploymentId }
  });
  const submit = draft => admittedSubmit(metadata, { authority: controller, logicalOperationId: randomUUID(), draft });
  try {
    submit(incident('production_deployment_failed', 'incident-1', 'deployment-1', 0, 'failed'));
    assert.throws(() => submit(incident('production_rollback', 'incident-1', 'deployment-2', 1, 'rolled-back')), { code: 'developer-request-conflict' });
    assert.throws(() => submit(incident('production_deployment_failed', 'incident-2', 'deployment-1', 0, 'failed')), { code: 'developer-request-conflict' });
    const rollback = submit(incident('production_rollback', 'incident-1', 'deployment-1', 1, 'rolled-back'));
    assert.equal(rollback.workRevision, 2);
    assert.equal(metadata.getDeveloperProducerRequest({ producerId: controller.producerId, workId: 'deployment-work', requestId: 'incident-1' }).revision, 2);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('DEV resolver checks exact session incarnation and request state at readback', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  // api.runtime.agent.session.getSessionEntry returns raw SessionEntry, not agent/key.
  let entry = { sessionId: session.sessionId, lifecycleRevision: session.lifecycleRevision };
  let clock = Date.parse('2026-09-26T10:00:00Z');
  let duringRead = () => {};
  const calls = [];
  const producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: async input => { calls.push(input); duringRead(); return entry; }, now: () => clock, receiver: { send: async () => { throw new Error('receiver unavailable'); } } });
  try {
    admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-a') });
    const ready = await producer.resolve({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.sessionKey, session.sessionKey);
    assert.deepEqual(calls[0], { agentId: session.agentId, sessionKey: session.sessionKey, readConsistency: 'latest' });
    entry = { sessionId: session.sessionId, lifecycleRevision: session.lifecycleRevision, agentId: 'wrong-agent' };
    assert.deepEqual((await producer.resolve({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' })).reason, 'session-replaced');
    entry = { sessionId: session.sessionId, lifecycleRevision: session.lifecycleRevision, agentId: undefined };
    assert.deepEqual((await producer.resolve({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' })).reason, 'session-replaced');
    entry = { sessionId: session.sessionId, lifecycleRevision: session.lifecycleRevision, sessionKey: 'agent:sample-agent:other' };
    assert.deepEqual((await producer.resolve({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' })).reason, 'session-replaced');
    entry = { sessionId: session.sessionId, lifecycleRevision: 'lifecycle-2' };
    assert.deepEqual((await producer.resolve({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' })).reason, 'session-replaced');
    entry = { sessionId: 'replacement', lifecycleRevision: session.lifecycleRevision };
    assert.deepEqual((await producer.resolve({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' })).reason, 'session-replaced');
    entry = undefined;
    assert.deepEqual((await producer.resolve({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' })).reason, 'session-replaced');
    const currentWork = await producer.resolve({ schemaVersion: 1, workId: 'feature-1' });
    assert.deepEqual(currentWork.requests.map(row => row.requestId), ['review-a']);
    admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-a', 1, 'request_resolved') });
    assert.deepEqual((await producer.resolve({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' })).reason, 'request-ended');
    assert.deepEqual((await producer.resolve({ schemaVersion: 1, workId: 'feature-1' })).requests, []);
    entry = { sessionId: session.sessionId, lifecycleRevision: session.lifecycleRevision };
    const expiresAt = '2026-09-26T10:01:00Z';
    const expiring = draft('review-expiring');
    admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: { ...expiring, request: { ...expiring.request, expiresAt } } });
    const target = { schemaVersion: 1, workId: 'feature-1', requestId: 'review-expiring' };
    assert.equal((await producer.resolve(target)).status, 'ready');
    duringRead = () => { clock = Date.parse(expiresAt); };
    assert.equal((await producer.resolve(target)).reason, 'request-expired', 'expiry while the source read is in flight refuses ready');
    const callCount = calls.length;
    assert.equal((await producer.resolve(target)).reason, 'request-expired');
    assert.equal(calls.length, callCount, 'already-expired requests need no session read');
  } finally { producer.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('lost receiver reply leaves the same event pending and blocks its successor until retry', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const sent = [];
  const watermarks = [];
  let failFirst = true;
  let clock = Date.parse('2026-09-26T11:00:00.000Z');
  const receiver = { async send(value, options) {
    sent.push(value);
    watermarks.push(options.watermark);
    if (failFirst) { failFirst = false; throw new Error('lost reply'); }
    return { schemaVersion: 1, producerId: authority.producerId, eventId: value.eventId, workId: value.workId, workRevision: value.workRevision, eventDigest: metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: operations.get(value.eventId) }).eventDigest, projectionState: 'projected', acceptedAt: '2026-09-26T11:00:00.000Z' };
  } };
  const operations = new Map();
  const producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: () => undefined, receiver, now: () => clock });
  try {
    const first = admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-a') });
    operations.set(first.eventId, first.logicalOperationId);
    const second = admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-b') });
    operations.set(second.eventId, second.logicalOperationId);
    const firstFlush = await producer.flush();
    assert.equal(firstFlush.delivered, 0);
    assert.deepEqual(sent.map(row => row.eventId), [first.eventId]);
    const recorded = metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: first.logicalOperationId }).deliveryDiagnostic;
    assert.equal(recorded.attemptCount, 1);
    assert.equal(recorded.lastErrorCode, 'receiver-unavailable');
    assert.ok(recorded.nextAttemptAtMs > clock);
    assert.equal((await producer.flush()).attempted, 0, 'native Cron checks before the due time cannot hot-loop');
    clock = recorded.nextAttemptAtMs;
    const retried = await producer.flush();
    assert.equal(retried.delivered, 2);
    assert.deepEqual(sent.map(row => row.eventId), [first.eventId, first.eventId, second.eventId]);
    assert.deepEqual(watermarks, [2, 2, 2]);
    assert.equal(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).length, 0);
  } finally { producer.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('authentication refusal pauses durable delivery across restart without retrying later revisions', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-pause-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const first = admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-a') });
  admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-b') });
  let calls = 0;
  let reject = true;
  const receiver = { async send(event) {
    calls++;
    if (reject) throw Object.assign(new Error('unauthorized'), { code: 'receiver-http-401' });
    const row = metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).find(item => item.eventId === event.eventId);
    return { schemaVersion: 1, producerId: authority.producerId, eventId: event.eventId, workId: event.workId, workRevision: event.workRevision, eventDigest: row.eventDigest, projectionState: 'projected', acceptedAt: '2026-09-26T11:00:00.000Z' };
  } };
  let producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: () => undefined, receiver });
  try {
    const failed = await producer.flush();
    assert.deepEqual([failed.attempted, failed.paused, failed.pending], [1, 1, 2]);
    const diagnostic = metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: first.logicalOperationId }).deliveryDiagnostic;
    assert.deepEqual({ attemptCount: diagnostic.attemptCount, lastErrorCode: diagnostic.lastErrorCode, paused: diagnostic.paused, nextAttemptAtMs: diagnostic.nextAttemptAtMs },
      { attemptCount: 1, lastErrorCode: 'receiver-http-401', paused: true, nextAttemptAtMs: null });
    producer.close(); metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: () => undefined, receiver });
    const afterRestart = await producer.flush();
    assert.deepEqual([afterRestart.attempted, afterRestart.paused, afterRestart.pending], [0, 1, 2]);
    assert.equal(calls, 1);
    reject = false;
    const resumed = await producer.flush({ resumePaused: true });
    assert.deepEqual([resumed.delivered, resumed.pending], [2, 0]);
    assert.equal(calls, 3);
    const completed = metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: first.logicalOperationId });
    assert.equal(completed.deliveryState, 'delivered');
    assert.equal(completed.deliveryDiagnostic.deliveryState, 'delivered');
    assert.equal(completed.deliveryDiagnostic.paused, false);
    assert.equal(completed.deliveryDiagnostic.nextAttemptAtMs, null);
    assert.ok(completed.deliveryDiagnostic.deliveredAtMs > 0);
    producer.close(); metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    const afterCompletionRestart = metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: first.logicalOperationId });
    assert.deepEqual(afterCompletionRestart.deliveryDiagnostic, completed.deliveryDiagnostic);
    producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: () => undefined, receiver });
    assert.equal((await producer.flush()).pending, 0);
    assert.equal(calls, 3);
  } finally { producer.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a delivery pass freezes its per-work watermark before awaiting the receiver', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const sent = [];
  let appendResolution = true;
  const receiver = { async send(event, options) {
    sent.push({ eventId: event.eventId, watermark: options.watermark });
    if (appendResolution) {
      appendResolution = false;
      admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-a', 1, 'request_resolved') });
    }
    const row = metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).find(item => item.eventId === event.eventId);
    return { schemaVersion: 1, producerId: authority.producerId, eventId: event.eventId, workId: event.workId, workRevision: event.workRevision, eventDigest: row.eventDigest, projectionState: 'projected', acceptedAt: '2026-09-26T11:00:00.000Z' };
  } };
  const producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: () => undefined, receiver });
  try {
    admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: draft('review-a') });
    const first = await producer.flush();
    assert.deepEqual({ delivered: first.delivered, pending: first.pending }, { delivered: 1, pending: 1 });
    assert.deepEqual(sent.map(row => row.watermark), [1]);
    const second = await producer.flush();
    assert.deepEqual({ delivered: second.delivered, pending: second.pending }, { delivered: 1, pending: 0 });
    assert.deepEqual(sent.map(row => row.watermark), [1, 2]);
  } finally { producer.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a retry run is bounded even when the receiver accepts a large outbox', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const receipts = new Map();
  const producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: () => undefined, receiver: { send: async value => receipts.get(value.eventId) } });
  try {
    for (let index = 0; index < 11; index++) {
      const row = admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: { ...draft('review-a'), workId: `feature-${index}` } });
      receipts.set(row.eventId, { schemaVersion: 1, producerId: authority.producerId, eventId: row.eventId, workId: row.workId, workRevision: row.workRevision, eventDigest: row.eventDigest, projectionState: 'projected', acceptedAt: '2026-09-26T11:00:00.000Z' });
    }
    const first = await producer.flush();
    assert.deepEqual({ delivered: first.delivered, attempted: first.attempted, pending: first.pending }, { delivered: 10, attempted: 10, pending: 1 });
    const second = await producer.flush();
    assert.deepEqual({ delivered: second.delivered, attempted: second.attempted, pending: second.pending }, { delivered: 1, attempted: 1, pending: 0 });
  } finally { producer.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('the DEV agent tool derives session identity and preserves one operation across retries', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-producer-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  let entry = { sessionId: 'session-1', lifecycleRevision: 'lifecycle-1' };
  const sessionReader = () => entry;
  const producer = createDeveloperWorkProducer({ metadata, authority, sessionReader, receiver: { send: async () => { throw new Error('offline'); } } });
  const tool = developerWorkToolFactory({ getOwner: () => producer, sessionReader, allowedAgentIds: ['sample-agent'] })({ agentId: 'sample-agent', sessionKey: session.sessionKey, sessionId: session.sessionId });
  const params = { workId: 'feature-1', eventType: 'feature_ready_for_review', context: { projectAlias: 'sample-project' }, request: { requestId: 'review-a', kind: 'review', expectedRequestRevision: 0, summary: 'Review sample feature', question: 'Is it ready?' } };
  try {
    const first = await tool.execute('tool-call-1', params);
    const repeated = await tool.execute('tool-call-1', params);
    assert.deepEqual(repeated.details, first.details);
    assert.equal(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).length, 1);
    assert.throws(() => admittedSubmit(metadata, { authority, logicalOperationId: randomUUID(), draft: { schemaVersion: 1, workId: 'feature-1', eventType: 'feature_ready_for_review', context: { projectAlias: 'sample-project' }, session: { ...session, lifecycleRevision: 'lifecycle-2' }, request: params.request }, assertSourceCurrent: () => { throw Object.assign(new Error('changed'), { code: 'session-stale' }); } }), { code: 'session-stale' });
    assert.equal(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).length, 1);
    await assert.rejects(() => tool.execute('tool-call-1', { ...params, request: { ...params.request, question: 'Different question' } }), { code: 'developer-producer-conflict' });
    entry = { sessionId: 'session-1', lifecycleRevision: 'lifecycle-2' };
    await assert.rejects(() => tool.execute('tool-call-1', params), { code: 'developer-producer-conflict' });
  } finally { producer.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});


test('synchronous commit has no delivery side effect; exact-intent lost-reply recovery never executes', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-sync-'));
  const evidence = draft('review-a');
  const logicalOperationId = randomUUID();
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  let sends = 0;
  let producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: () => session,
    receiver: { async send() { sends++; throw new Error('offline'); } } });
  try {
    assert.equal(producer.reconcile({ logicalOperationId, draft: evidence }), null);
    assert.throws(() => producer.commit({ logicalOperationId, draft: evidence }), { code: 'source-admission-required' });
    assert.throws(() => producer.commit({ logicalOperationId, draft: evidence, assertSourceCurrent() { throw Object.assign(new Error('changed'), { code: 'session-stale' }); } }), { code: 'session-stale' });
    assert.equal(producer.reconcile({ logicalOperationId, draft: evidence }), null);
    assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }), []);
    const applied = producer.commit({ logicalOperationId, draft: evidence, assertSourceCurrent(expected) { assert.deepEqual(expected, session); } });
    assert.equal(typeof applied?.then, 'undefined', 'the owning commit must not return a Promise');
    assert.equal(applied.workRevision, 1);
    assert.equal(sends, 0, 'commit must not start async delivery');
    // Simulate loss of the successful commit reply, and reopen the real ledger.
    producer.close(); metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    producer = createDeveloperWorkProducer({ metadata, authority, sessionReader: () => session });
    assert.deepEqual(producer.reconcile({ logicalOperationId, draft: evidence }), applied);
    assert.throws(() => producer.reconcile({ logicalOperationId, draft: { ...evidence, occurredAt: '2026-09-26T10:00:01.000Z' } }), { code: 'developer-producer-conflict' });
    assert.equal(producer.reconcile({ logicalOperationId: randomUUID(), draft: evidence }), null);
    assert.deepEqual(producer.commit({ logicalOperationId, draft: evidence, assertSourceCurrent: () => {} }), applied);
    assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).map(row => row.eventId), [applied.eventId]);
    assert.equal(metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId: evidence.workId, requestId: evidence.request.requestId }).revision, 1);
    const next = producer.commit({ logicalOperationId: randomUUID(), draft: draft('review-b'), assertSourceCurrent: () => {} });
    assert.equal(next.workRevision, 2, 'replay must not advance the cursor');
  } finally { producer.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});
