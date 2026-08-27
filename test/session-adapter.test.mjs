import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createSessionAdapter } from '../src/sources/sessions.mjs';

function metadataFixture() {
  const refs = [];
  const states = new Map();
  return {
    refs,
    listSourceReferences: () => refs,
    createSourceReference: (reference) => { refs.push(reference); return reference; },
    getSourceReference: (id) => refs.find((reference) => reference.referenceId === id) ?? null,
    setSessionState: (value) => { states.set(value.referenceId, value); return value; },
    getSessionState: (id) => states.get(id) ?? null
  };
}

test('Session create/history/send use exact linked keys without transcript inheritance', async () => {
  const metadata = metadataFixture();
  const calls = [];
  const gateway = { request: async (method, params) => { calls.push({ method, params }); if (method === 'sessions.create') return { ['k' + 'ey']: params['k' + 'ey'], sessionId: 'fictional-session-id' }; if (method === 'chat.history') return { messages: ['authoritative'] }; return { runId: params.idempotencyKey }; } };
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  const logicalOperationId = randomUUID();
  const created = await adapter.create({ logicalOperationId, isPrimary: true });
  assert.equal(created.value.sourceReference.externalSourceId, `agent:main:command-center:${logicalOperationId}`);
  assert.equal(calls[0].params.parentSessionKey, undefined);
  assert.equal(calls[0].params.fork, undefined);
  const history = await adapter.history({ referenceId: created.value.sourceReference.referenceId });
  assert.deepEqual(history.messages, ['authoritative']);
  const callsBeforeForeignHistory = calls.length;
  await assert.rejects(
    () => adapter.history({ referenceId: created.value.sourceReference.referenceId, sessionId: 'foreign-session-id' }),
    /unsupported.*sessionId/i
  );
  assert.equal(calls.length, callsBeforeForeignHistory);
  await adapter.send({ referenceId: created.value.sourceReference.referenceId, message: 'hello', logicalOperationId: randomUUID() });
  assert.equal(calls.at(-1).params.sessionKey, created.value.sourceReference.externalSourceId);
  assert.equal(calls.at(-1).params.idempotencyKey.length > 0, true);
  const callsBeforeAttachment = calls.length;
  await assert.rejects(() => adapter.send({ referenceId: created.value.sourceReference.referenceId, message: 'unsafe', attachments: [{ path: '/fictional/private.md' }], logicalOperationId: randomUUID() }), /unsupported.*attachments/i);
  assert.equal(calls.length, callsBeforeAttachment);
  await assert.rejects(() => adapter.history({ referenceId: 'missing' }), /exact linked Session/i);
});

test('Session history withholds an explicitly mismatched authoritative identity', async () => {
  const metadata = metadataFixture();
  const reference = {
    version: 1,
    referenceId: 'session:owned',
    topicId: 'topic-session',
    sourceSystem: 'openclaw',
    sourceKind: 'session',
    externalSourceId: 'agent:main:command-center:owned',
    observedRevision: null
  };
  metadata.refs.push(reference);
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'owned-session-id', status: 'open', isPrimary: false });
  let response = { sessionKey: 'agent:main:command-center:foreign', sessionId: 'foreign-session-id', messages: ['private foreign transcript'] };
  const gateway = { request: async () => response };
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });

  for (const providerResponse of [
    response,
    { sessionKey: reference.externalSourceId, sessionId: 'foreign-session-id', messages: ['another private transcript'] }
  ]) {
    response = providerResponse;
    let caught;
    try { await adapter.history({ referenceId: reference.referenceId }); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'source-recovery');
    assert.equal(String(caught?.message).includes('private transcript'), false);
  }
});

test('Primary close is rejected and ambiguous create reconciles by exact key lookup', async () => {
  const metadata = metadataFixture();
  let createCalls = 0;
  const gateway = { request: async (method, params) => {
    if (method === 'sessions.create') { createCalls += 1; const error = new Error('delivery unknown'); error.code = 'timeout'; error.ambiguous = true; throw error; }
    if (method === 'sessions.list') return { sessions: [{ ['k' + 'ey']: params['k' + 'ey'] ?? `agent:main:command-center:${operationId}`, sessionId: 'reconciled-id' }] };
    return {};
  } };
  const operationId = randomUUID();
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  const created = await adapter.create({ logicalOperationId: operationId, isPrimary: true });
  assert.equal(created.status, 'applied');
  assert.equal(createCalls, 1);
  await assert.rejects(() => adapter.close({ referenceId: created.value.sourceReference.referenceId, logicalOperationId: randomUUID() }), /Primary Session|Primary/i);
});

test('creating a replacement Primary atomically demotes and permits closing the former Primary', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-primary-transfer-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    metadata.createTopic({ topicId: 'topic-primary-transfer', paraCategory: 'project', lifecycle: 'active' });
    const gateway = { request: async (_method, params) => ({ ['k' + 'ey']: params['k' + 'ey'], sessionId: `id:${params['k' + 'ey']}` }) };
    const adapter = createSessionAdapter({ topicId: 'topic-primary-transfer', metadata, gateway });
    const first = await adapter.create({ logicalOperationId: randomUUID(), label: 'Fictional First Primary', isPrimary: true });
    const second = await adapter.create({ logicalOperationId: randomUUID(), label: 'Fictional Replacement Primary', isPrimary: true });
    assert.equal(metadata.getSessionState(first.value.sourceReference.referenceId).isPrimary, false);
    assert.equal(metadata.getSessionState(first.value.sourceReference.referenceId).wasPrimary, true);
    assert.equal(metadata.getSessionState(first.value.sourceReference.referenceId).displayName, 'Fictional First Primary');
    assert.equal(metadata.getSessionState(second.value.sourceReference.referenceId).isPrimary, true);
    assert.equal(metadata.getSessionState(second.value.sourceReference.referenceId).displayName, 'Fictional Replacement Primary');
    assert.equal(metadata.listSessionStates().filter((state) => state.isPrimary).length, 1);
    const closed = await adapter.close({ referenceId: first.value.sourceReference.referenceId, logicalOperationId: randomUUID() });
    assert.equal(closed.value.status, 'closed');
    let dispatched = false;
    gateway.request = async () => { dispatched = true; return {}; };
    await assert.rejects(
      () => adapter.send({ referenceId: first.value.sourceReference.referenceId, message: 'must not dispatch', logicalOperationId: randomUUID() }),
      (error) => error.code === 'conflict' && /Closed Conversation/i.test(error.message)
    );
    assert.equal(dispatched, false);
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    assert.deepEqual(
      { wasPrimary: metadata.getSessionState(first.value.sourceReference.referenceId).wasPrimary, displayName: metadata.getSessionState(first.value.sourceReference.referenceId).displayName },
      { wasPrimary: true, displayName: 'Fictional First Primary' }
    );
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('close and reopen are journaled and replay without repeating metadata effects', async () => {
  const metadata = metadataFixture();
  const reference = {
    version: 1,
    referenceId: 'session:journaled',
    topicId: 'topic-session',
    sourceSystem: 'openclaw',
    sourceKind: 'session',
    externalSourceId: 'agent:main:command-center:journaled',
    observedRevision: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  metadata.refs.push(reference);
  let writes = 0;
  const originalSet = metadata.setSessionState;
  metadata.setSessionState = (value) => { writes += 1; return originalSet(value); };
  const operations = new Map();
  metadata.getOperation = (id) => operations.get(id) ?? null;
  metadata.recordOperation = (value) => { const row = { ...operations.get(value.logicalOperationId), ...value }; operations.set(value.logicalOperationId, row); return row; };
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'fictional-session', status: 'open', isPrimary: false, updatedAt: new Date().toISOString() });
  writes = 0;
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway: { request: async () => ({}) } });
  const closeId = randomUUID();
  const first = await adapter.close({ referenceId: reference.referenceId, logicalOperationId: closeId, requestId: 'transport-close-1' });
  assert.equal(first.value.status, 'closed');
  assert.equal(operations.get(closeId).state, 'applied');
  await adapter.close({ referenceId: reference.referenceId, logicalOperationId: closeId, requestId: 'transport-close-2' });
  assert.equal(writes, 1);
  const reopenId = randomUUID();
  const reopened = await adapter.reopen({ referenceId: reference.referenceId, logicalOperationId: reopenId, requestId: 'transport-open-1' });
  assert.equal(reopened.value.status, 'open');
  assert.equal(operations.get(reopenId).state, 'applied');
});

test('applied Session send replay reconciles history without redispatch', async () => {
  const metadata = metadataFixture();
  const reference = { version: 1, referenceId: 'session:send-replay', topicId: 'topic-session', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:command-center:send-replay', observedRevision: null };
  metadata.refs.push(reference);
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'send-replay-id', status: 'open', isPrimary: false });
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'chat.send') return { runId: params.idempotencyKey, status: 'started' };
    if (method === 'chat.history') return { sessionId: 'send-replay-id', messages: [{ role: 'user', __openclaw: { idempotencyKey: `${operationId}:user` } }] };
    throw new Error(`Unexpected method ${method}`);
  } };
  const operationId = randomUUID();
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  await adapter.send({ referenceId: reference.referenceId, message: 'fictional', logicalOperationId: operationId, requestId: 'send-first' });
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'send-replay-id', status: 'closed', isPrimary: false });
  const replay = await adapter.send({ referenceId: reference.referenceId, message: 'fictional', logicalOperationId: operationId, requestId: 'send-replay' });
  assert.equal(replay.value.runId, operationId);
  assert.equal(calls.filter((call) => call.method === 'chat.send').length, 1);
  assert.equal(calls.filter((call) => call.method === 'chat.history').length, 1);
});

test('applied Session create replay preserves a later Closed state', async () => {
  const metadata = metadataFixture();
  const calls = [];
  const operationId = randomUUID();
  const expectedKey = `agent:main:command-center:${operationId}`;
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'sessions.create') return { ['k' + 'ey']: expectedKey, sessionId: 'create-replay-id' };
    if (method === 'sessions.list') return { sessions: [{ ['k' + 'ey']: expectedKey, sessionId: 'create-replay-id' }] };
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  const created = await adapter.create({ logicalOperationId: operationId, requestId: 'create-first' });
  metadata.setSessionState({ referenceId: created.value.sourceReference.referenceId, sessionId: 'create-replay-id', status: 'closed', isPrimary: false });
  await adapter.create({ logicalOperationId: operationId, requestId: 'create-replay' });
  assert.equal(metadata.getSessionState(created.value.sourceReference.referenceId).status, 'closed');
  assert.equal(calls.filter((call) => call.method === 'sessions.create').length, 1);
});

test('Session create rejects logical operation reuse with changed primary or Topic intent', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-session-intent-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    metadata.createTopic({ topicId: 'topic-one', paraCategory: 'project', lifecycle: 'active' });
    metadata.createTopic({ topicId: 'topic-two', paraCategory: 'project', lifecycle: 'active' });
    const gateway = { request: async (_method, params) => ({ ['k' + 'ey']: params['k' + 'ey'], sessionId: `id:${params['k' + 'ey']}` }) };
    const operationId = randomUUID();
    await createSessionAdapter({ topicId: 'topic-one', metadata, gateway }).create({ logicalOperationId: operationId, isPrimary: false });
    await assert.rejects(
      () => createSessionAdapter({ topicId: 'topic-one', metadata, gateway }).create({ logicalOperationId: operationId, isPrimary: true }),
      (error) => error.code === 'intent-mismatch'
    );
    await assert.rejects(
      () => createSessionAdapter({ topicId: 'topic-two', metadata, gateway }).create({ logicalOperationId: operationId, isPrimary: false }),
      (error) => error.code === 'intent-mismatch'
    );
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
