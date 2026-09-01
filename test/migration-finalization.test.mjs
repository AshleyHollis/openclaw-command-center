import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';

const fixturePath = new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url).pathname;
const channel = { channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-finalization', paraCategory: 'project', noteFolderPath: '/fictional/vault/finalization' };
function runtime() { const sessions = new Map(); return { sessions, async appendSessionTranscriptMessageByIdentityStrict(params) { const events = sessions.get(params.sessionKey) ?? []; events.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message }); sessions.set(params.sessionKey, events); return { kind: 'result', result: { messageId: params.eventId, appended: true } }; }, async withSessionTranscriptWriteLock(target, run) { return run({ readEvents: async () => sessions.get(target.sessionKey) ?? [], publishUpdate: async () => undefined }); }, async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return sessions.get(sessionKey) ?? []; } }; }

for (const corruption of ['remove', 'reorder', 'duplicate', 'alter']) {
  test(`authoritative transcript ${corruption} corruption prevents finalization`, async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), `command-center-migration-${corruption}-corrupt-`));
    let metadata;
    try {
      metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      const transcripts = runtime();
      let corrupted = false;
      const topicId = `fictional-topic-${corruption}-corrupt`;
      const service = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: fixturePath, channels: [{ ...channel, topicId }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: `fictional-${corruption}-corrupt` }) }, transcriptRuntime: transcripts, folderVerifier: async () => undefined, hooks: { afterCheckpoint({ displayOrder }) { if (displayOrder !== 1 || corrupted) return; corrupted = true; const events = [...transcripts.sessions.values()][0]; if (corruption === 'remove') events.splice(0, 1); if (corruption === 'reorder') events.reverse(); if (corruption === 'duplicate') events.push(structuredClone(events[0])); if (corruption === 'alter') events[0].message.text = 'Fictional altered authoritative text.'; } } });
      assert.equal((await service.start()).phase, 'review');
      assert.equal(metadata.getTopic(topicId).lifecycle, 'provisioning');
      assert.equal(metadata.getMigrationCompletion(), null);
    } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
  });
}

test('destination corruption blocks activation and completion; success leaves only a payload-free tombstone', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-finalization-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const transcripts = runtime();
    const service = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: fixturePath, channels: [channel] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-finalization' }) }, transcriptRuntime: transcripts, folderVerifier: async () => undefined, hooks: { afterCheckpoint({ displayOrder }) { if (displayOrder === 1) { const events = [...transcripts.sessions.values()][0]; events.push({ id: 'foreign-during-bootstrap', parentId: events.at(-1).id, message: { role: 'user', text: 'fictional foreign event' } }); } } } });
    const failed = await service.start();
    assert.equal(failed.phase, 'review');
    assert.equal(metadata.getTopic(channel.topicId).lifecycle, 'provisioning');
    assert.equal(metadata.getMigrationCompletion(), null);
    assert.ok(metadata.getMigrationState());

    const anchorState = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-anchor-corrupt-'));
    let anchorMetadata;
    try {
      anchorMetadata = openCommandCenterMetadataService({ stateDir: anchorState, capabilities: { notes: true, sessions: true } });
      let corrupted = false;
      const anchorService = createLegacyDiscordMigrationService({ metadata: anchorMetadata, config: { schemaVersion: 1, exportPath: fixturePath, channels: [{ ...channel, topicId: 'fictional-topic-anchor-corrupt' }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-anchor-corrupt' }) }, transcriptRuntime: runtime(), folderVerifier: async () => undefined, hooks: { afterCheckpoint({ displayOrder }) { if (!corrupted && displayOrder === 1) { corrupted = true; const database = new DatabaseSync(anchorMetadata.databasePath); try { database.exec("UPDATE migration_occurrences SET destination_anchor_json = json_set(destination_anchor_json, '$.generation', 'corrupt') WHERE display_order = 0"); } finally { database.close(); } } } } });
      assert.equal((await anchorService.start()).phase, 'review');
      assert.equal(anchorMetadata.getMigrationCompletion(), null);
    } finally { anchorMetadata?.close(); await rm(anchorState, { recursive: true, force: true }); }

    const ambiguousState = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-binding-ambiguous-'));
    let ambiguousMetadata;
    try {
      ambiguousMetadata = openCommandCenterMetadataService({ stateDir: ambiguousState, capabilities: { notes: true, sessions: true } });
      let inserted = false;
      const ambiguousTopicId = 'fictional-topic-binding-ambiguous';
      const ambiguousService = createLegacyDiscordMigrationService({
        metadata: ambiguousMetadata,
        config: { schemaVersion: 1, exportPath: fixturePath, channels: [{ ...channel, topicId: ambiguousTopicId }] },
        gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-binding-ambiguous' }) },
        transcriptRuntime: runtime(),
        folderVerifier: async () => undefined,
        hooks: { afterCheckpoint() { if (!inserted) { inserted = true; ambiguousMetadata.createSourceReference({ version: 1, referenceId: 'fictional-extra-folder', topicId: ambiguousTopicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault/extra', observedRevision: null }); } } }
      });
      assert.equal((await ambiguousService.start()).phase, 'review');
      assert.equal(ambiguousMetadata.getTopic(ambiguousTopicId).lifecycle, 'provisioning');
      assert.equal(ambiguousMetadata.getMigrationCompletion(), null);
    } finally { ambiguousMetadata?.close(); await rm(ambiguousState, { recursive: true, force: true }); }

    const racedState = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-transcript-race-'));
    let racedMetadata;
    try {
      racedMetadata = openCommandCenterMetadataService({ stateDir: racedState, capabilities: { notes: true, sessions: true } });
      const racedRuntime = runtime();
      const racedTopicId = 'fictional-topic-transcript-race';
      const racedService = createLegacyDiscordMigrationService({ metadata: racedMetadata, config: { schemaVersion: 1, exportPath: fixturePath, channels: [{ ...channel, topicId: racedTopicId }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-transcript-race' }) }, transcriptRuntime: racedRuntime, folderVerifier: async () => undefined, hooks: { afterVerify() { const events = [...racedRuntime.sessions.values()][0]; events.push({ id: 'foreign-after-verification', parentId: events.at(-1).id, message: { role: 'user', text: 'fictional race' } }); } } });
      assert.equal((await racedService.start()).phase, 'review');
      assert.equal(racedMetadata.getTopic(racedTopicId).lifecycle, 'provisioning');
      assert.equal(racedMetadata.getMigrationCompletion(), null);
    } finally { racedMetadata?.close(); await rm(racedState, { recursive: true, force: true }); }

    const cleanState = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-finalization-clean-'));
    let cleanMetadata;
    try {
      cleanMetadata = openCommandCenterMetadataService({ stateDir: cleanState, capabilities: { notes: true, sessions: true } });
      const cleanRuntime = runtime();
      const cleanConfig = { schemaVersion: 1, exportPath: fixturePath, channels: [{ ...channel, topicId: 'fictional-topic-finalization-clean' }] };
      const cleanService = createLegacyDiscordMigrationService({ metadata: cleanMetadata, config: cleanConfig, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-finalization-clean' }) }, transcriptRuntime: cleanRuntime, folderVerifier: async () => undefined });
      assert.equal((await cleanService.start()).phase, 'complete');
      const tombstone = cleanMetadata.getMigrationCompletion();
      assert.equal(tombstone.schemaVersion, 1);
      assert.equal(cleanMetadata.listMigrationChannels().length, 0);
      assert.equal(cleanMetadata.getMigrationState(), null);
      assert.equal(Object.keys(tombstone).sort().join(','), 'completionId,completionRevision,configDigest,schemaVersion,sourceDigest,verifiedAt,verifiedChannelCount,verifiedOccurrenceCount');
      const importedCount = [...cleanRuntime.sessions.values()][0].length;
      const cleanDatabasePath = cleanMetadata.databasePath;
      cleanMetadata.close();
      const legacyDatabase = new DatabaseSync(cleanDatabasePath);
      try {
        legacyDatabase.prepare('UPDATE topics SET revision = 0, activated_at = NULL WHERE topic_id = ?').run('fictional-topic-finalization-clean');
      } finally { legacyDatabase.close(); }
      cleanMetadata = openCommandCenterMetadataService({ stateDir: cleanState, capabilities: { notes: true, sessions: true } });
      // The reopened completion tombstone repairs legacy activation metadata
      // without a retained config or authoritative source rediscovery.
      const restarted = createLegacyDiscordMigrationService({ metadata: cleanMetadata });
      assert.equal((await restarted.start()).phase, 'complete');
      const reconciledTopic = cleanMetadata.getTopic('fictional-topic-finalization-clean');
      assert.equal(reconciledTopic.revision, 1);
      assert.equal(reconciledTopic.activatedAt, tombstone.verifiedAt);
      const malformedRestart = createLegacyDiscordMigrationService({ metadata: cleanMetadata, config: { schemaVersion: 999, unexpected: true } });
      assert.equal((await malformedRestart.start()).phase, 'complete');
      const changedRestart = createLegacyDiscordMigrationService({ metadata: cleanMetadata, config: { schemaVersion: 1, exportPath: fixturePath, channels: [{ ...channel, topicId: 'fictional-topic-conflicting-completion' }] } });
      const changedStatus = await changedRestart.start();
      assert.equal(changedStatus.complete, true);
      assert.equal(changedStatus.failures[0].failureCode, 'completed-bootstrap-conflict');
      const unchangedRestart = createLegacyDiscordMigrationService({ metadata: cleanMetadata, config: cleanConfig, transcriptRuntime: cleanRuntime, folderVerifier: async () => undefined });
      assert.equal((await unchangedRestart.start()).phase, 'complete');
      assert.equal(cleanMetadata.listMigrationChannels().length, 0);
      assert.equal(cleanMetadata.getMigrationState(), null);
      assert.equal([...cleanRuntime.sessions.values()][0].length, importedCount);
      const ownedSession = cleanMetadata.listSourceReferences('fictional-topic-finalization-clean').find((reference) => reference.sourceKind === 'session');
      const ownedSessionState = cleanMetadata.getSessionState(ownedSession.referenceId);
      cleanMetadata.setSessionState({ referenceId: ownedSession.referenceId, sessionId: ownedSessionState.sessionId, status: 'closed', isPrimary: false, wasPrimary: true });
      const replacedPrimaryRestart = createLegacyDiscordMigrationService({ metadata: cleanMetadata });
      assert.equal((await replacedPrimaryRestart.start()).phase, 'complete');
      cleanMetadata.setSessionState({ referenceId: ownedSession.referenceId, sessionId: null, status: 'closed', isPrimary: false, wasPrimary: true });
      const missingBindingRestart = createLegacyDiscordMigrationService({ metadata: cleanMetadata });
      const substitutedStatus = await missingBindingRestart.start();
      assert.equal(substitutedStatus.phase, 'review');
      assert.equal(substitutedStatus.failures[0].failureCode, 'completed-activation-conflict');
    } finally { cleanMetadata?.close(); await rm(cleanState, { recursive: true, force: true }); }
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
