import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { createPersistenceService, PersistenceError } from '../src/persistence/service.mjs';

let nextGatewayPort = 26100;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}

function bridge(world) {
  return createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive });
}

test('public service durably stores only Command Center metadata and preserves Topic identity', async () => {
  await withIsolatedWorld(async (world) => {
    const externalBefore = await Promise.all(['vault', 'session', 'scheduler'].map((name) => readFile(`${world.paths[name]}/fixture.json`)));
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await service.initialize()).mode, 'Ready');
    const created = service.createTopic({ topicId: 'fictional-cooking', title: 'Cooking', paraCategory: 'Project' });
    assert.equal(created.topic_id, 'fictional-cooking');
    service.addSourceReference({ sourceReferenceId: 'fictional-cooking-folder', topicId: 'fictional-cooking', sourceKind: 'note_folder', sourceRole: 'note_folder', opaqueIdentifier: 'fictional-folder-ref' });
    service.addSourceReference({ sourceReferenceId: 'fictional-cooking-session-one', topicId: 'fictional-cooking', sourceKind: 'session', sourceRole: 'primary_session', opaqueIdentifier: 'fictional-session-one' });
    service.addSourceReference({ sourceReferenceId: 'fictional-cooking-session-two', topicId: 'fictional-cooking', sourceKind: 'session', sourceRole: 'topic_conversation', opaqueIdentifier: 'fictional-session-two' });
    service.replacePrimarySession({ topicId: 'fictional-cooking', sourceReferenceId: 'fictional-cooking-session-two' });
    assert.equal(service.getSourceReference('fictional-cooking-session-one').source_role, 'topic_conversation');
    assert.equal(service.getSourceReference('fictional-cooking-session-two').source_role, 'primary_session');
    const updated = service.updateTopic({ topicId: 'fictional-cooking', title: 'Kitchen', paraCategory: 'Archive', lifecycleState: 'Archived' });
    assert.equal(updated.topic_id, 'fictional-cooking');
    assert.equal(updated.para_category, 'Archive');
    service.updateTopic({ topicId: 'fictional-cooking', paraCategory: 'Project', lifecycleState: 'Active' });
    service.setConvention({ conventionKey: 'topic-folder', managementState: 'customized' });
    service.setPreference({ preferenceKey: 'dashboard-density', preferenceValue: 'compact' });
    service.linkAttentionActivity({ linkId: 'fictional-link', topicId: 'fictional-cooking', attentionIdentifier: 'fictional-attention', activityIdentifier: 'fictional-activity' });
    service.createStructuralChangeProposal({ proposalId: 'fictional-proposal', topicId: 'fictional-cooking', changeKind: 'primary_session' });
    assert.throws(() => service.createTopic({ topicId: 'forbidden', title: 'Forbidden', paraCategory: 'Project', body: 'not allowed' }), { code: 'AUTHORITATIVE_SOURCE_PAYLOAD_FORBIDDEN' });
    await service.close();
    const externalAfter = await Promise.all(['vault', 'session', 'scheduler'].map((name) => readFile(`${world.paths[name]}/fixture.json`)));
    assert.deepEqual(externalAfter, externalBefore);

    const reopened = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await reopened.initialize()).mode, 'Ready');
    assert.equal(reopened.getTopic('fictional-cooking').topic_id, 'fictional-cooking');
    assert.equal(reopened.getSourceReference('fictional-cooking-session-one').source_role, 'topic_conversation');
    assert.equal(reopened.getMigrationStatus().schemaVersion, 1);
    await reopened.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('Source Reference ownership constraints and unresolved-source guard have no silent rebind', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await service.initialize();
    service.createTopic({ topicId: 'fictional-cooking', title: 'Cooking', paraCategory: 'Project' });
    service.createTopic({ topicId: 'fictional-household', title: 'Household', paraCategory: 'Area' });
    service.addSourceReference({ sourceReferenceId: 'folder-one', topicId: 'fictional-cooking', sourceKind: 'note_folder', sourceRole: 'note_folder', opaqueIdentifier: 'shared-folder' });
    assert.throws(() => service.addSourceReference({ sourceReferenceId: 'folder-two', topicId: 'fictional-household', sourceKind: 'note_folder', sourceRole: 'note_folder', opaqueIdentifier: 'shared-folder' }));
    service.addSourceReference({ sourceReferenceId: 'unresolved-session', topicId: 'fictional-cooking', sourceKind: 'session', sourceRole: 'topic_conversation', opaqueIdentifier: 'unresolved-session', verificationState: 'unresolved' });
    assert.throws(() => service.replacePrimarySession({ topicId: 'fictional-cooking', sourceReferenceId: 'unresolved-session' }), { code: 'SOURCE_UNRESOLVED' });
    // Unrelated metadata remains mutable while only dependent source work is blocked.
    assert.equal(service.updateTopic({ topicId: 'fictional-household', title: 'Home' }).title, 'Home');
    service.setSourceVerification({ sourceReferenceId: 'unresolved-session', verificationState: 'verified' });
    service.replacePrimarySession({ topicId: 'fictional-cooking', sourceReferenceId: 'unresolved-session' });
    await service.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('public service starts closed, and restored state opens mutations only after validation', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), restored: true });
    assert.equal(service.getStatus().mode, 'Recovery-only');
    assert.throws(() => service.createTopic({ topicId: 'fictional-topic', title: 'Topic', paraCategory: 'Project' }), PersistenceError);
    assert.equal((await service.initialize()).mode, 'Ready');
    service.createTopic({ topicId: 'fictional-topic', title: 'Topic', paraCategory: 'Project' });
    await service.close();
    const incompatible = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), restored: true, pluginBuild: 'fictional-incompatible-build' });
    assert.equal((await incompatible.initialize()).mode, 'Recovery-only');
    assert.throws(() => incompatible.createTopic({ topicId: 'different-topic', title: 'Different', paraCategory: 'Project' }), { code: 'MUTATION_BLOCKED_RECOVERY_ONLY' });
    await incompatible.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
