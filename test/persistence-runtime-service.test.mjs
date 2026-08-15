import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { createUnavailableArchiveBridge, requireVerifiedSnapshot } from '../src/persistence/archive-bridge.mjs';
import { withIsolatedWorld } from '../src/fixtures.mjs';
import { resolveDatabaseLocation } from '../src/persistence/location.mjs';
import { createCommandCenterPersistenceRuntimeService, persistenceRuntimeServiceId } from '../src/persistence/runtime-service.mjs';
import { createPersistenceService, PersistenceError } from '../src/persistence/service.mjs';

let nextGatewayPort = 28100;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}

test('the registered host lifecycle opens the resolved-state database and closes its service', async () => {
  await withIsolatedWorld(async (world) => {
    let persistence;
    const runtime = createCommandCenterPersistenceRuntimeService({
      createService(options) {
        persistence = createPersistenceService(options);
        return persistence;
      }
    });
    assert.equal(runtime.id, persistenceRuntimeServiceId);
    await runtime.start({ stateDir: world.paths.state });
    assert.equal(persistence.getStatus().mode, 'Ready');
    await access(resolveDatabaseLocation(world.paths.state).databasePath);
    persistence.createTopic({ topicId: 'runtime-topic', title: 'Runtime', paraCategory: 'Project' });
    await runtime.stop();
    assert.throws(() => persistence.listTopics(), PersistenceError);
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('the deployed default bridge makes destructive migrations explicitly unavailable', async () => {
  const bridge = createUnavailableArchiveBridge();
  await assert.rejects(requireVerifiedSnapshot(bridge, {
    stateDirectory: '/tmp/fictional-state',
    databasePath: '/tmp/fictional-state/plugins/command-center/metadata.sqlite',
    schemaVersion: 2,
    ledgerHead: 'fictional-head',
    ledgerDigest: 'fictional-digest'
  }), /receipt capability is unavailable/);
});
