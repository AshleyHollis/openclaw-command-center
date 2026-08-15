import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { resolveDatabaseLocation } from '../src/persistence/location.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 26300;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}

function bridge(world) { return createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive }); }

test('missing rebuildable projections produces Degraded mode; rebuild preserves durable metadata and unrelated mutations', async () => {
  await withIsolatedWorld(async (world) => {
    const externalBefore = await Promise.all(['vault', 'session', 'scheduler'].map((name) => readFile(`${world.paths[name]}/fixture.json`)));
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await service.initialize();
    service.createTopic({ topicId: 'fictional-vehicle', title: 'Vehicle', paraCategory: 'Area' });
    await service.close();
    // Intentional fixture corruption: only optional projection structures are removed.
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    database.exec('DROP TABLE projection_topic_summary; DROP TABLE projection_metadata;');
    database.close();
    const degraded = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    const state = await degraded.initialize();
    assert.equal(state.mode, 'Degraded');
    assert.deepEqual(state.disabledCapabilities, ['projections']);
    assert.equal(degraded.updateTopic({ topicId: 'fictional-vehicle', title: 'Car' }).title, 'Car');
    assert.throws(() => degraded.getTopicProjection('fictional-vehicle'), { code: 'CAPABILITY_UNAVAILABLE' });
    assert.deepEqual(degraded.rebuildProjections(), { rebuilt: true });
    assert.equal(degraded.getStatus().mode, 'Ready');
    assert.equal(degraded.getTopicProjection('fictional-vehicle').current_source_count, 0);
    await degraded.close();
    const externalAfter = await Promise.all(['vault', 'session', 'scheduler'].map((name) => readFile(`${world.paths[name]}/fixture.json`)));
    assert.deepEqual(externalAfter, externalBefore);
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('durable validation failure is Recovery-only and all public mutation entry points share the guard', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await service.initialize();
    service.createTopic({ topicId: 'fictional-technology', title: 'Technology', paraCategory: 'Resource' });
    await service.close();
    // Intentional fixture corruption of a schema-critical index.
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    database.exec('DROP INDEX one_current_primary_session_per_topic;');
    database.close();
    const recovery = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await recovery.initialize()).mode, 'Recovery-only');
    for (const operation of [
      () => recovery.createTopic({ topicId: 'blocked-one', title: 'Blocked', paraCategory: 'Project' }),
      () => recovery.updateTopic({ topicId: 'fictional-technology', title: 'Blocked' }),
      () => recovery.setConvention({ conventionKey: 'folder', managementState: 'managed' }),
      () => recovery.setPreference({ preferenceKey: 'density', preferenceValue: 'compact' }),
      () => recovery.linkAttentionActivity({ linkId: 'blocked-link', attentionIdentifier: 'attention', activityIdentifier: 'activity' }),
      () => recovery.createStructuralChangeProposal({ proposalId: 'blocked-proposal', topicId: 'fictional-technology', changeKind: 'classification' }),
      () => recovery.setPolicyVersion({ policyName: 'command-center-metadata', version: 1 }),
      () => recovery.rebuildProjections()
    ]) assert.throws(operation, { code: 'MUTATION_BLOCKED_RECOVERY_ONLY' });
    assert.equal(recovery.getDiagnostics().mode, 'Recovery-only');
    assert.equal(recovery.listTopics().length, 1);
    await recovery.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
