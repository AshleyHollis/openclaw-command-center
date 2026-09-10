import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';
import { legacyDiscordMigrationConfigDigest } from '../src/migration/config.mjs';
import { createTopicService } from '../src/topics/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { NOTE_FOLDER_IDENTITY_FILE, readNoteFolderIdentity } from '../src/sources/note-folder-identity.mjs';

// Only native Sessions/transcripts are external fixtures. Filesystem admission,
// the host SQLite lease, migration, metadata and retained Note reads are real.
async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'first-live-migration-'));
  const folder = path.join(stateDir, 'vault', 'Fictional Alpha');
  await mkdir(folder, { recursive: true });
  const text = '# Existing fictional Note\nPreserve the mapped authoritative content.\n';
  await writeFile(path.join(folder, 'Overview.md'), text);
  const topicId = '44444444-4444-4444-8444-444444444444';
  const config = { schemaVersion: 1, exportPath: fileURLToPath(new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url)), channels: [{ channelId: 'fictional-channel-alpha', topicId, paraCategory: 'project', noteFolderPath: folder }] };
  const sessions = new Map();
  const events = new Map();
  const gateway = { async request(method, params) {
    if (method === 'sessions.list') return { sessions: [...sessions.values()] };
    assert.equal(method, 'sessions.create');
    const result = { key: params.key, sessionId: 'fictional-imported-session', updatedAt: 20 };
    sessions.set(params.key, result); return result;
  } };
  const transcriptRuntime = {
    async appendSessionTranscriptMessageByIdentityStrict(input) {
      const rows = events.get(input.sessionKey) ?? [];
      if (!rows.some(row => row.id === input.eventId)) rows.push({ id: input.eventId, parentId: input.parentId ?? null, message: input.message });
      events.set(input.sessionKey, rows);
      return { kind: 'result', result: { messageId: input.eventId, appended: true } };
    },
    async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return events.get(sessionKey) ?? []; },
    async withSessionTranscriptWriteLock({ sessionKey }, action) { return action({ readEvents: async () => events.get(sessionKey) ?? [], publishUpdate: async () => {} }); }
  };
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  const reopen = () => { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } }); return metadata; };
  try { await run({ stateDir, folder, text, topicId, config, gateway, transcriptRuntime, metadata, reopen }); }
  finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('default mapped migration survives reopen as a usable Topic with exact read-only Notes', async () => fixture(async ({ stateDir, folder, text, topicId, config, gateway, transcriptRuntime, metadata, reopen }) => {
  const migration = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime });
  assert.equal((await migration.start()).complete, true);
  const reopened = reopen();
  const topics = createTopicService({ metadata: reopened, gateway, noteVaultRoot: path.join(stateDir, 'vault') });
  const folderReferenceId = 'migration:folder:fictional-channel-alpha';
  assert.equal((await topics.recovery.inspect(topicId, folderReferenceId)).available, true);
  const destination = await topics.listDestinationVerified();
  assert.equal(destination.activeGroups.project.find(topic => topic.topicId === topicId)?.usable, true);
  assert.equal(destination.recovery.length, 0);
  const binding = reopened.getSourceLocator(folderReferenceId);
  assert.equal(binding.locator, folder);
  assert.equal(binding.ownership, 'external');
  assert.equal(binding.locatorVersion, 1);
  assert.equal(binding.observedRevision, await readNoteFolderIdentity(folder));
  assert.equal(reopened.getSourceReference(folderReferenceId).observedRevision, `legacy-discord-owner:${legacyDiscordMigrationConfigDigest(config)}`);
  const fsSafeRootFactory = process.env.COMMAND_CENTER_TEST_SECURITY_RUNTIME ? (await import(process.env.COMMAND_CENTER_TEST_SECURITY_RUNTIME)).root : undefined;
  const source = createAuthoritativeSourceService({ metadata: reopened, gateway, fsSafeRootFactory, noteRecoveryEffects: false, capabilities: { notes: true, sessions: true } });
  assert.equal((await source.notesRead({ topicId, path: 'Overview.md' })).text, text);
  assert.equal(await readFile(path.join(folder, 'Overview.md'), 'utf8'), text);
}));

for (const change of ['missing', 'replaced']) test(`interrupted migration refuses a ${change} saved folder marker without reenrollment`, async () => fixture(async ({ folder, config, gateway, transcriptRuntime, metadata, reopen }) => {
  const first = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime, hooks: { afterTopicBinding() { throw new Error('fictional interrupted binding'); } } });
  assert.equal((await first.start()).complete, false);
  const marker = path.join(folder, NOTE_FOLDER_IDENTITY_FILE);
  const bytes = await readFile(marker);
  const binding = metadata.getSourceLocator('migration:folder:fictional-channel-alpha');
  await unlink(marker);
  if (change === 'replaced') await writeFile(marker, bytes, { flag: 'wx' });
  const reopened = reopen();
  const retry = createLegacyDiscordMigrationService({ metadata: reopened, config, gateway, transcriptRuntime });
  assert.equal((await retry.start()).complete, false);
  assert.equal(reopened.getTopic(config.channels[0].topicId).lifecycle, 'provisioning');
  assert.deepEqual(reopened.getSourceLocator(binding.referenceId), binding);
  if (change === 'missing') await assert.rejects(readFile(marker), { code: 'ENOENT' });
  else assert.deepEqual(await readFile(marker), bytes);
}));

test('final migration activation rechecks the saved folder marker after transcript verification', async () => fixture(async ({ folder, config, gateway, transcriptRuntime, metadata }) => {
  const migration = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime, hooks: {} });
  const originalLock = transcriptRuntime.withSessionTranscriptWriteLock;
  let verifying = false;
  migration.hooks.afterVerify = () => { verifying = true; };
  transcriptRuntime.withSessionTranscriptWriteLock = async (...args) => {
    if (verifying) await unlink(path.join(folder, NOTE_FOLDER_IDENTITY_FILE));
    return originalLock(...args);
  };
  assert.equal((await migration.start()).complete, false);
  assert.equal(metadata.getTopic(config.channels[0].topicId).lifecycle, 'provisioning');
  assert.equal(metadata.getMigrationCompletion(), null);
}));

async function killAfterBinding(stateDir, config) {
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/note-runtime-loader.mjs', import.meta.url)), fileURLToPath(new URL('./fixtures/migration-folder-binding-crash.mjs', import.meta.url)), stateDir, JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60_000);
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    assert.equal(result.signal, 'SIGKILL', diagnostics);
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
}

for (const change of ['unchanged', 'missing', 'replaced']) test(`SIGKILL after atomic migration binding preserves ${change} folder admission on reopen`, { skip: process.platform !== 'linux' }, async () => fixture(async ({ stateDir, folder, text, config, gateway, transcriptRuntime, metadata, reopen }) => {
  await killAfterBinding(stateDir, config);
  const binding = metadata.getSourceLocator('migration:folder:fictional-channel-alpha');
  assert.ok(binding);
  const marker = path.join(folder, NOTE_FOLDER_IDENTITY_FILE);
  const bytes = await readFile(marker);
  if (change !== 'unchanged') await unlink(marker);
  if (change === 'replaced') await writeFile(marker, bytes, { flag: 'wx' });
  const reopened = reopen();
  const result = await createLegacyDiscordMigrationService({ metadata: reopened, config, gateway, transcriptRuntime }).start();
  assert.equal(result.complete, change === 'unchanged');
  assert.deepEqual(reopened.getSourceLocator(binding.referenceId), binding);
  assert.equal(await readFile(path.join(folder, 'Overview.md'), 'utf8'), text);
  if (change === 'missing') await assert.rejects(readFile(marker), { code: 'ENOENT' });
  else assert.deepEqual(await readFile(marker), bytes);
}));

for (const completed of [false, true]) test(`historical unbound ${completed ? 'completed' : 'pending'} migration refuses inferred folder backfill`, async () => fixture(async ({ folder, config, gateway, transcriptRuntime, metadata, reopen }) => {
  const migration = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime, hooks: completed ? {} : { afterTopicBinding() { throw new Error('Interrupted fixture'); } } });
  assert.equal((await migration.start()).complete, completed);
  const completion = metadata.getMigrationCompletion();
  const marker = path.join(folder, NOTE_FOLDER_IDENTITY_FILE);
  const bytes = await readFile(marker);
  // A retained legacy database had a migration-owned reference but no binding.
  const legacy = new DatabaseSync(metadata.databasePath);
  try { legacy.prepare('DELETE FROM source_locators WHERE reference_id = ?').run('migration:folder:fictional-channel-alpha'); }
  finally { legacy.close(); }
  const reopened = reopen();
  const result = await createLegacyDiscordMigrationService({ metadata: reopened, config, gateway, transcriptRuntime }).start();
  assert.equal(result.phase, 'review', JSON.stringify(result));
  assert.ok(result.failures.length > 0, JSON.stringify(result));
  assert.equal(reopened.getSourceLocator('migration:folder:fictional-channel-alpha'), null);
  assert.deepEqual(reopened.getMigrationCompletion(), completion);
  assert.deepEqual(await readFile(marker), bytes);
}));

test('migration refuses a changed locator generation rather than refreshing its activation base', async () => fixture(async ({ config, gateway, transcriptRuntime, metadata }) => {
  const migration = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime, hooks: {} });
  migration.hooks.afterVerify = () => {
    const saved = metadata.getSourceLocator('migration:folder:fictional-channel-alpha');
    metadata.setSourceLocator({ ...saved, locatorVersion: saved.locatorVersion + 1 });
  };
  assert.equal((await migration.start()).complete, false);
  assert.equal(metadata.getTopic(config.channels[0].topicId).lifecycle, 'provisioning');
  assert.equal(metadata.getSourceLocator('migration:folder:fictional-channel-alpha').locatorVersion, 2);
  assert.equal(metadata.getMigrationCompletion(), null);
}));

test('a mapped folder held by another current locator is not enrolled or taken over', async () => fixture(async ({ folder, config, gateway, transcriptRuntime, metadata }) => {
  const ownerId = '55555555-5555-4555-8555-555555555555';
  metadata.createTopic({ topicId: ownerId, paraCategory: 'area', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'fictional-foreign-folder', topicId: ownerId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: path.join(folder, 'original-location') });
  const owner = metadata.setSourceLocator({ referenceId: 'fictional-foreign-folder', locator: folder, ownership: 'external', observedRevision: 'fictional-foreign-identity' });
  const result = await createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime }).start();
  assert.equal(result.phase, 'review');
  assert.equal(metadata.getTopic(config.channels[0].topicId), null);
  assert.deepEqual(metadata.getSourceLocator('fictional-foreign-folder'), owner);
  await assert.rejects(readFile(path.join(folder, NOTE_FOLDER_IDENTITY_FILE)), { code: 'ENOENT' });
}));
