import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BRIDGE_CONTRACTS, validateBridgeRequest } from '../src/bridge/contracts.mjs';
import { invokeBridgeMethod, registerBridgeMethods } from '../src/bridge/register.mjs';
import { FIRST_LIVE_FEATURES } from '../src/release-scope.mjs';

const method = action => `command-center.v1.chat-capture.${action}`;
const planId = '10000000-0000-4000-8000-000000000101';
const saved = { logicalOperationId: planId, plan: { observedAt: '2026-10-01T00:00:00.000Z', processorVersion: 'fictional-v1', acceptedExtraction: { knowledgeMarkdown: 'private fictional text' }, acceptedChat: { principalId: 'fictional-private-principal' }, outcomes: [{ outcomeId: 'fictional-task', kind: 'obligation' }] }, account: { outcomes: [{ outcomeId: 'fictional-task', kind: 'obligation', status: 'missing', summary: 'private fictional summary' }] } };

test('explicit saved-plan replay forwards fresh authority and keeps unsubmitted coverage unknown', async () => {
  const runtime = { principalId: 'fictional-operator', assertCurrent() {} };
  const result = await invokeBridgeMethod({ acceptedChatCaptureReplay(input, authority) {
    assert.equal(authority, runtime);
    assert.deepEqual(input, { schemaVersion: 1, planId });
    return saved;
  } }, method('replay'), { schemaVersion: 1, logicalOperationId: randomUUID(), planId }, null, null, runtime);
  assert.equal(result.planId, planId);
  assert.equal(result.sourceCoverage, 'unknown');
  assert.equal(result.coverage, 'accepted-plan-only');
  assert.equal(result.acceptedAt, saved.plan.observedAt);
  assert.deepEqual(result.outcomes, [{ outcomeId: 'fictional-task', kind: 'obligation', status: 'missing' }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('authority lost during owner await refuses even the content-free response', async () => {
  let current = true;
  const runtime = { principalId: 'fictional-operator', assertCurrent() { if (!current) throw new Error('fictional revoked'); } };
  await assert.rejects(invokeBridgeMethod({ async acceptedChatCaptureLoad() { await Promise.resolve(); current = false; return saved; } }, method('load'), { schemaVersion: 1, planId }, null, null, runtime), /revoked/);
});

test('closed replay accepts no new extraction or serialized authority and all commands need write scope', () => {
  for (const action of ['accept', 'load', 'replay']) assert.equal(BRIDGE_CONTRACTS[method(action)].scope, 'operator.write');
  assert.throws(() => validateBridgeRequest(method('replay'), { schemaVersion: 1, logicalOperationId: randomUUID(), planId, input: { reclassify: true } }), /Unsupported/);
  assert.throws(() => validateBridgeRequest(method('load'), { schemaVersion: 1, planId, principalId: 'forged' }), /Unsupported/);
});

test('disabled candidate transport refuses before acquiring authority or owners', async () => {
  assert.equal(FIRST_LIVE_FEATURES.acceptedChatCapture, false);
  const handlers = new Map();
  registerBridgeMethods({ registerGatewayMethod(name, handler) { handlers.set(name, handler); } }, new Proxy({}, { get() { throw new Error('must not acquire owner'); } }));
  for (const action of ['accept', 'load', 'replay']) {
    let response;
    await handlers.get(method(action))({ req: { id: 'fictional-transport' }, params: { schemaVersion: 1 }, context: { authenticated: true }, respond(...args) { response = args; } });
    assert.equal(response[0], false);
    assert.equal(response[2].code, 'feature-unavailable');
  }
});
