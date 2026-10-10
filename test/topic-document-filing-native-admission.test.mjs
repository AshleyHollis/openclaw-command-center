import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createRequestScopedConversationRuntime } from '../src/bridge/gateway-method-dispatch.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

// Native accepted-source/media admission is real. The filesystem identity
// provider is the existing explicit ext4 CI fixture, not Btrfs qualification.
const linux = { skip: process.platform !== 'linux' && 'The real Note descriptor boundary requires Linux.' };
const bytes = Buffer.from('%PDF-1.4\nFictional original\n%%EOF\n');

// The public SDK has no database shutdown facade. Each scenario owns a process;
// its parent removes the isolated state only after all SDK handles have exited.
function nativeTest(name, options, body) {
  if (process.env.COMMAND_CENTER_NATIVE_ADMISSION_CHILD === '1') return test(name, options, body);
  return test(name, options, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'filing-native-admission-'));
    const nativeDir = path.join(directory, 'native');
    const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const env = { ...process.env, COMMAND_CENTER_NATIVE_ADMISSION_CHILD: '1', COMMAND_CENTER_NATIVE_ADMISSION_DIRECTORY: directory,
      OPENCLAW_STATE_DIR: nativeDir, OPENCLAW_CONFIG_PATH: path.join(nativeDir, 'openclaw.json') };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', '--test-name-pattern', pattern, fileURLToPath(import.meta.url)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timedOut = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60000);
    try {
      const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      assert.equal(timedOut, false, `SDK scenario timed out:\n${output}`);
      assert.equal(result.code, 0, `SDK scenario failed (${result.signal ?? result.code}):\n${output}`);
      assert.match(output, /# pass 1\n/, `The SDK child must actually execute its selected scenario:\n${output}`);
      assert.match(output, /# skipped 0\n/, `SDK admission evidence cannot be skipped:\n${output}`);
      t.diagnostic(output);
    } finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
  });
}

async function fixture(t, beforeAtomicCommit) {
  const sdk = await import('openclaw/plugin-sdk/session-transcript-runtime');
  assert.equal(sdk.ACCEPTED_SESSION_ATTACHMENT_ADMISSION_VERSION, 1, 'PR67 packaged native SDK is required; pinned26a9 is insufficient.');
  assert.equal(sdk.ACCEPTED_SESSION_ATTACHMENT_MAX_BYTES, 5 * 1024 * 1024);
  const nativeStore = await import('openclaw/plugin-sdk/session-store-runtime');
  const nativeSqlite = await import('openclaw/plugin-sdk/sqlite-runtime');
  const directory = process.env.COMMAND_CENTER_NATIVE_ADMISSION_DIRECTORY;
  assert.ok(directory, 'Scenario state must be owned by the parent process.');
  const nativeDir = path.join(directory, 'native');
  process.env.OPENCLAW_STATE_DIR = nativeDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(nativeDir, 'openclaw.json');
  const release = installHostFileAccessFixture();
  let metadata, service;
  const admissions = [];
  t.after(async () => {
    try {
      await Promise.allSettled(admissions.map(cap => cap.close()));
      for (const topic of service?.topicServices.values() ?? []) topic.notes?.close();
      metadata?.close();
    } finally {
      release();
    }
  });
  const identity = { agentId: 'main', sessionKey: 'agent:main:fictional-native-filing', sessionId: 'fictional-native-incarnation' };
  await nativeStore.upsertSessionEntry({ ...identity, entry: { sessionId: identity.sessionId, updatedAt: 10 } });
  const mediaPath = path.join(nativeDir, 'media', 'inbound', 'fictional-original.pdf');
  await mkdir(path.dirname(mediaPath), { recursive: true });
  await writeFile(mediaPath, bytes);
  const mediaRef = 'media://inbound/fictional-original.pdf';
  assert.equal((await sdk.appendSessionTranscriptMessageByIdentityStrict({ ...identity, config: {}, eventId: 'fictional-accepted', message: {
    role: 'user', content: 'Fictional attachment', __openclaw: { media: [{ url: mediaRef, fileName: 'original.pdf', contentType: 'application/pdf', sizeBytes: bytes.length }] }
  } })).kind, 'result');
  const root = path.join(directory, 'vault');
  await mkdir(root);
  metadata = openCommandCenterMetadataService({ stateDir: path.join(directory, 'cc'), capabilities: { notes: true, sessions: true } });
  const { createAuthoritativeSourceService } = await import('../src/sources/service.mjs');
  service = createAuthoritativeSourceService({ metadata, root, noteRecoveryEffects: false, beforeAtomicCommit,
    capabilities: { notes: true, sessions: true }, sessionStore: nativeStore,
    api: { runtime: { media: { loadWebMedia: async (_ref, options) => { assert.equal(options.maxBytes, 5 * 1024 * 1024); return { buffer: await readFile(mediaPath), fileName: 'original.pdf', contentType: 'application/pdf' }; } } } } });
  const topicId = 'fictional-native-filing';
  metadata.createTopic({ topicId, name: 'Fictional project', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-native-filing', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root, observedRevision: null });
  await enrollFixtureFolder(metadata, 'folder:fictional-native-filing', root);
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'session:fictional-native-filing', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: identity.sessionKey, observedRevision: '10' }, state: { referenceId: 'session:fictional-native-filing', sessionId: identity.sessionId, status: 'open', isPrimary: true } });
  const context = {};
  const scope = { pluginId: 'command-center', gatewayMethodDispatchAllowed: true,
    client: { authenticatedUserProfile: { profileId: 'fictional-principal' }, connect: { role: 'operator', scopes: ['operator.write'] } }, resolveGatewayContext: () => context };
  const request = await createRequestScopedConversationRuntime({ getRequestScope: () => scope, includeAttachmentAdmission: true });
  assert.equal(typeof request.admitAttachment, 'function');
  const runtime = { ...request.creationAuthority, admitAttachment: async input => { const cap = await request.admitAttachment(input); admissions.push(cap); return cap; } };
  const input = { topicId, sessionKey: identity.sessionKey, sessionId: identity.sessionId, logicalOperationId: '00000000-0000-4000-8000-000000000789' };
  const page = await service.documents.listAttachments({ topicId, ...identityWithoutAgent(identity) }, runtime);
  const prepared = await service.documents.prepareAttachment({ ...input, selection: page.attachments[0].selection }, runtime);
  assert.equal(prepared.canFile, true);
  return { service, metadata, runtime, input, prepared, root, mediaPath, scope, nativeStore, identity, sourcePath: nativeSqlite.resolveOpenClawAgentSqlitePath(identity) };
}

function identityWithoutAgent({ sessionKey, sessionId }) { return { sessionKey, sessionId }; }

nativeTest('real native admission joins Note publication, synchronous Session readback, atomic receipt and Check result', linux, async t => {
  const f = await fixture(t);
  const admit = f.runtime.admitAttachment;
  let effects = 0;
  f.runtime.admitAttachment = async input => {
    const cap = await admit(input);
    return { ...cap, publish: effect => cap.publish(() => {
      const peer = new DatabaseSync(f.sourcePath);
      try { peer.exec('PRAGMA busy_timeout=0'); assert.throws(() => peer.exec('BEGIN IMMEDIATE'), { errcode: 5 }); }
      finally { peer.close(); }
      effect(); effects++;
    }) };
  };
  const result = await f.service.documents.filePreparedAttachment(f.input, f.runtime);
  assert.equal(effects, 1);
  assert.equal(result.status, 'applied');
  assert.deepEqual(await readFile(path.join(f.root, result.value.document.path)), bytes);
  assert.deepEqual(await f.service.documents.checkPreparedAttachment(f.input, f.runtime), result);
  assert.equal((await f.service.documents.reopenPreparedAttachment(f.input, f.runtime)).document.referenceId, result.value.document.referenceId);
});

for (const change of ['principal', 'session', 'media']) nativeTest(`real admission refuses ${change} retired after Note staging`, linux, async t => {
  let f;
  let staged = 0;
  f = await fixture(t, async () => {
    staged++;
    if (change === 'principal') f.scope.client.authenticatedUserProfile = { profileId: 'fictional-other-principal' };
    if (change === 'session') await f.nativeStore.upsertSessionEntry({ ...f.identity, entry: { sessionId: 'fictional-replaced', updatedAt: 20 } });
    if (change === 'media') { await rename(f.mediaPath, `${f.mediaPath}.retired`); await writeFile(f.mediaPath, bytes); }
  });
  await assert.rejects(() => f.service.documents.filePreparedAttachment(f.input, f.runtime));
  assert.equal(staged, 1, 'Retirement must exercise the boundary after actual Note staging.');
  assert.ok((await readdir(path.join(f.root, 'Documents'))).every(name => name.startsWith('.')));
  assert.equal(f.metadata.getTopicOperation(f.input.logicalOperationId).state, 'unknown');
});

nativeTest('native completed publication followed by response loss retains causal Check without another file effect', linux, async t => {
  const f = await fixture(t);
  const admit = f.runtime.admitAttachment;
  let effects = 0;
  f.runtime.admitAttachment = async input => {
    const cap = await admit(input);
    return { ...cap, async publish(effect) {
      await cap.publish(() => { effect(); effects++; });
      throw Object.assign(new Error('Fictional response lost after native settlement'), { effectState: 'completed' });
    } };
  };
  await assert.rejects(() => f.service.documents.filePreparedAttachment(f.input, f.runtime), /Fictional response lost/);
  const result = await f.service.documents.checkPreparedAttachment(f.input, f.runtime);
  assert.equal(result.status, 'applied');
  assert.equal(effects, 1);
  assert.deepEqual(await readFile(path.join(f.root, result.value.document.path)), bytes);
});
