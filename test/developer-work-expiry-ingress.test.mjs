import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDeveloperEventHandler } from '../src/developer-work/http-route.mjs';
import { createDeveloperWorkService } from '../src/developer-work/service.mjs';
import { createDeveloperEventTransport, createDeveloperWorkProducer } from '../src/developer-work/producer.mjs';
import { createAttentionService } from '../src/attention/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const credential = 'a'.repeat(48);
const principal = { producerId: 'sample-dev', role: 'worker', tokenEnv: 'SAMPLE_DEV_BEARER', allowedProjects: ['sample-project'], families: ['human-request', 'request-terminal'] };
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

test('an older receiver lacking disposition authority refuses the mode explicitly', async () => {
  const handler = createDeveloperEventHandler({ service: { async accept() { throw new Error('normal acceptance must not run'); } }, principals: [principal], env: { SAMPLE_DEV_BEARER: credential } });
  const event = { schemaVersion: 1, eventId: randomUUID(), workId: 'sample-work', workRevision: 1, eventType: 'feature_ready_for_review' };
  const result = response();
  await handler({ ...request(event), headers: { ...request(event).headers, 'x-developer-work-disposition': 'expired' } }, result);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'capability-unavailable');
  const transport = createDeveloperEventTransport({ baseUrl: 'https://receiver.example.test/', tokenEnv: 'SAMPLE_DEV_BEARER', env: { SAMPLE_DEV_BEARER: credential }, fetchImpl: async (_url, options) => {
    const responseValue = response();
    await handler({ ...request(event), headers: options.headers, body: options.body }, responseValue);
    return new Response(JSON.stringify(responseValue.body), { status: responseValue.statusCode, headers: responseValue.headers });
  } });
  await assert.rejects(() => transport.disposeExpired(event, { watermark: 1 }), { code: 'receiver-disposition-unavailable' });
});

test('separate SQLite stores carry ordered expired disposition, dependent terminal and later request through authenticated HTTP', async () => {
  const senderDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-sender-expiry-'));
  const receiverDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-receiver-expiry-'));
  const capabilities = { activity: true, attention: true };
  const sender = openCommandCenterMetadataService({ stateDir: senderDir, capabilities });
  let receiverMetadata = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities });
  let attention = createAttentionService({ metadata: receiverMetadata, now: () => '2026-09-26T10:02:00Z' });
  let receiver = createDeveloperWorkService({ metadata: receiverMetadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
  let handler = createDeveloperEventHandler({ service: receiver, principals: [principal], env: { SAMPLE_DEV_BEARER: credential } });
  let loseDispositionReply = true;
  let loseClosureReply = true;
  let failClosureProjection = false;
  const calls = [];
  const transport = createDeveloperEventTransport({ baseUrl: 'https://receiver.example.test/', tokenEnv: 'SAMPLE_DEV_BEARER', env: { SAMPLE_DEV_BEARER: credential }, fetchImpl: async (_url, options) => {
    const res = response();
    await handler({ method: options.method, socket: { encrypted: true }, headers: options.headers, body: options.body }, res);
    calls.push({ status: res.statusCode, mode: options.headers['x-developer-work-disposition'] ?? 'normal', code: res.body.code });
    if (options.headers['x-developer-work-disposition'] === 'expired' && loseDispositionReply) { loseDispositionReply = false; throw new Error('fictional reply lost after durable disposition'); }
    if (options.headers['x-developer-work-disposition'] === 'expired' && JSON.parse(options.body).request?.requestId === 'review-current' && loseClosureReply) { loseClosureReply = false; throw new Error('fictional reply lost after durable terminal closure'); }
    return new Response(JSON.stringify(res.body), { status: res.statusCode, headers: res.headers });
  } });
  const bound = { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'sample-session', lifecycleRevision: 'sample-lifecycle' };
  const authority = { producerId: principal.producerId, role: 'worker', allowedProjects: principal.allowedProjects };
  let senderOwner = createDeveloperWorkProducer({ metadata: sender, authority, sessionReader: () => bound, receiver: transport, now: () => Date.parse('2026-09-26T10:02:00Z') });
  const base = { schemaVersion: 1, workId: 'sample-work', occurredAt: '2026-09-26T10:00:00Z', context: { projectAlias: 'sample-project' }, session: bound };
  const opening = { ...base, eventType: 'feature_ready_for_review', request: { requestId: 'review-expired', kind: 'review', expectedRequestRevision: 0, summary: 'Review fictional result', question: 'Is it ready?', expiresAt: '2026-09-26T10:01:00Z' } };
  const dependent = { ...base, eventType: 'request_withdrawn', request: { requestId: 'review-expired', kind: 'review', expectedRequestRevision: 1 }, outcome: { code: 'withdrawn', requestId: 'review-expired' } };
  const next = { ...base, eventType: 'feature_ready_for_review', request: { requestId: 'review-current', kind: 'review', expectedRequestRevision: 0, summary: 'Review current result', question: 'Is this ready?' } };
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  try {
    for (const [index, draft] of [opening, dependent, next].entries()) senderOwner.commit({ logicalOperationId: ids[index], draft, assertSourceCurrent(expected) { assert.deepEqual(expected, bound); } });
    const first = await senderOwner.flush();
    assert.deepEqual({ delivered: first.delivered, attempted: first.attempted, pending: first.pending }, { delivered: 0, attempted: 1, pending: 3 }, 'lost disposition reply blocks successors');
    const initial = sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: ids[0] });
    assert.equal(initial.deliveryDiagnostic.lastErrorCode, 'receiver-unavailable', JSON.stringify({ first, calls, diagnostic: initial.deliveryDiagnostic }));
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-expired' }), null);
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: initial.eventId })?.disposition, 'expired', JSON.stringify(calls));
    assert.equal(attention.list().episodes.length, 0);
    senderOwner.close(); receiver.close(); attention.close(); receiverMetadata.close();
    receiverMetadata = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities });
    attention = createAttentionService({ metadata: receiverMetadata, now: () => '2026-09-26T10:02:00Z' });
    receiver = createDeveloperWorkService({ metadata: receiverMetadata, attention: {
      registerSourceCapability: value => attention.registerSourceCapability(value),
      ingest: occurrence => failClosureProjection && occurrence.transitionEvidence?.state === 'withdrawn' ? Promise.reject(new Error('fictional Attention outage')) : attention.ingest(occurrence)
    }, now: () => Date.parse('2026-09-26T10:02:00Z') });
    handler = createDeveloperEventHandler({ service: receiver, principals: [principal], env: { SAMPLE_DEV_BEARER: credential } });
    senderOwner = createDeveloperWorkProducer({ metadata: sender, authority, sessionReader: () => bound, receiver: transport, now: () => initial.deliveryDiagnostic.nextAttemptAtMs });
    const retried = await senderOwner.flush();
    assert.deepEqual({ delivered: retried.delivered, pending: retried.pending }, { delivered: 3, pending: 0 }, JSON.stringify({ calls, second: sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: ids[1] }).deliveryDiagnostic }));
    assert.deepEqual(calls.map(call => [call.mode, call.status]), [['normal', 400], ['expired', 200], ['normal', 200], ['normal', 409], ['expired', 200], ['normal', 200]]);
    assert.equal(attention.list().episodes.length, 1, 'only the current request reaches Attention');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-expired' }), null);
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-current' }).state, 'active');
    assert.deepEqual(ids.map(id => sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: id }).receiverReceipt.disposition ?? 'accepted'), ['expired', 'expired', 'accepted']);
    const disposed = sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: ids[0] });
    const duplicate = response();
    await handler(request(disposed.event), duplicate);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.body.receipt.disposition, 'expired');
    assert.equal(duplicate.body.receipt.duplicate, true);
    const tampered = response();
    await handler(request({ ...disposed.event, occurredAt: '2026-09-26T10:00:01Z' }), tampered);
    assert.equal(tampered.statusCode, 409);
    assert.equal(tampered.body.code, 'developer-event-conflict');
    const disposedReplay = response();
    await handler({ ...request(disposed.event), headers: { ...request(disposed.event).headers, 'x-developer-work-disposition': 'expired' } }, disposedReplay);
    assert.equal(disposedReplay.body.receipt.duplicate, true);
    const changedDisposition = response();
    await handler({ ...request({ ...disposed.event, occurredAt: '2026-09-26T10:00:01Z' }), headers: { ...request(disposed.event).headers, 'x-developer-work-disposition': 'expired' } }, changedDisposition);
    assert.equal(changedDisposition.statusCode, 409);
    const unauthorized = response();
    await handler({ ...request(disposed.event), headers: { ...request(disposed.event).headers, authorization: 'Bearer ' + 'b'.repeat(48), 'x-developer-work-disposition': 'expired' } }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);
    const acceptedEvent = sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: ids[2] });
    const reclassify = response();
    await handler({ ...request(acceptedEvent.event), headers: { ...request(acceptedEvent.event).headers, 'x-developer-work-disposition': 'expired' } }, reclassify);
    assert.equal(reclassify.statusCode, 409);
    assert.equal(reclassify.body.code, 'developer-event-conflict');
    const premature = { ...acceptedEvent.event, eventId: randomUUID(), workRevision: 4, request: { ...acceptedEvent.event.request, requestId: 'not-expired', expiresAt: '2026-09-26T11:00:00Z' } };
    const prematureResult = response();
    await handler({ ...request(premature), headers: { ...request(premature).headers, 'x-developer-work-disposition': 'expired' } }, prematureResult);
    assert.equal(prematureResult.statusCode, 400);
    assert.equal(prematureResult.body.code, 'developer-request-disposition-invalid');
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: premature.eventId }), null);
    const terminalId = randomUUID();
    senderOwner.commit({ logicalOperationId: terminalId, draft: { ...base, occurredAt: '2026-09-26T10:02:00Z', eventType: 'request_withdrawn', request: { requestId: 'review-current', kind: 'review', expectedRequestRevision: 3, expiresAt: '2026-09-26T10:01:00Z' }, outcome: { code: 'withdrawn', requestId: 'review-current' } }, assertSourceCurrent() {} });
    const laterId = randomUUID();
    senderOwner.commit({ logicalOperationId: laterId, draft: { ...next, occurredAt: '2026-09-26T10:02:00Z', request: { ...next.request, requestId: 'review-after-closure' } }, assertSourceCurrent() {} });
    const activeTerminal = sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: terminalId }).event;
    const refusedTerminal = response();
    await handler(request(activeTerminal), refusedTerminal);
    assert.equal(refusedTerminal.body.code, 'developer-request-expired');
    failClosureProjection = true;
    assert.equal((await senderOwner.flush()).delivered, 0, 'lost closure receipt blocks its successor');
    let closedReceipt = receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: activeTerminal.eventId });
    assert.equal(closedReceipt.dispositionReason, 'expired-terminal-closure');
    assert.equal(closedReceipt.projectionState, 'pending', 'an Attention outage does not pretend terminal projection succeeded');
    const closurePending = sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: terminalId });
    assert.equal(closurePending.deliveryState, 'pending');
    senderOwner.close();
    senderOwner = createDeveloperWorkProducer({ metadata: sender, authority, sessionReader: () => bound, receiver: transport, now: () => closurePending.deliveryDiagnostic.nextAttemptAtMs });
    assert.equal((await senderOwner.flush()).delivered, 2);
    assert.equal(sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: terminalId }).receiverReceipt.dispositionReason, 'expired-terminal-closure');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-current' }).state, 'withdrawn');
    assert.equal(receiverMetadata.isDeveloperWorkNotificationReady({ producerId: authority.producerId, workId: 'sample-work' }), false);
    failClosureProjection = false;
    await receiver.drain();
    closedReceipt = receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: activeTerminal.eventId });
    assert.equal(closedReceipt.projectionState, 'projected');
    assert.equal(receiverMetadata.isDeveloperWorkNotificationReady({ producerId: authority.producerId, workId: 'sample-work' }), true);
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-closure' }).state, 'active');
    assert.equal(attention.list().episodes.filter(episode => episode.evidenceFacts?.requestId === 'review-current').every(episode => !JSON.stringify(episode).includes('2026-09-26T10:01:00Z')), true, 'closure projects no expired request content');
    const duplicateClosure = response();
    await handler(request(activeTerminal), duplicateClosure);
    assert.equal(duplicateClosure.body.receipt.duplicate, true);
    assert.equal(duplicateClosure.body.receipt.dispositionReason, 'expired-terminal-closure');
    const wrongRevision = { ...activeTerminal, eventId: randomUUID(), workRevision: 6, eventType: 'request_resolved', request: { requestId: 'review-after-closure', kind: 'review', expectedRequestRevision: 4, expiresAt: '2026-09-26T10:01:00Z' }, outcome: { code: 'reviewed', requestId: 'review-after-closure' } };
    const wrongRevisionResult = response();
    await handler({ ...request(wrongRevision), headers: { ...request(wrongRevision).headers, 'x-developer-work-disposition': 'expired' } }, wrongRevisionResult);
    assert.equal(wrongRevisionResult.statusCode, 409);
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: wrongRevision.eventId }), null);
    const resolutionId = randomUUID();
    senderOwner.commit({ logicalOperationId: resolutionId, draft: { ...base, occurredAt: '2026-09-26T10:02:00Z', eventType: 'request_resolved', request: { requestId: 'review-after-closure', kind: 'review', expectedRequestRevision: 5, expiresAt: '2026-09-26T10:01:00Z' }, outcome: { code: 'reviewed', requestId: 'review-after-closure' } }, assertSourceCurrent() {} });
    const afterResolutionId = randomUUID();
    senderOwner.commit({ logicalOperationId: afterResolutionId, draft: { ...next, occurredAt: '2026-09-26T10:02:00Z', request: { ...next.request, requestId: 'review-after-resolution' } }, assertSourceCurrent() {} });
    assert.equal((await senderOwner.flush()).delivered, 2);
    assert.equal(sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: resolutionId }).receiverReceipt.dispositionReason, 'expired-terminal-closure');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-closure' }).state, 'resolved');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-resolution' }).state, 'active');
  } finally {
    senderOwner.close(); receiver.close(); attention.close(); sender.close(); receiverMetadata.close();
    await rm(senderDir, { recursive: true, force: true }); await rm(receiverDir, { recursive: true, force: true });
  }
});

test('disposition survives actual receiver process death before producer acknowledgement', { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-disposition-crash-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/developer-work-disposition-child.mjs', import.meta.url)), stateDir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let closed = false;
  const exit = new Promise(resolve => child.once('close', code => { closed = true; resolve(code); }));
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Disposition child timed out: ' + stderr.slice(0, 500))), 10_000);
      child.stdout.on('data', data => { if (String(data).includes('disposition-committed')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Disposition child exited early: ' + code + ' ' + stderr.slice(0, 500))); });
    });
    assert.equal(child.kill('SIGKILL'), true);
    await exit;
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { activity: true, attention: true } });
    const attention = createAttentionService({ metadata, now: () => '2026-09-26T10:02:00Z' });
    const work = createDeveloperWorkService({ metadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
    try {
      const producerId = principal.producerId;
      const eventId = 'a3c429e9-c12f-4301-a799-622852499df1';
      const receipt = metadata.getDeveloperReceipt({ producerId, eventId });
      assert.equal(receipt.disposition, 'expired');
      assert.equal(metadata.getDeveloperRequest({ producerId, workId: 'crash-feature', requestId: 'crash-expired' }), null);
      const pendingClosure = metadata.getDeveloperReceipt({ producerId, eventId: 'a3c429e9-c12f-4301-a799-622852499df3' });
      assert.equal(pendingClosure.dispositionReason, 'expired-terminal-closure');
      assert.equal(pendingClosure.projectionState, 'pending');
      assert.equal(metadata.getDeveloperRequest({ producerId, workId: 'crash-active', requestId: 'crash-active-review' }).state, 'resolved');
      assert.equal(metadata.listPendingDeveloperEvents({}).length, 2);
      assert.equal(attention.list().episodes.length, 0);
      await work.drain();
      assert.equal(metadata.getDeveloperReceipt({ producerId, eventId: 'a3c429e9-c12f-4301-a799-622852499df3' }).projectionState, 'projected');
      assert.equal(metadata.listPendingDeveloperEvents({}).length, 0);
      assert.equal(attention.list().episodes.every(episode => !JSON.stringify(episode).includes('2026-09-26T10:01:00Z')), true);
      const event = { schemaVersion: 1, eventId: randomUUID(), workId: 'crash-feature', workRevision: 2, eventType: 'feature_ready_for_review', occurredAt: '2026-09-26T10:02:00Z', context: { projectAlias: 'sample-project' }, session: { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'fictional-session', lifecycleRevision: 'fictional-lifecycle' }, request: { requestId: 'crash-current', kind: 'review', expectedRequestRevision: 0, summary: 'Review current fictional feature', question: 'Is it ready?' } };
      assert.equal((await work.accept({ producerId, role: 'worker', allowedProjects: ['sample-project'], event, assertAuthorityCurrent() {} })).workRevision, 2);
      const afterClosure = { ...event, eventId: randomUUID(), workId: 'crash-active', workRevision: 3, request: { ...event.request, requestId: 'crash-active-next' } };
      assert.equal((await work.accept({ producerId, role: 'worker', allowedProjects: ['sample-project'], event: afterClosure, assertAuthorityCurrent() {} })).workRevision, 3);
      assert.equal(attention.list().episodes.filter(episode => ['crash-current', 'crash-active-next'].includes(episode.evidenceFacts?.requestId)).length, 2);
    } finally { work.close(); attention.close(); metadata.close(); }
  } finally {
    if (!closed) { child.kill('SIGKILL'); await exit; }
    await rm(stateDir, { recursive: true, force: true });
  }
});
