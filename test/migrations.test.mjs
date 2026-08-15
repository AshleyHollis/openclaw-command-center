import assert from 'node:assert/strict';
import test from 'node:test';
import { compatibilityTuple } from '../src/compatibility.mjs';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { migrationCatalog, migrationChecksum } from '../src/persistence/migrations.mjs';
import { PLUGIN_BUILD } from '../src/persistence/schema.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 26200;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}

function bridge(world, options) {
  return createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive, ...options });
}

function schemaTwoCompatibility() {
  const value = structuredClone(compatibilityTuple);
  value.commandCenterSchema.readable.max = 2;
  value.commandCenterSchema.writable.max = 2;
  return value;
}

function migrationTwo({ destructive = false, statements = ['CREATE TABLE fictional_migration_two (id INTEGER PRIMARY KEY)'] } = {}) {
  const migration = { version: 2, id: 'fictional-metadata-v2', destructive, compatiblePluginBuild: PLUGIN_BUILD, statements };
  return Object.freeze({ ...migration, checksum: migrationChecksum(migration) });
}

async function establishVersionOne(world) {
  const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
  assert.equal((await service.initialize()).mode, 'Ready');
  await service.close();
}

test('clean creation records the immutable initial migration and ordered public upgrade is durable', async () => {
  await withIsolatedWorld(async (world) => {
    await establishVersionOne(world);
    const second = migrationTwo();
    const upgraded = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: schemaTwoCompatibility(), catalog: [...migrationCatalog, second] });
    assert.equal((await upgraded.initialize()).mode, 'Ready');
    const state = upgraded.getMigrationStatus();
    assert.equal(state.schemaVersion, 2);
    assert.deepEqual(state.ledger.map((entry) => entry.version), [1, 2]);
    assert.deepEqual(state.ledger.map((entry) => entry.migration_id), ['command-center-metadata-initial-v1', 'fictional-metadata-v2']);
    await upgraded.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('transaction failure is restart-safe: prior migration remains, failed transition is absent, and retry commits once', async () => {
  await withIsolatedWorld(async (world) => {
    await establishVersionOne(world);
    const failed = migrationTwo({ statements: ['CREATE TABLE fictional_rolled_back (id INTEGER PRIMARY KEY)', 'INSERT INTO imaginary_table VALUES (1)'] });
    const unsuccessful = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: schemaTwoCompatibility(), catalog: [...migrationCatalog, failed] });
    assert.equal((await unsuccessful.initialize()).mode, 'Recovery-only');
    await unsuccessful.close();
    // Restart through the public service sees exactly the committed v1 state.
    const prior = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await prior.initialize()).mode, 'Ready');
    assert.equal(prior.getMigrationStatus().schemaVersion, 1);
    await prior.close();
    const retry = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: schemaTwoCompatibility(), catalog: [...migrationCatalog, migrationTwo()] });
    assert.equal((await retry.initialize()).mode, 'Ready');
    assert.equal(retry.getMigrationStatus().schemaVersion, 2);
    await retry.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('a pre-commit interruption rolls back the whole transition and restart does not replay committed work', async () => {
  await withIsolatedWorld(async (world) => {
    await establishVersionOne(world);
    const catalog = [...migrationCatalog, migrationTwo()];
    const interrupted = createPersistenceService({
      stateDirectory: world.paths.state,
      archiveBridge: bridge(world),
      compatibility: schemaTwoCompatibility(),
      catalog,
      beforeCommit: async (migration) => { if (migration.version === 2) throw new Error('fictional interruption before commit'); }
    });
    assert.equal((await interrupted.initialize()).mode, 'Recovery-only');
    await interrupted.close();
    const retry = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: schemaTwoCompatibility(), catalog });
    assert.equal((await retry.initialize()).mode, 'Ready');
    assert.deepEqual(retry.getMigrationStatus().ledger.map((entry) => entry.version), [1, 2]);
    await retry.close();
    const reopened = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: schemaTwoCompatibility(), catalog });
    assert.equal((await reopened.initialize()).mode, 'Ready');
    assert.equal(reopened.getMigrationStatus().ledger.length, 2);
    await reopened.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('concurrent initializers apply each transition once and an older catalog refuses a newer schema without mutation', async () => {
  await withIsolatedWorld(async (world) => {
    await establishVersionOne(world);
    const catalog = [...migrationCatalog, migrationTwo()];
    const options = { stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: schemaTwoCompatibility(), catalog };
    const left = createPersistenceService(options);
    const right = createPersistenceService(options);
    const states = await Promise.all([left.initialize(), right.initialize()]);
    assert.deepEqual(states.map((state) => state.mode), ['Ready', 'Ready']);
    assert.equal(left.getMigrationStatus().ledger.length, 2);
    assert.equal(right.getMigrationStatus().ledger.length, 2);
    await left.close();
    await right.close();
    const older = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await older.initialize()).mode, 'Recovery-only');
    assert.match(older.getDiagnostics().checks[0].guidance, /down-migrations/);
    await older.close();
    const compatible = createPersistenceService(options);
    assert.equal((await compatible.initialize()).mode, 'Ready');
    assert.equal(compatible.getMigrationStatus().schemaVersion, 2);
    await compatible.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('declared destructive migrations require a verified normal broad-archive receipt before statements or ledger changes', async () => {
  await withIsolatedWorld(async (world) => {
    await establishVersionOne(world);
    const destructive = migrationTwo({ destructive: true });
    const options = { stateDirectory: world.paths.state, compatibility: schemaTwoCompatibility(), catalog: [...migrationCatalog, destructive] };
    const unavailable = createPersistenceService({ ...options, archiveBridge: { protocolVersion: 1 } });
    assert.equal((await unavailable.initialize()).mode, 'Recovery-only');
    await unavailable.close();
    const stillVersionOne = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await stillVersionOne.initialize()).mode, 'Ready');
    assert.equal(stillVersionOne.getMigrationStatus().schemaVersion, 1);
    await stillVersionOne.close();

    const rejectedReceipt = createPersistenceService({ ...options, archiveBridge: bridge(world, { verify: () => false }) });
    assert.equal((await rejectedReceipt.initialize()).mode, 'Recovery-only');
    await rejectedReceipt.close();
    const mismatchedReceipt = createPersistenceService({ ...options, archiveBridge: {
      protocolVersion: 1,
      createSnapshot: async () => ({ complete: true, bindings: { fictional: 'mismatch' } }),
      verifySnapshot: async () => true
    } });
    assert.equal((await mismatchedReceipt.initialize()).mode, 'Recovery-only');
    await mismatchedReceipt.close();
    const snapshotBridge = bridge(world);
    const upgraded = createPersistenceService({ ...options, archiveBridge: snapshotBridge });
    assert.equal((await upgraded.initialize()).mode, 'Ready');
    assert.equal(snapshotBridge.captures.length, 1);
    assert.equal(upgraded.getMigrationStatus().schemaVersion, 2);
    await upgraded.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
