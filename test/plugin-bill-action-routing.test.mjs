import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceServiceError } from '../src/sources/errors.mjs';

// Keep plugin registration, proxy routing, contracts and authority real. Only
// service construction is replaced; its source owner has no bill methods.
async function routingPlugin() {
  const url = new URL('../src/plugin.mjs', import.meta.url);
  const factory = `data:text/javascript;base64,${Buffer.from('export const createMetadataService = api => api.routingFixtureOwner;').toString('base64')}`;
  const source = (await readFile(url, 'utf8'))
    .replace("import { createMetadataService } from './plugin-service.mjs';", `import { createMetadataService } from '${factory}';`)
    .replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => {
      const resolved = specifier.startsWith('.') ? new URL(specifier, url).href
        : specifier.startsWith('data:') ? specifier : import.meta.resolve(specifier);
      return `from ${quote}${resolved}${quote}`;
    });
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
}

const loopId = 'fictional-routing-bill';
const logicalOperationId = '10000000-0000-4000-8000-000000000102';
const inputs = {
  list: { schemaVersion: 1 },
  read: { schemaVersion: 1, loopId },
  admit: { schemaVersion: 1, loopId, logicalOperationId, tenantId: 'fictional-routing', boardId: 'default' },
  handle: { schemaVersion: 1, loopId, logicalOperationId, expectedUpdatedAt: 100.25 },
  defer: { schemaVersion: 1, loopId, logicalOperationId, expectedEligibilityRevision: 3,
    reviewAt: '2026-10-08T23:00:00.000Z', timeZone: 'Australia/Brisbane', offsetMinutes: 600 },
  reconcile: { schemaVersion: 1, loopId, logicalOperationId }
};

async function fixture() {
  let current = true, hostChecks = 0;
  const calls = [], nativeCalls = [], handlers = new Map();
  const client = { connId: 'fictional-routing-connection', authenticatedOperatorId: 'fictional-routing-operator',
    connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } };
  const sessionMutationAuthorization = { assertCurrent() {
    hostChecks += 1;
    if (!current) throw new SourceServiceError('unauthenticated', 'Fictional host authority revoked.');
  } };
  const context = {
    authenticated: true,
    getClientConnIds: predicate => new Set(current && predicate(client) ? [client.connId] : []),
    getGatewayMethodRegistry: () => ({ getHandler: method => async request => {
      nativeCalls.push({ method, request });
      request.sessionMutationCommitGuard();
      request.respond(true, { cards: [] });
    } })
  };
  const owner = { sourceService: Object.freeze({}) };
  for (const action of Object.keys(inputs)) {
    owner[`billActions${action[0].toUpperCase()}${action.slice(1)}`] = async function(input, runtime) {
      const call = { action, input, runtime, receiver: this };
      calls.push(call);
      runtime.assertCurrent();
      call.nativeResult = await runtime.nativeRequest('workboard.cards.list', { boardId: 'default' });
      throw new SourceServiceError('conflict', `Fictional ${action} owning-route sentinel.`);
    };
  }
  const plugin = await routingPlugin();
  plugin.register({ pluginConfig: {}, routingFixtureOwner: owner,
    registerHttpRoute() {}, registerTool() {}, registerService(value) { assert.equal(value, owner); },
    registerGatewayMethod(method, handler, options) { handlers.set(method, { handler, options }); }
  });
  return { calls, nativeCalls, handlers, owner, client, sessionMutationAuthorization, hostChecks: () => hostChecks,
    revoke() { current = false; },
    async invoke(action) {
      let response;
      await handlers.get(`command-center.v1.bill-actions.${action}`).handler({
        req: { id: 'fictional-routing-transport' }, params: inputs[action], client, context, sessionMutationAuthorization,
        respond(ok, payload, error) { response = { ok, payload, error }; }
      });
      return response;
    }
  };
}

for (const action of Object.keys(inputs)) {
  test(`activated plugin routes bill ${action} to its service owner with request authority`, async () => {
    const value = await fixture();
    assert.equal(value.handlers.get(`command-center.v1.bill-actions.${action}`).options.scope,
      ['list', 'read'].includes(action) ? 'operator.read' : 'operator.write');
    const response = await value.invoke(action);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'conflict');
    assert.equal(response.error.message, `Fictional ${action} owning-route sentinel.`);
    assert.equal(value.calls.length, 1); assert.equal(value.calls[0].action, action);
    assert.deepEqual(value.calls[0].input, { ...inputs[action], requestId: 'fictional-routing-transport' });
    assert.equal(value.calls[0].receiver, value.owner);
    assert.equal(value.calls[0].runtime.principalId, value.client.authenticatedOperatorId);
    assert.equal(value.calls[0].runtime.canWrite, true);
    assert.equal(typeof value.calls[0].runtime.assertCurrent, 'function');
    assert.deepEqual(value.calls[0].nativeResult, { cards: [] });
    assert.equal(value.nativeCalls.length, 1); assert.equal(value.nativeCalls[0].method, 'workboard.cards.list');
    assert.equal(value.nativeCalls[0].request.client, value.client);
    assert.equal(value.nativeCalls[0].request.sessionMutationAuthorization, value.sessionMutationAuthorization);
    assert.equal(typeof value.nativeCalls[0].request.sessionMutationCommitGuard, 'function');
    assert.ok(value.hostChecks() > 0);
  });
}

test('activated bill routing refuses revoked host authority before service or native dispatch', async () => {
  const value = await fixture();
  value.revoke();
  const response = await value.invoke('admit');
  assert.equal(response.ok, false); assert.equal(response.error.code, 'unauthenticated');
  assert.equal(value.calls.length, 0); assert.equal(value.nativeCalls.length, 0);
});
