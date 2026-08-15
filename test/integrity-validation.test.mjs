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

test('a changed durable metadata constraint is Recovery-only rather than a projection repair', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await service.initialize()).mode, 'Ready');
    await service.close();
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    // Intentional fixture corruption: this table is durable, so the missing
    // value-length constraint must never be treated as rebuildable.
    database.exec(`DROP TABLE presentation_preferences;
      CREATE TABLE presentation_preferences (
        preference_key TEXT PRIMARY KEY CHECK (length(preference_key) BETWEEN 1 AND 160),
        preference_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    database.close();
    const recovery = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    const status = await recovery.initialize();
    assert.equal(status.mode, 'Recovery-only');
    assert.ok(status.checks.some((check) => check.name === 'durable-schema' && check.code === 'DURABLE_SCHEMA_MISSING'));
    await recovery.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('a non-unique replacement index and duplicate current Primary Sessions cannot unlock Ready', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await service.initialize()).mode, 'Ready');
    service.createTopic({ topicId: 'fixture-topic', title: 'Fixture', paraCategory: 'Project' });
    await service.close();
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    database.exec(`DROP INDEX one_current_primary_session_per_topic;
      CREATE INDEX one_current_primary_session_per_topic ON source_references(topic_id)
        WHERE is_current = 1 AND source_role = 'primary_session'`);
    for (const sourceReferenceId of ['fixture-primary-one', 'fixture-primary-two']) {
      database.prepare(`INSERT INTO source_references (source_reference_id, topic_id, source_kind, source_role, opaque_identifier, verification_state, is_current, originating_topic_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sourceReferenceId, 'fixture-topic', 'session', 'primary_session', sourceReferenceId, 'verified', 1, null, '2026-01-01T00:00:00.000Z');
    }
    database.close();
    const recovery = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    const status = await recovery.initialize();
    assert.equal(status.mode, 'Recovery-only');
    assert.ok(status.checks.some((check) => check.name === 'required-indexes' && check.code === 'REQUIRED_INDEX_MISSING'));
    assert.ok(status.checks.some((check) => check.name === 'source-reference-invariants' && check.code === 'SOURCE_REFERENCE_INVARIANT_FAILED'));
    await recovery.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});

test('an altered Topic identity trigger is Recovery-only and blocks public mutations', async () => {
  await withIsolatedWorld(async (world) => {
    const service = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    assert.equal((await service.initialize()).mode, 'Ready');
    service.createTopic({ topicId: 'original-topic', title: 'Original', paraCategory: 'Project' });
    await service.close();
    const database = new DatabaseSync(resolveDatabaseLocation(world.paths.state).databasePath);
    // Intentional fixture corruption: preserve the trigger name and event but
    // remove the immutable-ID RAISE body to model a misleading no-op trigger.
    database.exec(`DROP TRIGGER topic_id_immutable;
      CREATE TRIGGER topic_id_immutable
      BEFORE UPDATE OF topic_id ON topics
      BEGIN
        SELECT 1;
      END`);
    database.prepare("UPDATE topics SET topic_id = 'rewritten-topic' WHERE topic_id = 'original-topic'").run();
    database.close();
    const recovery = createPersistenceService({ stateDirectory: world.paths.state, archiveBridge: bridge(world) });
    const status = await recovery.initialize();
    assert.equal(status.mode, 'Recovery-only');
    assert.ok(status.checks.some((check) => check.name === 'durable-schema' && check.code === 'DURABLE_SCHEMA_MISSING'));
    assert.equal(recovery.getTopic('rewritten-topic').title, 'Original');
    assert.throws(() => recovery.createTopic({ topicId: 'blocked-topic', title: 'Blocked', paraCategory: 'Project' }), { code: 'MUTATION_BLOCKED_RECOVERY_ONLY' });
    await recovery.close();
  }, { reserveEndpoint: reserveFixtureEndpoint });
});
