import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { metadataSchemaV9Sql, metadataSchemaV10Sql } from '../src/metadata/schema.mjs';

test('schema-9 store migrates with recovery material before Developer Work receipts are writable', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-work-migration-'));
  try {
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new DatabaseSync(databasePath);
    seed.exec(metadataSchemaV9Sql);
    seed.close();
    const service = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true } });
    try {
      assert.equal(service.getOperatingStatus().schemaVersion, 11);
      assert.equal(service.getOperatingStatus().mode, 'ready');
      assert.deepEqual(service.listPendingDeveloperEvents({}), []);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(database.prepare('PRAGMA user_version').get().user_version, 11);
        assert.deepEqual(database.prepare('SELECT from_version AS fromVersion, to_version AS toVersion FROM schema_migrations').all().map(row => ({ ...row })), [{ fromVersion: 9, toVersion: 10 }, { fromVersion: 10, toVersion: 11 }]);
      } finally { database.close(); }
    } finally { service.close(); }
  } finally {
    if (path.dirname(stateDir) !== os.tmpdir() || !path.basename(stateDir).startsWith('cc-developer-work-migration-')) throw new Error('Refusing unsafe test cleanup path');
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('schema-10 store migrates to a separate watermark table without rewriting Developer Work receipts', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-work-migration-'));
  try {
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new DatabaseSync(databasePath);
    seed.exec(metadataSchemaV10Sql);
    seed.prepare('INSERT INTO developer_work_cursors (producer_id, work_id, revision) VALUES (?, ?, ?)').run('sample-dev', 'sample-work', 1);
    seed.close();
    const service = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true } });
    try {
      assert.equal(service.getOperatingStatus().mode, 'ready');
      assert.equal(service.getOperatingStatus().schemaVersion, 11);
      assert.equal(service.isDeveloperWorkNotificationReady({ producerId: 'sample-dev', workId: 'sample-work' }), false);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(database.prepare('SELECT revision FROM developer_work_cursors WHERE producer_id = ? AND work_id = ?').get('sample-dev', 'sample-work').revision, 1);
        assert.deepEqual(database.prepare('SELECT from_version AS fromVersion, to_version AS toVersion FROM schema_migrations').all().map(row => ({ ...row })), [{ fromVersion: 10, toVersion: 11 }]);
      } finally { database.close(); }
    } finally { service.close(); }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
