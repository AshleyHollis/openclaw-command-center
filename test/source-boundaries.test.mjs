import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compatibilityTuple } from '../src/compatibility.mjs';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { resolveDatabaseLocation } from '../src/persistence/location.mjs';
import { migrationCatalog, migrationChecksum } from '../src/persistence/migrations.mjs';
import { PLUGIN_BUILD } from '../src/persistence/schema.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 27300;
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
function failedMigration() {
  const migration = { version: 3, id: 'fictional-boundary-failure-v3', destructive: false, compatiblePluginBuild: PLUGIN_BUILD, statements: ['CREATE TABLE fictional_boundary_probe (id INTEGER PRIMARY KEY)', 'INSERT INTO fictional_missing_table VALUES (1)'] };
  return Object.freeze({ ...migration, checksum: migrationChecksum(migration) });
}

test('service success, failure, restart, migration, and projection rebuild leave authoritative fixtures unchanged', async () => {
  await withIsolatedWorld(async (world) => {
    const before = await Promise.all(['vault', 'session', 'scheduler'].map((name) => readFile(`${world.paths[name]}/fixture.json`)));
    const initial = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await initial.initialize();
    initial.createTopic({ topicId: 'fictional-cooking', title: 'Cooking', paraCategory: 'Project' });
    initial.addSourceReference({ sourceReferenceId: 'cooking-folder', topicId: 'fictional-cooking', sourceKind: 'note_folder', sourceRole: 'note_folder', opaqueIdentifier: 'cooking-folder' });
    assert.throws(() => initial.setPreference({ preferenceKey: 'density', preferenceValue: 'compact', transcript: 'forbidden' }), { code: 'AUTHORITATIVE_SOURCE_PAYLOAD_FORBIDDEN' });
    assert.doesNotMatch(JSON.stringify(initial.getMetadataSnapshot()), /Safe fixture content|fictional-session-cooking/);
    await initial.close();
    const failed = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: schemaThreeCompatibility(), catalog: [...migrationCatalog, failedMigration()] });
    assert.equal((await failed.initialize()).mode, 'Recovery-only');
    await failed.close();
    const restarted = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await restarted.initialize()).mode, 'Ready');
    assert.equal(restarted.getTopic('fictional-cooking').title, 'Cooking');
    await restarted.close();
    // Fixture corruption is confined to optional cache structures.
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    database.exec('DROP TABLE projection_topic_summary; DROP TABLE projection_metadata;');
    database.close();
    const rebuild = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await rebuild.initialize()).mode, 'Degraded');
    rebuild.rebuildProjections();
    await rebuild.close();
    const after = await Promise.all(['vault', 'session', 'scheduler'].map((name) => readFile(`${world.paths[name]}/fixture.json`)));
    assert.deepEqual(after, before);
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
