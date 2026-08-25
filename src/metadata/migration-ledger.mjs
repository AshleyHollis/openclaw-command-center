import { createHash } from 'node:crypto';
import {
  COMMAND_CENTER_SCHEMA_VERSION,
  LEGACY_METADATA_SCHEMA_VERSION,
  PRIOR_COMMAND_CENTER_SCHEMA_VERSION,
  inspectMigrationLedger,
  inspectSchema,
  metadataSchemaV1ToV2Sql,
  metadataSchemaV2ToV3Sql,
  metadataSchemaV3ToV4Sql
} from './schema.mjs';
import canonical from '../compatibility-tuple.json' with { type: 'json' };
import { recoveryMigrationId } from './path.mjs';

export const V1_TO_V2_MIGRATION_ID = recoveryMigrationId;
export const V2_TO_V3_MIGRATION_ID = 'command-center-schema-2-to-3';
export const V3_TO_V4_MIGRATION_ID = 'command-center-schema-3-to-4';
export const MIGRATION_ID = V3_TO_V4_MIGRATION_ID;
export const MIGRATION_FROM_VERSION = PRIOR_COMMAND_CENTER_SCHEMA_VERSION;
export const MIGRATION_TO_VERSION = COMMAND_CENTER_SCHEMA_VERSION;
export const MIGRATION_IS_DESTRUCTIVE = true;

function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
const v1Definition = Object.freeze({ id: V1_TO_V2_MIGRATION_ID, fromVersion: 1, toVersion: 2, destructive: true, statements: Object.freeze([metadataSchemaV1ToV2Sql]) });
const v2Definition = Object.freeze({ id: V2_TO_V3_MIGRATION_ID, fromVersion: 2, toVersion: 3, destructive: true, statements: Object.freeze([metadataSchemaV2ToV3Sql]) });
const v3Definition = Object.freeze({ id: V3_TO_V4_MIGRATION_ID, fromVersion: 3, toVersion: 4, destructive: false, statements: Object.freeze([metadataSchemaV3ToV4Sql]) });
export const V1_TO_V2_MIGRATION_DIGEST = digest(v1Definition);
export const V2_TO_V3_MIGRATION_DIGEST = digest(v2Definition);
export const MIGRATION_DIGEST = digest(v3Definition);
export const migrationDescriptor = Object.freeze({ ...v3Definition, digest: MIGRATION_DIGEST });
export const CURRENT_BUILD = canonical.package.build;

function invokeHook(hooks, name, context) { if (typeof hooks?.[name] === 'function') hooks[name](context); }

export function validateMigrationLedger(database, { snapshotId, allowEmpty = false } = {}) {
  const rows = inspectMigrationLedger(database);
  const problems = [];
  const definitions = [
    { id: V1_TO_V2_MIGRATION_ID, digest: V1_TO_V2_MIGRATION_DIGEST, from: 1, to: 2, builds: ['0.2.0', CURRENT_BUILD] },
    { id: V2_TO_V3_MIGRATION_ID, digest: V2_TO_V3_MIGRATION_DIGEST, from: 2, to: 3, builds: ['0.2.0', CURRENT_BUILD] },
    { id: V3_TO_V4_MIGRATION_ID, digest: MIGRATION_DIGEST, from: 3, to: 4, builds: [CURRENT_BUILD] }
  ];
  const targetVersion = Number(database.prepare('PRAGMA user_version').get().user_version);
  const firstFrom = rows[0]?.from_version;
  const start = definitions.findIndex((definition) => definition.from === firstFrom);
  const end = definitions.findIndex((definition) => definition.to === targetVersion);
  const expected = start < 0 || end < start ? definitions : definitions.slice(start, end + 1);
  if (allowEmpty && rows.length === 0) return Object.freeze({ valid: true, problems: Object.freeze([]), rows });
  if (rows.length !== expected.length) problems.push('migration ledger must contain the supported contiguous rows');
  rows.forEach((row, index) => {
    const wanted = expected[index];
    if (!wanted) return;
    if (row.sequence !== index + 1) problems.push('migration ledger sequence is not contiguous');
    if (row.migration_id !== wanted.id) problems.push('migration ledger migration ID is unknown');
    if (row.migration_digest !== wanted.digest) problems.push('migration ledger digest differs');
    if (row.from_version !== wanted.from || row.to_version !== wanted.to) problems.push('migration ledger version range differs');
    if (snapshotId !== undefined && index === expected.length - 1 && row.snapshot_id !== snapshotId) problems.push('migration ledger snapshot identity differs');
    if (!wanted.builds.includes(row.applied_build)) problems.push('migration ledger applied build differs');
    if (typeof row.applied_at !== 'string' || row.applied_at.trim() === '') problems.push('migration ledger timestamp is invalid');
  });
  return Object.freeze({ valid: problems.length === 0, problems: Object.freeze([...new Set(problems)]), rows });
}

function applyDefinition(database, definition, { sequence, snapshotId, appliedAt, hooks } = {}) {
  invokeHook(hooks, 'beforeTransaction', { migration: definition, snapshotId });
  database.exec('BEGIN IMMEDIATE');
  try {
    invokeHook(hooks, 'insideTransaction', { migration: definition, snapshotId });
    for (const statement of definition.statements) database.exec(statement);
    database.prepare('INSERT INTO schema_migrations (sequence, migration_id, migration_digest, from_version, to_version, snapshot_id, applied_build, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      sequence, definition.id, digest(definition), definition.fromVersion, definition.toVersion, snapshotId, CURRENT_BUILD, appliedAt
    );
    database.exec(`PRAGMA user_version = ${definition.toVersion}`);
    const shape = inspectSchema(database, definition.toVersion);
    if (!shape.valid) throw new Error('Target schema validation failed: ' + shape.problems.join('; '));
    invokeHook(hooks, 'beforeCommit', { migration: definition, snapshotId });
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve the migration failure */ }
    throw error;
  }
}

export function applyV1ToV2Migration(database, { snapshotId, appliedAt = new Date().toISOString(), hooks } = {}) {
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') throw new TypeError('snapshotId must be a non-empty string');
  applyDefinition(database, v1Definition, { sequence: 1, snapshotId, appliedAt, hooks });
}
export function applyV2ToV3Migration(database, { snapshotId, appliedAt = new Date().toISOString(), hooks } = {}) {
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') throw new TypeError('snapshotId must be a non-empty string');
  applyDefinition(database, v2Definition, { sequence: inspectMigrationLedger(database).length + 1, snapshotId, appliedAt, hooks });
}
export function applyV3ToV4Migration(database, { snapshotId, appliedAt = new Date().toISOString(), hooks } = {}) {
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') throw new TypeError('snapshotId must be a non-empty string');
  applyDefinition(database, v3Definition, { sequence: inspectMigrationLedger(database).length + 1, snapshotId, appliedAt, hooks });
}
export { digest };
