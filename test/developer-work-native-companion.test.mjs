import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNativeDeveloperSessionReader, createNativeDeveloperWorkCompanion } from '../src/developer-work/native-companion.mjs';
import { openInstalledNativeDeveloperWorkCompanion } from '../src/developer-work/native-library.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { existsSync, readFileSync } from 'node:fs';

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

test('raw local SDK read cannot enable submission without host lifecycle admission', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-native-companion-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  let companion;
  let localReads = 0;
  const options = { metadata, authority,
    gatewayRequest: async () => ({ session: { key: session.sessionKey, agentId: session.agentId, sessionId: session.sessionId }, lifecycleRevision: session.lifecycleRevision }),
    chatBaseUrl: 'https://code.invalid/ui/' };
  try {
    assert.throws(() => createNativeDeveloperWorkCompanion({ ...options,
      localSource: { binding: session, getSessionEntry() { localReads++; return { sessionId: session.sessionId, lifecycleRevision: session.lifecycleRevision }; } }
    }), /host lifecycle admission/);
    assert.equal(localReads, 0);
    companion = createNativeDeveloperWorkCompanion(options);
    assert.equal(companion.submit, undefined);
    assert.equal((await companion.chatTarget(target)).reason, 'request-missing');
    assert.equal(metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId: target.workId, requestId: target.requestId }), null);
    assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }), []);
    companion.close(); metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    companion = createNativeDeveloperWorkCompanion({ ...options, metadata });
    assert.equal((await companion.chatTarget(target)).reason, 'request-missing');
    assert.deepEqual(metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId }), []);
  } finally { companion?.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
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
    function makeCompanionWithBadBase() { return createNativeDeveloperWorkCompanion({ metadata, authority, gatewayRequest, chatBaseUrl: 'https://code.invalid/ui/?query=fictional' }); }
  } finally {
    companion?.close(); metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});


test('companion export names a fixed built library, not the runtime plugin', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.exports, { './native-developer-work-companion': './dist/developer-work/native-library.mjs' });
  assert.notEqual(pkg.exports['./native-developer-work-companion'], pkg.openclaw.extensions[0]);
});

test('sealed library prepares the fixed ledger before admission and exposes no standalone submission', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-installed-companion-'));
  const installation = { stateDir, sourceEnvironment: 'fictional-code', producerId: authority.producerId,
    role: authority.role, allowedProjects: authority.allowedProjects };
  const gatewayRequest = async () => ({ session: { key: session.sessionKey, agentId: session.agentId, sessionId: session.sessionId }, lifecycleRevision: session.lifecycleRevision });
  const make = () => openInstalledNativeDeveloperWorkCompanion({ installation, gatewayRequest, chatBaseUrl: 'https://code.invalid/ui/' });
  let companion;
  try {
    assert.throws(() => openInstalledNativeDeveloperWorkCompanion({ installation: { ...installation, modulePath: 'caller-chosen.mjs' }, gatewayRequest, chatBaseUrl: 'https://code.invalid/ui/' }), /fixed installation-owned/);
    companion = make();
    assert.equal(existsSync(resolveCommandCenterDatabasePath(stateDir)), true, 'ledger is opened before any held callback');
    assert.equal(companion.sourceEnvironment, 'fictional-code');
    assert.equal(companion.submit, undefined);
    assert.equal(companion.commit, undefined);
    assert.equal((await companion.chatTarget(target)).reason, 'request-missing');
    const logicalOperationId = randomUUID();
    const evidence = draft('2030-01-01T00:00:00Z');
    assert.equal(companion.reconcile({ logicalOperationId, draft: evidence }), null, 'absence does not execute');
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    let committed;
    try { committed = metadata.submitDeveloperWork({ authority, logicalOperationId, draft: evidence }); }
    finally { metadata.close(); }
    assert.deepEqual(companion.reconcile({ logicalOperationId, draft: evidence }), committed);
    assert.throws(() => companion.reconcile({ logicalOperationId, draft: { ...evidence, workId: 'different' } }), { code: 'developer-producer-conflict' });
    assert.equal((await companion.chatTarget(target)).status, 'ready');
    companion.close();
    assert.throws(() => companion.reconcile({ logicalOperationId, draft: evidence }), { code: 'producer-closed' });
    companion = make();
    assert.deepEqual(companion.reconcile({ logicalOperationId, draft: evidence }), committed);
  } finally { companion?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
