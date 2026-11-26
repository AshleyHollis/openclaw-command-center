import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sessionSdk from 'openclaw/plugin-sdk/session-store-runtime';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';

// These tests write through the actual public SDK. No private JSON reader or
// synchronous list mock can hide the production wrapper's Promise contract.
async function fixture(run) {
  const parent = process.env.CC_NATIVE_FENCE_PROBE_ROOT;
  assert.ok(parent, 'Probe must own an isolated parent directory');
  let metadata, service;
  let primaryFailure;
  try {
    const storePath = path.join(parent, 'native', 'agents', 'main', 'sessions', 'sessions.json');
    await mkdir(path.dirname(storePath), { recursive: true });
    const sessionKey = 'agent:main:command-center:fictional-fence';
    const sessionId = 'fictional-original-incarnation';
    const referenceId = 'session:fictional-fence';
    const topicId = 'fictional-fence-topic';
    const scope = { agentId: 'main', sessionKey, storePath };
    const replace = async (id) => sessionSdk.upsertSessionEntry({ ...scope, entry: { sessionId: id, updatedAt: Date.now() } });
    await replace(sessionId);
    metadata = openCommandCenterMetadataService({ stateDir: path.join(parent, 'cc'), capabilities: { sessions: true } });
    metadata.createTopic({ topicId, name: 'Fictional fence', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSessionBinding({
      reference: { version: 1, referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey },
      state: { referenceId, sessionId, status: 'open', isPrimary: true, displayName: 'Fictional Conversation' }
    });
    const locatorCalls = [];
    const store = { ...sessionSdk, resolveStorePath(input, options) {
      assert.equal(input, undefined);
      assert.deepEqual(options, { agentId: 'main' });
      locatorCalls.push(options);
      return sessionSdk.resolveStorePath(storePath, options);
    } };
    const api = { runtime: { agent: { session: store } } };
    const make = (owner = metadata) => createAuthoritativeSourceService({ metadata: owner, api, capabilities: { sessions: true, notes: false, scheduler: false } });
    service = make();
    const binding = { version: 1, sessionKey, sessionId, referenceId, topicId,
      topicRevision: metadata.getTopic(topicId).revision,
      sessionReference: metadata.getSourceReference(referenceId),
      sessionState: metadata.getSessionState(referenceId),
      sessionLocator: metadata.getSourceLocator(referenceId) };
    await run({ service, metadata, store, make, binding, scope, sessionKey, sessionId, topicId, referenceId, replace, locatorCalls });
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanupFailures = [];
    for (const cleanup of [
      () => service?.close(), () => metadata?.close()
    ]) {
      try { await cleanup(); } catch (error) { cleanupFailures.push(error); }
    }
    if (cleanupFailures.length) throw new AggregateError([
      ...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures
    ], 'Native Session fixture failed or cleanup was incomplete');
  }
  if (primaryFailure) throw primaryFailure;
}

const probes = {};
probes.accepted = async f => {
  const list = f.service.forTopic(f.topicId).sessions.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true });
  assert.equal(typeof list.then, 'function');
  assert.equal((await list).find(row => row.sessionKey === f.sessionKey).entry.sessionId, f.sessionId);
  assert.equal(f.service.assertAcceptedChatBinding(f.binding), undefined);
  assert.ok(f.locatorCalls.length > 0);
  // The final fence re-reads the persisted incarnation, bypassing cached rows.
  await f.replace('fictional-replacement-incarnation');
  assert.throws(() => f.service.assertAcceptedChatBinding(f.binding), { code: 'source-recovery' });
};

probes.refusal = async f => {
  assert.equal(f.service.assertAcceptedChatBinding(f.binding), undefined);
  const resolve = f.store.resolveStorePath;
  f.store.resolveStorePath = () => undefined;
  assert.throws(() => f.service.assertAcceptedChatBinding(f.binding), { code: 'capability-unavailable' });
  f.store.resolveStorePath = resolve;
  f.metadata.setSessionState({ referenceId: f.referenceId, sessionId: 'fictional-other-durable-incarnation', status: 'open', isPrimary: true });
  assert.throws(() => f.service.assertAcceptedChatBinding(f.binding), { code: 'conflict' });
};

probes.history = async f => {
  // Isolate only the verified-history metadata view, as the existing context
  // regression does. Session storage and the host's Promise wrapper are real.
  const owner = Object.create(f.metadata);
  Object.defineProperty(owner, 'listImportedHistories', { value: () => [{ phase: 'verified',
    target: { agentId: 'main', sessionKey: f.sessionKey, sessionId: f.sessionId }, intent: { topicId: f.topicId } }] });
  const service = f.make(owner);
  try {
    const request = { schemaVersion: 1, sessionKey: f.sessionKey };
    const result = await service.sessionTopicContext(request);
    assert.deepEqual(result, { schemaVersion: 1, status: 'protected', sessionKey: f.sessionKey,
      sessionId: f.sessionId, topicId: f.topicId, name: 'Imported History' });
    await f.replace('fictional-replaced-history');
    assert.deepEqual(await service.sessionTopicContext(request), {
      schemaVersion: 1, status: 'protected-unavailable', sessionKey: f.sessionKey,
      topicId: f.topicId, name: 'Imported History' });
  } finally { service.close(); }
};

// Native shutdown/testing internals are absent from the real tarball. Each
// probe owns its SDK workers/databases in a disposable process. The parent
// removes its directory only after close confirms process/stdio settlement.
async function runProbe(name) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cc-native-fence-process-'));
  let primaryFailure;
  try {
    await mkdir(path.join(parent, 'home'));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--native-fence-probe', name], {
        env: { ...process.env, CC_NATIVE_FENCE_PROBE_ROOT: parent,
          OPENCLAW_STATE_DIR: path.join(parent, 'native-state'), HOME: path.join(parent, 'home'),
          USERPROFILE: path.join(parent, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '', childError, timedOut = false, escalation;
      const retain = data => { output = (output + data.toString()).slice(-16384); };
      child.stdout.on('data', retain); child.stderr.on('data', retain);
      child.on('error', error => { childError = error; });
      const timeout = setTimeout(() => {
        timedOut = true; child.kill('SIGTERM');
        escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
      }, 30000);
      child.once('close', (code, signal) => {
        clearTimeout(timeout); clearTimeout(escalation);
        if (childError || timedOut || code !== 0) reject(new Error(`Native fence ${name} probe failed: ${childError?.message ?? ''} timeout=${timedOut} code=${code} signal=${signal}\n${output}`));
        else resolve();
      });
    });
  } catch (error) { primaryFailure = error; }
  const cleanupFailures = [];
  try { await rm(parent, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
  if (cleanupFailures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures], 'Native Session probe cleanup failed');
  if (primaryFailure) throw primaryFailure;
}
if (process.argv[2] === '--native-fence-probe') {
  const probe = probes[process.argv[3]];
  assert.equal(typeof probe, 'function');
  try { await fixture(probe); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
} else {
  test('Accepted Chat commit fence stays synchronous over the actual public SDK', () => runProbe('accepted'));
  test('Accepted Chat public SDK fence refuses locator loss and durable ownership changes', () => runProbe('refusal'));
  test('Imported History awaits the real public SDK wrapper and protects replaced identities', () => runProbe('history'));
}
