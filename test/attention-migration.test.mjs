import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { metadataSchemaV2Sql, metadataSchemaV3Sql, inspectSchema } from '../src/metadata/schema.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';

test('schema-2 metadata migrates forward to the Attention schema and reopens with durable tables', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-v4-migration-'));
  const capabilities = { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true };
  try {
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(metadataSchemaV2Sql);
    database.close();
    const service = openCommandCenterMetadataService({ stateDir, capabilities });
    assert.equal(service.getOperatingStatus().schemaVersion, 8);
    service.close();
    const reopened = openCommandCenterMetadataService({ stateDir, capabilities });
    const check = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(inspectSchema(check, 8).valid, true);
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'attention_%' ORDER BY name").all().map((row) => row.name), ['attention_activity_links', 'attention_activity_records', 'attention_approvals', 'attention_attempts', 'attention_episodes', 'attention_occurrences']);
    check.close();
    reopened.close();
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('schema-3 metadata migrates narrowly to schema 6 without losing migration state', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-v3-to-v4-'));
  const capabilities = { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true };
  try {
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(metadataSchemaV3Sql);
    database.prepare("INSERT INTO migration_state (state_id, schema_version, config_digest, source_digest, revision, phase, failure_count, updated_at) VALUES ('legacy-discord-v1', 1, 'fictional-config', 'fictional-source', 1, 'review', 0, '2026-08-24T00:00:00.000Z')").run();
    database.close();
    const service = openCommandCenterMetadataService({ stateDir, capabilities });
    assert.equal(service.getOperatingStatus().schemaVersion, 8);
    service.close();
    const check = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(inspectSchema(check, 8).valid, true);
    assert.equal(check.prepare('SELECT phase FROM migration_state').get().phase, 'review');
    assert.deepEqual(check.prepare('SELECT from_version, to_version FROM schema_migrations').all().map((row) => ({ ...row })), [{ from_version: 3, to_version: 4 }, { from_version: 4, to_version: 5 }, { from_version: 5, to_version: 6 }, { from_version: 6, to_version: 7 }, { from_version: 7, to_version: 8 }]);
    check.close();
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
