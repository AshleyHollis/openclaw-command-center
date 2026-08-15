import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createFictionalBroadArchiveBridge, withIsolatedWorld } from '../src/fixtures.mjs';
import { resolveDatabaseLocation } from '../src/persistence/location.mjs';
import { createPersistenceService } from '../src/persistence/service.mjs';

let nextGatewayPort = 27600;
function reserveFixtureEndpoint() {
  return { endpoint: { host: '127.0.0.1', port: nextGatewayPort++, url: 'http://127.0.0.1' }, release: async () => {}, isReserved: () => true };
}
function bridge(world) { return createFictionalBroadArchiveBridge({ stateDirectory: world.paths.state, archiveDirectory: world.paths.archive }); }

test('foreign-key and durable-constraint corruption is diagnosed without exposing source values', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    await service.initialize();
    await service.close();
    // Intentional fixture corruption bypasses SQLite foreign keys only here.
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    database.exec('PRAGMA foreign_keys = OFF;');
    database.prepare(`INSERT INTO source_references (source_reference_id, topic_id, source_kind, source_role, opaque_identifier, verification_state, is_current, originating_topic_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('orphaned-reference', 'missing-topic', 'session', 'topic_conversation', 'fictional-session-reference', 'verified', 1, null, '2026-01-01T00:00:00.000Z');
    database.close();
    const recovery = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    const status = await recovery.initialize();
    assert.equal(status.mode, 'Recovery-only');
    assert.ok(status.checks.some((check) => check.code === 'FOREIGN_KEY_VIOLATIONS'));
    assert.ok(status.checks.some((check) => check.code === 'SOURCE_REFERENCE_INVARIANT_FAILED'));
    assert.doesNotMatch(JSON.stringify(recovery.getDiagnostics()), /fictional-session-reference|missing-topic/);
    await recovery.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
