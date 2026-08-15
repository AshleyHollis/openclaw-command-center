import assert from 'node:assert/strict';
import test from 'node:test';
import { compatibilityTuple } from '../src/compatibility.mjs';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { migrationCatalog, migrationChecksum } from '../src/persistence/migrations.mjs';
import { PLUGIN_BUILD } from '../src/persistence/schema.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 27500;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}
function bridge(world) { return createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive }); }
function schemaThreeCompatibility() {
  const tuple = structuredClone(compatibilityTuple);
  tuple.commandCenterSchema.readable.max = 3;
  tuple.commandCenterSchema.writable.max = 3;
  return tuple;
}
function secondMigration() {
  const migration = { version: 3, id: 'fictional-commit-failure-v3', destructive: false, compatiblePluginBuild: PLUGIN_BUILD, statements: ['CREATE TABLE fictional_commit_probe (id INTEGER PRIMARY KEY)'] };
  return Object.freeze({ ...migration, checksum: migrationChecksum(migration) });
}

test('a commit failure rolls back migration DDL and ledger together through the public service', async () => {
  await withIsolatedWorld(async (world) => {
    const initial = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await initial.initialize();
    await initial.close();
    const catalog = [...migrationCatalog, secondMigration()];
    const failure = createPersistenceService({
      stateDirectory: world.paths.state,
      archiveBridge: bridge(world),
      compatibility: schemaThreeCompatibility(),
      catalog,
      commitMigration: () => { throw new Error('fictional commit failure'); }
    });
    assert.equal((await failure.initialize()).mode, 'Recovery-only');
    await failure.close();
    const prior = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await prior.initialize()).mode, 'Ready');
    assert.equal(prior.getMigrationStatus().schemaVersion, 2);
    await prior.close();
    const retry = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: schemaThreeCompatibility(), catalog });
    assert.equal((await retry.initialize()).mode, 'Ready');
    assert.equal(retry.getMigrationStatus().schemaVersion, 3);
    await retry.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
