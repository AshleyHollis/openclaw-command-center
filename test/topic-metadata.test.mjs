import assert from 'node:assert/strict';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 27000;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}

test('Topic identity survives rename, PARA changes, Archive/restore, Source relocation, and Primary replacement', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({
      stateDirectory: world.paths.state,
      archiveBridge: createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive })
    });
    await service.initialize();
    const topicId = 'fictional-vehicle';
    service.createTopic({ topicId, title: 'Vehicle', paraCategory: 'Project' });
    service.addSourceReference({ sourceReferenceId: 'vehicle-folder', topicId, sourceKind: 'note_folder', sourceRole: 'note_folder', opaqueIdentifier: 'vehicle-folder-original' });
    service.addSourceReference({ sourceReferenceId: 'vehicle-primary', topicId, sourceKind: 'session', sourceRole: 'primary_session', opaqueIdentifier: 'vehicle-primary-session' });
    service.addSourceReference({ sourceReferenceId: 'vehicle-conversation', topicId, sourceKind: 'session', sourceRole: 'topic_conversation', opaqueIdentifier: 'vehicle-conversation-session' });
    assert.equal(service.relocateSourceReference({ sourceReferenceId: 'vehicle-folder', opaqueIdentifier: 'vehicle-folder-relocated' }).topic_id, topicId);
    service.replacePrimarySession({ topicId, sourceReferenceId: 'vehicle-conversation' });
    service.updateTopic({ topicId, title: 'Car', paraCategory: 'Archive', lifecycleState: 'Archived' });
    const restored = service.updateTopic({ topicId, paraCategory: 'Area', lifecycleState: 'Active' });
    assert.equal(restored.topic_id, topicId);
    assert.equal(restored.para_category, 'Area');
    assert.equal(service.getSourceReference('vehicle-folder').topic_id, topicId);
    assert.equal(service.getSourceReference('vehicle-primary').source_role, 'topic_conversation');
    assert.equal(service.getSourceReference('vehicle-conversation').source_role, 'primary_session');
    await service.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
