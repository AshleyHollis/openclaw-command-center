import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as metadata from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';

test('explicit metadata initialization creates the current core without activation and retries by read-only verification', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'metadata-initialize-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  assert.deepEqual(metadata.initializeCommandCenterMetadata({ stateDir, expectedSchemaVersion: 8 }),
    { phase: 'verified', schemaVersion: 8, disposition: 'created' });
  const writer = metadata.openCommandCenterMetadataService({ stateDir });
  writer.createTopic({ topicId: 'fictional-garden', name: 'Garden', paraCategory: 'area', lifecycle: 'active' });
  writer.close();
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  const bytes = await readFile(databasePath); const files = await readdir(stateDir, { recursive: true });
  assert.deepEqual(metadata.initializeCommandCenterMetadata({ stateDir, expectedSchemaVersion: 8 }),
    { phase: 'verified', schemaVersion: 8, disposition: 'existing' });
  assert.deepEqual(await readFile(databasePath), bytes);
  assert.deepEqual(await readdir(stateDir, { recursive: true }), files);
  const reader = metadata.openCommandCenterMetadataService({ stateDir, readOnly: true });
  try { assert.equal(reader.getTopic('fictional-garden').name, 'Garden'); } finally { reader.close(); }
});

test('initialization refuses an unapproved schema before creating state', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'metadata-initialize-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  for (const expectedSchemaVersion of [undefined, 7, 9, '8']) {
    assert.throws(() => metadata.initializeCommandCenterMetadata({ stateDir, expectedSchemaVersion }), { code: 'initialization-schema-mismatch' });
  }
  assert.deepEqual(await readdir(stateDir), []);
});

test('initialization never migrates or replaces old, future or corrupt existing metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'metadata-initialize-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const version of [7, 9, 'corrupt']) {
    const stateDir = path.join(root, String(version));
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    await mkdir(path.dirname(databasePath), { recursive: true });
    if (version === 'corrupt') await writeFile(databasePath, 'retained original data');
    else {
      const database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA user_version=${version}; CREATE TABLE retained_fixture (value TEXT); INSERT INTO retained_fixture VALUES ('preserve');`);
      database.close();
    }
    const bytes = await readFile(databasePath); const files = await readdir(stateDir, { recursive: true });
    assert.throws(() => metadata.initializeCommandCenterMetadata({ stateDir, expectedSchemaVersion: 8 }));
    assert.deepEqual(await readFile(databasePath), bytes);
    assert.deepEqual(await readdir(stateDir, { recursive: true }), files);
  }
});

test('initialization refuses a redirected state directory before creating metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'metadata-initialize-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'retained'); const alias = path.join(root, 'alias');
  await mkdir(target); await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => metadata.initializeCommandCenterMetadata({ stateDir: alias, expectedSchemaVersion: 8 }), { code: 'initialization-state-invalid' });
  assert.deepEqual(await readdir(target), []);
});
