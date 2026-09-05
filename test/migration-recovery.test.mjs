import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';

const fixture = new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url);

test('migration Review retains bounded SQLite classification without exposing exception content', async () => {
  let saved;
  const service = createLegacyDiscordMigrationService({ metadata: { getMigrationState: () => ({ phase: 'importing' }), setMigrationState: (value) => { saved = value; } } });
  service.failureBoundary = 'authoritative-append';
  await service.recordReview(Object.assign(new Error('Fictional private SQL and path must not escape'), { code: 'ERR_SQLITE_ERROR', errcode: 517 }));
  assert.equal(saved.failureCode, 'ERR_SQLITE_ERROR');
  assert.equal(saved.failureSummary, 'ERR_SQLITE_ERROR:sqlite-517:authoritative-append');
  assert.doesNotMatch(JSON.stringify(saved), /private SQL|path must/u);
});
const channel = { channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-recovery', paraCategory: 'project', noteFolderPath: '/fictional/vault/recovery' };
function runtime() { const sessions = new Map(); return { sessions, async appendSessionTranscriptMessageByIdentityStrict(params) { const events = sessions.get(params.sessionKey) ?? []; events.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message }); sessions.set(params.sessionKey, events); return { kind: 'result', result: { messageId: params.eventId, appended: true } }; }, async withSessionTranscriptWriteLock(target, run) { return run({ readEvents: async () => sessions.get(target.sessionKey) ?? [], publishUpdate: async () => undefined }); }, async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return sessions.get(sessionKey) ?? []; } }; }

test('malformed or changed source and unavailable capabilities remain bounded Review failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-recovery-'));
  let metadata;
  try {
    const malformedPath = path.join(root, 'malformed.json');
    await writeFile(malformedPath, JSON.stringify({ schemaVersion: 1, source: 'discord', channels: [{ channelId: 'fictional-channel-alpha', displayName: 'fictional', messages: [], unexpected: true }] }));
    metadata = openCommandCenterMetadataService({ stateDir: path.join(root, 'state-malformed'), capabilities: { notes: true, sessions: true } });
    const malformed = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: malformedPath, channels: [channel] }, gateway: { request: async () => ({ ['k' + 'ey']: 'fictional', sessionId: 'fictional' }) }, transcriptRuntime: runtime(), folderVerifier: async () => undefined });
    const malformedStatus = await malformed.start();
    assert.equal(malformedStatus.phase, 'review');
    assert.equal(malformedStatus.failures[0].failureCode, 'invalid-export');
    metadata.close();
    metadata = undefined;

    const changedPath = path.join(root, 'changed.json');
    await writeFile(changedPath, await readFile(fixture));
    metadata = openCommandCenterMetadataService({ stateDir: path.join(root, 'state-changed'), capabilities: { notes: true, sessions: true } });
    let interrupted = true;
    const changedRuntime = runtime();
    const changed = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: changedPath, channels: [{ ...channel, topicId: 'fictional-topic-changed' }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-changed' }) }, transcriptRuntime: changedRuntime, folderVerifier: async () => undefined, hooks: { afterAppend() { if (interrupted) { interrupted = false; throw new Error('fictional interruption'); } } } });
    await changed.start();
    const altered = JSON.parse(await readFile(changedPath, 'utf8'));
    altered.channels[0].messages[0].text = 'Fictional changed source.';
    await writeFile(changedPath, JSON.stringify(altered));
    const changedStatus = await changed.resume({ logicalOperationId: randomUUID(), expectedMigrationRevision: metadata.getMigrationState().revision });
    assert.equal(changedStatus.phase, 'review');
    assert.equal(changedStatus.failures[0].failureCode, 'source-changed');
    assert.equal(metadata.getTopic('fictional-topic-changed').lifecycle, 'provisioning');
  } finally { metadata?.close(); await rm(root, { recursive: true, force: true }); }
});

test('unconfigured export drift does not change configured migration identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-unconfigured-drift-'));
  let metadata;
  try {
    const exportPath = path.join(root, 'export.json');
    const exported = JSON.parse(await readFile(fixture, 'utf8'));
    exported.channels.push({ channelId: 'fictional-channel-unconfigured', displayName: 'Unconfigured', messages: [] });
    await writeFile(exportPath, JSON.stringify(exported));
    metadata = openCommandCenterMetadataService({ stateDir: path.join(root, 'state'), capabilities: { notes: true, sessions: true } });
    let interrupted = true;
    const service = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath, channels: [{ ...channel, topicId: 'fictional-topic-unconfigured-drift' }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params['k' + 'ey'], sessionId: 'fictional-unconfigured-drift' }) }, transcriptRuntime: runtime(), folderVerifier: async () => undefined, hooks: { afterAppend() { if (interrupted) { interrupted = false; throw Object.assign(new Error('fictional interruption'), { channelId: channel.channelId }); } } } });
    await service.start();
    exported.channels[1].displayName = 'Unconfigured changed';
    await writeFile(exportPath, JSON.stringify(exported));
    const durableDigest = metadata.getMigrationState().configDigest;
    const removed = createLegacyDiscordMigrationService({ metadata, transcriptRuntime: runtime(), folderVerifier: async () => undefined });
    const removedStatus = await removed.start();
    assert.equal(removedStatus.phase, 'review');
    assert.equal(removedStatus.complete, false);
    assert.equal(removedStatus.actions.length, 2);
    const malformed = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 999 }, transcriptRuntime: runtime(), folderVerifier: async () => undefined });
    assert.equal((await malformed.start()).phase, 'review');
    assert.equal(metadata.getMigrationState().configDigest, durableDigest);
    assert.equal((await service.resume({ logicalOperationId: randomUUID(), expectedMigrationRevision: metadata.getMigrationState().revision })).complete, true);
  } finally { metadata?.close(); await rm(root, { recursive: true, force: true }); }
});

test('a verified channel activates independently while another channel remains reviewable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-partial-channel-'));
  let metadata;
  try {
    const exportPath = path.join(root, 'export.json');
    const exported = JSON.parse(await readFile(fixture, 'utf8'));
    exported.channels.push({ channelId: 'fictional-channel-beta', displayName: 'Fictional Beta', messages: [] });
    await writeFile(exportPath, JSON.stringify(exported));
    const channels = [
      { ...channel, topicId: 'fictional-topic-partial-alpha' },
      { channelId: 'fictional-channel-beta', topicId: 'fictional-topic-partial-beta', paraCategory: 'area', noteFolderPath: '/fictional/vault/partial-beta' }
    ];
    metadata = openCommandCenterMetadataService({ stateDir: path.join(root, 'state'), capabilities: { notes: true, sessions: true } });
    let interrupted = true;
    let failCompletedAlpha = false;
    const service = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath, channels }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params['k' + 'ey'], sessionId: `fictional-${params['k' + 'ey']}` }) }, transcriptRuntime: runtime(), folderVerifier: async (folderPath) => { if (failCompletedAlpha && folderPath === channel.noteFolderPath) throw new Error('fictional transient folder failure'); }, hooks: { afterVerify({ channelId }) { if (channelId === 'fictional-channel-beta' && interrupted) { interrupted = false; throw Object.assign(new Error('fictional beta verification interruption'), { channelId }); } } } });
    const failed = await service.start();
    assert.equal(failed.phase, 'review');
    assert.equal(metadata.getTopic('fictional-topic-partial-alpha').lifecycle, 'active');
    assert.equal(metadata.getMigrationChannel('fictional-channel-alpha').phase, 'complete');
    assert.equal(metadata.getTopic('fictional-topic-partial-beta').lifecycle, 'provisioning');
    assert.equal(metadata.getMigrationChannel('fictional-channel-beta').phase, 'review');
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-ordinary-secondary', topicId: 'fictional-topic-partial-alpha', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-ordinary-secondary', observedRevision: null });
    metadata.setSessionState({ referenceId: 'fictional-ordinary-secondary', sessionId: 'fictional-ordinary-secondary', status: 'open', isPrimary: false });
    failCompletedAlpha = true;
    assert.equal((await service.resume({ logicalOperationId: randomUUID(), expectedMigrationRevision: metadata.getMigrationState().revision })).phase, 'review');
    assert.equal(metadata.getMigrationChannel('fictional-channel-alpha').phase, 'complete');
    assert.equal(metadata.getMigrationChannel('fictional-channel-alpha').failureCode, 'folder-unavailable');
    assert.equal(metadata.getTopic('fictional-topic-partial-alpha').lifecycle, 'active');
    failCompletedAlpha = false;
    assert.equal((await service.resume({ logicalOperationId: randomUUID(), expectedMigrationRevision: metadata.getMigrationState().revision })).complete, true);
  } finally { metadata?.close(); await rm(root, { recursive: true, force: true }); }
});

test('malformed migration configuration enters Review instead of escaping startup', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-config-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const service = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: fixture.pathname, channels: [], unexpected: true }, folderVerifier: async () => undefined });
    const status = await service.start();
    assert.equal(status.phase, 'review');
    assert.equal(status.failures[0].failureCode, 'invalid-migration-config');
    assert.equal(status.failures[0].failureCount, 1);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('missing Sessions capability never activates a partially provisioned Topic', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-capability-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: false } });
    const service = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: fixture.pathname, channels: [{ ...channel, topicId: 'fictional-topic-capability' }] }, folderVerifier: async () => undefined });
    const status = await service.start();
    assert.equal(status.phase, 'review');
    assert.equal(metadata.getTopic('fictional-topic-capability'), null);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('Resume rejects a stale revision and permanently records a reusable logical operation intent', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-revision-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    let interrupted = true;
    const service = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: fixture.pathname, channels: [{ ...channel, topicId: 'fictional-topic-revision' }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-revision' }) }, transcriptRuntime: runtime(), folderVerifier: async () => undefined, hooks: { afterAppend() { if (interrupted) { interrupted = false; throw new Error('fictional interruption'); } } } });
    await service.start();
    const stale = metadata.getMigrationState().revision - 1;
    await assert.rejects(() => service.resume({ logicalOperationId: randomUUID(), expectedMigrationRevision: stale }), (error) => error.code === 'stale-revision');
    const logicalOperationId = randomUUID();
    const expectedMigrationRevision = metadata.getMigrationState().revision;
    assert.equal((await service.resume({ logicalOperationId, expectedMigrationRevision })).complete, true);
    assert.equal(metadata.getOperation(logicalOperationId).operationKind, 'migration.resume');
    assert.equal((await service.resume({ logicalOperationId, expectedMigrationRevision })).complete, true, 'a completed logical operation replays after progress cleanup');
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('durable occurrence identities reject a changed digest instead of overwriting the checkpoint', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-occurrence-conflict-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    metadata.createTopic({ topicId: 'fictional-topic-occurrence-conflict', paraCategory: 'project', lifecycle: 'provisioning' });
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-folder-conflict', topicId: 'fictional-topic-occurrence-conflict', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault/conflict', observedRevision: null });
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-session-conflict', topicId: 'fictional-topic-occurrence-conflict', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:command-center:legacy-discord:fictional-channel-alpha', observedRevision: null });
    metadata.setSessionState({ referenceId: 'fictional-session-conflict', sessionId: 'fictional-session-conflict', status: 'open', isPrimary: true });
    metadata.setMigrationChannel({ sourceChannelId: 'fictional-channel-alpha', topicId: 'fictional-topic-occurrence-conflict', noteFolderReferenceId: 'fictional-folder-conflict', sessionReferenceId: 'fictional-session-conflict', sessionId: 'fictional-session-conflict', phase: 'pending', expectedCount: 1, expectedDigest: 'sha256:' + 'a'.repeat(64), importedCount: 0, importedDigest: 'sha256:' + '0'.repeat(64), nextOrdinal: 0 });
    metadata.setMigrationOccurrences('fictional-channel-alpha', [{ occurrenceId: 'discord:v1:fictional', occurrenceDigest: 'sha256:' + 'b'.repeat(64), displayOrder: 0 }]);
    assert.throws(() => metadata.setMigrationOccurrences('fictional-channel-alpha', [{ occurrenceId: 'discord:v1:fictional', occurrenceDigest: 'sha256:' + 'c'.repeat(64), displayOrder: 0 }]), (error) => error.code === 'conflict');
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
