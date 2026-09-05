import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openCommandCenterMetadataService as openMetadataService } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { metadataTableNames } from '../src/metadata/schema.mjs';

const openServices = new Set();

async function withDatabaseLock(databasePath, kind, releaseAfterMs, run) {
  const start = new SharedArrayBuffer(4);
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.databasePath, { readOnly: workerData.kind === 'reader' });
    db.exec(workerData.kind === 'reader' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    db.prepare('SELECT count(*) FROM migration_occurrences').get();
    parentPort.postMessage('locked');
    const start = new Int32Array(workerData.start);
    Atomics.wait(start, 0, 0, 5000);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.releaseAfterMs);
    db.exec('ROLLBACK');
    db.close();
  `, { eval: true, workerData: { databasePath, kind, releaseAfterMs, start } });
  const exited = once(worker, 'exit');
  try {
    await once(worker, 'message');
    Atomics.store(new Int32Array(start), 0, 1);
    Atomics.notify(new Int32Array(start), 0);
    return run();
  } finally {
    await exited;
  }
}

function seedMigrationChannel(service) {
  service.createTopic({ topicId: 'fictional-lock-topic', paraCategory: 'project', lifecycle: 'provisioning' });
  for (const [referenceId, sourceSystem, sourceKind] of [['fictional-folder', 'obsidian', 'note_folder'], ['fictional-session', 'openclaw', 'session']]) {
    service.createSourceReference({ version: 1, referenceId, topicId: 'fictional-lock-topic', sourceSystem, sourceKind, externalSourceId: referenceId });
  }
  service.setSessionState({ referenceId: 'fictional-session', sessionId: 'fictional-session', status: 'open', isPrimary: true });
  service.setMigrationChannel({ sourceChannelId: 'fictional-channel', topicId: 'fictional-lock-topic', noteFolderReferenceId: 'fictional-folder', sessionReferenceId: 'fictional-session', sessionId: 'fictional-session', phase: 'importing', expectedCount: 1, expectedDigest: 'sha256:' + 'a'.repeat(64) });
}

for (const kind of ['reader', 'writer']) test(`migration anchor commits after a brief external ${kind} lock without rebinding or replay`, async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    seedMigrationChannel(service);
    const occurrence = { occurrenceId: 'fictional-occurrence', occurrenceDigest: 'sha256:' + 'b'.repeat(64), displayOrder: 0, destinationMessageId: 'fictional-message', destinationAnchor: { entryId: 'fictional-message', rawSeq: 1, generation: 'fictional-generation' } };
    const [persisted] = await withDatabaseLock(service.databasePath, kind, 150, () => service.setMigrationOccurrences('fictional-channel', [occurrence]));
    assert.equal(persisted.destinationMessageId, occurrence.destinationMessageId);
    assert.deepEqual(persisted.destinationAnchor, occurrence.destinationAnchor);
    assert.equal(service.listMigrationOccurrences('fictional-channel').length, 1);
    assert.throws(() => service.setMigrationOccurrences('fictional-channel', [{ ...occurrence, destinationMessageId: 'fictional-other-message' }]), (error) => error.code === 'conflict');
  });
});

for (const kind of ['reader', 'writer']) test(`a persistent ${kind} lock has a bounded refusal and leaves no partial anchor`, async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    seedMigrationChannel(service);
    const occurrence = { occurrenceId: 'fictional-bounded-occurrence', occurrenceDigest: 'sha256:' + 'c'.repeat(64), displayOrder: 0, destinationMessageId: 'fictional-bounded-message', destinationAnchor: { entryId: 'fictional-bounded-message', rawSeq: 1, generation: 'fictional-generation' } };
    await withDatabaseLock(service.databasePath, kind, 1400, () => {
      const started = performance.now();
      assert.throws(() => service.setMigrationOccurrences('fictional-channel', [occurrence]), (error) => error.code === 'ERR_SQLITE_ERROR' && error.errcode === 5);
      assert.ok(performance.now() - started >= 900, 'brief contention must be allowed to clear');
    });
    assert.equal(service.listMigrationOccurrences('fictional-channel').length, 0);
    service.setMigrationOccurrences('fictional-channel', [occurrence]);
    assert.equal(service.listMigrationOccurrences('fictional-channel').length, 1);
  });
});
function openCommandCenterMetadataService(options) {
  const service = openMetadataService(options);
  openServices.add(service);
  return service;
}

async function withState(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-metadata-'));
  try { return await run(stateDir); } finally {
    for (const service of openServices) service.close();
    openServices.clear();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('creates exactly one schema-8 database and preserves public metadata across reopen', async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir });
    assert.equal(service.getOperatingStatus().mode, 'degraded');
    assert.deepEqual(service.getOperatingStatus().unavailableCapabilities, ['notes', 'sessions', 'scheduler', 'activity', 'analysis', 'attention', 'search']);
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    assert.equal(service.databasePath, databasePath);
    assert.deepEqual(await readdir(path.dirname(databasePath)), ['metadata.sqlite']);

    service.createTopic({ topicId: 'topic-fictional', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-08-22T00:00:00Z' });
    service.setPresentationPreferences({ topicId: 'topic-fictional', displayLabel: 'Fictional Area', sortOrder: 4, collapsed: false, updatedAt: '2026-08-22T00:00:01Z' });
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir });
    assert.deepEqual(reopened.getTopic('topic-fictional'), {
      topicId: 'topic-fictional', name: 'topic-fictional', paraCategory: 'area', lifecycle: 'active', revision: 0,
      activatedAt: '2026-08-22T00:00:00Z',
      createdAt: '2026-08-22T00:00:00Z', updatedAt: '2026-08-22T00:00:00Z'
    });
    assert.equal(reopened.getPresentationPreferences('topic-fictional').displayLabel, 'Fictional Area');
    reopened.close();
  });
});

test('schema inspection exposes only the permitted strict application tables', async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir });
    const database = new DatabaseSync(service.databasePath, { readOnly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
      assert.deepEqual(tables, [...metadataTableNames, 'schema_migrations'].sort());
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 8);
      assert.ok(database.prepare('SELECT name FROM pragma_table_list WHERE name = ? AND strict = 1').get('topics'));
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%blob%' OR sql LIKE '%payload%' OR sql LIKE '%transcript%' OR sql LIKE '%schedule_definition%'").get(), undefined);
    } finally {
      database.close();
    }
    service.close();
  });
});
