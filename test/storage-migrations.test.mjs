import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { metadataSchemaV1Sql, metadataSchemaV2Sql } from '../src/metadata/schema.mjs';
import { resolveCommandCenterDatabasePath, resolveCommandCenterRecoveryMigrationPath } from '../src/metadata/path.mjs';
import { MIGRATION_DIGEST, MIGRATION_ID, V1_TO_V2_MIGRATION_DIGEST, V1_TO_V2_MIGRATION_ID } from '../src/metadata/migration-ledger.mjs';
import { applyV1ToV2Migration } from '../src/metadata/migration-ledger.mjs';
import { ensureRecoverySnapshot, expectedRollbackRelease, verifyRollbackMaterial } from '../src/metadata/recovery.mjs';

const openServices = new Set();
const migrationTestHooks = Symbol.for('openclaw.command-center.test.migration-hooks');
const availableCapabilities = Object.freeze({ notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true });
function open(options) {
  const service = openCommandCenterMetadataService({ ...options, capabilities: options.capabilities ?? availableCapabilities });
  openServices.add(service);
  return service;
}

async function withState(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migrations-'));
  try { return await run(stateDir); } finally {
    for (const service of openServices) service.close();
    openServices.clear();
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function seedV1(stateDir) {
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(metadataSchemaV1Sql);
    database.prepare('INSERT INTO topics (topic_id, para_category, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('topic-migration', 'area', 'active', 'fictional-created', 'fictional-created');
    database.prepare('INSERT INTO policy_versions (policy_id, version, digest, updated_at) VALUES (?, ?, ?, ?)').run('policy-migration', 'v1', 'fictional-digest', 'fictional-updated');
  } finally { database.close(); }
  return databasePath;
}

async function seedV2(stateDir) {
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try { database.exec(metadataSchemaV2Sql); } finally { database.close(); }
  return databasePath;
}

async function seedBaselineMigratedV2(stateDir) {
  const databasePath = await seedV1(stateDir);
  const material = ensureRecoverySnapshot({ stateDir, databasePath });
  const manifest = JSON.parse(await readFile(material.manifestPath, 'utf8'));
  manifest.targetRelease.commandCenterSchema = { readable: { min: 1, max: 2 }, migratable: { min: 1, max: 1 }, writable: { min: 2, max: 2 } };
  await writeFile(material.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const database = new DatabaseSync(databasePath);
  try { applyV1ToV2Migration(database, { snapshotId: material.manifest.snapshotId }); } finally { database.close(); }
  return databasePath;
}

test('schema-2 stores retain and reuse baseline schema-1 recovery evidence during ordered upgrade', async () => {
  await withState(async (stateDir) => {
    const databasePath = await seedBaselineMigratedV2(stateDir);
    const service = open({ stateDir });
    assert.equal(service.getOperatingStatus().mode, 'ready');
    service.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.deepEqual(database.prepare('SELECT sequence, from_version, to_version FROM schema_migrations ORDER BY sequence').all().map((row) => ({ ...row })), [{ sequence: 1, from_version: 1, to_version: 2 }, { sequence: 2, from_version: 2, to_version: 3 }]); } finally { database.close(); }
  });
});

test('direct schema-2 to schema-3 migration retains a verified snapshot and valid first ledger row', async () => {
  await withState(async (stateDir) => {
    const databasePath = await seedV2(stateDir);
    const service = open({ stateDir });
    assert.equal(service.getOperatingStatus().mode, 'ready');
    service.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(database.prepare('SELECT sequence, from_version, to_version FROM schema_migrations').all().map((row) => ({ ...row })), [{ sequence: 1, from_version: 2, to_version: 3 }]);
    } finally { database.close(); }
    const manifest = JSON.parse(await readFile(path.join(resolveCommandCenterRecoveryMigrationPath(stateDir), 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'committed');
    const priorRelease = expectedRollbackRelease(stateDir);
    const verification = verifyRollbackMaterial(stateDir, { snapshotId: manifest.snapshotId, priorRelease }, databasePath);
    assert.deepEqual(verification.priorRelease, priorRelease);
    assert.equal(verification.sourceSchema, 2);
  });
});

test('direct schema-2 migration reconciles prepared recovery material after transaction boundaries', async () => {
  for (const boundary of ['after-commit', 'before-commit']) {
    await withState(async (stateDir) => {
      const databasePath = await seedV2(stateDir);
      const args = [fileURLToPath(new URL('./fixtures/migration-crash.mjs', import.meta.url)), stateDir];
      if (boundary === 'before-commit') args.push('before-commit');
      const child = spawnSync(process.execPath, args, { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });
      assert.notEqual(child.status, 0, child.stderr);
      const manifestPath = path.join(resolveCommandCenterRecoveryMigrationPath(stateDir), 'manifest.json');
      assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'prepared');
      const restarted = open({ stateDir });
      assert.equal(restarted.getOperatingStatus().mode, 'ready', `${boundary}: ${JSON.stringify(restarted.getOperatingStatus())}`);
      restarted.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try { assert.equal(database.prepare('PRAGMA user_version').get().user_version, 3); } finally { database.close(); }
      assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'committed');
    });
  }
});

test('ordered v1 to v3 migration preserves application data and records contiguous ledger rows', async () => {
  await withState(async (stateDir) => {
    const databasePath = await seedV1(stateDir);
    const service = open({ stateDir });
    assert.deepEqual(service.getOperatingStatus(), { mode: 'ready', schemaVersion: 3, diagnostics: [], unavailableCapabilities: [] });
    assert.equal(service.getTopic('topic-migration').paraCategory, 'area');
    assert.equal(service.getPolicyVersion('policy-migration').digest, 'fictional-digest');
    service.close();

    let ledgerSnapshotId;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 3);
      const ledgerRows = database.prepare('SELECT sequence, migration_id, migration_digest, from_version, to_version, snapshot_id, applied_build FROM schema_migrations').all().map((row) => ({ ...row }));
      assert.equal(ledgerRows.length, 2);
      ledgerSnapshotId = ledgerRows[0].snapshot_id;
      assert.match(ledgerSnapshotId, /^sha256:[a-f0-9]{64}$/u);
      assert.deepEqual({ ...ledgerRows[0], snapshot_id: undefined }, {
        sequence: 1,
        migration_id: V1_TO_V2_MIGRATION_ID,
        migration_digest: V1_TO_V2_MIGRATION_DIGEST,
        from_version: 1,
        to_version: 2,
        snapshot_id: undefined,
        applied_build: '0.2.0'
      });
      assert.deepEqual({ ...ledgerRows[1], snapshot_id: undefined }, {
        sequence: 2,
        migration_id: MIGRATION_ID,
        migration_digest: MIGRATION_DIGEST,
        from_version: 2,
        to_version: 3,
        snapshot_id: undefined,
        applied_build: '0.2.0'
      });
    } finally { database.close(); }

    const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
    assert.deepEqual((await readdir(recoveryDirectory)).sort(), ['manifest.json', 'metadata.sqlite.snapshot']);
    assert.equal((await stat(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'))).isFile(), true);
    const manifest = JSON.parse(await readFile(path.join(recoveryDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'committed');
    assert.equal(manifest.snapshotId, ledgerSnapshotId);
    assert.equal(manifest.snapshotId, manifest.snapshot.sha256);
    assert.equal(manifest.snapshotFile, 'metadata.sqlite.snapshot');
    assert.equal(manifest.sourceRelease.package.version, '0.1.0');
    assert.equal(manifest.targetRelease.package.version, '0.2.0');
    const snapshotBytes = await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'));

    const reopened = open({ stateDir });
    assert.deepEqual(reopened.getOperatingStatus(), { mode: 'ready', schemaVersion: 3, diagnostics: [], unavailableCapabilities: [] });
    reopened.close();
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot')), snapshotBytes);
    assert.deepEqual((await readdir(path.dirname(databasePath))).filter((name) => !name.startsWith('.')), ['metadata.sqlite', 'recovery']);
  });
});

test('transactional migration failure leaves schema-v1 durable and retry reuses the published snapshot', async () => {
  await withState(async (stateDir) => {
    const databasePath = await seedV1(stateDir);
    let failure = true;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    let failed;
    try {
      failed = open({
        stateDir,
        [migrationTestHooks]: {
          beforeCommit() {
            if (failure) {
              failure = false;
              throw new Error('fictional transactional failure');
            }
          }
        }
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    assert.equal(failed.getOperatingStatus().mode, 'recovery-only');
    assert.equal(failed.getOperatingStatus().diagnostics[0].code, 'migration-failed');
    failed.close();

    const afterFailure = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(afterFailure.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(afterFailure.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(afterFailure.prepare("SELECT para_category FROM topics WHERE topic_id = 'topic-migration'").get().para_category, 'area');
      assert.equal(afterFailure.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
    } finally { afterFailure.close(); }
    const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
    const snapshotBeforeRetry = await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'));

    const recovered = open({ stateDir });
    assert.equal(recovered.getOperatingStatus().mode, 'ready');
    assert.equal(recovered.getTopic('topic-migration').paraCategory, 'area');
    recovered.close();
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot')), snapshotBeforeRetry);
  });
});

test('a process interruption after the SQLite commit reconciles the prepared snapshot on restart', async () => {
  await withState(async (stateDir) => {
    const databasePath = await seedV1(stateDir);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/migration-crash.mjs', import.meta.url)), stateDir], {
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8'
    });
    assert.notEqual(child.status, 0, child.stderr);

    const committedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(committedDatabase.prepare('PRAGMA user_version').get().user_version, 3); } finally { committedDatabase.close(); }
    const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
    assert.equal(JSON.parse(await readFile(path.join(recoveryDirectory, 'manifest.json'), 'utf8')).state, 'prepared');

    const restarted = open({ stateDir });
    assert.equal(restarted.getOperatingStatus().mode, 'ready');
    restarted.close();
    assert.equal(JSON.parse(await readFile(path.join(recoveryDirectory, 'manifest.json'), 'utf8')).state, 'committed');
  });
});

test('a process interruption inside the SQLite transaction rolls back cleanly and reuses the snapshot on restart', async () => {
  await withState(async (stateDir) => {
    const databasePath = await seedV1(stateDir);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/migration-crash.mjs', import.meta.url)), stateDir, 'before-commit'], {
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8'
    });
    assert.notEqual(child.status, 0, child.stderr);

    const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
    const snapshotBeforeRestart = await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'));
    assert.equal(JSON.parse(await readFile(path.join(recoveryDirectory, 'manifest.json'), 'utf8')).state, 'prepared');

    const restarted = open({ stateDir });
    assert.equal(restarted.getOperatingStatus().mode, 'ready');
    assert.equal(restarted.getTopic('topic-migration').paraCategory, 'area');
    restarted.close();
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot')), snapshotBeforeRestart);

    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(migratedDatabase.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(migratedDatabase.prepare('PRAGMA user_version').get().user_version, 3);
      assert.equal(migratedDatabase.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 2);
    } finally { migratedDatabase.close(); }
  });
});

test('an obstructed pre-migration recovery path blocks migration without changing schema 1', async () => {
  await withState(async (stateDir) => {
    const databasePath = await seedV1(stateDir);
    const before = await readFile(databasePath);
    const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
    await mkdir(path.dirname(recoveryDirectory), { recursive: true });
    await mkdir(recoveryDirectory);

    const blocked = open({ stateDir });
    assert.equal(blocked.getOperatingStatus().mode, 'recovery-only');
    assert.equal(blocked.getOperatingStatus().diagnostics[0].code, 'recovery-material-missing');
    blocked.close();
    assert.deepEqual(await readFile(databasePath), before);
  });
});

test('a linked recovery path cannot publish snapshot material outside the plugin state tree', async () => {
  await withState(async (stateDir) => {
    const databasePath = await seedV1(stateDir);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'command-center-outside-recovery-'));
    try {
      const migrationDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
      const recoveryDirectory = path.dirname(path.dirname(migrationDirectory));
      await mkdir(path.dirname(recoveryDirectory), { recursive: true });
      await symlink(outside, recoveryDirectory, process.platform === 'win32' ? 'junction' : 'dir');

      const blocked = open({ stateDir });
      assert.equal(blocked.getOperatingStatus().mode, 'recovery-only');
      assert.equal(blocked.getOperatingStatus().diagnostics[0].code, 'recovery-material-obstructed');
      blocked.close();
      assert.deepEqual(await readdir(outside), []);

      const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(sourceDatabase.prepare('PRAGMA user_version').get().user_version, 1);
        assert.equal(sourceDatabase.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
      } finally { sourceDatabase.close(); }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('fresh schema-3 storage does not invent a migration snapshot and can reopen after a successful commit', async () => {
  await withState(async (stateDir) => {
    const service = open({ stateDir });
    assert.equal(service.getOperatingStatus().schemaVersion, 3);
    service.close();
    assert.deepEqual(await readdir(path.dirname(resolveCommandCenterDatabasePath(stateDir))), ['metadata.sqlite']);
    const reopened = open({ stateDir });
    assert.equal(reopened.getOperatingStatus().mode, 'ready');
    reopened.close();
  });
});
