import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService as openMetadataService } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { metadataTableNames } from '../src/metadata/schema.mjs';

const openServices = new Set();
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

test('creates exactly one schema-2 database and preserves public metadata across reopen', async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir });
    assert.deepEqual(service.getOperatingStatus(), { mode: 'ready', schemaVersion: 2, diagnostics: [], unavailableCapabilities: [] });
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    assert.equal(service.databasePath, databasePath);
    assert.deepEqual(await readdir(path.dirname(databasePath)), ['metadata.sqlite']);

    service.createTopic({ topicId: 'topic-fictional', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-08-22T00:00:00Z' });
    service.setPresentationPreferences({ topicId: 'topic-fictional', displayLabel: 'Fictional Area', sortOrder: 4, collapsed: false, updatedAt: '2026-08-22T00:00:01Z' });
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir });
    assert.deepEqual(reopened.getTopic('topic-fictional'), {
      topicId: 'topic-fictional', paraCategory: 'area', lifecycle: 'active',
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
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 2);
      assert.ok(database.prepare('SELECT name FROM pragma_table_list WHERE name = ? AND strict = 1').get('topics'));
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%blob%' OR sql LIKE '%payload%' OR sql LIKE '%transcript%' OR sql LIKE '%schedule_definition%'").get(), undefined);
    } finally {
      database.close();
    }
    service.close();
  });
});
