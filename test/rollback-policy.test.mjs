import assert from 'node:assert/strict';
import test from 'node:test';
import { compatibilityTuple } from '../src/compatibility.mjs';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { migrationCatalog, migrationChecksum } from '../src/persistence/migrations.mjs';
import { PLUGIN_BUILD } from '../src/persistence/schema.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 27700;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}
function schemaThreeCompatibility() {
  const tuple = structuredClone(compatibilityTuple);
  tuple.commandCenterSchema.readable.max = 3;
  tuple.commandCenterSchema.writable.max = 3;
  return tuple;
}
function destructiveMigration() {
  const migration = { version: 3, id: 'fictional-rollback-v3', destructive: true, compatiblePluginBuild: PLUGIN_BUILD, statements: ['CREATE TABLE fictional_rollback_probe (id INTEGER PRIMARY KEY)'] };
  return Object.freeze({ ...migration, checksum: migrationChecksum(migration) });
}

test('rollback policy preserves newer schemas and directs operators to verified archive plus compatible prior code', async () => {
  await withIsolatedWorld(async (world) => {
    const bridge = createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive });
    const initial = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge });
    await initial.initialize();
    await initial.close();
    const catalog = [...migrationCatalog, destructiveMigration()];
    const upgraded = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge, compatibility: schemaThreeCompatibility(), catalog });
    assert.equal((await upgraded.initialize()).mode, 'Ready');
    assert.equal(bridge.captures.length, 1);
    assert.equal(upgraded.getMigrationStatus().schemaVersion, 3);
    await upgraded.close();
    const older = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge });
    assert.equal((await older.initialize()).mode, 'Recovery-only');
    assert.match(older.getDiagnostics().rollbackGuidance, /verified broad-archive snapshot/);
    assert.match(older.getDiagnostics().rollbackGuidance, /prior compatible Command Center release/);
    await older.close();
    const compatible = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge, compatibility: schemaThreeCompatibility(), catalog });
    assert.equal((await compatible.initialize()).mode, 'Ready');
    assert.equal(compatible.getMigrationStatus().schemaVersion, 3);
    await compatible.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
