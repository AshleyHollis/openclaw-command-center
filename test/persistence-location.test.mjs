import assert from 'node:assert/strict';
import { access, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { prepareDatabaseLocation, resolveDatabaseLocation } from '../src/persistence/location.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 26000;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}

test('uses one deterministic plugin-owned database beneath an explicit resolved state directory', async () => {
  await withIsolatedWorld(async (world) => {
    const stateDirectory = world.paths.state;
    const bridge = createFictionalBroadArchiveBridge({ stateDirectory, archiveDirectory: world.paths.archive });
    const expected = resolveDatabaseLocation(stateDirectory);
    assert.equal(expected.databasePath, path.join(stateDirectory, 'plugins', 'command-center', 'metadata.sqlite'));
    const first = createPersistenceService({ stateDirectory, archiveBridge: bridge });
    assert.equal((await first.initialize()).mode, 'Ready');
    first.createTopic({ topicId: 'fictional-cooking', title: 'Cooking', paraCategory: 'Project' });
    await first.close();
    const second = createPersistenceService({ stateDirectory, archiveBridge: bridge });
    assert.equal((await second.initialize()).mode, 'Ready');
    assert.equal(second.getTopic('fictional-cooking').title, 'Cooking');
    await second.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('concurrent clean public initializers share one database and apply each ledger transition once', async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await withIsolatedWorld(async (world) => {
      const options = {
        stateDirectory: world.paths.state,
        archiveBridge: createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive })
      };
      const left = createPersistenceService(options);
      const right = createPersistenceService(options);
      const statuses = await Promise.all([left.initialize(), right.initialize()]);
      assert.deepEqual(statuses.map((status) => status.mode), ['Ready', 'Ready']);
      assert.equal(left.getMigrationStatus().schemaVersion, 2);
      assert.deepEqual(left.getMigrationStatus().ledger.map((entry) => entry.version), [1, 2]);
      assert.deepEqual(right.getMigrationStatus().ledger.map((entry) => entry.version), [1, 2]);
      await left.close();
      await right.close();
    }, { reserveEndpoint: reserveFixtureEndpoint });
  }
});

test('fails closed for missing, relative, escaping, and unsafe resolved-state inputs', async () => {
  assert.throws(() => resolveDatabaseLocation(), /resolved absolute state directory/);
  assert.throws(() => resolveDatabaseLocation('relative-state'), /resolved absolute state directory/);
  assert.throws(() => resolveDatabaseLocation('/tmp/fictional/../state'), /resolved absolute state directory/);
  await withIsolatedWorld(async (world) => {
    const missing = path.join(world.root, 'missing-state');
    await assert.rejects(prepareDatabaseLocation(missing), /missing or unsafe/);
    await mkdir(path.join(world.paths.state, 'plugins', 'command-center'), { recursive: true });
    // A directory in place of the database is rejected rather than followed.
    await mkdir(path.join(world.paths.state, 'plugins', 'command-center', 'metadata.sqlite'));
    await assert.rejects(prepareDatabaseLocation(world.paths.state), /database file is unsafe/);
    const service = createPersistenceService({ stateDirectory: missing, archiveBridge: { protocolVersion: 1 } });
    assert.equal((await service.initialize()).mode, 'Recovery-only');
    assert.throws(() => service.createTopic({ topicId: 'x', title: 'X', paraCategory: 'Project' }), { code: 'MUTATION_BLOCKED_RECOVERY_ONLY' });
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('fails closed when an intermediate state-directory component is a symlink', async () => {
  await withIsolatedWorld(async (world) => {
    const outside = path.join(world.root, 'outside-state');
    await mkdir(outside);
    await symlink(outside, path.join(world.paths.state, 'plugins'));
    await assert.rejects(prepareDatabaseLocation(world.paths.state), /OpenClaw plugins directory is missing or unsafe/);
    const service = createPersistenceService({
      stateDirectory: world.paths.state,
      archiveBridge: createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive })
    });
    assert.equal((await service.initialize()).mode, 'Recovery-only');
    await service.close();
    await assert.rejects(access(path.join(outside, 'command-center', 'metadata.sqlite')));
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('incompatible bridge refusal occurs before clean database creation', async () => {
  await withIsolatedWorld(async (world) => {
    const expected = resolveDatabaseLocation(world.paths.state);
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: { protocolVersion: 99 } });
    assert.equal((await service.initialize()).mode, 'Recovery-only');
    await assert.rejects(access(expected.databasePath));
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
