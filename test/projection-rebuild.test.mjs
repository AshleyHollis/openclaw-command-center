import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { resolveDatabaseLocation } from '../src/persistence/location.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 27200;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}
function bridge(world) { return createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive }); }

test('rebuilding lost projections preserves every durable metadata family and external source fixture', async () => {
  await withIsolatedWorld(async (world) => {
    const externalBefore = await Promise.all(['vault', 'session', 'scheduler'].map((name) => readFile(`${world.paths[name]}/fixture.json`)));
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await service.initialize();
    service.createTopic({ topicId: 'fictional-technology', title: 'Technology', paraCategory: 'Resource' });
    service.addSourceReference({ sourceReferenceId: 'technology-folder', topicId: 'fictional-technology', sourceKind: 'note_folder', sourceRole: 'note_folder', opaqueIdentifier: 'technology-folder' });
    service.setConvention({ conventionKey: 'topic-folder', managementState: 'managed' });
    service.setPreference({ preferenceKey: 'dashboard-density', preferenceValue: 'compact' });
    service.linkAttentionActivity({ linkId: 'technology-link', topicId: 'fictional-technology', attentionIdentifier: 'technology-attention', activityIdentifier: 'technology-activity' });
    service.createStructuralChangeProposal({ proposalId: 'technology-proposal', topicId: 'fictional-technology', changeKind: 'classification' });
    const before = service.getMetadataSnapshot();
    await service.close();
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    database.exec('DROP TABLE projection_topic_summary; DROP TABLE projection_metadata;');
    database.close();
    const degraded = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await degraded.initialize()).mode, 'Degraded');
    assert.throws(() => degraded.getTopicProjection('fictional-technology'), { code: 'CAPABILITY_UNAVAILABLE' });
    degraded.rebuildProjections();
    assert.equal(degraded.getStatus().mode, 'Ready');
    assert.deepEqual(degraded.getMetadataSnapshot(), before);
    await degraded.close();
    const externalAfter = await Promise.all(['vault', 'session', 'scheduler'].map((name) => readFile(`${world.paths[name]}/fixture.json`)));
    assert.deepEqual(externalAfter, externalBefore);
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('a corrupt optional projection structure is Degraded and rebuildable, not a durable-schema repair', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await service.initialize();
    service.createTopic({ topicId: 'fictional-cooking', title: 'Cooking', paraCategory: 'Project' });
    await service.close();
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    database.exec('DROP TABLE projection_topic_summary; CREATE TABLE projection_topic_summary (topic_id TEXT PRIMARY KEY, invalid_value TEXT);');
    database.close();
    const degraded = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    const status = await degraded.initialize();
    assert.equal(status.mode, 'Degraded');
    assert.ok(status.checks.some((check) => check.code === 'PROJECTION_UNAVAILABLE'));
    degraded.rebuildProjections();
    assert.equal(degraded.getStatus().mode, 'Ready');
    assert.equal(degraded.getTopicProjection('fictional-cooking').current_source_count, 0);
    await degraded.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
