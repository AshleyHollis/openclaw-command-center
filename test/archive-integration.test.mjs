import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { resolveDatabaseLocation } from '../src/persistence/location.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 26500;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}

test('fictional broad archive captures the plugin database and sidecars without a Command Center backup format', async () => {
  await withIsolatedWorld(async (world) => {
    const bridge = createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive });
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge });
    await service.initialize();
    await service.close();
    const location = resolveDatabaseLocation(world.paths.state);
    const sidecar = `${location.databasePath}-wal`;
    await writeFile(sidecar, 'fictional sqlite sidecar');
    const bindings = { stateDirectory: world.paths.state, databasePath: location.databasePath, schemaVersion: 1, ledgerHead: 'fictional-head', ledgerDigest: 'fictional-ledger' };
    const receipt = await bridge.createSnapshot(bindings);
    assert.equal(await bridge.verifySnapshot(receipt, bindings), true);
    await access(path.join(receipt.captureDirectory, 'plugins', 'command-center', 'metadata.sqlite'));
    assert.equal((await readFile(path.join(receipt.captureDirectory, 'plugins', 'command-center', 'metadata.sqlite-wal'), 'utf8')), 'fictional sqlite sidecar');
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
