import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import canonical from '../src/compatibility-tuple.json' with { type: 'json' };
import { openCommandCenterMetadataService, CommandCenterMetadataError } from '../src/metadata/service.mjs';
import { metadataSchemaV1Sql } from '../src/metadata/schema.mjs';
import { resolveCommandCenterDatabasePath, resolveCommandCenterRecoveryMigrationPath } from '../src/metadata/path.mjs';

const openServices = new Set();
const availableCapabilities = Object.freeze({ notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true });
function open(options) {
  const service = openCommandCenterMetadataService({ ...options, capabilities: options.capabilities ?? availableCapabilities });
  openServices.add(service);
  return service;
}

async function withState(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-recovery-'));
  try { return await run(stateDir); } finally {
    for (const service of openServices) service.close();
    openServices.clear();
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function migratedState(stateDir, { topicId = 'topic-recovery', paraCategory = 'project' } = {}) {
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(metadataSchemaV1Sql);
  database.prepare('INSERT INTO topics VALUES (?, ?, ?, ?, ?)').run(topicId, paraCategory, 'active', 'fictional-created', 'fictional-created');
  database.close();
  const service = open({ stateDir });
  assert.equal(service.getOperatingStatus().mode, 'ready');
  service.close();
  return {
    databasePath,
    recoveryDirectory: resolveCommandCenterRecoveryMigrationPath(stateDir)
  };
}

test('verified rollback snapshot is reusable, exact, and non-mutating', async () => {
  await withState(async (stateDir) => {
    const { recoveryDirectory } = await migratedState(stateDir);
    const service = open({ stateDir });
    const beforeManifest = await readFile(path.join(recoveryDirectory, 'manifest.json'));
    const beforeSnapshot = await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'));
    const snapshotId = JSON.parse(beforeManifest).snapshotId;
    const verification = service.verifyRollbackSnapshot({
      snapshotId,
      priorRelease: canonical.priorRelease
    });
    assert.equal(verification.verified, true);
    assert.equal(verification.sourceSchema, 1);
    assert.equal(verification.priorRelease.package.version, '0.1.0');
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'manifest.json')), beforeManifest);
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot')), beforeSnapshot);
    service.close();
  });
});

test('a normal broad state archive captures and restores the database and recovery material', async () => {
  await withState(async (stateDir) => {
    const archiveRoot = await mkdtemp(path.join(os.tmpdir(), 'command-center-broad-archive-'));
    try {
      const { databasePath, recoveryDirectory } = await migratedState(stateDir);
      const archivedState = path.join(archiveRoot, 'state');
      await cp(stateDir, archivedState, { recursive: true });
      assert.equal((await readFile(path.join(archivedState, path.relative(stateDir, databasePath)))).length > 0, true);
      assert.equal((await readFile(path.join(archivedState, path.relative(stateDir, recoveryDirectory), 'manifest.json'))).length > 0, true);
      assert.equal((await readFile(path.join(archivedState, path.relative(stateDir, recoveryDirectory), 'metadata.sqlite.snapshot'))).length > 0, true);

      await rm(stateDir, { recursive: true, force: true });
      await cp(archivedState, stateDir, { recursive: true });
      const restored = open({ stateDir });
      assert.equal(restored.getOperatingStatus().mode, 'ready');
      assert.equal(restored.getTopic('topic-recovery').paraCategory, 'project');
      restored.close();
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });
});

test('recovery material from a different database is rejected by startup and rollback verification', async () => {
  await withState(async (stateDir) => {
    const otherStateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-other-store-'));
    try {
      const first = await migratedState(stateDir, { topicId: 'topic-first', paraCategory: 'area' });
      const second = await migratedState(otherStateDir, { topicId: 'topic-second', paraCategory: 'resource' });
      const swappedManifest = JSON.parse(await readFile(path.join(second.recoveryDirectory, 'manifest.json'), 'utf8'));
      await rm(first.recoveryDirectory, { recursive: true, force: true });
      await cp(second.recoveryDirectory, first.recoveryDirectory, { recursive: true });

      const mixed = open({ stateDir });
      assert.equal(mixed.getOperatingStatus().mode, 'recovery-only');
      assert.equal(mixed.getOperatingStatus().diagnostics[0].code, 'recovery-ledger-mismatch');
      assert.throws(() => mixed.verifyRollbackSnapshot({
        snapshotId: swappedManifest.snapshotId,
        priorRelease: canonical.priorRelease
      }), (error) => error instanceof CommandCenterMetadataError && error.code === 'rollback-database-mismatch');
      mixed.close();
    } finally {
      await rm(otherStateDir, { recursive: true, force: true });
    }
  });
});

test('existing recovery material linked outside state is rejected on every restart without mutation', async () => {
  await withState(async (stateDir) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'command-center-linked-recovery-'));
    try {
      const { databasePath, recoveryDirectory } = await migratedState(stateDir);
      const recoveryRoot = path.dirname(path.dirname(recoveryDirectory));
      const outsideRecovery = path.join(outside, 'recovery');
      await rename(recoveryRoot, outsideRecovery);
      await symlink(outsideRecovery, recoveryRoot, process.platform === 'win32' ? 'junction' : 'dir');
      const beforeDatabase = await readFile(databasePath);
      const beforeManifest = await readFile(path.join(outsideRecovery, 'migrations', path.basename(recoveryDirectory), 'manifest.json'));

      const blocked = open({ stateDir });
      assert.equal(blocked.getOperatingStatus().mode, 'recovery-only');
      assert.equal(blocked.getOperatingStatus().diagnostics[0].code, 'recovery-material-obstructed');
      assert.throws(() => blocked.verifyRollbackSnapshot({ snapshotId: 'sha256:' + '0'.repeat(64), priorRelease: canonical.priorRelease }), (error) => error.code === 'recovery-material-obstructed');
      blocked.close();

      assert.deepEqual(await readFile(databasePath), beforeDatabase);
      assert.deepEqual(await readFile(path.join(outsideRecovery, 'migrations', path.basename(recoveryDirectory), 'manifest.json')), beforeManifest);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('rollback verification rejects every compatibility mismatch without filesystem effects', async () => {
  await withState(async (stateDir) => {
    const { recoveryDirectory } = await migratedState(stateDir);
    const service = open({ stateDir });
    const before = {
      manifest: await readFile(path.join(recoveryDirectory, 'manifest.json')),
      snapshot: await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'))
    };
    const snapshotId = JSON.parse(before.manifest).snapshotId;
    const mismatches = [
      ['snapshot', { snapshotId: 'fictional-other-snapshot', priorRelease: canonical.priorRelease }],
      ['package', { snapshotId, priorRelease: { ...canonical.priorRelease, package: { ...canonical.priorRelease.package, name: 'other-plugin' } } }],
      ['build', { snapshotId, priorRelease: { ...canonical.priorRelease, package: { ...canonical.priorRelease.package, build: '0.1.1' } } }],
      ['schema-range', { snapshotId, priorRelease: { ...canonical.priorRelease, commandCenterSchema: { readable: { min: 1, max: 2 }, writable: { min: 1, max: 1 } } } }],
      ['host', { snapshotId, priorRelease: { ...canonical.priorRelease, host: { range: '=fictional-host' } } }],
      ['plugin-api', { snapshotId, priorRelease: { ...canonical.priorRelease, pluginApi: { package: 'openclaw', range: '=fictional-api' } } }],
      ['bridge', { snapshotId, priorRelease: { ...canonical.priorRelease, capabilityBridgeProtocol: { min: 1, max: 2 } } }]
    ];
    for (const [label, input] of mismatches) {
      assert.throws(() => service.verifyRollbackSnapshot(input), (error) => error instanceof CommandCenterMetadataError && error.code.startsWith('rollback-'), label);
    }
    service.close();
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'manifest.json')), before.manifest);
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot')), before.snapshot);
  });
});

test('restored schema-v1 snapshot is detected as rollback and all public mutations remain blocked', async () => {
  await withState(async (stateDir) => {
    const { databasePath, recoveryDirectory } = await migratedState(stateDir);
    await copyFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'), databasePath);
    const beforeDatabase = await readFile(databasePath);
    const beforeRecovery = await readdir(recoveryDirectory);
    const service = open({ stateDir });
    assert.equal(service.getOperatingStatus().diagnostics[0].code, 'rollback-snapshot-detected');
    const mutations = [
      () => service.createTopic({ topicId: 'blocked', paraCategory: 'area', lifecycle: 'active' }),
      () => service.updateTopic({ topicId: 'blocked', paraCategory: 'resource' }),
      () => service.deleteTopic('blocked'),
      () => service.setPolicyVersion({ policyId: 'blocked', version: 'v1', digest: 'fictional' }),
      () => service.setProjectionBookkeeping({ projectionId: 'blocked', sourceRevision: 'v1', inputDigest: 'fictional' }),
      () => service.setConventionState({ referenceId: 'blocked', aspect: 'name', state: 'managed' }),
      () => service.createAttentionActivityLink({ linkId: 'blocked', attentionId: 'a', activityId: 'b' })
    ];
    for (const mutate of mutations) assert.throws(mutate, (error) => error.code === 'recovery-only');
    service.close();
    assert.deepEqual(await readFile(databasePath), beforeDatabase);
    assert.deepEqual(await readdir(recoveryDirectory), beforeRecovery);
  });
});

test('missing, malformed, hashed, and symlinked recovery material fail closed without overwriting evidence', async () => {
  await withState(async (stateDir) => {
    const { databasePath, recoveryDirectory } = await migratedState(stateDir);
    const snapshotPath = path.join(recoveryDirectory, 'metadata.sqlite.snapshot');
    const manifestPath = path.join(recoveryDirectory, 'manifest.json');
    const originalSnapshot = await readFile(snapshotPath);
    const originalManifest = await readFile(manifestPath);
    await writeFile(manifestPath, JSON.stringify({ formatVersion: 1 }));
    const malformed = open({ stateDir });
    assert.equal(malformed.getOperatingStatus().diagnostics[0].code, 'recovery-manifest-invalid');
    malformed.close();
    assert.deepEqual(await readFile(snapshotPath), originalSnapshot);

    await writeFile(manifestPath, originalManifest);
    await chmod(snapshotPath, 0o644);
    await writeFile(snapshotPath, Buffer.concat([originalSnapshot, Buffer.from('fictional-corruption')]));
    const hashed = open({ stateDir });
    assert.equal(hashed.getOperatingStatus().diagnostics[0].code, 'recovery-integrity-failure');
    hashed.close();
    await writeFile(snapshotPath, originalSnapshot);

    await rm(manifestPath);
    const missing = open({ stateDir });
    assert.equal(missing.getOperatingStatus().diagnostics[0].code, 'recovery-material-missing');
    missing.close();
    await writeFile(manifestPath, originalManifest);

    await rm(snapshotPath);
    await symlink(path.basename(databasePath), snapshotPath);
    const obstructed = open({ stateDir });
    assert.equal(obstructed.getOperatingStatus().diagnostics[0].code, 'recovery-material-obstructed');
    obstructed.close();
  });
});
