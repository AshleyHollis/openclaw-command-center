import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService as openMetadataService } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { metadataSchemaSql } from '../src/metadata/schema.mjs';

const openServices = new Set();
function openCommandCenterMetadataService(options) {
  const service = openMetadataService(options);
  openServices.add(service);
  return service;
}

async function withState(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-compatibility-'));
  try { return await run(stateDir); } finally {
    for (const service of openServices) service.close();
    openServices.clear();
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function createDatabase(stateDir, setup) {
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  let result;
  try { result = setup(database); } finally { database.close(); }
  return { databasePath, result };
}

async function assertRecoveryPreservesFixture(stateDir, expectedCode) {
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  const beforeBytes = await readFile(databasePath);
  const beforeMtime = (await stat(databasePath)).mtimeMs;
  const beforeSiblings = (await readdir(path.dirname(databasePath))).sort();
  const service = openCommandCenterMetadataService({ stateDir });
  const firstStatus = service.getOperatingStatus();
  assert.equal(firstStatus.mode, 'recovery-only');
  assert.equal(firstStatus.diagnostics[0].code, expectedCode);
  assert.deepEqual(service.getOperatingStatus(), firstStatus);
  assert.throws(() => service.createTopic({ topicId: 'blocked-topic', paraCategory: 'area', lifecycle: 'active' }), (error) => error.code === 'recovery-only');
  assert.throws(() => service.setPolicyVersion({ policyId: 'blocked-policy', version: 'v1', digest: 'blocked-digest' }), (error) => error.code === 'recovery-only');
  service.close();
  assert.deepEqual(await readFile(databasePath), beforeBytes);
  assert.equal((await stat(databasePath)).mtimeMs, beforeMtime);
  assert.deepEqual((await readdir(path.dirname(databasePath))).sort(), beforeSiblings);
}

const malformedFixtures = [
  ['missing table', (db) => { db.exec(metadataSchemaSql); db.exec('DROP TABLE topics'); }],
  ['missing required check', (db) => db.exec(metadataSchemaSql.replace("para_category TEXT NOT NULL CHECK (para_category IN ('project', 'area', 'resource', 'archive'))", 'para_category TEXT NOT NULL'))],
  ['weakened required check', (db) => db.exec(metadataSchemaSql.replace("CHECK (para_category IN ('project', 'area', 'resource', 'archive'))", "CHECK (para_category IN ('project', 'area', 'resource', 'archive') OR 1)"))],
  ['case-altered check literal', (db) => db.exec(metadataSchemaSql.replace("'project', 'area', 'resource', 'archive'", "'PROJECT', 'area', 'resource', 'archive'"))],
  ['altered implicit unique constraint', (db) => db.exec(metadataSchemaSql.replace('UNIQUE (attention_id, activity_id)', 'UNIQUE (attention_id)'))],
  ['altered source identity constraint', (db) => db.exec(metadataSchemaSql.replace('UNIQUE (source_system, source_kind, external_source_id)', 'UNIQUE (source_system, external_source_id)'))],
  ['altered foreign key', (db) => db.exec(metadataSchemaSql.replace('topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE RESTRICT,', 'topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,'))],
  ['unexpected application object', (db) => { db.exec(metadataSchemaSql); db.exec('CREATE VIEW unexpected_projection_results AS SELECT topic_id FROM topics;'); }]
];

test('future, version-0, zero-byte, and every malformed schema fixture fail closed without mutation', async () => {
  const fixtures = [
    ['future-schema', async (stateDir) => createDatabase(stateDir, (db) => db.exec('CREATE TABLE fictional_future (id TEXT) STRICT; PRAGMA user_version = 99;'))],
    ['unversioned-schema', async (stateDir) => createDatabase(stateDir, (db) => db.exec('CREATE TABLE fictional_unversioned (id TEXT) STRICT;'))],
    ['unversioned-schema', async (stateDir) => {
      const databasePath = resolveCommandCenterDatabasePath(stateDir);
      await mkdir(path.dirname(databasePath), { recursive: true });
      await writeFile(databasePath, Buffer.alloc(0));
    }],
    ...malformedFixtures.map(([, setup]) => ['malformed-schema', async (stateDir) => createDatabase(stateDir, setup)])
  ];
  for (const [expectedCode, setup] of fixtures) {
    await withState(async (stateDir) => {
      await setup(stateDir);
      await assertRecoveryPreservesFixture(stateDir, expectedCode);
    });
  }
});

test('integrity-failing and corrupt databases receive distinct diagnostics and remain byte-for-byte unchanged', async () => {
  await withState(async (stateDir) => {
    const { databasePath, result } = await createDatabase(stateDir, (database) => {
      database.exec(metadataSchemaSql);
      return {
        rootPage: database.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'topics'").get().rootpage,
        pageSize: database.prepare('PRAGMA page_size').get().page_size
      };
    });
    const bytes = await readFile(databasePath);
    bytes[(result.rootPage - 1) * result.pageSize] = 0;
    await writeFile(databasePath, bytes);
    await assertRecoveryPreservesFixture(stateDir, 'integrity-failure');
  });

  await withState(async (stateDir) => {
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(databasePath, Buffer.from('fictional-corrupt-input'));
    await assertRecoveryPreservesFixture(stateDir, 'corrupt-storage');
  });
});

test('oversized sparse databases inspect only their fixed header before SQLite preflight', async () => {
  await withState(async (stateDir) => {
    const { databasePath } = await createDatabase(stateDir, (database) => database.exec(metadataSchemaSql));
    await truncate(databasePath, 5 * 1024 * 1024 * 1024);
    const beforeSize = (await stat(databasePath)).size;
    const service = openCommandCenterMetadataService({ stateDir });
    const status = service.getOperatingStatus();
    assert.equal(status.mode, 'ready');
    assert.deepEqual(status.diagnostics, []);
    service.close();
    assert.equal((await stat(databasePath)).size, beforeSize);
  });
});

test('an unreadable existing regular database is an access failure and remains untouched', async () => {
  await withState(async (stateDir) => {
    const { databasePath } = await createDatabase(stateDir, (database) => database.exec(metadataSchemaSql));
    const beforeBytes = await readFile(databasePath);
    await chmod(databasePath, 0o000);
    const beforeMtime = (await stat(databasePath)).mtimeMs;
    const beforeSiblings = (await readdir(path.dirname(databasePath))).sort();
    try {
      const service = openCommandCenterMetadataService({ stateDir });
      assert.equal(service.getOperatingStatus().diagnostics[0].code, 'storage-access-failure');
      assert.throws(() => service.setProjectionBookkeeping({ projectionId: 'blocked', sourceRevision: 'blocked', inputDigest: 'blocked' }), (error) => error.code === 'recovery-only');
      service.close();
    } finally {
      await chmod(databasePath, 0o600);
    }
    assert.deepEqual(await readFile(databasePath), beforeBytes);
    assert.equal((await stat(databasePath)).mtimeMs, beforeMtime);
    assert.deepEqual((await readdir(path.dirname(databasePath))).sort(), beforeSiblings);
  });
});

test('an existing database below an inaccessible directory is an access failure, not a creation failure', async () => {
  await withState(async (stateDir) => {
    const { databasePath } = await createDatabase(stateDir, (database) => database.exec(metadataSchemaSql));
    const databaseDirectory = path.dirname(databasePath);
    const beforeBytes = await readFile(databasePath);
    const beforeMtime = (await stat(databasePath)).mtimeMs;
    const beforeSiblings = (await readdir(databaseDirectory)).sort();
    await chmod(databaseDirectory, 0o000);
    try {
      const service = openCommandCenterMetadataService({ stateDir });
      assert.equal(service.getOperatingStatus().diagnostics[0].code, 'storage-access-failure');
      assert.throws(() => service.createTopic({ topicId: 'blocked-topic', paraCategory: 'area', lifecycle: 'active' }), (error) => error.code === 'recovery-only');
      service.close();
    } finally {
      await chmod(databaseDirectory, 0o700);
    }
    assert.deepEqual(await readFile(databasePath), beforeBytes);
    assert.equal((await stat(databasePath)).mtimeMs, beforeMtime);
    assert.deepEqual((await readdir(databaseDirectory)).sort(), beforeSiblings);
  });
});

test('a genuinely uncreatable plugin storage path reports a creation failure', async () => {
  await withState(async (stateDir) => {
    await writeFile(path.join(stateDir, 'plugins'), 'fictional path obstruction');
    const service = openCommandCenterMetadataService({ stateDir });
    assert.equal(service.getOperatingStatus().mode, 'recovery-only');
    assert.equal(service.getOperatingStatus().diagnostics[0].code, 'storage-creation-failure');
    assert.throws(() => service.setPolicyVersion({ policyId: 'blocked', version: 'v1', digest: 'blocked' }), (error) => error.code === 'recovery-only');
    service.close();
    assert.equal(await readFile(path.join(stateDir, 'plugins'), 'utf8'), 'fictional path obstruction');
  });
});
