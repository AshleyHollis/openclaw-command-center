import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';
import { legacyDiscordMigrationConfigDigest } from '../src/migration/config.mjs';

const fixturePath = new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url).pathname;
const config = { schemaVersion: 1, exportPath: fixturePath, channels: [{ channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-restart', paraCategory: 'project', noteFolderPath: '/fictional/vault/restart' }] };
function runtime() {
  const sessions = new Map();
  return { sessions, async appendSessionTranscriptMessageByIdentityStrict(params) { const events = sessions.get(params.sessionKey) ?? []; if (!events.some((event) => event.id === params.eventId)) events.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message }); sessions.set(params.sessionKey, events); return { kind: 'result', result: { messageId: params.eventId, appended: true } }; }, async withSessionTranscriptWriteLock(target, run) { return run({ readEvents: async () => sessions.get(target.sessionKey) ?? [], publishUpdate: async () => undefined }); },
    async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return sessions.get(sessionKey) ?? []; }
  };
}

const durableRuntimeLocks = new Map();
function durableRuntime(filename) {
  const load = async () => JSON.parse(await readFile(filename, 'utf8').catch((error) => error.code === 'ENOENT' ? '{}' : Promise.reject(error)));
  const save = (value) => writeFile(filename, JSON.stringify(value));
  const serialized = async (operation) => {
    const previous = durableRuntimeLocks.get(filename) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    durableRuntimeLocks.set(filename, current.catch(() => undefined));
    return current;
  };
  return {
    async appendSessionTranscriptMessageByIdentityStrict(params) {
      return serialized(async () => {
        const sessions = await load();
        const events = sessions[params.sessionKey] ?? [];
        if (!events.some((event) => event.id === params.eventId)) events.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message });
        sessions[params.sessionKey] = events;
        await save(sessions);
        return { kind: 'result', result: { messageId: params.eventId, appended: true } };
      });
    },
    async withSessionTranscriptWriteLock(target, run) { return serialized(async () => { const sessions = await load(); return run({ readEvents: async () => sessions[target.sessionKey] ?? [], publishUpdate: async () => undefined }); }); },
    async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return (await load())[sessionKey] ?? []; }
  };
}

test('an interruption after a durable checkpoint converges without duplicate events', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-restart-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const transcripts = runtime();
    let interrupted = true;
    const gateway = { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-session-restart' }) };
    const service = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined, hooks: { afterAppend() { if (interrupted) { interrupted = false; throw new Error('fictional interruption'); } } } });
    assert.equal((await service.start()).complete, false);
    assert.equal(metadata.getMigrationState().phase, 'review');
    const checkpoint = metadata.listMigrationOccurrences('fictional-channel-alpha')[0];
    assert.equal(checkpoint.destinationMessageId, checkpoint.occurrenceId);
    assert.equal(checkpoint.destinationAnchor.entryId, checkpoint.destinationMessageId);
    assert.equal('storePath' in checkpoint.destinationAnchor, false);
    assert.equal((await service.resume({ logicalOperationId: randomUUID(), expectedMigrationRevision: metadata.getMigrationState().revision })).complete, true);
    const reference = metadata.listSourceReferences('fictional-topic-restart').find((item) => item.sourceKind === 'session');
    const events = transcripts.sessions.get(reference.externalSourceId);
    assert.equal(events.length, 2);
    assert.equal(new Set(events.map((event) => event.message.__openclaw.legacyDiscordV1.occurrenceId)).size, 2);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a reopened transcript and metadata ledger reconcile an append with no checkpoint acknowledgement', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-durable-restart-'));
  const transcriptPath = path.join(stateDir, 'fictional-transcript.json');
  let metadata;
  try {
    const gateway = { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-session-durable-restart' }) };
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    let interrupted = true;
    const first = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime: durableRuntime(transcriptPath), folderVerifier: async () => undefined, hooks: { afterAuthoritativeAppend() { if (interrupted) { interrupted = false; throw new Error('fictional crash before checkpoint acknowledgement'); } } } });
    assert.equal((await first.start()).phase, 'review');
    assert.equal(metadata.listMigrationOccurrences('fictional-channel-alpha')[0].destinationMessageId, null);
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const second = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime: durableRuntime(transcriptPath), folderVerifier: async () => undefined });
    assert.equal((await second.resume({ logicalOperationId: randomUUID(), expectedMigrationRevision: metadata.getMigrationState().revision })).complete, true);
    const persisted = JSON.parse(await readFile(transcriptPath, 'utf8'))['agent:main:command-center:legacy-discord:fictional-channel-alpha'];
    assert.deepEqual(persisted.map((event) => event.message.__openclaw.legacyDiscordV1.displayOrder), [0, 1]);
    assert.equal(new Set(persisted.map((event) => event.id)).size, 2);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('concurrent Resume requests converge and durably complete both logical operations', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-concurrent-resume-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const transcripts = runtime();
    const gateway = { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-session-concurrent-resume' }) };
    let interrupted = true;
    await createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined, hooks: { afterAuthoritativeAppend() { if (interrupted) { interrupted = false; throw new Error('fictional concurrent resume setup'); } } } }).start();
    const expectedMigrationRevision = metadata.getMigrationState().revision;
    const operationIds = [randomUUID(), randomUUID()];
    const services = operationIds.map(() => createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined }));
    const results = await Promise.all(services.map((service, index) => service.resume({ logicalOperationId: operationIds[index], expectedMigrationRevision })));
    assert.equal(results.every((result) => result.complete), true);
    const events = transcripts.sessions.get('agent:main:command-center:legacy-discord:fictional-channel-alpha');
    assert.deepEqual(events.map((event) => event.message.__openclaw.legacyDiscordV1.displayOrder), [0, 1]);
    assert.equal(new Set(events.map((event) => event.id)).size, 2);
    assert.deepEqual(operationIds.map((id) => metadata.getOperation(id).state), ['applied', 'applied']);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('an interruption after Session binding reuses the deterministic Primary Session', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-binding-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const transcripts = runtime();
    let interrupted = true;
    let sessionCreates = 0;
    const gateway = { request: async (method, params) => { if (method === 'sessions.create') sessionCreates += 1; return { ['k' + 'ey']: params.key, sessionId: 'fictional-session-binding' }; } };
    const configWithBinding = { ...config, channels: [{ ...config.channels[0], topicId: 'fictional-topic-binding' }] };
    const first = createLegacyDiscordMigrationService({ metadata, config: configWithBinding, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined, hooks: { afterProvisioningBinding() { if (interrupted) { interrupted = false; throw new Error('fictional binding interruption'); } } } });
    assert.equal((await first.start()).complete, false);
    assert.equal(metadata.getMigrationChannel('fictional-channel-alpha'), null);
    const second = createLegacyDiscordMigrationService({ metadata, config: configWithBinding, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined });
    assert.equal((await second.start()).complete, true);
    assert.equal(sessionCreates, 1);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('Topic and host Session creation boundaries resume from durable migration ownership', async () => {
  for (const boundary of ['topic', 'session']) {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), `command-center-migration-${boundary}-boundary-`));
    let metadata;
    try {
      metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      const transcripts = runtime();
      const created = new Map();
      let creates = 0;
      const gateway = { request: async (method, params) => {
        if (method === 'sessions.list') return { sessions: created.has(params.search) ? [{ ['k' + 'ey']: params.search, sessionId: created.get(params.search) }] : [] };
        creates += 1;
        created.set(params.key, 'fictional-boundary-session');
        return { ['k' + 'ey']: params.key, sessionId: 'fictional-boundary-session' };
      } };
      let interrupted = true;
      const boundaryConfig = { ...config, channels: [{ ...config.channels[0], topicId: `fictional-topic-${boundary}-boundary` }] };
      const hooks = boundary === 'topic'
        ? { afterTopicBinding() { if (interrupted) { interrupted = false; throw new Error('fictional Topic boundary interruption'); } } }
        : { afterSessionCreate() { if (interrupted) { interrupted = false; throw new Error('fictional Session boundary interruption'); } } };
      assert.equal((await createLegacyDiscordMigrationService({ metadata, config: boundaryConfig, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined, hooks }).start()).complete, false);
      assert.equal((await createLegacyDiscordMigrationService({ metadata, config: boundaryConfig, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined }).start()).complete, true);
      assert.equal(creates, 1);
    } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
  }
});

test('an ordinary suffix blocks resume before another imported append', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-suffix-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const transcripts = runtime();
    let interrupted = true;
    const suffixConfig = { ...config, channels: [{ ...config.channels[0], topicId: 'fictional-topic-suffix' }] };
    const gateway = { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-session-suffix' }) };
    await createLegacyDiscordMigrationService({ metadata, config: suffixConfig, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined, hooks: { afterAppend() { if (interrupted) { interrupted = false; throw new Error('fictional interruption'); } } } }).start();
    const events = transcripts.sessions.values().next().value;
    events.push({ id: 'fictional-ordinary-suffix', parentId: events.at(-1).id, message: { role: 'user', content: 'ordinary suffix', text: 'ordinary suffix' } });
    const before = events.length;
    const resumed = await createLegacyDiscordMigrationService({ metadata, config: suffixConfig, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined }).start();
    assert.equal(resumed.phase, 'review');
    assert.equal(events.length, before);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('an orphaned deterministic Session reference is reconciled through the authoritative catalog', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-session-gap-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const gapConfig = { ...config, channels: [{ ...config.channels[0], topicId: 'fictional-topic-session-gap' }] };
    metadata.createTopic({ topicId: 'fictional-topic-session-gap', paraCategory: 'project', lifecycle: 'provisioning' });
    metadata.createSourceReference({ version: 1, referenceId: 'migration:folder:fictional-channel-alpha', topicId: 'fictional-topic-session-gap', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault/restart', observedRevision: `legacy-discord-owner:${legacyDiscordMigrationConfigDigest(gapConfig)}` });
    metadata.createSourceReference({ version: 1, referenceId: 'migration:session:fictional-channel-alpha', topicId: 'fictional-topic-session-gap', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:command-center:legacy-discord:fictional-channel-alpha', observedRevision: null });
    let creates = 0;
    const listOffsets = [];
    const gateway = { request: async (method, params) => {
      if (method === 'sessions.create') creates += 1;
      if (method === 'sessions.list') {
        listOffsets.push(params.offset);
        if (params.offset === 0) return { sessions: Array.from({ length: 100 }, (_, index) => ({ ['k' + 'ey']: `agent:main:fictional:${index}`, sessionId: `fictional-session-${index}` })), hasMore: true, nextOffset: 100 };
        return { sessions: [{ ['k' + 'ey']: 'agent:main:command-center:legacy-discord:fictional-channel-alpha', sessionId: 'fictional-session-gap' }], hasMore: false };
      }
      return {};
    } };
    const service = createLegacyDiscordMigrationService({ metadata, config: gapConfig, gateway, transcriptRuntime: runtime(), folderVerifier: async (value) => value });
    assert.equal((await service.start()).complete, true);
    assert.equal(creates, 0);
    assert.deepEqual(listOffsets, [0, 100, 0, 100]);
    assert.equal(metadata.getSessionState('migration:session:fictional-channel-alpha').sessionId, 'fictional-session-gap');
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('strict identity append and verification use the pinned host runtime', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-locked-append-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const sessions = new Map();
    let strictAppends = 0;
    const transcriptRuntime = {
      async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return sessions.get(sessionKey) ?? []; },
      async appendSessionTranscriptMessageByIdentityStrict(options) {
        assert.equal(options.agentId, 'main');
        assert.equal(options.sessionId, 'fictional-session-locked-append');
        assert.equal(options.now, Date.parse(options.message.timestamp));
        const events = sessions.get(options.sessionKey) ?? [];
        events.push({ id: options.eventId, parentId: options.parentId ?? null, message: options.message });
        sessions.set(options.sessionKey, events);
        strictAppends += 1;
        return { kind: 'result', result: { messageId: options.eventId, appended: true } };
      },
      async withSessionTranscriptWriteLock(target, run) {
        return run({
          async readEvents() { return sessions.get(target.sessionKey) ?? []; },
          async appendMessage() { throw new Error('generic locked append must not import migration history'); },
          async publishUpdate() {}
        });
      }
    };
    const service = createLegacyDiscordMigrationService({ metadata, config: { ...config, channels: [{ ...config.channels[0], topicId: 'fictional-topic-locked-append' }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-session-locked-append' }) }, transcriptRuntime, folderVerifier: async (value) => value });
    assert.equal((await service.start()).complete, true);
    assert.equal(sessions.values().next().value.length, 2);
    assert.equal(strictAppends, 2);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a checkpoint ahead of its append is reconciled from the authoritative transcript', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-checkpoint-ahead-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const transcripts = runtime();
    let interrupted = true;
    const service = createLegacyDiscordMigrationService({ metadata, config: { ...config, channels: [{ ...config.channels[0], topicId: 'fictional-topic-checkpoint-ahead' }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-session-checkpoint-ahead' }) }, transcriptRuntime: transcripts, folderVerifier: async () => undefined, hooks: { beforePhase({ phase }) { if (phase === 'importing' && interrupted) { interrupted = false; const row = metadata.getMigrationChannel('fictional-channel-alpha'); metadata.setMigrationChannel({ ...row, phase: 'importing', importedCount: 1, importedDigest: 'sha256:' + '1'.repeat(64), nextOrdinal: 1, updatedAt: new Date().toISOString() }); throw new Error('fictional checkpoint-only interruption'); } } } });
    assert.equal((await service.start()).complete, false);
    assert.equal((await service.resume({ logicalOperationId: randomUUID(), expectedMigrationRevision: metadata.getMigrationState().revision })).complete, true);
    const reference = metadata.listSourceReferences('fictional-topic-checkpoint-ahead').find((item) => item.sourceKind === 'session');
    assert.equal(transcripts.sessions.get(reference.externalSourceId).length, 2);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
