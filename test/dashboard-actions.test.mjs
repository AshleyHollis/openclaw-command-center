import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDashboardActionsHttpHandler, createDashboardReadHttpHandler } from '../src/dashboard/http-route.mjs';

function response() { return { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; } }; }
async function invoke(handler, { method = 'GET', url = '/', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); Object.assign(req, { method, url, headers });
  const res = response(); await handler(req, res); return { statusCode: res.statusCode, body: JSON.parse(res.body) };
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
