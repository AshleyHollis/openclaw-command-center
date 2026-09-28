import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeveloperEventHandler } from '../src/developer-work/http-route.mjs';
import { createDeveloperWorkService } from '../src/developer-work/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const credential = 'a'.repeat(48);
const principal = { producerId: 'sample-dev', role: 'worker', tokenEnv: 'SAMPLE_DEV_BEARER', allowedProjects: ['sample-project'], families: ['human-request'] };
function response() { return { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(value) { this.body = value ? JSON.parse(value) : null; } }; }
function request(body) { return { method: 'POST', socket: { encrypted: true }, headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body }; }

test('authenticated ingress rejects expired evidence with no receiver writes; expiry remains optional', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-http-expiry-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { activity: true, attention: true } });
  const developer = createDeveloperWorkService({ metadata, attention: { registerSourceCapability() {}, async ingest() { throw new Error('fictional projection held'); } }, now: () => Date.parse('2026-09-26T10:01:00Z') });
  const handler = createDeveloperEventHandler({ service: developer, principals: [principal], env: { SAMPLE_DEV_BEARER: credential } });
  const event = { schemaVersion: 1, eventId: randomUUID(), workId: 'sample-work', workRevision: 1, eventType: 'feature_ready_for_review', occurredAt: '2026-09-26T10:00:00Z', context: { projectAlias: 'sample-project' }, session: { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'sample-session', lifecycleRevision: 'sample-lifecycle' }, request: { requestId: 'review-a', kind: 'review', expectedRequestRevision: 0, summary: 'Review fictional work', question: 'Is it ready?', expiresAt: '2026-09-26T10:01:00Z' } };
  try {
    const expired = response();
    await handler(request(event), expired);
    assert.equal(expired.statusCode, 400);
    assert.equal(expired.body.code, 'developer-request-expired');
    assert.equal(metadata.getDeveloperReceipt({ producerId: principal.producerId, eventId: event.eventId }), null);
    assert.equal(metadata.getDeveloperRequest({ producerId: principal.producerId, workId: event.workId, requestId: event.request.requestId }), null);
    assert.deepEqual(metadata.listPendingDeveloperEvents({}), []);
    const accepted = response();
    await handler(request({ ...event, request: { ...event.request, expiresAt: undefined } }), accepted);
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.body.receipt.workRevision, 1, 'rejected ingress did not advance the receiver cursor');
  } finally { developer.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});
