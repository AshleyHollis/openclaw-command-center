import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'metadata-read-only-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test('read-only metadata refuses missing and old stores without creating or migrating files', async t => {
  const stateDir = await fixture(t);
  assert.throws(() => openCommandCenterMetadataService({ stateDir, readOnly: true }), { code: 'existing-metadata-required' });
  assert.deepEqual(await readdir(stateDir), []);
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const old = new DatabaseSync(databasePath);
  old.exec('PRAGMA user_version=7; CREATE TABLE retained_fixture (value TEXT); INSERT INTO retained_fixture VALUES (\'preserve\');');
  old.close();
  const bytes = await readFile(databasePath);
  const files = await readdir(stateDir, { recursive: true });
  assert.throws(() => openCommandCenterMetadataService({ stateDir, readOnly: true }), { code: 'current-schema-required' });
  assert.deepEqual(await readFile(databasePath), bytes);
  assert.deepEqual(await readdir(stateDir, { recursive: true }), files);
});

test('existing current metadata is readable but writes and derived initialization are refused', async t => {
  const stateDir = await fixture(t);
  const writer = openCommandCenterMetadataService({ stateDir });
  writer.createTopic({ topicId: 'fictional-garden', name: 'Garden', paraCategory: 'area', lifecycle: 'active' });
  writer.close();
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  const bytes = await readFile(databasePath);
  const files = await readdir(stateDir, { recursive: true });
  const reader = openCommandCenterMetadataService({ stateDir, readOnly: true });
  try {
    assert.equal(reader.getTopic('fictional-garden').name, 'Garden');
    assert.throws(() => reader.createTopic({ topicId: 'unwanted', name: 'Unwanted', paraCategory: 'area', lifecycle: 'active' }), { code: 'read-only' });
    assert.throws(() => reader.deleteDerivedProjections(), { code: 'read-only' });
    assert.deepEqual(reader.listReconciliations(), []);
  } finally { reader.close(); }
  assert.deepEqual(await readFile(databasePath), bytes);
  assert.deepEqual(await readdir(stateDir, { recursive: true }), files);
});
