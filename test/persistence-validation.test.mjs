import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { resolveDatabaseLocation } from '../src/persistence/location.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';
import { compatibilityTuple } from '../src/compatibility.mjs';

let nextGatewayPort = 26400;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}
function bridge(world, protocolVersion = 1) { return createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive, protocolVersion }); }

test('ledger checksum drift, future policy versions, and incompatible bridges fail closed with sanitized diagnostics', async () => {
  await withIsolatedWorld(async (world) => {
    const initial = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await initial.initialize();
    initial.createTopic({ topicId: 'fictional-cooking', title: 'Cooking', paraCategory: 'Project' });
    await initial.close();
    const filename = resolveDatabaseLocation(world.paths.state).databasePath;
    const corrupt = new DatabaseSync(filename);
    corrupt.prepare('UPDATE migration_ledger SET checksum = ? WHERE version = 1').run('fictional-checksum-drift');
    corrupt.close();
    const ledgerFailure = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await ledgerFailure.initialize()).mode, 'Recovery-only');
    assert.ok(ledgerFailure.getDiagnostics().checks.some((check) => check.code === 'MIGRATION_LEDGER_INVALID'));
    assert.doesNotMatch(JSON.stringify(ledgerFailure.getDiagnostics()), /metadata\.sqlite|fixture-/);
    await ledgerFailure.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });

  await withIsolatedWorld(async (world) => {
    const initial = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await initial.initialize();
    await initial.close();
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    database.exec("UPDATE policy_versions SET version = 2 WHERE policy_name = 'command-center-metadata'");
    database.close();
    const futurePolicy = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await futurePolicy.initialize()).mode, 'Recovery-only');
    assert.ok(futurePolicy.getStatus().checks.some((check) => check.code === 'POLICY_VERSION_UNSUPPORTED'));
    await futurePolicy.close();
    const bridgeMismatch = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world, 2) });
    assert.equal((await bridgeMismatch.initialize()).mode, 'Recovery-only');
    assert.ok(bridgeMismatch.getStatus().checks.some((check) => check.code === 'BRIDGE_PROTOCOL_INCOMPATIBLE'));
    await bridgeMismatch.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('schema below the readable range is refused without a compatibility repair', async () => {
  await withIsolatedWorld(async (world) => {
    const initial = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await initial.initialize();
    initial.createTopic({ topicId: 'fictional-resource', title: 'Resource', paraCategory: 'Resource' });
    await initial.close();
    const unsupported = structuredClone(compatibilityTuple);
    unsupported.commandCenterSchema.readable.min = 2;
    unsupported.commandCenterSchema.writable.min = 2;
    unsupported.commandCenterSchema.writable.max = 2;
    const refused = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), compatibility: unsupported });
    assert.equal((await refused.initialize()).mode, 'Recovery-only');
    assert.equal(refused.getDiagnostics().checks[0].code, 'SCHEMA_RANGE_UNSUPPORTED');
    await refused.close();
    const compatible = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await compatible.initialize()).mode, 'Ready');
    assert.equal(compatible.getTopic('fictional-resource').title, 'Resource');
    await compatible.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
