import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';
import { legacyDiscordMigrationConfigDigest } from '../src/migration/config.mjs';

const fixturePath = new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url).pathname;
const config = { schemaVersion: 1, exportPath: fixturePath, channels: [{ channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-alpha', paraCategory: 'project', noteFolderPath: '/fictional/vault/alpha' }] };

function runtime() {
  const sessions = new Map();
  return {
    sessions,
    async withSessionTranscriptWriteLock(target, run) { return run({ readEvents: async () => sessions.get(target.sessionKey) ?? [], appendMessage: async (params) => { const events = sessions.get(target.sessionKey) ?? []; events.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message }); sessions.set(target.sessionKey, events); return { messageId: params.eventId, appended: true }; }, publishUpdate: async () => undefined }); },
    async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return sessions.get(sessionKey) ?? []; },
    async appendSessionTranscriptMessageByIdentityStrict(params) {
      const events = sessions.get(params.sessionKey) ?? [];
      events.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message });
      sessions.set(params.sessionKey, events);
      return { kind: 'result', result: { messageId: params.eventId, appended: true } };
    }
  };
}

test('one configured channel reconciles one provisioning Topic, Note Folder, and Primary Session', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-map-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, activity: true } });
    const calls = [];
    const gateway = { request: async (method, params) => { calls.push({ method, params }); return { ['k' + 'ey']: params.key ?? params.kay, sessionId: 'fictional-session-alpha' }; } };
    const service = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime: runtime(), folderVerifier: async () => undefined });
    const first = await service.start();
    assert.equal(first.complete, true);
    assert.equal(metadata.listTopics().length, 1);
    assert.equal(metadata.getTopic('fictional-topic-alpha').lifecycle, 'active');
    assert.equal(metadata.listSourceReferences('fictional-topic-alpha').filter((row) => row.sourceKind === 'note_folder').length, 1);
    assert.equal(metadata.listSourceReferences('fictional-topic-alpha').filter((row) => row.sourceKind === 'session').length, 1);
    assert.equal(calls.filter((call) => call.method === 'sessions.create').length, 1);
    assert.equal(metadata.listMigrationChannels().length, 0);
    assert.ok(metadata.getMigrationCompletion());
    const second = await service.start();
    assert.equal(second.complete, true);
    assert.equal(calls.filter((call) => call.method === 'sessions.create').length, 1);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('external plugin startup provisions through the public Session store runtime without trusted Gateway RPC', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-public-session-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, activity: true } });
    const entries = new Map();
    const expectedStorePath = path.join(stateDir, 'fictional-authoritative-sessions.json');
    const sessionStore = {
      resolveStorePath: () => expectedStorePath,
      listSessionEntries: ({ storePath }) => { assert.equal(storePath, expectedStorePath); return [...entries].map(([sessionKey, entry]) => ({ sessionKey, entry })); },
      getSessionEntry: ({ sessionKey, storePath }) => { assert.equal(storePath, expectedStorePath); return entries.get(sessionKey); },
      patchSessionEntry: async ({ sessionKey, storePath, fallbackEntry, update }) => {
        assert.equal(storePath, expectedStorePath);
        const existingEntry = entries.get(sessionKey);
        const next = await update(existingEntry ?? fallbackEntry, { existingEntry });
        if (!next) return null;
        entries.set(sessionKey, next);
        return next;
      }
    };
    const gateway = { request: async () => { throw new Error('external plugins cannot dispatch trusted Gateway methods'); } };
    const transcripts = runtime();
    const strictAppend = transcripts.appendSessionTranscriptMessageByIdentityStrict;
    transcripts.appendSessionTranscriptMessageByIdentityStrict = async (params) => {
      assert.equal(params.storePath, expectedStorePath);
      return strictAppend(params);
    };
    const service = createLegacyDiscordMigrationService({ metadata, config, gateway, sessionStore, transcriptRuntime: transcripts, folderVerifier: async () => undefined });

    assert.equal((await service.start()).complete, true);
    assert.equal(entries.size, 1);
    assert.equal([...entries.keys()][0], 'agent:main:command-center:legacy-discord:fictional-channel-alpha');
    assert.equal(typeof [...entries.values()][0].sessionId, 'string');
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a foreign Session claiming the deterministic key after binding persistence is never adopted', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-session-claim-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const ownershipMarker = `legacy-discord-owner:${legacyDiscordMigrationConfigDigest(config)}`;
    metadata.createMigrationTopicBinding({
      topic: { topicId: 'fictional-topic-alpha', paraCategory: 'project', lifecycle: 'provisioning' },
      reference: { version: 1, referenceId: 'migration:folder:fictional-channel-alpha', topicId: 'fictional-topic-alpha', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault/alpha', observedRevision: ownershipMarker }
    });
    metadata.createSourceReference({ version: 1, referenceId: 'migration:session:fictional-channel-alpha', topicId: 'fictional-topic-alpha', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:command-center:legacy-discord:fictional-channel-alpha', observedRevision: null });
    const foreignEntry = { sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', updatedAt: Date.now() };
    const sessionStore = {
      listSessionEntries: () => [{ sessionKey: 'agent:main:command-center:legacy-discord:fictional-channel-alpha', entry: foreignEntry }],
      getSessionEntry: () => foreignEntry,
      patchSessionEntry: async () => { throw new Error('foreign Session must fail during preflight'); }
    };
    const service = createLegacyDiscordMigrationService({ metadata, config, sessionStore, transcriptRuntime: runtime(), folderVerifier: async () => undefined });

    const result = await service.start();
    assert.equal(result.phase, 'review');
    assert.equal(metadata.getMigrationState().failureCode, 'session-conflict');
    assert.equal(metadata.getSessionState('migration:session:fictional-channel-alpha'), null);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a pre-existing unowned Note Folder Source Reference is rejected without adding a Session binding', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-folder-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    metadata.createTopic({ topicId: 'fictional-topic-existing-folder', paraCategory: 'project', lifecycle: 'provisioning' });
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-folder-reference', topicId: 'fictional-topic-existing-folder', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault/alpha', observedRevision: null });
    let sessionCreates = 0;
    const gateway = { request: async (_method, params) => { sessionCreates += 1; return { ['k' + 'ey']: params.key, sessionId: 'fictional-session-existing-folder' }; } };
    const service = createLegacyDiscordMigrationService({ metadata, config: { ...config, channels: [{ ...config.channels[0], topicId: 'fictional-topic-existing-folder' }] }, gateway, transcriptRuntime: runtime(), folderVerifier: async () => undefined });
    assert.equal((await service.start()).phase, 'review');
    const references = metadata.listSourceReferences('fictional-topic-existing-folder');
    assert.equal(references.filter((reference) => reference.sourceKind === 'note_folder').length, 1);
    assert.equal(references.find((reference) => reference.sourceKind === 'note_folder').referenceId, 'fictional-folder-reference');
    assert.equal(references.filter((reference) => reference.sourceKind === 'session').length, 0);
    assert.equal(sessionCreates, 0);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a configured Note Folder owned by another Topic fails whole-set preflight', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-folder-owner-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    metadata.createTopic({ topicId: 'fictional-topic-folder-owner', paraCategory: 'area', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-owned-folder', topicId: 'fictional-topic-folder-owner', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault/alpha', observedRevision: null });
    let sessionCreates = 0;
    const service = createLegacyDiscordMigrationService({ metadata, config, gateway: { request: async () => { sessionCreates += 1; return {}; } }, transcriptRuntime: runtime(), folderVerifier: async (value) => value });
    assert.equal((await service.start()).phase, 'review');
    assert.equal(metadata.getTopic('fictional-topic-alpha'), null);
    assert.equal(sessionCreates, 0);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('an explicitly mapped channel with no occurrences still completes an empty immutable prefix', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-empty-'));
  let metadata;
  try {
    const exportPath = path.join(stateDir, 'empty-export.json');
    await writeFile(exportPath, JSON.stringify({ schemaVersion: 1, source: 'discord', channels: [{ channelId: 'fictional-channel-alpha', displayName: 'fictional', messages: [] }] }));
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const transcripts = runtime();
    const service = createLegacyDiscordMigrationService({ metadata, config: { ...config, exportPath, channels: [{ ...config.channels[0], topicId: 'fictional-topic-empty' }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-session-empty' }) }, transcriptRuntime: transcripts, folderVerifier: async () => undefined });
    assert.equal((await service.start()).complete, true);
    assert.equal((transcripts.sessions.get('agent:main:command-center:legacy-discord:fictional-channel-alpha') ?? []).length, 0);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('provisioning Topics stay out of the normal projection snapshot', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-projection-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, scheduler: true } });
    metadata.createTopic({ topicId: 'fictional-topic-provisioning', paraCategory: 'project', lifecycle: 'provisioning' });
    metadata.createTopic({ topicId: 'fictional-topic-active', paraCategory: 'project', lifecycle: 'active' });
    assert.deepEqual(metadata.readProjectionSnapshot().topics.map((topic) => topic.topicId), ['fictional-topic-active']);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('canonical Note Folder aliases are rejected before creating Topics or Sessions', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-folder-alias-'));
  let metadata;
  try {
    const aliasExportPath = path.join(stateDir, 'alias-export.json');
    const fixture = JSON.parse(await (await import('node:fs/promises')).readFile(fixturePath, 'utf8'));
    await writeFile(aliasExportPath, JSON.stringify({ ...fixture, channels: [...fixture.channels, { ...fixture.channels[0], channelId: 'fictional-channel-beta', displayName: 'Fictional Beta', messages: [] }] }));
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    let sessionCreates = 0;
    const service = createLegacyDiscordMigrationService({
      metadata,
      config: {
        ...config,
        exportPath: aliasExportPath,
        channels: [
          config.channels[0],
          { ...config.channels[0], channelId: 'fictional-channel-beta', topicId: 'fictional-topic-beta', noteFolderPath: '/fictional/vault/./alpha/' }
        ]
      },
      gateway: { request: async () => { sessionCreates += 1; return {}; } },
      folderVerifier: async (folderPath) => path.resolve(folderPath)
    });
    const status = await service.start();
    assert.equal(status.complete, false);
    assert.equal(metadata.getMigrationState().failureCode, 'folder-conflict');
    assert.deepEqual(metadata.listTopics(), []);
    assert.equal(sessionCreates, 0);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
