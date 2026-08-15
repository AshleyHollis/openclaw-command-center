import assert from 'node:assert/strict';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 27100;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}

test('Source References enforce active ownership and make Source Recovery explicit', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({
      stateDirectory: world.paths.state,
      archiveBridge: createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive })
    });
    await service.initialize();
    service.createTopic({ topicId: 'fictional-cooking', title: 'Cooking', paraCategory: 'Project' });
    service.createTopic({ topicId: 'fictional-household', title: 'Household', paraCategory: 'Area' });
    service.addSourceReference({ sourceReferenceId: 'cooking-folder', topicId: 'fictional-cooking', sourceKind: 'note_folder', sourceRole: 'note_folder', opaqueIdentifier: 'shared-folder' });
    service.addSourceReference({ sourceReferenceId: 'cooking-primary', topicId: 'fictional-cooking', sourceKind: 'session', sourceRole: 'primary_session', opaqueIdentifier: 'shared-session' });
    assert.throws(() => service.addSourceReference({ sourceReferenceId: 'household-folder', topicId: 'fictional-household', sourceKind: 'note_folder', sourceRole: 'note_folder', opaqueIdentifier: 'shared-folder' }));
    assert.throws(() => service.addSourceReference({ sourceReferenceId: 'household-conversation', topicId: 'fictional-household', sourceKind: 'session', sourceRole: 'topic_conversation', opaqueIdentifier: 'shared-session' }));
    assert.throws(() => service.addSourceReference({ sourceReferenceId: 'second-primary', topicId: 'fictional-cooking', sourceKind: 'session', sourceRole: 'primary_session', opaqueIdentifier: 'other-session' }));
    service.addSourceReference({ sourceReferenceId: 'unresolved-session', topicId: 'fictional-cooking', sourceKind: 'session', sourceRole: 'topic_conversation', opaqueIdentifier: 'unresolved-session', verificationState: 'unresolved' });
    assert.throws(() => service.relocateSourceReference({ sourceReferenceId: 'unresolved-session', opaqueIdentifier: 'would-be-rebound' }), { code: 'SOURCE_UNRESOLVED' });
    assert.throws(() => service.replacePrimarySession({ topicId: 'fictional-cooking', sourceReferenceId: 'unresolved-session' }), { code: 'SOURCE_UNRESOLVED' });
    assert.equal(service.updateTopic({ topicId: 'fictional-household', title: 'Home' }).title, 'Home');
    service.setSourceVerification({ sourceReferenceId: 'unresolved-session', verificationState: 'verified' });
    assert.equal(service.relocateSourceReference({ sourceReferenceId: 'unresolved-session', opaqueIdentifier: 'explicitly-relinked-session' }).opaque_identifier, 'explicitly-relinked-session');
    await service.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
