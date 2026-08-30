import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSearchRebuildHttpHandler, searchRebuildRoute } from '../src/search/http-route.mjs';

const topicId = '11111111-1111-4111-8111-111111111111';

async function invoke(service, { method = 'POST', body = {}, headers = { 'content-type': 'application/json', origin: 'null' } } = {}) {
  const req = { method, headers, body };
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
  await createSearchRebuildHttpHandler(service)(req, res);
  return { statusCode: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
}

test('public search rebuild is an exact closed POST with bounded idempotent evidence', async () => {
  const calls = [];
  const service = { async searchRebuild(input) { calls.push(input); return { topicIds: [input.topicId], notes: { projectionId: 'topic-search-notes-v1' }, conversations: { projectionId: 'topic-search-conversations-v1' } }; } };
  const logicalOperationId = randomUUID();
  assert.equal(searchRebuildRoute, '/plugins/command-center/api/search/rebuild');
  assert.equal((await invoke(service, { method: 'GET' })).statusCode, 405);
  assert.equal((await invoke(service, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' } })).statusCode, 403);
  assert.equal((await invoke(service, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })).statusCode, 204);
  assert.equal((await invoke(service, { body: { schemaVersion: 1, topicId, logicalOperationId, extra: true } })).statusCode, 400);
  const applied = await invoke(service, { body: { schemaVersion: 1, topicId, logicalOperationId } });
  assert.equal(applied.statusCode, 200);
  assert.deepEqual(calls, [{ schemaVersion: 1, topicId, logicalOperationId }]);
  assert.deepEqual(applied.body, { schemaVersion: 1, status: 'applied', logicalOperationId, result: { topicId, topicIds: [topicId], projections: ['topic-search-conversations-v1', 'topic-search-notes-v1'] } });
  assert.equal(Buffer.byteLength(JSON.stringify(applied.body)) < 4096, true);
});

test('public search rebuild rejects non-canonical identities and non-opaque origins', async () => {
  const service = { async searchRebuild() { throw new Error('must not run'); } };
  assert.equal((await invoke(service, { body: { schemaVersion: 1, topicId: 'topic', logicalOperationId: randomUUID() } })).statusCode, 400);
  assert.equal((await invoke(service, { headers: { 'content-type': 'application/json', origin: 'https://fictional.invalid' }, body: { schemaVersion: 1, topicId, logicalOperationId: randomUUID() } })).statusCode, 403);
});
