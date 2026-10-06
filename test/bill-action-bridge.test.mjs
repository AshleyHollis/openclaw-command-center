import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBridgeRequest, sanitizeBridgeResult, BRIDGE_CONTRACTS } from '../src/bridge/contracts.mjs';
import { invokeBridgeMethod, createAuthenticatedCoreGateway } from '../src/bridge/register.mjs';
import { FIRST_LIVE_COMMANDS, FIRST_LIVE_FEATURES } from '../src/release-scope.mjs';

const logicalOperationId = '10000000-0000-4000-8000-000000000101';
const loopId = 'fictional-BILL-101';
const method = action => `command-center.v1.bill-actions.${action}`;

test('bill actions preserve original native CAS and immutable operation identity through the bridge', async () => {
  const input = { schemaVersion: 1, loopId, logicalOperationId, expectedUpdatedAt: 1791234000000.125 };
  const runtime = { principalId: 'fictional-operator', assertCurrent() {} };
  const service = { billActionsHandle(params, authority) {
    assert.equal(authority, runtime);
    assert.equal(params.expectedUpdatedAt, input.expectedUpdatedAt);
    assert.equal(params.logicalOperationId, logicalOperationId);
    return { ...input, action: 'handle', state: 'applied', outcome: 'handled-observed', actorId: 'private-actor', cardId: 'private-native-id' };
  } };
  const value = await invokeBridgeMethod(service, method('handle'), input, 'transport-101', null, runtime);
  assert.equal(value.outcome, 'handled-observed');
  assert.equal(value.action, 'handle');
  assert.equal(value.actorId, undefined);
  assert.equal(value.cardId, undefined);
});

test('read envelope retains exact source, saved nullable eligibility and supported native history only', () => {
  const value = sanitizeBridgeResult(method('read'), { schemaVersion: 1, loopId, native: { status: 'done', updatedAt: 100,
    events: [{ id: 'event-101', kind: 'status_changed', at: 100, fromStatus: 'todo', toStatus: 'done', sessionKey: 'private-session', runId: 'private-run' }] },
    eligibility: { revision: 0, reviewAt: null, timeZone: null, offsetMinutes: null, eligible: false },
    source: { kind: 'note', topicId: 'fictional-topic', referenceId: 'note-101', path: 'bills/BILL-101.md', revision: 'note-v1' } });
  assert.equal(value.native.events.length, 1);
  assert.equal(value.native.events[0].sessionKey, undefined);
  assert.equal(value.eligibility.reviewAt, null);
});

test('closed requests refuse serialized authority and malformed native revisions', () => {
  assert.throws(() => validateBridgeRequest(method('handle'), { schemaVersion: 1, loopId, logicalOperationId, expectedUpdatedAt: 100, assertCurrent: true }), /Unsupported/);
  assert.throws(() => validateBridgeRequest(method('handle'), { schemaVersion: 1, loopId, logicalOperationId, expectedUpdatedAt: '100' }), /number/);
  assert.equal(BRIDGE_CONTRACTS[method('defer')].scope, 'operator.write');
});

test('nested native dispatch retains the host-prepared commit guard rather than serialized params', async () => {
  let current = true;
  const guard = () => { if (!current) throw new Error('revoked'); };
  const gateway = createAuthenticatedCoreGateway({ req: { id: 'transport-101' }, client: { connect: { scopes: ['operator.write'] } },
    sessionMutationCommitGuard: guard,
    context: { getGatewayMethodRegistry: () => ({ getHandler: () => async request => {
      assert.equal(request.params.assertCurrent, undefined);
      current = false;
      request.sessionMutationCommitGuard();
      request.respond(true, { card: {} });
    } }) } });
  await assert.rejects(gateway.request('workboard.cards.update', { id: 'fictional-card', patch: { status: 'done' }, expectedUpdatedAt: 100 }), /revoked/);
});

test('new bill controls remain release-disabled pending exact native qualification', () => {
  assert.equal(FIRST_LIVE_FEATURES.billActions, false);
  for (const action of ['list', 'read', 'admit', 'handle', 'defer', 'reconcile']) assert.equal(FIRST_LIVE_COMMANDS.bridge.includes(method(action)), false);
});
