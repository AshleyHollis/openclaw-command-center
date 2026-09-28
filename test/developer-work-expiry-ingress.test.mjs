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

test('separate SQLite stores carry ordered expired openings, active updates, terminals and successors through authenticated HTTP', async () => {
  const senderDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-sender-expiry-'));
  const receiverDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-receiver-expiry-'));
  const capabilities = { activity: true, attention: true };
  const sender = openCommandCenterMetadataService({ stateDir: senderDir, capabilities });
  let receiverMetadata = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities });
  let attention = createAttentionService({ metadata: receiverMetadata, now: () => '2026-09-26T10:02:00Z' });
  let receiver = createDeveloperWorkService({ metadata: receiverMetadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
  let handler = createDeveloperEventHandler({ service: receiver, principals: [principal], env: { SAMPLE_DEV_BEARER: credential } });
  let loseDispositionReply = true;
  let loseTerminalReply = true;
  let loseUpdateReply = true;
  const calls = [];
  const transport = createDeveloperEventTransport({ baseUrl: 'https://receiver.example.test/', tokenEnv: 'SAMPLE_DEV_BEARER', env: { SAMPLE_DEV_BEARER: credential }, fetchImpl: async (_url, options) => {
    const res = response();
    await handler({ method: options.method, socket: { encrypted: true }, headers: options.headers, body: options.body }, res);
    calls.push({ status: res.statusCode, mode: options.headers['x-developer-work-disposition'] ?? 'normal', code: res.body.code });
    if (options.headers['x-developer-work-disposition'] === 'expired' && loseDispositionReply) { loseDispositionReply = false; throw new Error('fictional reply lost after durable disposition'); }
    if (options.headers['x-developer-work-disposition'] === 'expired' && JSON.parse(options.body).request?.requestId === 'review-after-resolution' && loseUpdateReply) { loseUpdateReply = false; throw new Error('fictional reply lost after active update disposition'); }
    if (!options.headers['x-developer-work-disposition'] && JSON.parse(options.body).request?.requestId === 'review-current' && JSON.parse(options.body).eventType === 'request_withdrawn' && loseTerminalReply) { loseTerminalReply = false; throw new Error('fictional reply lost after accepted terminal'); }
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
    receiver = createDeveloperWorkService({ metadata: receiverMetadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
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
    // Neither a stale transition nor a disposition may close an active request.
    const activeTerminal = { ...acceptedEvent.event, eventId: randomUUID(), workRevision: 4, eventType: 'request_withdrawn', request: { requestId: 'review-current', kind: 'review', expectedRequestRevision: 3, expiresAt: '2026-09-26T10:01:00Z' }, outcome: { code: 'withdrawn', requestId: 'review-current' } };
    const expiredRefresh = { ...acceptedEvent.event, eventId: randomUUID(), workRevision: 4, request: { ...acceptedEvent.event.request, expectedRequestRevision: 3, expiresAt: '2026-09-26T10:01:00Z' } };
    const refreshResult = response();
    await handler(request(expiredRefresh), refreshResult);
    assert.equal(refreshResult.body.code, 'developer-request-expired');
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: expiredRefresh.eventId }), null);
    for (const changed of [
      { ...activeTerminal, eventId: randomUUID(), request: { ...activeTerminal.request, expectedRequestRevision: 2 } },
      { ...activeTerminal, eventId: randomUUID(), request: { ...activeTerminal.request, requestId: 'missing-review' }, outcome: { code: 'withdrawn', requestId: 'missing-review' } },
      { ...activeTerminal, eventId: randomUUID(), request: { ...activeTerminal.request, kind: 'input' } }
    ]) {
      const rejected = response();
      await handler(request(changed), rejected);
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.body.code, 'developer-request-expired');
      assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: changed.eventId }), null);
    }
    const terminalDisposition = response();
    await handler({ ...request(activeTerminal), headers: { ...request(activeTerminal).headers, 'x-developer-work-disposition': 'expired' } }, terminalDisposition);
    assert.equal(terminalDisposition.statusCode, 409);
    assert.equal(terminalDisposition.body.code, 'developer-request-conflict');
    const revokedEnv = { SAMPLE_DEV_BEARER: credential };
    const revokedHandler = createDeveloperEventHandler({ service: receiver, principals: [principal], env: revokedEnv });
    const revokedResult = response();
    await revokedHandler({ ...request(activeTerminal), body: undefined, readBody: async () => { revokedEnv.SAMPLE_DEV_BEARER = 'b'.repeat(48); return JSON.stringify(activeTerminal); } }, revokedResult);
    assert.equal(revokedResult.statusCode, 401);
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: activeTerminal.eventId }), null);
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-current' }).state, 'active');
    const activeEpisodeId = attention.list().episodes[0].episodeId;
    const terminalId = randomUUID();
    senderOwner.commit({ logicalOperationId: terminalId, draft: { ...base, occurredAt: '2026-09-26T10:02:00Z', eventType: 'request_withdrawn', request: { ...activeTerminal.request, summary: 'Expired content must not reappear' }, outcome: activeTerminal.outcome }, assertSourceCurrent() {} });
    const laterId = randomUUID();
    senderOwner.commit({ logicalOperationId: laterId, draft: { ...next, occurredAt: '2026-09-26T10:02:00Z', request: { ...next.request, requestId: 'review-after-withdrawal' } }, assertSourceCurrent() {} });
    assert.equal((await senderOwner.flush()).delivered, 0, 'lost accepted terminal reply blocks its successor');
    const pendingTerminal = sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: terminalId });
    assert.equal(pendingTerminal.deliveryState, 'pending');
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: pendingTerminal.eventId }).disposition, undefined);
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-current' }).state, 'withdrawn');
    assert.equal(attention.list().episodes.length, 0, 'late closure leaves no active human request');
    assert.equal(attention.get(activeEpisodeId).episode.state, 'Withdrawn');
    assert.equal(attention.get(activeEpisodeId).episode.evidenceFacts.summary, undefined);
    assert.equal(attention.get(activeEpisodeId).episode.evidenceFacts.requestExpiresAt, undefined);
    senderOwner.close(); receiver.close(); attention.close(); receiverMetadata.close();
    receiverMetadata = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities });
    attention = createAttentionService({ metadata: receiverMetadata, now: () => '2026-09-26T10:02:00Z' });
    receiver = createDeveloperWorkService({ metadata: receiverMetadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
    handler = createDeveloperEventHandler({ service: receiver, principals: [principal], env: { SAMPLE_DEV_BEARER: credential } });
    senderOwner = createDeveloperWorkProducer({ metadata: sender, authority, sessionReader: () => bound, receiver: transport, now: () => pendingTerminal.deliveryDiagnostic.nextAttemptAtMs });
    assert.equal((await senderOwner.flush()).delivered, 2);
    assert.equal(sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: terminalId }).receiverReceipt.disposition, undefined);
    assert.equal(calls.filter(call => call.mode === 'expired').length, 2, 'an active terminal uses ordinary acceptance, not disposition');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-withdrawal' }).state, 'active');
    assert.deepEqual(attention.list().episodes.map(episode => episode.evidenceFacts.requestId), ['review-after-withdrawal']);
    const duplicateTerminal = response();
    await handler(request(pendingTerminal.event), duplicateTerminal);
    assert.equal(duplicateTerminal.body.receipt.duplicate, true);
    const resolutionId = randomUUID();
    senderOwner.commit({ logicalOperationId: resolutionId, draft: { ...base, occurredAt: '2026-09-26T10:02:00Z', eventType: 'request_resolved', request: { requestId: 'review-after-withdrawal', kind: 'review', expectedRequestRevision: 5, expiresAt: '2026-09-26T10:01:00Z' }, outcome: { code: 'reviewed', requestId: 'review-after-withdrawal' } }, assertSourceCurrent() {} });
    const finalId = randomUUID();
    senderOwner.commit({ logicalOperationId: finalId, draft: { ...next, occurredAt: '2026-09-26T10:02:00Z', request: { ...next.request, requestId: 'review-after-resolution' } }, assertSourceCurrent() {} });
    assert.equal((await senderOwner.flush()).delivered, 2);
    assert.equal(sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: resolutionId }).receiverReceipt.disposition, undefined);
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-withdrawal' }).state, 'resolved');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-resolution' }).state, 'active');
    assert.deepEqual(attention.list().episodes.map(episode => episode.evidenceFacts.requestId), ['review-after-resolution']);
    const activeUpdate = { ...next, occurredAt: '2026-09-26T10:02:00Z', request: { ...next.request, requestId: 'review-after-resolution', expectedRequestRevision: 7, summary: 'Expired update must never reach Attention', expiresAt: '2026-09-26T10:01:00Z' } };
    const badUpdate = { ...activeUpdate, eventId: randomUUID(), workRevision: 8, request: { ...activeUpdate.request, expectedRequestRevision: 6 } };
    const badResponse = response();
    await handler({ ...request(badUpdate), headers: { ...request(badUpdate).headers, 'x-developer-work-disposition': 'expired' } }, badResponse);
    assert.equal(badResponse.statusCode, 409);
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: badUpdate.eventId }), null);
    const deniedHandler = createDeveloperEventHandler({ service: receiver, principals: [{ ...principal, families: ['request-terminal'] }], env: { SAMPLE_DEV_BEARER: credential } });
    const denied = response();
    await deniedHandler({ ...request(badUpdate), headers: { ...request(badUpdate).headers, 'x-developer-work-disposition': 'expired' } }, denied);
    assert.equal(denied.statusCode, 403);
    const revokedEnv2 = { SAMPLE_DEV_BEARER: credential };
    const revokedHandler2 = createDeveloperEventHandler({ service: receiver, principals: [principal], env: revokedEnv2 });
    const revoked2 = response();
    await revokedHandler2({ ...request(badUpdate), body: undefined, headers: { ...request(badUpdate).headers, 'x-developer-work-disposition': 'expired' }, readBody: async () => { revokedEnv2.SAMPLE_DEV_BEARER = 'b'.repeat(48); return JSON.stringify(badUpdate); } }, revoked2);
    assert.equal(revoked2.statusCode, 401);
    const changedPrincipal = { ...principal, allowedProjects: [...principal.allowedProjects] };
    const changedHandler = createDeveloperEventHandler({ service: receiver, principals: [changedPrincipal], env: { SAMPLE_DEV_BEARER: credential } });
    const changedResult = response();
    await changedHandler({ ...request(badUpdate), body: undefined, headers: { ...request(badUpdate).headers, 'x-developer-work-disposition': 'expired' }, readBody: async () => { changedPrincipal.allowedProjects = [...changedPrincipal.allowedProjects, 'another-project']; return JSON.stringify(badUpdate); } }, changedResult);
    assert.equal(changedResult.statusCode, 401);
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: badUpdate.eventId }), null);
    const updateId = randomUUID();
    senderOwner.commit({ logicalOperationId: updateId, draft: activeUpdate, assertSourceCurrent() {} });
    const resolvedId = randomUUID();
    senderOwner.commit({ logicalOperationId: resolvedId, draft: { ...base, occurredAt: '2026-09-26T10:02:00Z', eventType: 'request_resolved', request: { requestId: 'review-after-resolution', kind: 'review', expectedRequestRevision: 8 }, outcome: { code: 'reviewed', requestId: 'review-after-resolution' } }, assertSourceCurrent() {} });
    const afterUpdateId = randomUUID();
    senderOwner.commit({ logicalOperationId: afterUpdateId, draft: { ...next, occurredAt: '2026-09-26T10:02:00Z', request: { ...next.request, requestId: 'review-after-update' } }, assertSourceCurrent() {} });
    assert.equal((await senderOwner.flush()).delivered, 0, 'lost update disposition reply blocks terminal and successor');
    const pendingUpdate = sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: updateId });
    assert.equal(pendingUpdate.deliveryState, 'pending');
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: authority.producerId, eventId: pendingUpdate.eventId }).dispositionReason, 'expired-active-update');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-resolution' }).state, 'active');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-resolution' }).revision, 8);
    assert.deepEqual(attention.list().episodes.map(episode => episode.evidenceFacts.requestId), ['review-after-resolution']);
    assert.equal(attention.list().episodes.some(episode => JSON.stringify(episode).includes('Expired update must never reach Attention')), false);
    senderOwner.close(); receiver.close(); attention.close(); receiverMetadata.close();
    receiverMetadata = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities });
    attention = createAttentionService({ metadata: receiverMetadata, now: () => '2026-09-26T10:02:00Z' });
    receiver = createDeveloperWorkService({ metadata: receiverMetadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
    handler = createDeveloperEventHandler({ service: receiver, principals: [principal], env: { SAMPLE_DEV_BEARER: credential } });
    senderOwner = createDeveloperWorkProducer({ metadata: sender, authority, sessionReader: () => bound, receiver: transport, now: () => pendingUpdate.deliveryDiagnostic.nextAttemptAtMs });
    assert.equal((await senderOwner.flush()).delivered, 3);
    assert.equal(sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: updateId }).receiverReceipt.dispositionReason, 'expired-active-update');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-work', requestId: 'review-after-resolution' }).state, 'resolved');
    assert.deepEqual(attention.list().episodes.map(episode => episode.evidenceFacts.requestId), ['review-after-update']);
  } finally {
    senderOwner.close(); receiver.close(); attention.close(); sender.close(); receiverMetadata.close();
    await rm(senderDir, { recursive: true, force: true }); await rm(receiverDir, { recursive: true, force: true });
  }
});

test('metadata-only disposition survives process death before any HTTP or producer acknowledgement', { timeout: 20_000 }, async () => {
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
      assert.deepEqual(metadata.listPendingDeveloperEvents({}), []);
      assert.equal(attention.list().episodes.length, 0);
      const event = { schemaVersion: 1, eventId: randomUUID(), workId: 'crash-feature', workRevision: 2, eventType: 'feature_ready_for_review', occurredAt: '2026-09-26T10:02:00Z', context: { projectAlias: 'sample-project' }, session: { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'fictional-session', lifecycleRevision: 'fictional-lifecycle' }, request: { requestId: 'crash-current', kind: 'review', expectedRequestRevision: 0, summary: 'Review current fictional feature', question: 'Is it ready?' } };
      assert.equal((await work.accept({ producerId, role: 'worker', allowedProjects: ['sample-project'], event, assertAuthorityCurrent() {} })).workRevision, 2);
      assert.equal(attention.list().episodes.length, 1);
    } finally { work.close(); attention.close(); metadata.close(); }
  } finally {
    if (!closed) { child.kill('SIGKILL'); await exit; }
    await rm(stateDir, { recursive: true, force: true });
  }
});

// A separate child owns the receiver SQLite store and real loopback HTTP
// listener. Only that child can commit the disposition before being killed.
async function startHttpReceiver(stateDir, mode) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/developer-work-http-receiver-child.mjs', import.meta.url)), stateDir, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let stderr = '';
  let closed = false;
  const watchers = new Set();
  child.stdout.on('data', data => { output += String(data); for (const check of watchers) check(); });
  child.stderr.on('data', data => { stderr += String(data); });
  const exited = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  const waitFor = marker => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); watchers.delete(check); child.off('close', died); child.off('error', died); };
    const check = () => { if (output.includes(marker)) { cleanup(); resolve(output); } };
    const died = () => { cleanup(); reject(new Error('HTTP receiver died before ' + marker + ': ' + stderr.slice(0, 500))); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('HTTP receiver timed out before ' + marker + ': ' + stderr.slice(0, 500))); }, 10_000);
    watchers.add(check);
    child.once('close', died);
    child.once('error', died);
    check();
  });
  try {
    const ready = await waitFor('ready:');
    const port = Number(ready.match(/ready:(\d+)/)?.[1]);
    if (!Number.isInteger(port) || port < 1) throw new Error('HTTP receiver did not announce a port');
    return { child, port, waitFor, exited, isClosed: () => closed, stderr: () => stderr };
  } catch (error) { if (!closed) child.kill('SIGKILL'); await exited; throw error; }
}

test('authenticated HTTP disposition survives receiver SIGKILL before producer acknowledgement and ordered retry', { timeout: 30_000 }, async () => {
  const senderDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-http-crash-sender-'));
  const receiverDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-http-crash-receiver-'));
  const sender = openCommandCenterMetadataService({ stateDir: senderDir, capabilities: { activity: true, attention: true } });
  const authority = { producerId: principal.producerId, role: 'worker', allowedProjects: principal.allowedProjects };
  const bound = { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'crash-session', lifecycleRevision: 'crash-lifecycle' };
  const base = { schemaVersion: 1, workId: 'crash-work', occurredAt: '2026-09-26T10:00:00Z', context: { projectAlias: 'sample-project' }, session: bound };
  const drafts = [
    { ...base, eventType: 'feature_ready_for_review', request: { requestId: 'crash-expired', kind: 'review', expectedRequestRevision: 0, summary: 'Fictional expired request', question: 'Review?', expiresAt: '2026-09-26T10:01:00Z' } },
    { ...base, eventType: 'request_withdrawn', request: { requestId: 'crash-expired', kind: 'review', expectedRequestRevision: 1 }, outcome: { code: 'withdrawn', requestId: 'crash-expired' } },
    { ...base, eventType: 'feature_ready_for_review', request: { requestId: 'crash-current', kind: 'review', expectedRequestRevision: 0, summary: 'Fictional current request', question: 'Review?' } }
  ];
  const ids = drafts.map(() => randomUUID());
  let crashed, restarted, producer;
  let port;
  const statuses = [];
  const transport = createDeveloperEventTransport({ baseUrl: 'https://receiver.example.test/', tokenEnv: 'SAMPLE_DEV_BEARER', env: { SAMPLE_DEV_BEARER: credential }, fetchImpl: async (url, options) => {
    // Real HTTP over loopback through the route's explicit trusted-proxy
    // branch, not an in-process handler call or a claim of wire-level TLS.
    const result = await fetch('http://127.0.0.1:' + port + new URL(url).pathname, { ...options, headers: { ...options.headers, 'x-forwarded-proto': 'https' } });
    statuses.push([options.headers['x-developer-work-disposition'] ?? 'normal', result.status]);
    return result;
  } });
  try {
    crashed = await startHttpReceiver(receiverDir, 'hold');
    port = crashed.port;
    producer = createDeveloperWorkProducer({ metadata: sender, authority, sessionReader: () => bound, receiver: transport, now: () => Date.parse('2026-09-26T10:02:00Z') });
    for (const [index, draft] of drafts.entries()) producer.commit({ logicalOperationId: ids[index], draft, assertSourceCurrent(expected) { assert.deepEqual(expected, bound); } });
    const committedSignal = crashed.waitFor('disposition-committed');
    const firstFlush = producer.flush();
    await committedSignal;
    assert.equal(crashed.child.kill('SIGKILL'), true);
    await crashed.exited;
    assert.deepEqual({ delivered: (await firstFlush).delivered, pending: sender.listPendingDeveloperDeliveries({ producerId: authority.producerId }).length }, { delivered: 0, pending: 3 });
    const pending = sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: ids[0] });
    assert.equal(pending.deliveryState, 'pending');
    const afterKill = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities: { activity: true, attention: true } });
    try {
      assert.equal(afterKill.getDeveloperReceipt({ producerId: authority.producerId, eventId: pending.eventId }).dispositionReason, 'request-expired');
      assert.equal(afterKill.getDeveloperRequest({ producerId: authority.producerId, workId: 'crash-work', requestId: 'crash-expired' }), null);
      assert.equal(afterKill.getDeveloperReceipt({ producerId: authority.producerId, eventId: sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: ids[1] }).eventId }), null);
    } finally { afterKill.close(); }
    producer.close();
    restarted = await startHttpReceiver(receiverDir, 'normal');
    port = restarted.port;
    producer = createDeveloperWorkProducer({ metadata: sender, authority, sessionReader: () => bound, receiver: transport, now: () => pending.deliveryDiagnostic.nextAttemptAtMs });
    assert.deepEqual({ delivered: (await producer.flush()).delivered, pending: sender.listPendingDeveloperDeliveries({ producerId: authority.producerId }).length }, { delivered: 3, pending: 0 });
    assert.deepEqual(ids.map(id => sender.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: id }).receiverReceipt.dispositionReason ?? 'accepted'), ['request-expired', 'expired-dependency', 'accepted']);
    assert.deepEqual(statuses, [['normal', 400], ['normal', 200], ['normal', 409], ['expired', 200], ['normal', 200]], 'duplicate opening receipt replays via ordinary HTTP, while the dependent terminal needs disposition');
    const afterReplay = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities: { activity: true, attention: true } });
    const attention = createAttentionService({ metadata: afterReplay, now: () => '2026-09-26T10:02:00Z' });
    try {
      assert.equal(afterReplay.getDeveloperRequest({ producerId: authority.producerId, workId: 'crash-work', requestId: 'crash-expired' }), null);
      assert.equal(afterReplay.getDeveloperRequest({ producerId: authority.producerId, workId: 'crash-work', requestId: 'crash-current' }).state, 'active');
      assert.deepEqual(attention.list().episodes.map(row => row.evidenceFacts.requestId), ['crash-current']);
    } finally { attention.close(); afterReplay.close(); }
  } finally {
    producer?.close();
    sender.close();
    for (const child of [crashed, restarted]) if (child && !child.isClosed()) { child.child.kill('SIGKILL'); await child.exited; }
    await rm(senderDir, { recursive: true, force: true });
    await rm(receiverDir, { recursive: true, force: true });
  }
});

test('controller rollback and recovery refresh sanitized Attention and retain ordered Activity through projection replay', async () => {
  const senderDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-controller-sender-'));
  const receiverDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-controller-receiver-'));
  const capabilities = { activity: true, attention: true };
  const sender = openCommandCenterMetadataService({ stateDir: senderDir, capabilities });
  let receiverMetadata = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities });
  let attention = createAttentionService({ metadata: receiverMetadata, now: () => '2026-09-26T10:02:00Z' });
  let failRollbackProjection = false;
  const recordingMetadata = { ...receiverMetadata, markDeveloperEventProjected(input) {
    if (failRollbackProjection) throw new Error('fictional Activity projection marker unavailable');
    return receiverMetadata.markDeveloperEventProjected(input);
  } };
  let receiver = createDeveloperWorkService({ metadata: recordingMetadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
  const controller = { producerId: 'sample-controller', role: 'controller', allowedProjects: ['sample-project'] };
  const controllerPrincipal = { ...controller, tokenEnv: 'SAMPLE_DEV_BEARER', families: ['deployment-control', 'request-terminal'] };
  let handler = createDeveloperEventHandler({ service: receiver, principals: [controllerPrincipal], env: { SAMPLE_DEV_BEARER: credential } });
  const httpCalls = [];
  const transport = createDeveloperEventTransport({ baseUrl: 'https://receiver.example.test/', tokenEnv: 'SAMPLE_DEV_BEARER', env: { SAMPLE_DEV_BEARER: credential }, fetchImpl: async (_url, options) => {
    const res = response();
    await handler({ method: options.method, socket: { encrypted: true }, headers: options.headers, body: options.body }, res);
    httpCalls.push([options.headers['x-developer-work-disposition'] ?? 'normal', res.statusCode, res.body.code ?? res.body.receipt?.projectionState]);
    return new Response(JSON.stringify(res.body), { status: res.statusCode, headers: res.headers });
  } });
  let producer = createDeveloperWorkProducer({ metadata: sender, authority: controller, sessionReader: () => undefined, receiver: transport, now: () => Date.parse('2026-09-26T10:02:00Z') });
  const base = { schemaVersion: 1, workId: 'incident-work', occurredAt: '2026-09-26T10:00:00Z', context: { projectAlias: 'sample-project', deploymentId: 'deployment-1' } };
  const incident = (eventType, revision, summary, expiresAt, code) => ({ ...base, eventType,
    request: { requestId: 'incident-1', kind: 'deployment-incident', expectedRequestRevision: revision, summary, ...(expiresAt ? { question: 'Expired private question', choices: ['expired-choice'], expiresAt } : {}) },
    outcome: { code, deploymentId: 'deployment-1' }
  });
  const openingId = randomUUID(), rollbackId = randomUUID(), recoveryId = randomUUID();
  try {
    producer.commit({ logicalOperationId: openingId, draft: incident('production_deployment_failed', 0, 'Initial incident', undefined, 'failed') });
    assert.equal((await producer.flush()).delivered, 1);
    assert.equal(receiverMetadata.isDeveloperWorkNotificationReady({ producerId: controller.producerId, workId: base.workId }), true);
    const [initialEpisode] = attention.list().episodes;
    assert.equal(initialEpisode.state, 'Active');
    assert.equal(initialEpisode.sourceRevision, '1');
    assert.equal(initialEpisode.evidenceFacts.summary, 'Initial incident');
    producer.commit({ logicalOperationId: rollbackId, draft: incident('production_rollback', 1, 'Expired rollback text', '2026-09-26T10:01:00Z', 'rolled-back') });
    producer.commit({ logicalOperationId: recoveryId, draft: incident('production_recovered', 2, 'Expired recovery text', '2026-09-26T10:01:00Z', 'recovered') });
    failRollbackProjection = true;
    assert.deepEqual({ delivered: (await producer.flush()).delivered, pending: sender.listPendingDeveloperDeliveries({ producerId: controller.producerId }).length }, { delivered: 0, pending: 2 });
    const rollback = sender.getDeveloperProducerEvent({ producerId: controller.producerId, logicalOperationId: rollbackId });
    assert.equal(rollback.deliveryState, 'pending');
    const pendingReceipt = receiverMetadata.getDeveloperReceipt({ producerId: controller.producerId, eventId: rollback.eventId });
    assert.equal(pendingReceipt.dispositionReason, 'expired-active-update');
    assert.equal(pendingReceipt.projectionState, 'pending');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: controller.producerId, workId: base.workId, requestId: 'incident-1' }).revision, 2);
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: controller.producerId, eventId: sender.getDeveloperProducerEvent({ producerId: controller.producerId, logicalOperationId: recoveryId }).eventId }), null);
    assert.equal(receiverMetadata.isDeveloperWorkNotificationReady({ producerId: controller.producerId, workId: base.workId }), false);
    const [rollbackEpisode] = attention.list().episodes;
    assert.equal(rollbackEpisode.episodeId, initialEpisode.episodeId, 'the existing incident episode advances despite marker failure');
    assert.equal(rollbackEpisode.sourceRevision, '2');
    assert.equal(rollbackEpisode.state, 'Active', 'the source request remains active until an explicit resolution');
    assert.equal(rollbackEpisode.evidenceFacts.eventType, 'production_rollback');
    assert.equal(rollbackEpisode.evidenceFacts.outcome, 'rolled-back');
    for (const field of ['summary', 'question', 'choices', 'requestExpiresAt']) assert.equal(Object.hasOwn(rollbackEpisode.evidenceFacts, field), false, field + ' must be sanitized');
    assert.equal(attention.listActivity({ limit: 30 }).records.filter(row => row.operationKind === 'developer-work.production_rollback').length, 1, 'Activity is durable even if its projection marker fails');
    assert.equal(httpCalls.at(-1)[1], 503);
    producer.close();
    producer = createDeveloperWorkProducer({ metadata: sender, authority: controller, sessionReader: () => undefined, receiver: transport, now: () => rollback.deliveryDiagnostic.nextAttemptAtMs });
    assert.deepEqual({ delivered: (await producer.flush()).delivered, pending: sender.listPendingDeveloperDeliveries({ producerId: controller.producerId }).length }, { delivered: 0, pending: 2 }, 'duplicate pending disposition must remain retryable');
    const repeated = sender.getDeveloperProducerEvent({ producerId: controller.producerId, logicalOperationId: rollbackId });
    assert.equal(repeated.deliveryDiagnostic.paused, false);
    assert.equal(repeated.deliveryDiagnostic.attemptCount, 2);
    assert.deepEqual(httpCalls.at(-1).slice(0, 2), ['normal', 503]);
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: controller.producerId, eventId: rollback.eventId }).projectionState, 'pending');
    assert.equal(attention.list().episodes[0].revision, rollbackEpisode.revision, 'duplicate projection does not create another occurrence');
    assert.equal(attention.listActivity({ limit: 30 }).records.filter(row => row.operationKind === 'developer-work.production_rollback').length, 1, 'retry must not duplicate recorded Activity');
    producer.close(); receiver.close(); attention.close(); receiverMetadata.close();
    receiverMetadata = openCommandCenterMetadataService({ stateDir: receiverDir, capabilities });
    attention = createAttentionService({ metadata: receiverMetadata, now: () => '2026-09-26T10:02:00Z' });
    receiver = createDeveloperWorkService({ metadata: receiverMetadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
    handler = createDeveloperEventHandler({ service: receiver, principals: [controllerPrincipal], env: { SAMPLE_DEV_BEARER: credential } });
    producer = createDeveloperWorkProducer({ metadata: sender, authority: controller, sessionReader: () => undefined, receiver: transport, now: () => repeated.deliveryDiagnostic.nextAttemptAtMs });
    assert.deepEqual({ delivered: (await producer.flush()).delivered, pending: sender.listPendingDeveloperDeliveries({ producerId: controller.producerId }).length }, { delivered: 2, pending: 0 });
    for (const id of [rollbackId, recoveryId]) {
      const row = sender.getDeveloperProducerEvent({ producerId: controller.producerId, logicalOperationId: id });
      assert.equal(row.receiverReceipt.dispositionReason, 'expired-active-update');
      assert.equal(row.receiverReceipt.projectionState, 'projected');
    }
    assert.equal(receiverMetadata.getDeveloperReceipt({ producerId: controller.producerId, eventId: rollback.eventId }).acceptedAt, pendingReceipt.acceptedAt, 'Activity replay did not change the durable admission');
    const recovery = sender.getDeveloperProducerEvent({ producerId: controller.producerId, logicalOperationId: recoveryId });
    const incidentActivity = receiverMetadata.listActivity().filter(row => ['developer-work.production_rollback', 'developer-work.production_recovered'].includes(row.operationKind));
    assert.deepEqual(incidentActivity.map(row => [row.operationKind, row.transportRequestId, row.observedRevision, row.outcome]).sort((a, b) => a[0].localeCompare(b[0])), [
      ['developer-work.production_recovered', recovery.eventId, '3', 'applied'],
      ['developer-work.production_rollback', rollback.eventId, '2', 'applied']
    ]);
    assert.deepEqual(attention.listActivity({ limit: 30 }).records.filter(row => row.operationKind.startsWith('developer-work.production_')).map(row => row.operationKind).sort(), ['developer-work.production_deployment_failed', 'developer-work.production_recovered', 'developer-work.production_rollback']);
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: controller.producerId, workId: base.workId, requestId: 'incident-1' }).revision, 3);
    assert.equal(receiverMetadata.isDeveloperWorkNotificationReady({ producerId: controller.producerId, workId: base.workId }), true);
    const [recoveredEpisode] = attention.list().episodes;
    assert.equal(recoveredEpisode.episodeId, initialEpisode.episodeId);
    assert.equal(recoveredEpisode.state, 'Active', 'only a separate source resolution closes the incident');
    assert.equal(recoveredEpisode.sourceRevision, '3');
    assert.equal(recoveredEpisode.evidenceFacts.eventType, 'production_recovered');
    assert.equal(recoveredEpisode.evidenceFacts.outcome, 'recovered');
    assert.equal(recoveredEpisode.evidenceFacts['failed-operation'], true, 'the incident remains an active historical failure until a source terminal event');
    for (const field of ['summary', 'question', 'choices', 'requestExpiresAt']) assert.equal(Object.hasOwn(recoveredEpisode.evidenceFacts, field), false, field + ' must be sanitized');
    assert.equal(JSON.stringify(attention.list().episodes).includes('Expired rollback text'), false);
    assert.equal(JSON.stringify(attention.list().episodes).includes('Expired recovery text'), false);
    assert.equal(JSON.stringify(attention.list().episodes).includes('expired-choice'), false);
    assert.equal(JSON.stringify(attention.list().episodes).includes('Expired private question'), false);
    assert.equal(receiverMetadata.listPendingDeveloperEvents({}).length, 0);
    const resolutionId = randomUUID();
    producer.commit({ logicalOperationId: resolutionId, draft: { ...base, eventType: 'request_resolved',
      request: { requestId: 'incident-1', kind: 'deployment-incident', expectedRequestRevision: 3 },
      outcome: { code: 'recovered', requestId: 'incident-1', deploymentId: 'deployment-1' }
    } });
    assert.equal((await producer.flush()).delivered, 1);
    assert.equal(attention.list().episodes.length, 0, 'a distinct source terminal event closes the incident');
    assert.equal(attention.get(initialEpisode.episodeId).episode.state, 'Resolved');
    assert.equal(receiverMetadata.getDeveloperRequest({ producerId: controller.producerId, workId: base.workId, requestId: 'incident-1' }).state, 'resolved');
    assert.equal(receiverMetadata.isDeveloperWorkNotificationReady({ producerId: controller.producerId, workId: base.workId }), true);
  } finally {
    producer.close(); receiver.close(); attention.close(); sender.close(); receiverMetadata.close();
    await rm(senderDir, { recursive: true, force: true }); await rm(receiverDir, { recursive: true, force: true });
  }
});
