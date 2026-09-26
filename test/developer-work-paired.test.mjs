import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttentionService } from '../src/attention/service.mjs';
import { createDeveloperEventHandler, developerEventRoute } from '../src/developer-work/http-route.mjs';
import { createDeveloperEventTransport, createDeveloperWorkProducer } from '../src/developer-work/producer.mjs';
import { createDeveloperWorkService } from '../src/developer-work/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const capabilities = { notes: false, sessions: false, scheduler: false, activity: true, analysis: false, attention: true, search: false };
const authority = { producerId: 'sample-dev', role: 'worker', allowedProjects: ['sample-project'] };
const credential = 'fictional-machine-credential-with-enough-entropy-123456789';
const session = { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'session-1', lifecycleRevision: 'lifecycle-1' };

test('separate DEV and LIVE stores survive a lost response without duplicating Attention', async () => {
  const devDir = await mkdtemp(path.join(os.tmpdir(), 'cc-paired-dev-'));
  const liveDir = await mkdtemp(path.join(os.tmpdir(), 'cc-paired-live-'));
  const dev = openCommandCenterMetadataService({ stateDir: devDir, capabilities });
  const live = openCommandCenterMetadataService({ stateDir: liveDir, capabilities });
  const attention = createAttentionService({ metadata: live, now: () => '2026-09-26T11:00:00.000Z' });
  const receiver = createDeveloperWorkService({ metadata: live, attention, devBaseUrl: 'https://dev.example.test/ui' });
  const receiverEnv = { SAMPLE_DEV_BEARER: credential };
  const handler = createDeveloperEventHandler({ service: receiver, principals: [{ ...authority, tokenEnv: 'SAMPLE_DEV_BEARER', families: ['human-request'] }], env: receiverEnv });
  let loseFirstReply = true;
  let sends = 0;
  const transport = createDeveloperEventTransport({ baseUrl: 'https://live.example.test/ui', tokenEnv: 'SAMPLE_DEV_BEARER', env: { SAMPLE_DEV_BEARER: credential }, fetchImpl: async (url, options) => {
    sends++;
    assert.equal(url.href, `https://live.example.test/ui${developerEventRoute}`);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-developer-work-watermark'], '1');
    const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(value) { this.body = value; } };
    await handler({ method: options.method, socket: { encrypted: true }, headers: { authorization: options.headers.authorization, 'content-type': options.headers['content-type'], 'x-developer-work-watermark': options.headers['x-developer-work-watermark'] }, body: options.body }, response);
    if (loseFirstReply) { loseFirstReply = false; throw new Error('reply lost after LIVE commit'); }
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  } });
  let clock = Date.parse('2026-09-26T11:00:00.000Z');
  const producer = createDeveloperWorkProducer({ metadata: dev, authority, sessionReader: () => ({ sessionId: session.sessionId, lifecycleRevision: session.lifecycleRevision }), receiver: transport, now: () => clock });
  try {
    const operationId = randomUUID();
    const draft = { schemaVersion: 1, workId: 'sample-feature', eventType: 'feature_ready_for_review', occurredAt: '2026-09-26T10:00:00.000Z', context: { projectAlias: 'sample-project', phase: 'reviewing' }, session,
      request: { requestId: 'review-a', kind: 'review', expectedRequestRevision: 0, summary: 'Review sample feature', question: 'Is this ready?' } };
    const pending = await producer.submit({ logicalOperationId: operationId, draft });
    assert.equal(pending.deliveryState, 'pending');
    assert.equal(attention.list().episodes.length, 1);
    clock = pending.deliveryDiagnostic.nextAttemptAtMs;
    const flushed = await producer.flush();
    assert.deepEqual({ delivered: flushed.delivered, attempted: flushed.attempted, pending: flushed.pending }, { delivered: 1, attempted: 1, pending: 0 });
    assert.equal(sends, 2);
    assert.equal(attention.list().episodes.length, 1);
    assert.equal(live.listPendingDeveloperEvents({}).length, 0);
    const exact = await producer.resolve({ schemaVersion: 1, workId: 'sample-feature', requestId: 'review-a' });
    assert.equal(exact.status, 'ready');
    assert.equal(exact.sessionKey, session.sessionKey);
    assert.equal(JSON.stringify(attention.list().episodes[0]).includes(session.sessionKey), false);
    delete receiverEnv.SAMPLE_DEV_BEARER;
    const blocked = await producer.submit({ logicalOperationId: randomUUID(), draft: { ...draft, workId: 'sample-feature-two', request: { ...draft.request, requestId: 'review-b' } } });
    assert.equal(blocked.deliveryState, 'pending');
    assert.equal(attention.list().episodes.length, 1);
    receiverEnv.SAMPLE_DEV_BEARER = credential;
    assert.equal((await producer.flush({ resumePaused: true })).delivered, 1);
    assert.equal(attention.list().episodes.length, 2);
  } finally {
    producer.close(); receiver.close(); attention.close(); dev.close(); live.close();
    for (const [dir, prefix] of [[devDir, 'cc-paired-dev-'], [liveDir, 'cc-paired-live-']]) {
      if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith(prefix)) throw new Error('Refusing unsafe test cleanup path');
      await rm(dir, { recursive: true, force: true });
    }
  }
});
