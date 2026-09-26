import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { metadataSchemaV9Sql } from '../src/metadata/schema.mjs';

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
      assert.equal(service.getOperatingStatus().schemaVersion, 10);
      assert.equal(service.getOperatingStatus().mode, 'ready');
      assert.deepEqual(service.listPendingDeveloperEvents({}), []);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(database.prepare('PRAGMA user_version').get().user_version, 10);
        assert.deepEqual(database.prepare('SELECT from_version AS fromVersion, to_version AS toVersion FROM schema_migrations').all().map(row => ({ ...row })), [{ fromVersion: 9, toVersion: 10 }]);
      } finally { database.close(); }
    } finally { service.close(); }
  } finally {
    if (path.dirname(stateDir) !== os.tmpdir() || !path.basename(stateDir).startsWith('cc-developer-work-migration-')) throw new Error('Refusing unsafe test cleanup path');
    await rm(stateDir, { recursive: true, force: true });
  }
});
