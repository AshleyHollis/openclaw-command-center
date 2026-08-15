import assert from 'node:assert/strict';
import test from 'node:test';
import { migrationCatalog } from '../src/persistence/migrations.mjs';
import { initialSchemaStatements, requiredTables, requiredTriggers, SCHEMA_VERSION } from '../src/persistence/schema.mjs';

test('durable schema is an allowlist of Command Center metadata and excludes authoritative source payloads', () => {
  const schema = initialSchemaStatements.join('\n').toLowerCase();
  for (const table of ['topics', 'source_references', 'convention_state', 'presentation_preferences', 'attention_activity_links', 'structural_change_proposals', 'migration_ledger', 'policy_versions']) {
    assert.ok(requiredTables.includes(table));
  }
  for (const forbidden of ['note_body', 'transcript', 'session_message', 'canonical_history', 'reminder_schedule', 'scheduler_job']) assert.doesNotMatch(schema, new RegExp(forbidden));
  assert.match(schema, /para_category text not null check \(para_category in \('project', 'area', 'resource', 'archive'\)\)/);
  assert.match(schema, /lifecycle_state text not null check \(lifecycle_state in \('provisioning', 'active', 'archived', 'retired'\)\)/);
  assert.match(migrationCatalog.at(-1).statements.join('\n').toLowerCase(), /create trigger topic_id_immutable/);
  assert.equal(requiredTriggers.topic_id_immutable, 'BEFORE UPDATE OF topic_id ON topics');
  assert.equal(migrationCatalog.at(-1).version, SCHEMA_VERSION);
});
