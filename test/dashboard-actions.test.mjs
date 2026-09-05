import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDashboardActionsHttpHandler, createDashboardReadHttpHandler } from '../src/dashboard/http-route.mjs';

function response() { return { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; } }; }
async function invoke(handler, { method = 'GET', url = '/', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); Object.assign(req, { method, url, headers });
  const res = response(); await handler(req, res); return { statusCode: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
}

function assertOpaquePreflight(result, method, headers) {
  assert.equal(result.statusCode, 204);
  assert.equal(result.body, null);
  assert.equal(result.headers['Access-Control-Allow-Origin'], 'null');
  assert.equal(result.headers['Access-Control-Allow-Methods'], `${method}, OPTIONS`);
  assert.equal(result.headers['Access-Control-Allow-Headers'], headers);
  assert.equal(result.headers['Access-Control-Allow-Private-Network'], 'true');
  assert.equal(result.headers['Access-Control-Allow-Credentials'], undefined);
  assert.equal(result.headers.Vary, 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network');
}

test('Dashboard read is bounded and mutation settings use only the closed POST contract', async () => {
  let reads = 0; let update;
  const service = { dashboard: { async get(input) { reads += 1; assert.equal(input.activityLimit, 50); return { schemaVersion: 1, serverTime: '2026-08-27T12:00:00.000Z', attention: [], attentionBadgeCount: 0, inProgress: [], comingUp: [], topics: [], activity: { records: [], nextOffset: null, hasMore: false }, activityOffset: 0, activityLimit: 50 }; } }, async dashboardUpdateSettings(input) { update = input; return { revision: 2 }; } };
  const read = await invoke(createDashboardReadHttpHandler(service), { method: 'GET', url: '/plugins/command-center/api/dashboard?activityLimit=50' });
  assert.equal(read.statusCode, 200); assert.equal(reads, 1);
  assert.equal((await invoke(createDashboardReadHttpHandler(service), { method: 'POST' })).statusCode, 405);
  const operation = randomUUID();
  const changed = await invoke(createDashboardActionsHttpHandler(service), { method: 'POST', headers: { 'content-type': 'application/json' }, body: { schemaVersion: 1, action: 'settings.update', logicalOperationId: operation, expectedRevision: 1, settings: { dueReminders: false } } });
  assert.equal(changed.statusCode, 200); assert.equal(update.logicalOperationId, operation);
  assert.equal(update.action, undefined);
  assert.equal((await invoke(createDashboardActionsHttpHandler(service), { method: 'POST', headers: { 'content-type': 'application/json' }, body: { schemaVersion: 1, action: 'settings.update', logicalOperationId: operation, expectedRevision: 1, settings: { dueReminders: false }, extra: true } })).statusCode, 400);
  assert.equal((await invoke(createDashboardActionsHttpHandler(service), { method: 'GET' })).statusCode, 405);
});

test('Dashboard routes admit only exact opaque-frame CORS preflights', async () => {
  let calls = 0;
  const service = { dashboard: { async get() { calls += 1; return {}; } }, async dashboardUpdateSettings() { calls += 1; return {}; } };
  const privateNetwork = { origin: 'null', 'access-control-request-private-network': 'true' };
  assertOpaquePreflight(await invoke(createDashboardReadHttpHandler(service), { method: 'OPTIONS', headers: { ...privateNetwork, 'access-control-request-method': 'GET' } }), 'GET', undefined);
  assertOpaquePreflight(await invoke(createDashboardActionsHttpHandler(service), { method: 'OPTIONS', headers: { ...privateNetwork, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }), 'POST', 'Content-Type');
  for (const request of [
    { handler: createDashboardReadHttpHandler(service), headers: { origin: 'https://example.invalid', 'access-control-request-method': 'GET' } },
    { handler: createDashboardReadHttpHandler(service), headers: { origin: 'null', 'access-control-request-method': 'POST' } },
    { handler: createDashboardActionsHttpHandler(service), headers: { origin: 'null', 'access-control-request-method': 'POST' } },
    { handler: createDashboardActionsHttpHandler(service), headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } }
  ]) assert.equal((await invoke(request.handler, { method: 'OPTIONS', headers: request.headers })).statusCode, 403);
  assert.equal((await invoke(createDashboardReadHttpHandler(service), { headers: { origin: 'https://example.invalid' } })).statusCode, 403);
  assert.equal((await invoke(createDashboardActionsHttpHandler(service), { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: {} })).statusCode, 403);
  assert.equal(calls, 0);
});

test('Dashboard read responses remain byte-bounded without widening mutation requests or receipts', async () => {
  const tooLarge = { text: 'x'.repeat(256 * 1024) };
  const read = await invoke(createDashboardReadHttpHandler({ dashboard: { get: async () => tooLarge } }));
  assert.equal(read.statusCode, 507);
  assert.equal(read.body.code, 'response-too-large');
  assert.ok(Buffer.byteLength(JSON.stringify(read.body)) < 256);
  const unicode = await invoke(createDashboardReadHttpHandler({ dashboard: { get: async () => ({ text: '界'.repeat(100_000) }) } }));
  assert.equal(unicode.statusCode, 507, 'the response ceiling counts bytes, not characters');
  let mutations = 0;
  const mutate = createDashboardActionsHttpHandler({ async dashboardUpdateSettings() { mutations += 1; return { padding: 'x'.repeat(32_768) }; } });
  const input = { schemaVersion: 1, action: 'settings.update', logicalOperationId: randomUUID(), expectedRevision: 1, settings: { dueReminders: false } };
  const oversizedRequest = await invoke(mutate, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { ...input, settings: { padding: 'x'.repeat(32_768) } } });
  assert.equal(oversizedRequest.statusCode, 400);
  assert.equal(mutations, 0);
  const oversizedReceipt = await invoke(mutate, { method: 'POST', headers: { 'content-type': 'application/json' }, body: input });
  assert.equal(oversizedReceipt.statusCode, 507);
  assert.equal(mutations, 1);
});
