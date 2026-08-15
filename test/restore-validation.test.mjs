import assert from 'node:assert/strict';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 27400;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}
function bridge(world, protocolVersion = 1) { return createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive, protocolVersion }); }

test('restored deployment remains closed until compatible build, bridge, and validation pass', async () => {
  await withIsolatedWorld(async (world) => {
    const source = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await source.initialize();
    source.createTopic({ topicId: 'fictional-household', title: 'Household', paraCategory: 'Area' });
    await source.close();
    const restored = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world), restored: true });
    assert.equal(restored.getStatus().mode, 'Recovery-only');
    assert.throws(() => restored.createTopic({ topicId: 'blocked', title: 'Blocked', paraCategory: 'Project' }), { code: 'MUTATION_BLOCKED_RECOVERY_ONLY' });
    assert.equal((await restored.initialize()).mode, 'Ready');
    assert.equal(restored.getTopic('fictional-household').title, 'Household');
    await restored.close();
    const incompatible = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world, 2), restored: true });
    assert.equal((await incompatible.initialize()).mode, 'Recovery-only');
    assert.throws(() => incompatible.createTopic({ topicId: 'still-blocked', title: 'Still blocked', paraCategory: 'Project' }), { code: 'MUTATION_BLOCKED_RECOVERY_ONLY' });
    await incompatible.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
