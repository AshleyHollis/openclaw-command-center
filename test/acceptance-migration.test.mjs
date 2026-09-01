import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readVerifiedMigrationCompletion } from '../src/acceptance-migration.mjs';

const topicId = '11111111-1111-4111-8111-111111111111';

function migrationDatabase(referenceId) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE migration_completion (completion_id TEXT PRIMARY KEY, verified_channel_count INTEGER, verified_occurrence_count INTEGER);
    CREATE TABLE source_references (reference_id TEXT PRIMARY KEY, topic_id TEXT, source_system TEXT, source_kind TEXT, external_source_id TEXT);
    CREATE TABLE session_state (reference_id TEXT, session_id TEXT, is_primary INTEGER, status TEXT);
  `);
  database.prepare('INSERT INTO migration_completion VALUES (?, ?, ?)').run('legacy-discord-v1', 1, 2);
  database.prepare('INSERT INTO source_references VALUES (?, ?, ?, ?, ?)').run(referenceId, topicId, 'openclaw', 'session', 'session:fictional-primary');
  database.prepare('INSERT INTO session_state VALUES (?, ?, ?, ?)').run(referenceId, 'session-id-fictional', 1, 'open');
  return database;
}

test('migration completion returns the exact authoritative source reference identity', () => {
  const database = migrationDatabase('reference-fictional-primary');
  try {
    assert.deepEqual(readVerifiedMigrationCompletion(database, { completionId: 'legacy-discord-v1', topicId }), {
      completion: { completion_id: 'legacy-discord-v1', verified_channel_count: 1, verified_occurrence_count: 2 },
      binding: { referenceId: 'reference-fictional-primary', sessionKey: 'session:fictional-primary', sessionId: 'session-id-fictional' }
    });
  } finally { database.close(); }
});

test('migration completion refuses a blank source reference identity', () => {
  const database = migrationDatabase('   ');
  try {
    assert.equal(readVerifiedMigrationCompletion(database, { completionId: 'legacy-discord-v1', topicId }), undefined);
  } finally { database.close(); }
});
