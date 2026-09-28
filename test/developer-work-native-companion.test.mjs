import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNativeDeveloperSessionReader, createNativeDeveloperWorkCompanion } from '../src/developer-work/native-companion.mjs';

const authority = { producerId: 'fictional-code', role: 'worker', allowedProjects: ['fictional-project'] };
const session = { agentId: 'fictional-agent', sessionKey: 'agent:fictional-agent:main', sessionId: 'fictional-incarnation', lifecycleRevision: 'revision-one' };
const target = { schemaVersion: 1, workId: 'fictional-work', requestId: 'fictional-request' };
const capabilities = { notes: false, sessions: false, scheduler: false, activity: true, analysis: false, attention: true, search: false };

function draft(expiresAt) {
  return { schemaVersion: 1, workId: target.workId, eventType: 'feature_ready_for_review',
    context: { projectAlias: 'fictional-project' }, session,
    request: { requestId: target.requestId, kind: 'review', expectedRequestRevision: 0,
      summary: 'Review fictional work', question: 'Is it ready?', ...(expiresAt ? { expiresAt } : {}) } };
}

test('injected authorized sessions.describe rejects missing lifecycle, ambiguous shape and errors', async () => {
  let response = { session: { key: session.sessionKey, agentId: session.agentId, sessionId: session.sessionId }, lifecycleRevision: session.lifecycleRevision };
  const calls = [];
  const reader = createNativeDeveloperSessionReader({ request: async (...args) => { calls.push(args); return response; } });
  const input = { agentId: session.agentId, sessionKey: session.sessionKey, readConsistency: 'latest' };
  assert.deepEqual(await reader(input), session);
  assert.deepEqual(calls[0], ['sessions.describe', { key: session.sessionKey, agentId: session.agentId }]);
  for (const bad of [null, { session: response.session }, { ...response, lifecycleRevision: '' },
    { ...response, session: { key: session.sessionKey, sessionId: session.sessionId } },
    { ...response, session: { ...response.session, agentId: '' } },
    { ...response, session: { ...response.session, agentId: 'other-agent' } },
    { ...response, session: { ...response.session, key: 'agent:fictional-agent:other' } },
    { ...response, session: { ...response.session, sessionId: '' } }]) {
    response = bad;
    assert.equal(await reader(input), null);
  }
  await assert.rejects(() => reader({ ...input, readConsistency: 'cached' }), TypeError);
  await assert.rejects(() => reader({ ...input, agentId: 'other' }), TypeError);
});

test('same-machine local SDK read guards producer submission at SQLite commit', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-native-companion-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const sdkScope = { agentId: session.agentId, sessionKey: session.sessionKey, readConsistency: 'latest' };
  const live = { sessionId: session.sessionId, lifecycleRevision: session.lifecycleRevision };
  let local = () => live;
  const reads = [];
  const companion = createNativeDeveloperWorkCompanion({ metadata, authority,
    gatewayRequest: async () => ({ session: { key: session.sessionKey, agentId: session.agentId, sessionId: session.sessionId }, lifecycleRevision: session.lifecycleRevision }),
    chatBaseUrl: 'https://code.invalid/ui/',
    localSource: { binding: session, getSessionEntry(scope) { reads.push(scope); return local(); } } });
  try {
    const evidence = draft('2026-09-28T11:00:00Z');
    assert.equal(typeof companion.submit, 'function');
    await assert.rejects(() => companion.submit({ logicalOperationId: randomUUID(), draft: { ...evidence, session: { ...session, agentId: 'wrong-agent' } } }), { code: 'session-stale' });
    assert.equal(reads.length, 0, 'caller cannot select another agent before the fixed read');
    for (const changed of [undefined, { ...live, sessionId: 'replaced' },
      { ...live, lifecycleRevision: 'reset-in-place' }, { ...live, lifecycleRevision: '' }, Promise.resolve(live)]) {
      local = () => changed;
      await assert.rejects(() => companion.submit({ logicalOperationId: randomUUID(), draft: evidence }), { code: 'session-stale' });
      assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }), []);
    }
    let count = 0;
    local = () => ++count === 1 ? live : { ...live, lifecycleRevision: 'reset-in-place' };
    await assert.rejects(() => companion.submit({ logicalOperationId: randomUUID(), draft: evidence }), { code: 'session-stale' });
    assert.equal(count, 2, 'source changes between preflight and the synchronous ledger guard');
    assert.equal(metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId: evidence.workId, requestId: evidence.request.requestId }), null);
    assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }), []);
    local = () => live;
    const logicalOperationId = randomUUID();
    const result = await companion.submit({ logicalOperationId, draft: evidence });
    assert.equal(result.workRevision, 1, 'failed checks do not advance the durable cursor');
    assert.deepEqual(reads, Array.from({ length: reads.length }, () => sdkScope), 'no caller-supplied store path or identity');
    local = () => ({ ...live, lifecycleRevision: 'reset-in-place' });
    await assert.rejects(() => companion.submit({ logicalOperationId, draft: evidence }), { code: 'session-stale' });
    assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }).map(item => item.eventId), [result.eventId]);
  } finally { companion.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('companion issues a credential-free native Chat target only after durable exact request and fresh session check', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-native-companion-'));
  let metadata;
  let companion;
  let current = { session: { key: session.sessionKey, agentId: session.agentId, sessionId: session.sessionId }, lifecycleRevision: session.lifecycleRevision };
  let clock = Date.parse('2026-09-28T10:00:00Z');
  const calls = [];
  const gatewayRequest = async (method, params) => { calls.push([method, params]); return current; };
  const makeCompanion = () => createNativeDeveloperWorkCompanion({ metadata, authority, gatewayRequest, chatBaseUrl: 'https://code.invalid/ui/', now: () => clock });
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    companion = makeCompanion();
    assert.equal(companion.submit, undefined, 'an RPC-only companion cannot submit source-bound work');
    assert.equal((await companion.chatTarget(target)).reason, 'request-missing');
    metadata.submitDeveloperWork({ authority, logicalOperationId: randomUUID(), draft: draft('2026-09-28T11:00:00Z') });
    companion.close(); metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    companion = makeCompanion();
    const ready = await companion.chatTarget(target);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.requestRevision, 1);
    assert.equal(ready.url, 'https://code.invalid/ui/chat?session=agent%3Afictional-agent%3Amain');
    assert.equal(calls.length, 1);
    current = { ...current, session: { ...current.session, agentId: 'other-agent' } };
    assert.equal((await companion.chatTarget(target)).reason, 'session-replaced');
    current = { ...current, session: { ...current.session, agentId: session.agentId }, lifecycleRevision: 'revision-two' };
    assert.equal((await companion.chatTarget(target)).reason, 'session-replaced');
    current = { session: { key: session.sessionKey, agentId: session.agentId, sessionId: 'different' }, lifecycleRevision: session.lifecycleRevision };
    assert.equal((await companion.chatTarget(target)).reason, 'session-replaced');
    current = { session: { key: session.sessionKey, agentId: session.agentId, sessionId: session.sessionId }, lifecycleRevision: session.lifecycleRevision };
    clock = Date.parse('2026-09-28T11:00:00Z');
    assert.equal((await companion.chatTarget(target)).reason, 'request-expired');
    clock--;
    const pending = companion.chatTarget(target);
    clock = Date.parse('2026-09-28T11:00:00Z');
    assert.equal((await pending).reason, 'request-expired');
    clock = Date.parse('2026-09-28T10:30:00Z');
    // A withdrawn request must never acquire a Chat target, even when its session survives.
    metadata.submitDeveloperWork({ authority, logicalOperationId: randomUUID(), draft: {
      ...draft(), eventType: 'request_withdrawn', request: { ...draft().request, expectedRequestRevision: 1 },
      outcome: { code: 'withdrawn', requestId: target.requestId }
    } });
    assert.equal((await companion.chatTarget(target)).reason, 'request-ended');
    assert.throws(() => makeCompanionWithBadBase(), /credential-free/);
    function makeCompanionWithBadBase() { return createNativeDeveloperWorkCompanion({ metadata, authority, gatewayRequest, chatBaseUrl: 'https://code.invalid/ui/?token=fictional' }); }
  } finally {
    companion?.close(); metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
