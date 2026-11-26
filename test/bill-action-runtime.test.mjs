import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real registered handler with an isolated candidate policy. The
// production release policy remains sealed and bill actions remain disabled.
async function candidateBridge() {
  const registerUrl = new URL('../src/bridge/register.mjs', import.meta.url);
  const policyUrl = new URL('../src/release-scope.mjs', import.meta.url);
  const absoluteImports = (source, base) => source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, relative) => `from ${quote}${new URL(relative, base).href}${quote}`);
  const policy = absoluteImports((await readFile(policyUrl, 'utf8')).replace('billActions: false', 'billActions: true'), policyUrl);
  const policyModule = `data:text/javascript;base64,${Buffer.from(policy).toString('base64')}`;
  const register = absoluteImports(await readFile(registerUrl, 'utf8'), registerUrl)
    .replace(policyUrl.href, policyModule);
  return import(`data:text/javascript;base64,${Buffer.from(register).toString('base64')}`);
}

function connection() {
  let current = true;
  const client = { connId: 'fictional-connection', authenticatedOperatorId: 'fictional-operator',
    connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } };
  const context = {
    authenticated: true,
    getClientConnIds: predicate => new Set(current && predicate(client) ? [client.connId] : []),
    getGatewayMethodRegistry: () => ({ getHandler: method => async request => {
      assert.equal(method, 'workboard.cards.list');
      assert.equal(request.client, client);
      assert.equal(typeof request.sessionMutationCommitGuard, 'function');
      request.sessionMutationCommitGuard();
      request.respond(true, { cards: [] });
    } }),
  };
  return { client, context, revoke: () => { current = false; } };
}

async function invokeDashboard(service, connectionValue) {
  const { registerBridgeMethods } = await candidateBridge();
  const handlers = new Map();
  registerBridgeMethods({ registerGatewayMethod: (method, handler) => handlers.set(method, handler) }, service);
  let response;
  await handlers.get('command-center.v1.dashboard.get')({
    req: { id: 'fictional-request' }, params: { schemaVersion: 1, activityOffset: 0, activityLimit: 20 },
    client: connectionValue.client, context: connectionValue.context,
    respond: (ok, payload, error) => { response = { ok, payload, error }; },
  });
  return response;
}

test('enabled candidate dashboard retains bill authority and native transport alongside scheduler gateway', async () => {
  const value = connection();
  const result = await invokeDashboard({ dashboardGet: async (_input, runtime) => {
    assert.equal(runtime.principalId, 'fictional-operator');
    assert.equal(runtime.canWrite, true);
    assert.equal(typeof runtime.assertCurrent, 'function');
    assert.equal(typeof runtime.gateway.request, 'function');
    assert.deepEqual(await runtime.nativeRequest('workboard.cards.list', { boardId: 'fictional-board' }), { cards: [] });
    return { schemaVersion: 1, serverTime: '2026-10-05T23:00:00Z',
      billActions: { schemaVersion: 1, rows: [], total: 0, offset: 0, limit: 50,
        coverage: 'bound-actions-only', unavailableCount: 0, observedAt: '2026-10-05T23:00:00Z' } };
  } }, value);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.payload.result.billActions.rows, []);
});

test('revocation after dashboard owner returns suppresses source-bearing bridge publication', async () => {
  const value = connection();
  const result = await invokeDashboard({ dashboardGet: (_input, runtime) => {
    runtime.assertCurrent();
    value.revoke();
    return { schemaVersion: 1, billActions: { schemaVersion: 1, rows: [{ schemaVersion: 1,
      loopId: 'fictional-loop', topicId: 'fictional-topic', source: { kind: 'note',
        topicId: 'fictional-topic', referenceId: 'fictional-note', path: 'bills/BILL-101.md', revision: 'v1' } }] } };
  } }, value);
  assert.equal(result.ok, false);
  assert.equal(result.payload, null);
  assert.match(JSON.stringify(result.error), /unauthenticated|no longer available/);
  assert.equal(JSON.stringify(result.error).includes('bills/BILL-101.md'), false);
});
