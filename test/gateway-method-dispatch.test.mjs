import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestScopedGatewayRequest } from '../src/bridge/gateway-method-dispatch.mjs';
import { createSessionAdapter } from '../src/sources/sessions.mjs';

function metadataFixture() {
  const references = [];
  const states = new Map();
  return {
    createSourceReference(reference) { references.push(reference); return reference; },
    getSessionState(referenceId) { return states.get(referenceId) ?? null; },
    listSourceReferences() { return references; },
    setSessionState(state) { states.set(state.referenceId, state); return state; }
  };
}

test('request-scoped Session dispatch preserves the pinned create envelope and idempotency identity', async () => {
  const calls = [];
  const logicalOperationId = '11111111-1111-4111-8111-111111111111';
  const params = Object.freeze({ agentId: 'main', label: 'Fictional Conversation', idempotencyKey: logicalOperationId });
  const request = createRequestScopedGatewayRequest(async (...args) => {
    calls.push(args);
    return { ok: true, payload: { ok: true, key: 'agent:main:dashboard:fictional', sessionId: 'fictional-session', entry: { updatedAt: 47 } } };
  });

  const result = await request('sessions.create', params, { requestId: logicalOperationId });

  assert.deepEqual(result, { ok: true, key: 'agent:main:dashboard:fictional', sessionId: 'fictional-session', entry: { updatedAt: 47 } });
  assert.deepEqual(calls, [['sessions.create', params, { expectFinal: true, timeoutMs: 45_000 }]]);
  assert.equal(params.key, undefined);
  assert.equal(params.agentHarnessId, undefined);
});

test('request-scoped Session dispatch rejects changed operation identity and preserves host refusal', async () => {
  let dispatches = 0;
  const request = createRequestScopedGatewayRequest(async () => {
    dispatches += 1;
    return { ok: false, error: { code: 'MISSING_SCOPE', message: 'not exposed', retryable: false } };
  });
  await assert.rejects(
    () => request('sessions.create', { agentId: 'main', label: 'Fictional Conversation', idempotencyKey: '11111111-1111-4111-8111-111111111111' }, { requestId: '22222222-2222-4222-8222-222222222222' }),
    (error) => error?.code === 'invalid-request'
  );
  assert.equal(dispatches, 0);

  await assert.rejects(
    () => request('sessions.create', { agentId: 'main', label: 'Fictional Conversation', idempotencyKey: '11111111-1111-4111-8111-111111111111' }, { requestId: '11111111-1111-4111-8111-111111111111' }),
    (error) => error?.code === 'MISSING_SCOPE' && error?.retryable === false
  );
  assert.equal(dispatches, 1);
});

test('production Session adapter consumes the pinned dispatch envelope and exact catalog readback', async () => {
  const logicalOperationId = '33333333-3333-4333-8333-333333333333';
  const key = 'agent:main:dashboard:fictional-readback';
  const sessionId = 'fictional-readback-session';
  const calls = [];
  const gatewayRequest = createRequestScopedGatewayRequest(async (method, params, options) => {
    calls.push({ method, params, options });
    if (method === 'sessions.create') return { ok: true, payload: { ok: true, key, sessionId, entry: { updatedAt: 73 } } };
    if (method === 'sessions.list') return { ok: true, payload: { sessions: [{ sessionKey: key, sessionId, updatedAt: 73 }] } };
    throw new Error(`Unexpected method ${method}`);
  });
  const metadata = metadataFixture();
  const adapter = createSessionAdapter({ api: { runtime: { gateway: { async request() { throw new Error('detached Gateway must not be used'); } } } }, metadata, topicId: '44444444-4444-4444-8444-444444444444' });

  const created = await adapter.create({ logicalOperationId, label: 'Pinned Envelope' }, { gatewayRequest });

  assert.equal(created.value.key, key);
  assert.equal(created.value.sessionId, sessionId);
  assert.equal(created.value.creationRevision, '73');
  assert.equal(created.value.sourceReference.externalSourceId, key);
  assert.deepEqual(calls.map(({ method }) => method), ['sessions.create', 'sessions.list']);
  assert.deepEqual(calls[0].params, { agentId: 'main', label: 'Pinned Envelope', idempotencyKey: logicalOperationId });
  assert.deepEqual(calls[0].options, { expectFinal: true, timeoutMs: 45_000 });
});
