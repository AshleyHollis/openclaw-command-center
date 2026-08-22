import { createHash } from 'node:crypto';
import {
  COMMAND_CENTER_SCHEMA_VERSION,
  SOURCE_SCHEMA_VERSION,
  inspectMigrationLedger,
  inspectSchema,
  metadataSchemaV1ToV2Sql
} from './schema.mjs';
import canonical from '../compatibility-tuple.json' with { type: 'json' };
import { recoveryMigrationId } from './path.mjs';

export const MIGRATION_ID = recoveryMigrationId;
export const MIGRATION_FROM_VERSION = SOURCE_SCHEMA_VERSION;
export const MIGRATION_TO_VERSION = COMMAND_CENTER_SCHEMA_VERSION;
export const MIGRATION_IS_DESTRUCTIVE = true;

const migrationDefinition = Object.freeze({
  id: MIGRATION_ID,
  fromVersion: MIGRATION_FROM_VERSION,
  toVersion: MIGRATION_TO_VERSION,
  destructive: MIGRATION_IS_DESTRUCTIVE,
  statements: Object.freeze([
    metadataSchemaV1ToV2Sql
  ])
});

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const MIGRATION_DIGEST = digest(migrationDefinition);
export const migrationDescriptor = Object.freeze({ ...migrationDefinition, digest: MIGRATION_DIGEST });
export const CURRENT_BUILD = canonical.package.build;

function invokeHook(hooks, name, context) {
  const hook = hooks?.[name];
  if (typeof hook === 'function') hook(context);
}

export function validateMigrationLedger(database, { snapshotId } = {}) {
  const rows = inspectMigrationLedger(database);
  const problems = [];
  if (rows.length !== 1) problems.push('migration ledger must contain exactly one row');
  const row = rows[0];
  if (row) {
    if (row.sequence !== 1) problems.push('migration ledger sequence is not contiguous');
    if (row.migration_id !== MIGRATION_ID) problems.push('migration ledger migration ID is unknown');
    if (row.migration_digest !== MIGRATION_DIGEST) problems.push('migration ledger digest differs');
    if (row.from_version !== MIGRATION_FROM_VERSION || row.to_version !== MIGRATION_TO_VERSION) problems.push('migration ledger version range differs');
    if (snapshotId !== undefined && row.snapshot_id !== snapshotId) problems.push('migration ledger snapshot identity differs');
    if (row.applied_build !== CURRENT_BUILD) problems.push('migration ledger applied build differs');
    if (typeof row.applied_at !== 'string' || row.applied_at.trim() === '') problems.push('migration ledger timestamp is invalid');
  }
  return Object.freeze({ valid: problems.length === 0, problems: Object.freeze(problems), rows });
}

export function applyV1ToV2Migration(database, { snapshotId, appliedAt = new Date().toISOString(), hooks } = {}) {
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') throw new TypeError('snapshotId must be a non-empty string');
  invokeHook(hooks, 'beforeTransaction', { migration: migrationDescriptor, snapshotId });
  database.exec('BEGIN IMMEDIATE');
  try {
    invokeHook(hooks, 'insideTransaction', { migration: migrationDescriptor, snapshotId });
    for (const statement of migrationDescriptor.statements) database.exec(statement);
    database.prepare('INSERT INTO schema_migrations (sequence, migration_id, migration_digest, from_version, to_version, snapshot_id, applied_build, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      1,
      MIGRATION_ID,
      MIGRATION_DIGEST,
      MIGRATION_FROM_VERSION,
      MIGRATION_TO_VERSION,
      snapshotId,
      CURRENT_BUILD,
      appliedAt
    );
    database.exec('PRAGMA user_version = 2');
    const shape = inspectSchema(database, COMMAND_CENTER_SCHEMA_VERSION);
    if (!shape.valid) throw new Error('Target schema validation failed: ' + shape.problems.join('; '));
    const ledger = validateMigrationLedger(database, { snapshotId });
    if (!ledger.valid) throw new Error('Migration ledger validation failed: ' + ledger.problems.join('; '));
    invokeHook(hooks, 'beforeCommit', { migration: migrationDescriptor, snapshotId });
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve the migration failure */ }
    throw error;
  }
}

export { digest };
