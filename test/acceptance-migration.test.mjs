import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readVerifiedImportedHistoryEvidence, readVerifiedMigrationCompletion, retainPreparedMigrationFixtureEvidence } from '../src/acceptance-migration.mjs';
import { createAcceptanceScenarioCoordinator } from '../src/acceptance-scenario-coordinator.mjs';

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

test('prepared migration fixture evidence remains available to every independent startup case', async () => {
  let preparedEvidence;
  await (async function prepareFixture() {
    const migrationExport = {
      schemaVersion: 1,
      source: 'discord',
      channels: [
        { channelId: 'fictional-alpha', messages: [{ messageId: 'alpha-1', text: 'Fictional alpha text.' }] },
        { channelId: 'fictional-scale', messages: [{ messageId: 'scale-1', text: 'Fictional scale text.' }, { messageId: 'scale-2', text: 'More fictional scale text.' }] }
      ]
    };
    preparedEvidence = retainPreparedMigrationFixtureEvidence(migrationExport);
    migrationExport.channels.length = 0;
  })();

  const obtain = () => {
    assert.ok(preparedEvidence, 'prepared fixture evidence must outlive the preparation callback');
    return preparedEvidence;
  };
  const startupCases = [
    ['startup-migration-channel-count', () => assert.equal(obtain().channelCount, 2)],
    ['startup-migration-occurrence-count', () => assert.equal(obtain().occurrenceCount, 3)],
    ['startup-authenticated-history', () => assert.equal(obtain().migrationExport.channels[0].messages.length, 1)],
    ['startup-imported-history-text', () => assert.equal(obtain().migrationExport.channels[0].messages[0].text, 'Fictional alpha text.')],
    ['startup-imported-history-provenance', () => assert.equal(obtain().migrationExport.channels[0].channelId, 'fictional-alpha')]
  ];
  const coordinator = createAcceptanceScenarioCoordinator();
  for (const [id, startupCase] of startupCases) await coordinator.collect(id, async () => { startupCase(); return { retained: true }; });
  assert.deepEqual(coordinator.failures, []);
  for (const [id] of startupCases) assert.deepEqual(coordinator.result(id), { retained: true });
  assert.throws(() => { preparedEvidence.migrationExport.channels[0].messages[0].text = 'changed'; }, /read only|Cannot assign/iu);
});

test('verified imported history hands the exact migration binding to authenticated readback', async () => {
  const binding = Object.freeze({
    referenceId: 'reference-fictional-primary',
    sessionKey: 'session:fictional-primary',
    sessionId: 'session-id-fictional'
  });
  const prepared = retainPreparedMigrationFixtureEvidence({
    schemaVersion: 1,
    source: 'discord',
    channels: [{ channelId: 'fictional-alpha', messages: [{ messageId: 'alpha-1', text: 'Fictional alpha text.' }] }]
  });
  const observed = [];

  const evidence = await readVerifiedImportedHistoryEvidence({
    ensureMigrationBinding: async () => ({ completion: { completion_id: 'legacy-discord-v1' }, binding }),
    requireMigrationFixtureEvidence: () => prepared,
    readHistory: async (receivedBinding) => {
      observed.push(receivedBinding);
      return {
        messages: [
          { text: 'ordinary' },
          { text: 'Fictional alpha text.', __openclaw: { legacyDiscordV1: { immutable: true } } }
        ]
      };
    }
  });

  assert.deepEqual(observed, [binding]);
  assert.equal(evidence.binding, binding);
  assert.equal(evidence.channel.channelId, 'fictional-alpha');
  assert.equal(evidence.imported.length, 1);
  assert.equal(evidence.imported[0].text, 'Fictional alpha text.');
});
