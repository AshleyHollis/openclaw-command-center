import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createDashboardActionsHttpHandler } from '../src/dashboard/http-route.mjs';

const input = { schemaVersion: 1, action: 'settings.update', logicalOperationId: '11111111-1111-4111-8111-111111111111', expectedRevision: 1, settings: { quietHoursStart: '界'.repeat(11_000) } };
for (const representation of ['object', 'string', 'readBody', 'bytes', 'string-stream']) test(`HTTP byte limit rejects oversized UTF-8 before dispatch: ${representation}`, async () => {
  let calls = 0;
  const json = JSON.stringify(input);
  assert.ok(json.length < 32_768 && Buffer.byteLength(json) > 32_768);
  const req = representation === 'bytes' ? Readable.from([Buffer.from(json)]) : representation === 'string-stream' ? Readable.from([json]) : {};
  Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json' } });
  if (representation === 'object') req.body = input;
  if (representation === 'string') req.body = json;
  if (representation === 'readBody') req.readBody = async () => json;
  const res = { setHeader() {}, end(body) { this.body = body; } };
  await createDashboardActionsHttpHandler({ async dashboardUpdateSettings() { calls++; return {}; } })(req, res);
  assert.equal(calls, 0); assert.equal(res.statusCode, 400);
});
