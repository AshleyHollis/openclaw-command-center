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

test('private Dashboard handlers expose no opaque CORS bypass', async () => {
  const service = { dashboard: { get: async () => ({}) }, dashboardUpdateSettings: async () => ({}) };
  for (const handler of [createDashboardReadHttpHandler(service), createDashboardActionsHttpHandler(service)]) {
    const result = await invoke(handler, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } });
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
  }
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
