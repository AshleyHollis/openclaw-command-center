import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createRequestScopedConversationRuntime } from '../src/bridge/gateway-method-dispatch.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

// Native accepted-source/media admission is real. The filesystem identity
// provider is the existing explicit ext4 CI fixture, not Btrfs qualification.
const linux = { skip: process.platform !== 'linux' && 'The real Note descriptor boundary requires Linux.' };
const bytes = Buffer.from('%PDF-1.4\nFictional original\n%%EOF\n');

async function fixture(t, beforeAtomicCommit) {
  const sdk = await import('openclaw/plugin-sdk/session-transcript-runtime');
  assert.equal(sdk.ACCEPTED_SESSION_ATTACHMENT_ADMISSION_VERSION, 1, 'PR67 packaged native SDK is required; pinned26a9 is insufficient.');
  assert.equal(sdk.ACCEPTED_SESSION_ATTACHMENT_MAX_BYTES, 5 * 1024 * 1024);
  const nativeStore = await import('openclaw/plugin-sdk/session-store-runtime');
  const nativeSqlite = await import('openclaw/plugin-sdk/sqlite-runtime');
  const nativeTesting = await import(new URL('./sqlite-runtime-testing.js', process.env.COMMAND_CENTER_TEST_SESSION_TRANSCRIPT_RUNTIME).href);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'filing-native-admission-'));
  const prior = { state: process.env.OPENCLAW_STATE_DIR, config: process.env.OPENCLAW_CONFIG_PATH };
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
      await nativeTesting.closeOpenClawAgentDatabasesAsync();
      await nativeTesting.closeOpenClawStateDatabaseAsync();
    } finally {
      release();
      if (prior.state === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prior.state;
      if (prior.config === undefined) delete process.env.OPENCLAW_CONFIG_PATH; else process.env.OPENCLAW_CONFIG_PATH = prior.config;
      await rm(directory, { recursive: true, force: true });
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

test('real native admission joins Note publication, synchronous Session readback, atomic receipt and Check result', linux, async t => {
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

for (const change of ['principal', 'session', 'media']) test(`real admission refuses ${change} retired after Note staging`, linux, async t => {
  let f;
  f = await fixture(t, async () => {
    if (change === 'principal') f.scope.client.authenticatedUserProfile = { profileId: 'fictional-other-principal' };
    if (change === 'session') await f.nativeStore.upsertSessionEntry({ ...f.identity, entry: { sessionId: 'fictional-replaced', updatedAt: 20 } });
    if (change === 'media') { await rename(f.mediaPath, `${f.mediaPath}.retired`); await writeFile(f.mediaPath, bytes); }
  });
  await assert.rejects(() => f.service.documents.filePreparedAttachment(f.input, f.runtime));
  assert.ok((await readdir(path.join(f.root, 'Documents'))).every(name => name.startsWith('.')));
  assert.equal(f.metadata.getTopicOperation(f.input.logicalOperationId).state, 'unknown');
});

test('native completed publication followed by response loss retains causal Check without another file effect', linux, async t => {
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
