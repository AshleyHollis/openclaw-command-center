import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  COMMAND_CENTER_SCHEMA_VERSION,
  LEGACY_MIGRATION_SCHEMA_VERSION,
  LEGACY_METADATA_SCHEMA_VERSION,
  PRIOR_COMMAND_CENTER_SCHEMA_VERSION,
  SOURCE_SCHEMA_VERSION,
  conventionAspects,
  conventionStates,
  inspectSchema,
  metadataSchemaSql,
  metadataSchemaV1ToV2Sql,
  metadataSchemaV2Sql,
  metadataSchemaV2ToV3Sql,
  metadataTableNames,
  paraCategories,
  proposalStates,
  topicLifecycles
} from './schema.mjs';
import { evaluateOperatingMode, normalizeCapabilities } from './modes.mjs';
import { resolveCommandCenterDatabasePath } from './path.mjs';
import { openCommandCenterProjectionService } from './projections.mjs';
import {
  applyV1ToV2Migration,
  applyV2ToV3Migration,
  applyV3ToV4Migration,
  applyV4ToV5Migration,
  validateMigrationLedger
} from './migration-ledger.mjs';
import {
  RecoveryMaterialError,
  ensureRecoverySnapshot,
  inspectDatabaseAgainstRecoverySnapshot,
  isRollbackSnapshot,
  markRecoveryCommitted,
  readRecoveryMaterial,
  verifyRollbackMaterial
} from './recovery.mjs';

const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'ascii');
const diagnosticLimit = 300;
const migrationTestHooksSymbol = Symbol.for('openclaw.command-center.test.migration-hooks');
const commandCenterProjectionId = 'command-center-core-v1';
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/u;

export class CommandCenterMetadataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommandCenterMetadataError';
    this.code = code;
    Object.assign(this, details);
  }
}

function diagnostic(code, mode, summary, remediation, capability = null) {
  return Object.freeze({
    code,
    mode,
    capability,
    summary: String(summary).slice(0, diagnosticLimit),
    explanation: String(summary).slice(0, diagnosticLimit),
    remediation: String(remediation).slice(0, diagnosticLimit)
  });
}

function coreFailure(code, summary, remediation, schemaVersion = null) {
  return Object.freeze({
    mode: 'recovery-only',
    schemaVersion,
    diagnostics: Object.freeze([diagnostic(code, 'recovery-only', summary, remediation)])
  });
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requiredString(value, field) {
  if (!isNonBlankString(value)) throw new CommandCenterMetadataError('invalid-value', `${field} must be a non-blank string`);
  return value;
}

function optionalString(value, field, defaultValue = '') {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string') throw new CommandCenterMetadataError('invalid-value', `${field} must be a string`);
  return value;
}

function enumValue(value, values, field) {
  if (!values.includes(value)) throw new CommandCenterMetadataError('invalid-enum', `${field} is not supported`);
  return value;
}

function integerValue(value, field, { minimum = undefined } = {}) {
  if (!Number.isInteger(value) || (minimum !== undefined && value < minimum)) throw new CommandCenterMetadataError('invalid-value', `${field} must be an integer`);
  return value;
}

function booleanValue(value, field) {
  if (typeof value !== 'boolean') throw new CommandCenterMetadataError('invalid-value', `${field} must be a boolean`);
  return value;
}

function timestamp(value, field, fallback = new Date().toISOString()) {
  const result = value === undefined ? fallback : value;
  return requiredString(result, field);
}

function objectValue(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommandCenterMetadataError('invalid-value', `${field} must be an object`);
  return value;
}

function freezeSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeSnapshot));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeSnapshot(item)])));
  return value;
}

function allowedKeys(value, keys, field = 'value') {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new CommandCenterMetadataError('invalid-value', `${field} contains unsupported field ${key}`);
}

function mapTopic(row) {
  return row && { topicId: row.topic_id, paraCategory: row.para_category, lifecycle: row.lifecycle, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapSourceReference(row) {
  return row && {
    version: 1,
    referenceId: row.reference_id,
    topicId: row.topic_id,
    sourceSystem: row.source_system,
    sourceKind: row.source_kind,
    externalSourceId: row.external_source_id,
    observedRevision: row.last_observed_revision ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapConvention(row) {
  return row && { referenceId: row.reference_id, aspect: row.aspect, state: row.state, updatedAt: row.updated_at };
}

function mapPreferences(row) {
  return row && { topicId: row.topic_id, displayLabel: row.display_label, sortOrder: row.sort_order, collapsed: row.collapsed === 1, updatedAt: row.updated_at };
}

function mapLink(row) {
  return row && { linkId: row.link_id, attentionId: row.attention_id, activityId: row.activity_id, topicId: row.topic_id, createdAt: row.created_at };
}

function mapProposal(row) {
  return row && { proposalId: row.proposal_id, topicId: row.topic_id, state: row.state, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapPolicy(row) {
  return row && { policyId: row.policy_id, version: row.version, digest: row.digest, updatedAt: row.updated_at };
}

function mapProjection(row) {
  return row && { projectionId: row.projection_id, sourceRevision: row.source_revision, inputDigest: row.input_digest, updatedAt: row.updated_at };
}

function mapOperation(row) {
  return row && {
    logicalOperationId: row.logical_operation_id,
    transportRequestId: row.transport_request_id,
    intentDigest: row.intent_digest,
    operationKind: row.operation_kind,
    state: row.state,
    resultStatus: row.result_status,
    resultIdentity: row.result_identity,
    observedRevision: row.observed_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSessionState(row) {
  return row && { referenceId: row.reference_id, sessionId: row.session_id, status: row.status, isPrimary: row.is_primary === 1, wasPrimary: row.was_primary === 1, displayName: row.display_name, updatedAt: row.updated_at };
}

function mapActivity(row) {
  return row && {
    activityId: row.activity_id,
    topicId: row.topic_id,
    logicalOperationId: row.logical_operation_id,
    transportRequestId: row.transport_request_id,
    operationKind: row.operation_kind,
    outcome: row.outcome,
    observedRevision: row.observed_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMigrationState(row) { return row && { stateId: row.state_id, schemaVersion: row.schema_version, configDigest: row.config_digest, sourceDigest: row.source_digest, revision: row.revision, phase: row.phase, failureCode: row.failure_code, failureSummary: row.failure_summary, failureCount: row.failure_count, updatedAt: row.updated_at }; }

function mapMigrationChannel(row) {
  return row && {
    sourceChannelId: row.source_channel_id,
    topicId: row.topic_id,
    noteFolderReferenceId: row.note_folder_reference_id,
    sessionReferenceId: row.session_reference_id,
    sessionId: row.session_id,
    phase: row.phase,
    expectedCount: row.expected_count,
    expectedDigest: row.expected_digest,
    importedCount: row.imported_count,
    importedDigest: row.imported_digest,
    nextOrdinal: row.next_ordinal,
    failureCode: row.failure_code,
    failureSummary: row.failure_summary,
    failureCount: row.failure_count,
    updatedAt: row.updated_at
  };
}

function mapMigrationOccurrence(row) { return row && { sourceChannelId: row.source_channel_id, occurrenceId: row.occurrence_id, occurrenceDigest: row.occurrence_digest, displayOrder: row.display_order, destinationMessageId: row.destination_message_id, destinationAnchor: row.destination_anchor_json ? JSON.parse(row.destination_anchor_json) : null, destinationAnchorDigest: row.destination_anchor_digest }; }
function mapMigrationCompletion(row) { return row && { completionId: row.completion_id, schemaVersion: row.schema_version, configDigest: row.config_digest, sourceDigest: row.source_digest, verifiedChannelCount: row.verified_channel_count, verifiedOccurrenceCount: row.verified_occurrence_count, completionRevision: row.completion_revision, verifiedAt: row.verified_at }; }

function readSchemaVersion(database) {
  const row = database.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

function inspectSqliteHeader(databasePath) {
  let descriptor;
  try {
    descriptor = openSync(databasePath, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    return Object.freeze({ valid: bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER), bytesRead });
  } catch (error) {
    return Object.freeze({ valid: false, error });
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* header inspection classification is already determined */ }
    }
  }
}

function isStorageAccessError(error) {
  const sqlitePrimaryCode = Number.isInteger(error?.errcode) ? error.errcode & 0xff : undefined;
  return ['EACCES', 'EPERM', 'EROFS'].includes(error?.code) || [3, 8, 10, 14, 23].includes(sqlitePrimaryCode);
}

function closeQuietly(database) {
  try { database?.close(); } catch { /* preflight cleanup must not write or mask its classification */ }
}

function recoveryFailure(error, schemaVersion = null) {
  const code = error?.code || 'recovery-validation-failure';
  const summary = error?.message || 'Recovery material could not be verified.';
  return coreFailure(code, summary, 'Restore the retained recovery material or repair the storage through the external recovery workflow.', schemaVersion);
}

function inspectSchemaOneDatabase(database, schemaVersion) {
  const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check;
  if (integrity !== 'ok') return coreFailure('integrity-failure', 'The Command Center database failed SQLite integrity checks.', 'Restore a verified database before allowing metadata mutations.', schemaVersion);
  let shape;
  try { shape = inspectSchema(database, schemaVersion); } catch {
    return coreFailure('malformed-schema', 'The Command Center database does not match the supported schema shape.', 'Restore or migrate the database through the separate recovery workflow.', schemaVersion);
  }
  if (!shape.valid) return coreFailure('malformed-schema', 'The Command Center database does not match the supported schema shape.', 'Restore or migrate the database through the separate recovery workflow.', schemaVersion);
  return null;
}

function validateCurrentSchema(databasePath, stateDir) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const baseFailure = inspectSchemaOneDatabase(database, COMMAND_CENTER_SCHEMA_VERSION);
    if (baseFailure) return baseFailure;
    const ledger = validateMigrationLedger(database, { allowEmpty: true });
    if (!ledger.valid) return coreFailure('migration-ledger-invalid', 'The migration ledger is not an exact record of the supported migrations.', 'Restore a verified database and matching recovery material before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
    let material;
    try { material = readRecoveryMaterial(stateDir); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
    const hasMigrationRecovery = ledger.rows.length > 0;
    if (!hasMigrationRecovery) {
      if (material.exists) return coreFailure('unexpected-recovery-material', 'Recovery material exists without a committed migration ledger.', 'Repair storage through the external recovery workflow before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
    } else {
      if (!material.exists) return coreFailure('recovery-material-missing', 'The committed migration recovery material is missing.', 'Restore the retained recovery directory before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
      if (ledger.rows.some((row) => row.snapshot_id !== material.manifest.snapshotId)) return coreFailure('recovery-ledger-mismatch', 'The migration ledger does not identify the retained recovery snapshot.', 'Restore matching recovery material before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
      if (material.manifest.state === 'prepared') {
        try { material = markRecoveryCommitted(material); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
      }
      if (material.manifest.state !== 'committed') return coreFailure('recovery-manifest-invalid', 'The migration recovery manifest is not committed.', 'Complete recovery reconciliation before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
    }
    return Object.freeze({ mode: 'ready', schemaVersion: COMMAND_CENTER_SCHEMA_VERSION, diagnostics: Object.freeze([]) });
  } catch (error) {
    return isStorageAccessError(error)
      ? coreFailure('storage-access-failure', 'The Command Center database could not be opened for inspection.', 'Check storage access and retry Command Center startup.', COMMAND_CENTER_SCHEMA_VERSION)
      : recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION);
  } finally {
    closeQuietly(database);
  }
}

function inspectExistingDatabase(databasePath, stateDir, migrationHooks) {
  const header = inspectSqliteHeader(databasePath);
  if (header.error) return coreFailure('storage-access-failure', 'The Command Center database could not be read for inspection.', 'Check storage access and retry Command Center startup.');
  if (header.bytesRead === 0) return coreFailure('unversioned-schema', 'The existing Command Center database is pristine schema version 0.', 'Initialize only a missing database; move this existing file through the separate recovery workflow.', null);
  if (!header.valid) return coreFailure('corrupt-storage', 'The Command Center database is not a valid SQLite file.', 'Restore or replace the database through the separate recovery workflow.');
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    return isStorageAccessError(error)
      ? coreFailure('storage-access-failure', 'The Command Center database could not be opened for inspection.', 'Check storage access and retry Command Center startup.')
      : coreFailure('corrupt-storage', 'The Command Center database could not be read safely.', 'Restore or replace the database through the separate recovery workflow.');
  }
  let schemaVersion;
  try {
    try {
      schemaVersion = readSchemaVersion(database);
    } catch (error) {
      return isStorageAccessError(error)
        ? coreFailure('storage-access-failure', 'The Command Center database could not be read for inspection.', 'Check storage access and retry Command Center startup.')
        : coreFailure('corrupt-storage', 'The Command Center database could not be read safely.', 'Restore or replace the database through the separate recovery workflow.');
    }
    if (schemaVersion > COMMAND_CENTER_SCHEMA_VERSION) return coreFailure('future-schema', 'The Command Center database uses a newer schema version.', 'Upgrade Command Center to a compatible version; no automatic migration is attempted.', null);
    if (schemaVersion === SOURCE_SCHEMA_VERSION) {
      const sourceFailure = inspectSchemaOneDatabase(database, SOURCE_SCHEMA_VERSION);
      if (sourceFailure) return sourceFailure;
    } else if (schemaVersion === LEGACY_METADATA_SCHEMA_VERSION) {
      const legacyFailure = inspectSchemaOneDatabase(database, LEGACY_METADATA_SCHEMA_VERSION);
      if (legacyFailure) return legacyFailure;
    } else if (schemaVersion === LEGACY_MIGRATION_SCHEMA_VERSION) {
      const priorFailure = inspectSchemaOneDatabase(database, LEGACY_MIGRATION_SCHEMA_VERSION);
      if (priorFailure) return priorFailure;
    } else if (schemaVersion === PRIOR_COMMAND_CENTER_SCHEMA_VERSION) {
      const priorFailure = inspectSchemaOneDatabase(database, PRIOR_COMMAND_CENTER_SCHEMA_VERSION);
      if (priorFailure) return priorFailure;
    } else if (schemaVersion !== COMMAND_CENTER_SCHEMA_VERSION) return coreFailure('unversioned-schema', 'The existing Command Center database is not a declared migratable schema.', 'Use the separate migration or recovery workflow before writing metadata.', null);
  } finally {
    closeQuietly(database);
  }

  // Current-schema validation performs a full integrity check. Release the
  // lightweight classification handle before opening that validation handle.
  if (schemaVersion === COMMAND_CENTER_SCHEMA_VERSION) return validateCurrentSchema(databasePath, stateDir);

  if (schemaVersion === PRIOR_COMMAND_CENTER_SCHEMA_VERSION) {
    let material;
    try {
      material = readRecoveryMaterial(stateDir);
      if (material.exists && isRollbackSnapshot(databasePath, material)) return coreFailure('rollback-snapshot-detected', 'The database is the retained schema-3 rollback snapshot.', 'Install the prior compatible release before using this restored database.', PRIOR_COMMAND_CENTER_SCHEMA_VERSION);
      if (!material.exists) material = ensureRecoverySnapshot({ stateDir, databasePath, sourceSchemaVersion: PRIOR_COMMAND_CENTER_SCHEMA_VERSION });
    } catch (error) { return recoveryFailure(error, PRIOR_COMMAND_CENTER_SCHEMA_VERSION); }
    let migrationDatabase;
    try {
      migrationDatabase = new DatabaseSync(databasePath);
      migrationDatabase.exec('PRAGMA foreign_keys = ON;');
      applyV4ToV5Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    } catch {
      return coreFailure('migration-failed', 'The schema-4 to schema-5 migration was rolled back and the store remains recovery-only.', 'Retry startup with the current supported release before allowing metadata mutations.', PRIOR_COMMAND_CENTER_SCHEMA_VERSION);
    } finally { closeQuietly(migrationDatabase); }
    migrationHooks?.afterDatabaseCommit?.();
    try { markRecoveryCommitted(material); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
    return validateCurrentSchema(databasePath, stateDir);
  }

  if (schemaVersion === LEGACY_MIGRATION_SCHEMA_VERSION) {
    let material;
    try {
      material = readRecoveryMaterial(stateDir);
      if (!material.exists) material = ensureRecoverySnapshot({ stateDir, databasePath, sourceSchemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION });
    } catch (error) { return recoveryFailure(error, LEGACY_MIGRATION_SCHEMA_VERSION); }
    let migrationDatabase;
    try {
      migrationDatabase = new DatabaseSync(databasePath);
      migrationDatabase.exec('PRAGMA foreign_keys = ON;');
      applyV3ToV4Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV4ToV5Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    } catch {
      return coreFailure('migration-failed', 'The schema-3 to schema-5 migration was rolled back and the store remains recovery-only.', 'Retry startup with the current supported release before allowing metadata mutations.', LEGACY_MIGRATION_SCHEMA_VERSION);
    } finally { closeQuietly(migrationDatabase); }
    migrationHooks?.afterDatabaseCommit?.();
    try { markRecoveryCommitted(material); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
    return validateCurrentSchema(databasePath, stateDir);
  }

  if (schemaVersion === LEGACY_METADATA_SCHEMA_VERSION) {
    let material;
    try {
      material = readRecoveryMaterial(stateDir);
      if (material.exists && isRollbackSnapshot(databasePath, material)) return coreFailure('rollback-snapshot-detected', 'The database is the retained source-schema rollback snapshot.', 'Install the exact prior compatible release before using this restored database.', LEGACY_METADATA_SCHEMA_VERSION);
      if (material.exists && material.manifest.snapshot.schemaVersion === SOURCE_SCHEMA_VERSION) {
        let sourceLedgerDatabase;
        try {
          sourceLedgerDatabase = new DatabaseSync(databasePath, { readOnly: true });
          const ledger = validateMigrationLedger(sourceLedgerDatabase, { snapshotId: material.manifest.snapshotId });
          if (!ledger.valid || ledger.rows.length !== 1 || ledger.rows[0].to_version !== LEGACY_METADATA_SCHEMA_VERSION) return coreFailure('recovery-snapshot-mismatch', 'The retained schema-1 recovery snapshot is not bound to this schema-2 database.', 'Restore matching recovery evidence before continuing the ordered upgrade.', LEGACY_METADATA_SCHEMA_VERSION);
        } finally { closeQuietly(sourceLedgerDatabase); }
      } else if (material.exists && !inspectDatabaseAgainstRecoverySnapshot(databasePath, material)) return coreFailure('recovery-snapshot-mismatch', 'The retained recovery snapshot does not match the current schema-2 database.', 'Do not overwrite recovery evidence; restore a matching database or complete recovery externally.', LEGACY_METADATA_SCHEMA_VERSION);
      if (!material.exists) material = ensureRecoverySnapshot({ stateDir, databasePath, sourceSchemaVersion: LEGACY_METADATA_SCHEMA_VERSION });
    } catch (error) { return recoveryFailure(error, LEGACY_METADATA_SCHEMA_VERSION); }
    let migrationDatabase;
    try {
      migrationDatabase = new DatabaseSync(databasePath);
      migrationDatabase.exec('PRAGMA foreign_keys = ON;');
      applyV2ToV3Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV3ToV4Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV4ToV5Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    } catch {
      closeQuietly(migrationDatabase);
      return coreFailure('migration-failed', 'The schema-2 to schema-4 migration was rolled back and the store remains recovery-only.', 'Retry startup with the current supported release before allowing metadata mutations.', LEGACY_METADATA_SCHEMA_VERSION);
    } finally { closeQuietly(migrationDatabase); }
    migrationHooks?.afterDatabaseCommit?.();
    try { markRecoveryCommitted(material); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
    return validateCurrentSchema(databasePath, stateDir);
  }

  let material;
  try {
    material = readRecoveryMaterial(stateDir);
    if (material.exists && isRollbackSnapshot(databasePath, material)) {
      return coreFailure('rollback-snapshot-detected', 'The database is the retained schema-1 rollback snapshot.', 'Install the exact prior openclaw-command-center@0.1.0 release before using this restored database.', SOURCE_SCHEMA_VERSION);
    }
    if (material.exists && !inspectDatabaseAgainstRecoverySnapshot(databasePath, material)) {
      return coreFailure('recovery-snapshot-mismatch', 'The retained recovery snapshot does not match the current schema-1 database.', 'Do not overwrite recovery evidence; restore a matching database or complete recovery externally.', SOURCE_SCHEMA_VERSION);
    }
    if (!material.exists) material = ensureRecoverySnapshot({ stateDir, databasePath });
  } catch (error) {
    return recoveryFailure(error, SOURCE_SCHEMA_VERSION);
  }

  let migrationDatabase;
  try {
    migrationDatabase = new DatabaseSync(databasePath);
    migrationDatabase.exec('PRAGMA foreign_keys = ON;');
    applyV1ToV2Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    applyV2ToV3Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    applyV3ToV4Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    applyV4ToV5Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
  } catch (error) {
    closeQuietly(migrationDatabase);
    return coreFailure('migration-failed', 'The schema-1 to schema-4 migration was rolled back and the store remains recovery-only.', 'Retry startup with the retained verified snapshot or restore the prior compatible release.', SOURCE_SCHEMA_VERSION);
  } finally {
    closeQuietly(migrationDatabase);
  }
  migrationHooks?.afterDatabaseCommit?.();
  try {
    markRecoveryCommitted(material);
  } catch (error) {
    return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION);
  }
  return validateCurrentSchema(databasePath, stateDir);
}

function createNewDatabase(databasePath) {
  const directory = path.dirname(databasePath);
  const temporaryPath = path.join(directory, `.${path.basename(databasePath)}.creating-${randomUUID()}`);
  let database;
  try {
    mkdirSync(directory, { recursive: true });
    database = new DatabaseSync(temporaryPath);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(metadataSchemaSql);
    database.close();
    database = undefined;
    if (existsSync(databasePath)) throw new Error('database appeared during creation');
    linkSync(temporaryPath, databasePath);
    unlinkSync(temporaryPath);
  } catch (error) {
    closeQuietly(database);
    try { rmSync(temporaryPath, { force: true }); } catch { /* best-effort cleanup of our named temporary */ }
    throw error;
  }
  return Object.freeze({ mode: 'ready', schemaVersion: COMMAND_CENTER_SCHEMA_VERSION, migrationNeeded: false, diagnostics: Object.freeze([]) });
}

function migrateSchemaV1(databasePath) {
  let database;
  try {
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE;');
    database.exec(metadataSchemaV1ToV2Sql);
    const version = readSchemaVersion(database);
    if (version !== COMMAND_CENTER_SCHEMA_VERSION) throw new Error('schema migration did not reach the declared version');
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('schema migration violated foreign-key integrity');
    database.exec('COMMIT;');
    database.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
  } catch (error) {
    try { database?.exec('ROLLBACK;'); } catch { /* preserve migration failure */ }
    throw error;
  } finally {
    closeQuietly(database);
  }
}

function assertPluginDirectoryChain(databasePath) {
  const commandCenterDirectory = path.dirname(databasePath);
  const pluginsDirectory = path.dirname(commandCenterDirectory);
  for (const directory of [pluginsDirectory, commandCenterDirectory]) {
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error('plugin-owned directory is a symlink');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function openCore(stateDir, explicitDatabasePath, migrationHooks) {
  const databasePath = explicitDatabasePath ?? resolveCommandCenterDatabasePath(stateDir);
  let core;
  let phase = 'inspection';
  try {
    assertPluginDirectoryChain(databasePath);
    let existing = false;
    try {
      const pathStat = lstatSync(databasePath);
      if (pathStat.isSymbolicLink()) throw new Error('database path is a symlink');
      existing = pathStat.isFile();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (existing) core = inspectExistingDatabase(databasePath, stateDir, migrationHooks);
    else if (existsSync(databasePath)) core = coreFailure('storage-access-failure', 'The Command Center database path is not a regular file.', 'Check storage access and retry Command Center startup.');
    else {
      phase = 'creation';
      core = createNewDatabase(databasePath);
    }
    if (core.mode === 'ready' && core.migrationNeeded === true) {
      phase = 'migration';
      migrateSchemaV1(databasePath);
      core = inspectExistingDatabase(databasePath);
    }
  } catch (error) {
    if (phase === 'migration') core = coreFailure('migration-failure', 'The Command Center database migration could not be completed atomically.', 'Restore or retry the exact schema-1 database through the separate recovery workflow.');
    else core = phase === 'inspection' && isStorageAccessError(error)
      ? coreFailure('storage-access-failure', 'The Command Center database path could not be inspected.', 'Check storage access and retry Command Center startup.')
      : coreFailure('storage-creation-failure', 'The Command Center database could not be created or opened.', 'Check the resolved state directory and storage access, then retry startup.');
  }
  let database;
  if (core.mode === 'ready') {
    try {
      database = new DatabaseSync(databasePath);
      database.exec('PRAGMA foreign_keys = ON;');
    } catch {
      closeQuietly(database);
      core = coreFailure('storage-access-failure', 'The Command Center database could not be opened for use.', 'Check storage access and retry Command Center startup.', core.schemaVersion);
    }
  }
  return Object.freeze({ databasePath, core, database });
}

function createService(stateDir, databasePath, capabilities, migrationHooks) {
  const normalizedCapabilities = normalizeCapabilities(capabilities);
  const resolvedStateDir = stateDir ?? path.resolve(databasePath, '..', '..', '..');
  const opened = openCore(resolvedStateDir, databasePath, migrationHooks);
  const operating = evaluateOperatingMode({ core: opened.core, capabilities: normalizedCapabilities });
  let database = opened.database;
  let closed = false;
  let projectionService;

  const service = {
    databasePath: opened.databasePath,
    getOperatingStatus() {
      return {
        mode: operating.mode,
        schemaVersion: operating.schemaVersion,
        diagnostics: operating.diagnostics.map((item) => ({ ...item })),
        unavailableCapabilities: [...operating.unavailableCapabilities]
      };
    },
    verifyRollbackSnapshot(input) {
      if (closed) throw new CommandCenterMetadataError('service-closed', 'The Command Center metadata service is closed.');
      try {
        return verifyRollbackMaterial(resolvedStateDir, input || {}, opened.databasePath);
      } catch (error) {
        if (error instanceof RecoveryMaterialError) throw new CommandCenterMetadataError(error.code, error.message, { mode: operating.mode, cause: error });
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      projectionService?.close();
      closeQuietly(database);
      database = undefined;
    }
  };

  function assertOpen() {
    if (closed) throw new CommandCenterMetadataError('service-closed', 'The Command Center metadata service is closed.');
    if (!database) throw new CommandCenterMetadataError('recovery-only', 'Command Center metadata is recovery-only.', { mode: 'recovery-only' });
  }

  function assertMutation(capability = null) {
    if (closed) throw new CommandCenterMetadataError('service-closed', 'The Command Center metadata service is closed.');
    if (operating.mode === 'recovery-only') throw new CommandCenterMetadataError('recovery-only', 'Command Center metadata is recovery-only; mutations are blocked.', { mode: operating.mode });
    if (capability && normalizedCapabilities[capability]?.available === false) throw new CommandCenterMetadataError('capability-unavailable', `${capability} capability is unavailable; this mutation is blocked.`, { mode: operating.mode, capability });
    if (!database) throw new CommandCenterMetadataError('storage-unavailable', 'Command Center metadata storage is unavailable.', { mode: operating.mode });
  }

  function readOne(sql, values, mapper) {
    assertOpen();
    return mapper(database.prepare(sql).get(...values));
  }

  function readMany(sql, values, mapper) {
    assertOpen();
    return database.prepare(sql).all(...values).map(mapper);
  }

  service.readProjectionSnapshot = () => {
    assertOpen();
    const unavailableProjectionCapability = ['notes', 'sessions', 'scheduler'].find((capability) => normalizedCapabilities[capability]?.available !== true);
    if (operating.mode === 'recovery-only' || unavailableProjectionCapability) throw new CommandCenterMetadataError('metadata-not-ready', 'Command Center metadata is not ready for projection.', { mode: operating.mode, capability: unavailableProjectionCapability ?? null });
      database.exec('BEGIN');
      try {
        const snapshot = {
        topics: database.prepare("SELECT topic_id AS topicId, para_category AS paraCategory, lifecycle, created_at AS createdAt, updated_at AS updatedAt FROM topics WHERE lifecycle = 'active' ORDER BY topic_id").all(),
        sourceReferences: database.prepare("SELECT reference_id AS referenceId, topic_id AS topicId, source_system AS sourceSystem, source_kind AS sourceKind, external_source_id AS externalSourceId, created_at AS createdAt, updated_at AS updatedAt FROM source_references WHERE topic_id IN (SELECT topic_id FROM topics WHERE lifecycle = 'active') ORDER BY referenceId").all(),
        sourceConventionState: database.prepare("SELECT state.reference_id AS referenceId, state.aspect, state.state, state.updated_at AS updatedAt FROM source_convention_state AS state JOIN source_references AS reference ON reference.reference_id = state.reference_id JOIN topics ON topics.topic_id = reference.topic_id WHERE topics.lifecycle = 'active' ORDER BY state.reference_id, state.aspect").all(),
        presentationPreferences: database.prepare("SELECT preferences.topic_id AS topicId, preferences.display_label AS displayLabel, preferences.sort_order AS sortOrder, preferences.collapsed, preferences.updated_at AS updatedAt FROM presentation_preferences AS preferences JOIN topics ON topics.topic_id = preferences.topic_id WHERE topics.lifecycle = 'active' ORDER BY preferences.topic_id").all().map((row) => ({ ...row, collapsed: row.collapsed === 1 })),
        attentionActivityLinks: database.prepare("SELECT link_id AS linkId, attention_id AS attentionId, activity_id AS activityId, topic_id AS topicId, created_at AS createdAt FROM attention_activity_links WHERE topic_id IS NULL OR topic_id IN (SELECT topic_id FROM topics WHERE lifecycle = 'active') ORDER BY linkId").all(),
        proposalStates: database.prepare("SELECT proposal_id AS proposalId, topic_id AS topicId, state, revision, created_at AS createdAt, updated_at AS updatedAt FROM proposal_states WHERE topic_id IN (SELECT topic_id FROM topics WHERE lifecycle = 'active') ORDER BY proposalId").all(),
        policyVersions: database.prepare('SELECT policy_id AS policyId, version, digest, updated_at AS updatedAt FROM policy_versions ORDER BY policyId').all()
      };
      database.exec('COMMIT');
      return freezeSnapshot(snapshot);
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* preserve the original read failure */ }
      throw error;
    }
  };
  service.readCanonicalProjectionSnapshot = service.readProjectionSnapshot;

  function mutate(capability, operation) {
    assertMutation(capability);
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(database);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* preserve the original public failure */ }
      throw error;
    }
  }

  function topicInput(input, { partial = false } = {}) {
    const value = objectValue(input, 'topic');
    allowedKeys(value, ['topicId', 'paraCategory', 'lifecycle', 'createdAt', 'updatedAt'], 'topic');
    const result = {};
    if (!partial || value.topicId !== undefined) result.topicId = requiredString(value.topicId, 'topicId');
    if (!partial || value.paraCategory !== undefined) result.paraCategory = enumValue(value.paraCategory, paraCategories, 'paraCategory');
    if (!partial || value.lifecycle !== undefined) result.lifecycle = enumValue(value.lifecycle, topicLifecycles, 'lifecycle');
    if (value.createdAt !== undefined) result.createdAt = timestamp(value.createdAt, 'createdAt');
    if (value.updatedAt !== undefined) result.updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return result;
  }

  service.createTopic = (input) => {
    const value = topicInput(input);
    const now = timestamp(undefined, 'createdAt');
    return mutate(null, (db) => {
      db.prepare('INSERT INTO topics (topic_id, para_category, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(value.topicId, value.paraCategory, value.lifecycle, value.createdAt ?? now, value.updatedAt ?? value.createdAt ?? now);
      return mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(value.topicId));
    });
  };

  service.updateTopic = (input) => {
    const value = topicInput(input, { partial: true });
    if (!value.topicId) throw new CommandCenterMetadataError('invalid-value', 'topicId is required');
    if (!value.paraCategory && !value.lifecycle) throw new CommandCenterMetadataError('invalid-value', 'topic classification update is empty');
    const updatedAt = value.updatedAt ?? timestamp(undefined, 'updatedAt');
    return mutate(null, (db) => {
      const current = db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(value.topicId);
      if (!current) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
      db.prepare('UPDATE topics SET para_category = ?, lifecycle = ?, updated_at = ? WHERE topic_id = ?').run(value.paraCategory ?? current.para_category, value.lifecycle ?? current.lifecycle, updatedAt, value.topicId);
      return mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(value.topicId));
    });
  };

  service.getTopic = (topicId) => readOne('SELECT * FROM topics WHERE topic_id = ?', [requiredString(topicId, 'topicId')], mapTopic) || null;
  service.listTopics = () => readMany('SELECT * FROM topics ORDER BY topic_id', [], mapTopic);
  service.listUsableTopics = () => readMany("SELECT * FROM topics WHERE lifecycle = 'active' ORDER BY topic_id", [], mapTopic);
  service.deleteTopic = (topicId) => {
    requiredString(topicId, 'topicId');
    return mutate(null, (db) => {
      if (db.prepare('SELECT 1 FROM source_references WHERE topic_id = ? LIMIT 1').get(topicId)) {
        throw new CommandCenterMetadataError('dependent-record', 'Topic is still referenced by a Source Reference.');
      }
      return db.prepare('DELETE FROM topics WHERE topic_id = ?').run(topicId).changes > 0;
    });
  };

  function capabilityForSourceSystem(sourceSystem) {
    if (sourceSystem === 'obsidian') return 'notes';
    if (sourceSystem === 'openclaw') return 'sessions';
    if (sourceSystem === 'scheduler') return 'scheduler';
    return null;
  }

  function mutateCapabilityInsideTransaction(sourceSystem) {
    const capability = capabilityForSourceSystem(sourceSystem);
    if (capability && normalizedCapabilities[capability]?.available === false) throw new CommandCenterMetadataError('capability-unavailable', `${capability} capability is unavailable; this mutation is blocked.`, { mode: operating.mode, capability });
  }

  function referenceInput(input) {
    const value = objectValue(input, 'source reference');
    allowedKeys(value, ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt', 'updatedAt'], 'source reference');
    if (value.version !== 1) throw new CommandCenterMetadataError('unsupported-version', 'Source Reference version must be 1.');
    if (value.observedRevision !== undefined && value.observedRevision !== null && !isNonBlankString(value.observedRevision)) throw new CommandCenterMetadataError('invalid-value', 'observedRevision must be a non-blank string or null');
    return {
      referenceId: requiredString(value.referenceId, 'referenceId'),
      topicId: requiredString(value.topicId, 'topicId'),
      sourceSystem: requiredString(value.sourceSystem, 'sourceSystem'),
      sourceKind: requiredString(value.sourceKind, 'sourceKind'),
      externalSourceId: requiredString(value.externalSourceId, 'externalSourceId'),
      observedRevision: value.observedRevision ?? null,
      createdAt: value.createdAt === undefined ? undefined : timestamp(value.createdAt, 'createdAt'),
      updatedAt: value.updatedAt === undefined ? undefined : timestamp(value.updatedAt, 'updatedAt')
    };
  }

  function insertSourceReference(db, value, now) {
    const topic = db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(value.topicId);
    if (!topic) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
    db.prepare('INSERT INTO source_references (reference_id, topic_id, source_system, source_kind, external_source_id, last_observed_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(value.referenceId, value.topicId, value.sourceSystem, value.sourceKind, value.externalSourceId, value.observedRevision, value.createdAt ?? now, value.updatedAt ?? value.createdAt ?? now);
    return mapSourceReference(db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(value.referenceId));
  }

  service.createSourceReference = (input) => {
    const value = referenceInput(input);
    return mutate(capabilityForSourceSystem(value.sourceSystem), (db) => insertSourceReference(db, value, timestamp(undefined, 'createdAt')));
  };

  service.createMigrationTopicBinding = ({ topic: topicInputValue, reference: referenceInputValue } = {}) => {
    const topic = topicInput(topicInputValue);
    const reference = referenceInput(referenceInputValue);
    if (topic.lifecycle !== 'provisioning' || reference.topicId !== topic.topicId || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note_folder') throw new CommandCenterMetadataError('invalid-value', 'Migration Topic bootstrap requires its exact provisioning Note Folder binding.');
    return mutate('notes', (db) => {
      const now = topic.createdAt ?? timestamp(undefined, 'createdAt');
      db.prepare('INSERT INTO topics (topic_id, para_category, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(topic.topicId, topic.paraCategory, topic.lifecycle, now, topic.updatedAt ?? now);
      return Object.freeze({ topic: mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(topic.topicId)), reference: insertSourceReference(db, reference, now) });
    });
  };

  service.updateSourceReference = (input) => {
    const value = objectValue(input, 'source reference update');
    allowedKeys(value, ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt', 'updatedAt'], 'source reference update');
    if (value.version !== 1) throw new CommandCenterMetadataError('unsupported-version', 'Source Reference version must be 1.');
    const referenceId = requiredString(value.referenceId, 'referenceId');
    if (value.observedRevision !== undefined && value.observedRevision !== null && !isNonBlankString(value.observedRevision)) throw new CommandCenterMetadataError('invalid-value', 'observedRevision must be a non-blank string or null');
    return mutate(null, (db) => {
      const current = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(referenceId);
      if (!current) throw new CommandCenterMetadataError('not-found', 'Source Reference was not found.');
      for (const [field, column] of [['topicId', 'topic_id'], ['sourceSystem', 'source_system'], ['sourceKind', 'source_kind'], ['externalSourceId', 'external_source_id']]) {
        if (value[field] !== undefined && value[field] !== current[column]) throw new CommandCenterMetadataError('identity-change', 'Source Reference identity is immutable.');
      }
      mutateCapabilityInsideTransaction(current.source_system);
      const updatedAt = timestamp(undefined, 'updatedAt');
      db.prepare('UPDATE source_references SET last_observed_revision = ?, updated_at = ? WHERE reference_id = ?').run(value.observedRevision === undefined ? current.last_observed_revision : value.observedRevision, updatedAt, referenceId);
      return mapSourceReference(db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(referenceId));
    });
  };

  service.observeSourceReference = ({ referenceId, observedRevision, updatedAt } = {}) => {
    requiredString(referenceId, 'referenceId');
    if (observedRevision !== null && !isNonBlankString(observedRevision)) throw new CommandCenterMetadataError('invalid-value', 'observedRevision must be a non-blank string or null');
    return mutate(null, (db) => {
      const current = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(referenceId);
      if (!current) throw new CommandCenterMetadataError('not-found', 'Source Reference was not found.');
      db.prepare('UPDATE source_references SET last_observed_revision = ?, updated_at = ? WHERE reference_id = ?').run(observedRevision, timestamp(updatedAt, 'updatedAt'), referenceId);
      return mapSourceReference(db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(referenceId));
    });
  };

  service.deleteSourceReference = (referenceId) => {
    requiredString(referenceId, 'referenceId');
    return mutate(null, (db) => {
      const current = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(referenceId);
      if (!current) throw new CommandCenterMetadataError('not-found', 'Source Reference was not found.');
      mutateCapabilityInsideTransaction(current.source_system);
      db.prepare('DELETE FROM source_references WHERE reference_id = ?').run(referenceId);
      return true;
    });
  };

  service.getSourceReference = (referenceId) => readOne('SELECT * FROM source_references WHERE reference_id = ?', [requiredString(referenceId, 'referenceId')], mapSourceReference) || null;
  service.listSourceReferences = (topicId = undefined) => topicId === undefined
    ? readMany('SELECT * FROM source_references ORDER BY reference_id', [], mapSourceReference)
    : readMany('SELECT * FROM source_references WHERE topic_id = ? ORDER BY reference_id', [requiredString(topicId, 'topicId')], mapSourceReference);

  service.setSourceConventionState = (input) => {
    const value = objectValue(input, 'convention state');
    allowedKeys(value, ['referenceId', 'aspect', 'state', 'updatedAt'], 'convention state');
    const referenceId = requiredString(value.referenceId, 'referenceId');
    const aspect = enumValue(value.aspect, conventionAspects, 'aspect');
    const state = enumValue(value.state, conventionStates, 'state');
    return mutate(null, (db) => {
      const reference = db.prepare('SELECT source_system FROM source_references WHERE reference_id = ?').get(referenceId);
      if (!reference) throw new CommandCenterMetadataError('not-found', 'Source Reference was not found.');
      mutateCapabilityInsideTransaction(reference.source_system);
      const updatedAt = timestamp(value.updatedAt, 'updatedAt');
      db.prepare('INSERT INTO source_convention_state (reference_id, aspect, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(reference_id, aspect) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at').run(referenceId, aspect, state, updatedAt);
      return mapConvention(db.prepare('SELECT * FROM source_convention_state WHERE reference_id = ? AND aspect = ?').get(referenceId, aspect));
    });
  };

  service.getSourceConventionState = (referenceId) => readMany('SELECT * FROM source_convention_state WHERE reference_id = ? ORDER BY aspect', [requiredString(referenceId, 'referenceId')], mapConvention);

  service.setPresentationPreferences = (input) => {
    const value = objectValue(input, 'presentation preferences');
    allowedKeys(value, ['topicId', 'displayLabel', 'sortOrder', 'collapsed', 'updatedAt'], 'presentation preferences');
    const topicId = requiredString(value.topicId, 'topicId');
    const displayLabel = optionalString(value.displayLabel, 'displayLabel');
    const sortOrder = integerValue(value.sortOrder ?? 0, 'sortOrder');
    const collapsed = booleanValue(value.collapsed ?? false, 'collapsed');
    const updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return mutate(null, (db) => {
      if (!db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(topicId)) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
      db.prepare('INSERT INTO presentation_preferences (topic_id, display_label, sort_order, collapsed, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET display_label = excluded.display_label, sort_order = excluded.sort_order, collapsed = excluded.collapsed, updated_at = excluded.updated_at').run(topicId, displayLabel, sortOrder, collapsed ? 1 : 0, updatedAt);
      return mapPreferences(db.prepare('SELECT * FROM presentation_preferences WHERE topic_id = ?').get(topicId));
    });
  };

  service.getPresentationPreferences = (topicId) => readOne('SELECT * FROM presentation_preferences WHERE topic_id = ?', [requiredString(topicId, 'topicId')], mapPreferences) || null;

  service.linkAttentionActivity = (input) => {
    const value = objectValue(input, 'Attention/Activity link');
    allowedKeys(value, ['linkId', 'attentionId', 'activityId', 'topicId', 'createdAt'], 'Attention/Activity link');
    const linkId = requiredString(value.linkId, 'linkId');
    const attentionId = requiredString(value.attentionId, 'attentionId');
    const activityId = requiredString(value.activityId, 'activityId');
    const topicId = value.topicId === undefined ? null : requiredString(value.topicId, 'topicId');
    const createdAt = timestamp(value.createdAt, 'createdAt');
    return mutate(null, (db) => {
      if (topicId !== null && !db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(topicId)) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
      db.prepare('INSERT INTO attention_activity_links (link_id, attention_id, activity_id, topic_id, created_at) VALUES (?, ?, ?, ?, ?)').run(linkId, attentionId, activityId, topicId, createdAt);
      return mapLink(db.prepare('SELECT * FROM attention_activity_links WHERE link_id = ?').get(linkId));
    });
  };

  service.getAttentionActivityLink = (linkId) => readOne('SELECT * FROM attention_activity_links WHERE link_id = ?', [requiredString(linkId, 'linkId')], mapLink) || null;
  service.listAttentionActivityLinks = () => readMany('SELECT * FROM attention_activity_links ORDER BY link_id', [], mapLink);
  service.deleteAttentionActivityLink = (linkId) => {
    requiredString(linkId, 'linkId');
    return mutate(null, (db) => {
      const result = db.prepare('DELETE FROM attention_activity_links WHERE link_id = ?').run(linkId);
      return result.changes > 0;
    });
  };

  service.setProposalState = (input) => {
    const value = objectValue(input, 'proposal state');
    allowedKeys(value, ['proposalId', 'topicId', 'state', 'revision', 'createdAt', 'updatedAt'], 'proposal state');
    const proposalId = requiredString(value.proposalId, 'proposalId');
    const topicId = requiredString(value.topicId, 'topicId');
    const state = enumValue(value.state, proposalStates, 'state');
    const revision = integerValue(value.revision ?? 0, 'revision', { minimum: 0 });
    const createdAt = timestamp(value.createdAt, 'createdAt');
    const updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return mutate(null, (db) => {
      if (!db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(topicId)) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
      const existing = db.prepare('SELECT topic_id FROM proposal_states WHERE proposal_id = ?').get(proposalId);
      if (existing && existing.topic_id !== topicId) throw new CommandCenterMetadataError('identity-change', 'Proposal identity is immutable.');
      db.prepare('INSERT INTO proposal_states (proposal_id, topic_id, state, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(proposal_id) DO UPDATE SET topic_id = excluded.topic_id, state = excluded.state, revision = excluded.revision, updated_at = excluded.updated_at').run(proposalId, topicId, state, revision, createdAt, updatedAt);
      return mapProposal(db.prepare('SELECT * FROM proposal_states WHERE proposal_id = ?').get(proposalId));
    });
  };

  service.getProposalState = (proposalId) => readOne('SELECT * FROM proposal_states WHERE proposal_id = ?', [requiredString(proposalId, 'proposalId')], mapProposal) || null;
  service.listProposalStates = () => readMany('SELECT * FROM proposal_states ORDER BY proposal_id', [], mapProposal);

  service.setPolicyVersion = (input) => {
    const value = objectValue(input, 'policy version');
    allowedKeys(value, ['policyId', 'version', 'digest', 'updatedAt'], 'policy version');
    const policyId = requiredString(value.policyId, 'policyId');
    const version = requiredString(value.version, 'version');
    const digest = requiredString(value.digest, 'digest');
    const updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return mutate(null, (db) => {
      db.prepare('INSERT INTO policy_versions (policy_id, version, digest, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(policy_id) DO UPDATE SET version = excluded.version, digest = excluded.digest, updated_at = excluded.updated_at').run(policyId, version, digest, updatedAt);
      return mapPolicy(db.prepare('SELECT * FROM policy_versions WHERE policy_id = ?').get(policyId));
    });
  };

  service.getPolicyVersion = (policyId) => readOne('SELECT * FROM policy_versions WHERE policy_id = ?', [requiredString(policyId, 'policyId')], mapPolicy) || null;
  service.listPolicyVersions = () => readMany('SELECT * FROM policy_versions ORDER BY policy_id', [], mapPolicy);

  service.setProjectionBookkeeping = (input) => {
    const value = objectValue(input, 'projection bookkeeping');
    allowedKeys(value, ['projectionId', 'sourceRevision', 'inputDigest', 'updatedAt'], 'projection bookkeeping');
    const projectionId = requiredString(value.projectionId, 'projectionId');
    const sourceRevision = requiredString(value.sourceRevision, 'sourceRevision');
    const inputDigest = requiredString(value.inputDigest, 'inputDigest');
    if (projectionId === commandCenterProjectionId && !sha256DigestPattern.test(inputDigest)) {
      throw new CommandCenterMetadataError('invalid-value', 'Command Center projection inputDigest must be sha256:<64 lowercase hex>.');
    }
    const updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return mutate(null, (db) => {
      db.prepare('INSERT INTO projection_bookkeeping (projection_id, source_revision, input_digest, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(projection_id) DO UPDATE SET source_revision = excluded.source_revision, input_digest = excluded.input_digest, updated_at = excluded.updated_at').run(projectionId, sourceRevision, inputDigest, updatedAt);
      return mapProjection(db.prepare('SELECT * FROM projection_bookkeeping WHERE projection_id = ?').get(projectionId));
    });
  };

  service.setProjectionBookkeepingBatch = (inputs) => {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new CommandCenterMetadataError('invalid-value', 'Projection bookkeeping batch must be a non-empty array.');
    const rows = inputs.map((input) => {
      const value = objectValue(input, 'projection bookkeeping');
      allowedKeys(value, ['projectionId', 'sourceRevision', 'inputDigest', 'updatedAt'], 'projection bookkeeping');
      return {
        projectionId: requiredString(value.projectionId, 'projectionId'),
        sourceRevision: requiredString(value.sourceRevision, 'sourceRevision'),
        inputDigest: requiredString(value.inputDigest, 'inputDigest'),
        updatedAt: timestamp(value.updatedAt, 'updatedAt')
      };
    });
    if (new Set(rows.map(({ projectionId }) => projectionId)).size !== rows.length) throw new CommandCenterMetadataError('invalid-value', 'Projection bookkeeping batch contains duplicate projection IDs.');
    return mutate(null, (db) => {
      const statement = db.prepare('INSERT INTO projection_bookkeeping (projection_id, source_revision, input_digest, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(projection_id) DO UPDATE SET source_revision = excluded.source_revision, input_digest = excluded.input_digest, updated_at = excluded.updated_at');
      for (const row of rows) statement.run(row.projectionId, row.sourceRevision, row.inputDigest, row.updatedAt);
      return rows.map(({ projectionId }) => mapProjection(db.prepare('SELECT * FROM projection_bookkeeping WHERE projection_id = ?').get(projectionId)));
    });
  };

  service.getProjectionBookkeeping = (projectionId) => readOne('SELECT * FROM projection_bookkeeping WHERE projection_id = ?', [requiredString(projectionId, 'projectionId')], mapProjection) || null;
  service.listProjectionBookkeeping = () => readMany('SELECT * FROM projection_bookkeeping ORDER BY projection_id', [], mapProjection);

  service.recordOperation = (input) => {
    const value = objectValue(input, 'operation journal record');
    allowedKeys(value, ['logicalOperationId', 'transportRequestId', 'intentDigest', 'operationKind', 'state', 'resultStatus', 'resultIdentity', 'observedRevision', 'createdAt', 'updatedAt'], 'operation journal record');
    const logicalOperationId = requiredString(value.logicalOperationId, 'logicalOperationId');
    const transportRequestId = requiredString(value.transportRequestId, 'transportRequestId');
    const intentDigest = requiredString(value.intentDigest, 'intentDigest');
    const operationKind = requiredString(value.operationKind, 'operationKind');
    const state = enumValue(value.state, ['pending', 'applied', 'not-applied', 'conflict', 'unknown'], 'state');
    const now = timestamp(value.createdAt, 'createdAt');
    const updatedAt = timestamp(value.updatedAt, 'updatedAt', now);
    return mutate(null, (db) => {
      const existing = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(logicalOperationId);
      if (existing && existing.intent_digest !== intentDigest) throw new CommandCenterMetadataError('intent-mismatch', 'Logical operation ID was reused with a different intent.');
      db.prepare(`INSERT INTO operation_journal
        (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(logical_operation_id) DO UPDATE SET transport_request_id = excluded.transport_request_id, state = excluded.state,
          result_status = excluded.result_status, result_identity = excluded.result_identity, observed_revision = excluded.observed_revision, updated_at = excluded.updated_at`).run(
        logicalOperationId, transportRequestId, intentDigest, operationKind, state, value.resultStatus ?? null, value.resultIdentity ?? null,
        value.observedRevision ?? null, existing?.created_at ?? now, updatedAt
      );
      return mapOperation(db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(logicalOperationId));
    });
  };
  service.getOperation = (logicalOperationId) => readOne('SELECT * FROM operation_journal WHERE logical_operation_id = ?', [requiredString(logicalOperationId, 'logicalOperationId')], mapOperation) || null;
  service.listOperations = () => readMany('SELECT * FROM operation_journal ORDER BY created_at, logical_operation_id', [], mapOperation);

  service.setSessionState = (input) => {
    const value = objectValue(input, 'session state');
    allowedKeys(value, ['referenceId', 'sessionId', 'status', 'isPrimary', 'wasPrimary', 'displayName', 'updatedAt'], 'session state');
    const referenceId = requiredString(value.referenceId, 'referenceId');
    const status = enumValue(value.status, ['open', 'closed'], 'status');
    const isPrimary = booleanValue(value.isPrimary ?? false, 'isPrimary');
    const updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return mutate('sessions', (db) => {
      const reference = db.prepare('SELECT topic_id, external_source_id FROM source_references WHERE reference_id = ? AND source_system = ? AND source_kind = ?').get(referenceId, 'openclaw', 'session');
      if (!reference) throw new CommandCenterMetadataError('not-found', 'Session Source Reference was not found.');
      const current = db.prepare('SELECT * FROM session_state WHERE reference_id = ?').get(referenceId);
      const displayName = optionalString(value.displayName, 'displayName', current?.display_name || reference.external_source_id).trim();
      if (!displayName || displayName.length > 300) throw new CommandCenterMetadataError('invalid-value', 'displayName must be 1–300 characters');
      const wasPrimary = value.wasPrimary === undefined ? current?.was_primary === 1 || current?.is_primary === 1 && !isPrimary : booleanValue(value.wasPrimary, 'wasPrimary');
      if (status === 'closed' && isPrimary) throw new CommandCenterMetadataError('primary-session', 'The Primary Session cannot be closed until another Session is Primary.');
      if (isPrimary) {
        db.prepare(`UPDATE session_state SET is_primary = 0, was_primary = 1, updated_at = ?
          WHERE reference_id <> ? AND reference_id IN (
            SELECT reference_id FROM source_references WHERE topic_id = ? AND source_system = 'openclaw' AND source_kind = 'session'
          )`).run(updatedAt, referenceId, reference.topic_id);
      }
      db.prepare(`INSERT INTO session_state (reference_id, session_id, status, is_primary, was_primary, display_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(reference_id) DO UPDATE SET session_id = excluded.session_id, status = excluded.status, is_primary = excluded.is_primary, was_primary = excluded.was_primary, display_name = excluded.display_name, updated_at = excluded.updated_at`).run(referenceId, value.sessionId ?? null, status, isPrimary ? 1 : 0, wasPrimary ? 1 : 0, displayName, updatedAt);
      return mapSessionState(db.prepare('SELECT * FROM session_state WHERE reference_id = ?').get(referenceId));
    });
  };

  service.createSessionBinding = ({ reference: referenceInputValue, state: stateInputValue } = {}) => {
    const reference = referenceInput(referenceInputValue);
    if (reference.sourceSystem !== 'openclaw' || reference.sourceKind !== 'session') throw new CommandCenterMetadataError('invalid-value', 'A Session binding requires an openclaw/session Source Reference.');
    const stateValue = objectValue(stateInputValue, 'session state');
    allowedKeys(stateValue, ['referenceId', 'sessionId', 'status', 'isPrimary', 'wasPrimary', 'displayName', 'updatedAt'], 'session state');
    const referenceId = requiredString(stateValue.referenceId, 'referenceId');
    const sessionId = requiredString(stateValue.sessionId, 'sessionId');
    const status = enumValue(stateValue.status, ['open', 'closed'], 'status');
    const isPrimary = booleanValue(stateValue.isPrimary ?? false, 'isPrimary');
    const wasPrimary = booleanValue(stateValue.wasPrimary ?? false, 'wasPrimary');
    const displayName = optionalString(stateValue.displayName, 'displayName', reference.externalSourceId).trim();
    if (!displayName || displayName.length > 300) throw new CommandCenterMetadataError('invalid-value', 'displayName must be 1–300 characters');
    const updatedAt = timestamp(stateValue.updatedAt, 'updatedAt');
    if (referenceId !== reference.referenceId) throw new CommandCenterMetadataError('invalid-value', 'Session state must identify the new Source Reference.');
    if (status === 'closed' && isPrimary) throw new CommandCenterMetadataError('primary-session', 'The Primary Session cannot be created closed.');
    return mutate('sessions', (db) => {
      const created = insertSourceReference(db, reference, updatedAt);
      if (isPrimary) {
        db.prepare(`UPDATE session_state SET is_primary = 0, was_primary = 1, updated_at = ?
          WHERE reference_id <> ? AND reference_id IN (
            SELECT reference_id FROM source_references WHERE topic_id = ? AND source_system = 'openclaw' AND source_kind = 'session'
          )`).run(updatedAt, referenceId, reference.topicId);
      }
      db.prepare('INSERT INTO session_state (reference_id, session_id, status, is_primary, was_primary, display_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(referenceId, sessionId, status, isPrimary ? 1 : 0, wasPrimary ? 1 : 0, displayName, updatedAt);
      return Object.freeze({ reference: created, state: mapSessionState(db.prepare('SELECT * FROM session_state WHERE reference_id = ?').get(referenceId)) });
    });
  };
  service.getSessionState = (referenceId) => readOne('SELECT * FROM session_state WHERE reference_id = ?', [requiredString(referenceId, 'referenceId')], mapSessionState) || null;
  service.listSessionStates = () => readMany('SELECT * FROM session_state ORDER BY reference_id', [], mapSessionState);

  service.getMigrationState = () => readOne('SELECT * FROM migration_state WHERE state_id = ?', ['legacy-discord-v1'], mapMigrationState) || null;
  service.getMigrationCompletion = () => readOne('SELECT * FROM migration_completion WHERE completion_id = ?', ['legacy-discord-v1'], mapMigrationCompletion) || null;
  service.listMigrationChannels = () => readMany('SELECT * FROM migration_channels ORDER BY source_channel_id', [], mapMigrationChannel);
  service.getMigrationChannel = (sourceChannelId) => readOne('SELECT * FROM migration_channels WHERE source_channel_id = ?', [requiredString(sourceChannelId, 'sourceChannelId')], mapMigrationChannel) || null;
  service.listMigrationOccurrences = (sourceChannelId) => readMany('SELECT * FROM migration_occurrences WHERE source_channel_id = ? ORDER BY display_order', [requiredString(sourceChannelId, 'sourceChannelId')], mapMigrationOccurrence);

  service.setMigrationState = (input) => {
    const value = objectValue(input, 'migration state');
    allowedKeys(value, ['stateId', 'schemaVersion', 'configDigest', 'sourceDigest', 'revision', 'phase', 'failureCode', 'failureSummary', 'failureCount', 'updatedAt'], 'migration state');
    const stateId = value.stateId ?? 'legacy-discord-v1';
    const schemaVersion = value.schemaVersion ?? 1;
    const configDigest = requiredString(value.configDigest, 'configDigest');
    const sourceDigest = requiredString(value.sourceDigest, 'sourceDigest');
    const phase = enumValue(value.phase, ['pending', 'provisioning', 'importing', 'verifying', 'review'], 'phase');
    const failureCode = value.failureCode === undefined || value.failureCode === null ? null : optionalString(value.failureCode, 'failureCode');
    const failureSummary = value.failureSummary === undefined || value.failureSummary === null ? null : optionalString(value.failureSummary, 'failureSummary').slice(0, 300);
    const failureCount = integerValue(value.failureCount ?? 0, 'failureCount', { minimum: 0 });
    const updatedAt = timestamp(value.updatedAt, 'updatedAt');
    if (stateId !== 'legacy-discord-v1' || schemaVersion !== 1) throw new CommandCenterMetadataError('invalid-value', 'Unsupported migration state identity.');
    return mutate(null, (db) => {
      const existing = db.prepare('SELECT revision FROM migration_state WHERE state_id = ?').get(stateId);
      const revision = existing ? existing.revision + 1 : integerValue(value.revision ?? 1, 'revision', { minimum: 1 });
      db.prepare(`INSERT INTO migration_state (state_id, schema_version, config_digest, source_digest, revision, phase, failure_code, failure_summary, failure_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(state_id) DO UPDATE SET config_digest = excluded.config_digest, source_digest = excluded.source_digest, revision = excluded.revision, phase = excluded.phase, failure_code = excluded.failure_code, failure_summary = excluded.failure_summary, failure_count = excluded.failure_count, updated_at = excluded.updated_at`).run(stateId, schemaVersion, configDigest, sourceDigest, revision, phase, failureCode, failureSummary, failureCount, updatedAt);
      return mapMigrationState(db.prepare('SELECT * FROM migration_state WHERE state_id = ?').get(stateId));
    });
  };

  service.setMigrationOccurrences = (sourceChannelId, occurrences) => {
    const channelId = requiredString(sourceChannelId, 'sourceChannelId');
    if (!Array.isArray(occurrences)) throw new CommandCenterMetadataError('invalid-value', 'migration occurrences must be an array');
    return mutate(null, (db) => {
      for (const occurrence of occurrences) {
        const value = objectValue(occurrence, 'migration occurrence');
        allowedKeys(value, ['occurrenceId', 'occurrenceDigest', 'displayOrder', 'destinationMessageId', 'destinationAnchor'], 'migration occurrence');
        const occurrenceId = requiredString(value.occurrenceId, 'occurrenceId');
        const occurrenceDigest = requiredString(value.occurrenceDigest, 'occurrenceDigest');
        const displayOrder = integerValue(value.displayOrder, 'displayOrder', { minimum: 0 });
        const destinationMessageId = value.destinationMessageId == null ? null : requiredString(value.destinationMessageId, 'destinationMessageId');
        const destinationAnchorJson = value.destinationAnchor == null ? null : JSON.stringify(objectValue(value.destinationAnchor, 'destinationAnchor'));
        const destinationAnchorDigest = destinationAnchorJson ? 'sha256:' + createHash('sha256').update(destinationAnchorJson).digest('hex') : null;
        if (destinationAnchorJson && destinationAnchorJson.length > 2000) throw new CommandCenterMetadataError('invalid-value', 'destinationAnchor is too large.');
        const existing = db.prepare('SELECT occurrence_digest, display_order, destination_message_id, destination_anchor_json, destination_anchor_digest FROM migration_occurrences WHERE source_channel_id = ? AND occurrence_id = ?').get(channelId, occurrenceId);
        if (existing && (existing.occurrence_digest !== occurrenceDigest || existing.display_order !== displayOrder || (existing.destination_message_id && destinationMessageId && existing.destination_message_id !== destinationMessageId) || (existing.destination_anchor_json && destinationAnchorJson && existing.destination_anchor_json !== destinationAnchorJson))) throw new CommandCenterMetadataError('conflict', 'Migration occurrence identity cannot be rebound.');
        db.prepare(`INSERT INTO migration_occurrences (source_channel_id, occurrence_id, occurrence_digest, display_order, destination_message_id, destination_anchor_json, destination_anchor_digest) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_channel_id, occurrence_id) DO UPDATE SET destination_message_id = COALESCE(migration_occurrences.destination_message_id, excluded.destination_message_id), destination_anchor_json = COALESCE(migration_occurrences.destination_anchor_json, excluded.destination_anchor_json), destination_anchor_digest = COALESCE(migration_occurrences.destination_anchor_digest, excluded.destination_anchor_digest)`).run(channelId, occurrenceId, occurrenceDigest, displayOrder, destinationMessageId, destinationAnchorJson, destinationAnchorDigest);
      }
      return service.listMigrationOccurrences(channelId);
    });
  };

  service.setMigrationChannel = (input) => {
    const value = objectValue(input, 'migration channel');
    allowedKeys(value, ['sourceChannelId', 'topicId', 'noteFolderReferenceId', 'sessionReferenceId', 'sessionId', 'phase', 'expectedCount', 'expectedDigest', 'importedCount', 'importedDigest', 'nextOrdinal', 'failureCode', 'failureSummary', 'failureCount', 'updatedAt'], 'migration channel');
    const sourceChannelId = requiredString(value.sourceChannelId, 'sourceChannelId');
    const topicId = requiredString(value.topicId, 'topicId');
    const noteFolderReferenceId = requiredString(value.noteFolderReferenceId, 'noteFolderReferenceId');
    const sessionReferenceId = requiredString(value.sessionReferenceId, 'sessionReferenceId');
    const sessionId = requiredString(value.sessionId, 'sessionId');
    const phase = enumValue(value.phase, ['pending', 'provisioning', 'importing', 'verifying', 'review', 'complete'], 'phase');
    const expectedCount = integerValue(value.expectedCount, 'expectedCount', { minimum: 0 });
    const expectedDigest = requiredString(value.expectedDigest, 'expectedDigest');
    const importedCount = integerValue(value.importedCount ?? 0, 'importedCount', { minimum: 0 });
    const importedDigest = requiredString(value.importedDigest ?? 'sha256:' + '0'.repeat(64), 'importedDigest');
    const nextOrdinal = integerValue(value.nextOrdinal ?? 0, 'nextOrdinal', { minimum: 0 });
    const failureCount = integerValue(value.failureCount ?? 0, 'failureCount', { minimum: 0 });
    const failureCode = value.failureCode === undefined || value.failureCode === null ? null : optionalString(value.failureCode, 'failureCode');
    const failureSummary = value.failureSummary === undefined || value.failureSummary === null ? null : optionalString(value.failureSummary, 'failureSummary').slice(0, 300);
    const updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return mutate(null, (db) => {
      const existing = db.prepare('SELECT * FROM migration_channels WHERE source_channel_id = ?').get(sourceChannelId);
      if (existing && (existing.topic_id !== topicId || existing.note_folder_reference_id !== noteFolderReferenceId || existing.session_reference_id !== sessionReferenceId || existing.session_id !== sessionId)) {
        throw new CommandCenterMetadataError('conflict', 'Migration destination identity cannot be rebound.');
      }
      db.prepare(`INSERT INTO migration_channels
        (source_channel_id, topic_id, note_folder_reference_id, session_reference_id, session_id, phase, expected_count, expected_digest, imported_count, imported_digest, next_ordinal, failure_code, failure_summary, failure_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_channel_id) DO UPDATE SET phase = excluded.phase, expected_count = excluded.expected_count, expected_digest = excluded.expected_digest, imported_count = excluded.imported_count, imported_digest = excluded.imported_digest, next_ordinal = excluded.next_ordinal, failure_code = excluded.failure_code, failure_summary = excluded.failure_summary, failure_count = excluded.failure_count, updated_at = excluded.updated_at`).run(
        sourceChannelId, topicId, noteFolderReferenceId, sessionReferenceId, sessionId, phase, expectedCount, expectedDigest, importedCount, importedDigest, nextOrdinal, failureCode, failureSummary, failureCount, updatedAt
      );
      return mapMigrationChannel(db.prepare('SELECT * FROM migration_channels WHERE source_channel_id = ?').get(sourceChannelId));
    });
  };

  service.removeMigrationTransientState = () => mutate(null, (db) => {
    db.prepare('DELETE FROM migration_channels').run();
    db.prepare('DELETE FROM migration_state').run();
    return true;
  });

  service.completeLegacyDiscordMigrationChannel = (sourceChannelId, verifiedAt) => {
    requiredString(sourceChannelId, 'sourceChannelId');
    const completedAt = timestamp(verifiedAt, 'verifiedAt');
    return mutate(null, (db) => {
      const channel = db.prepare('SELECT * FROM migration_channels WHERE source_channel_id = ?').get(sourceChannelId);
      if (!channel) throw new CommandCenterMetadataError('not-found', 'Migration channel was not found.');
      const topic = db.prepare('SELECT lifecycle FROM topics WHERE topic_id = ?').get(channel.topic_id);
      if (channel.phase === 'complete') {
        if (!topic || topic.lifecycle !== 'active') throw new CommandCenterMetadataError('conflict', 'Completed migration Topic is not active.');
        return mapMigrationChannel(channel);
      }
      if (channel.phase !== 'verifying' || !topic || topic.lifecycle !== 'provisioning') throw new CommandCenterMetadataError('conflict', 'Migration channel must pass verification before activation.');
      const references = db.prepare('SELECT * FROM source_references WHERE topic_id = ? ORDER BY reference_id').all(channel.topic_id);
      const folder = references.filter((reference) => reference.reference_id === channel.note_folder_reference_id && reference.source_system === 'obsidian' && reference.source_kind === 'note_folder');
      const session = references.filter((reference) => reference.reference_id === channel.session_reference_id && reference.source_system === 'openclaw' && reference.source_kind === 'session');
      const sessionState = db.prepare('SELECT * FROM session_state WHERE reference_id = ?').get(channel.session_reference_id);
      if (references.length !== 2 || folder.length !== 1 || session.length !== 1 || session[0].external_source_id !== `agent:main:command-center:legacy-discord:${channel.source_channel_id}` || !sessionState || sessionState.session_id !== channel.session_id || sessionState.status !== 'open' || sessionState.is_primary !== 1) throw new CommandCenterMetadataError('conflict', 'Migration channel activation requires exact authoritative Topic bindings.');
      db.prepare("UPDATE topics SET lifecycle = 'active', updated_at = ? WHERE topic_id = ?").run(completedAt, channel.topic_id);
      db.prepare("UPDATE migration_channels SET phase = 'complete', failure_code = NULL, failure_summary = NULL, updated_at = ? WHERE source_channel_id = ?").run(completedAt, sourceChannelId);
      return mapMigrationChannel(db.prepare('SELECT * FROM migration_channels WHERE source_channel_id = ?').get(sourceChannelId));
    });
  };

  service.completeLegacyDiscordMigration = (input) => {
    const value = objectValue(input, 'migration completion');
    allowedKeys(value, ['configDigest', 'sourceDigest', 'verifiedChannelCount', 'verifiedOccurrenceCount', 'completionRevision', 'verifiedAt'], 'migration completion');
    const configDigest = requiredString(value.configDigest, 'configDigest');
    const sourceDigest = requiredString(value.sourceDigest, 'sourceDigest');
    const verifiedChannelCount = integerValue(value.verifiedChannelCount, 'verifiedChannelCount', { minimum: 0 });
    const verifiedOccurrenceCount = integerValue(value.verifiedOccurrenceCount, 'verifiedOccurrenceCount', { minimum: 0 });
    const completionRevision = integerValue(value.completionRevision, 'completionRevision', { minimum: 1 });
    const verifiedAt = timestamp(value.verifiedAt, 'verifiedAt');
    return mutate(null, (db) => {
      const existing = db.prepare('SELECT * FROM migration_completion WHERE completion_id = ?').get('legacy-discord-v1');
      if (existing) {
        if (existing.config_digest !== configDigest || existing.source_digest !== sourceDigest || existing.completion_revision !== completionRevision) throw new CommandCenterMetadataError('conflict', 'Migration completion identity cannot be changed.');
        return mapMigrationCompletion(existing);
      }
      const channels = db.prepare('SELECT * FROM migration_channels').all();
      if (channels.length === 0 || channels.some((row) => row.phase !== 'complete')) throw new CommandCenterMetadataError('conflict', 'Migration completion requires every channel to pass verification.');
      if (channels.length !== verifiedChannelCount || channels.reduce((sum, row) => sum + row.expected_count, 0) !== verifiedOccurrenceCount) throw new CommandCenterMetadataError('conflict', 'Migration completion counts do not match verified channels.');
      for (const row of channels) {
        const topic = db.prepare('SELECT lifecycle FROM topics WHERE topic_id = ?').get(row.topic_id);
        if (!topic || topic.lifecycle !== 'active') throw new CommandCenterMetadataError('conflict', 'Migration Topic binding is missing or already rebound.');
        const references = db.prepare('SELECT * FROM source_references WHERE topic_id = ? ORDER BY reference_id').all(row.topic_id);
        const folder = references.filter((reference) => reference.reference_id === row.note_folder_reference_id && reference.source_system === 'obsidian' && reference.source_kind === 'note_folder');
        const session = references.filter((reference) => reference.reference_id === row.session_reference_id && reference.source_system === 'openclaw' && reference.source_kind === 'session');
        const sessionState = db.prepare('SELECT * FROM session_state WHERE reference_id = ?').get(row.session_reference_id);
        if (folder.length !== 1 || session.length !== 1 || session[0].external_source_id !== `agent:main:command-center:legacy-discord:${row.source_channel_id}` || !sessionState || sessionState.session_id !== row.session_id || sessionState.status !== 'open' || sessionState.is_primary !== 1) throw new CommandCenterMetadataError('conflict', 'Migration completion requires exact authoritative Topic bindings.');
      }
      db.prepare('INSERT INTO migration_completion (completion_id, schema_version, config_digest, source_digest, verified_channel_count, verified_occurrence_count, completion_revision, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-discord-v1', 1, configDigest, sourceDigest, verifiedChannelCount, verifiedOccurrenceCount, completionRevision, verifiedAt);
      db.prepare('DELETE FROM migration_channels').run();
      db.prepare('DELETE FROM migration_state').run();
      return mapMigrationCompletion(db.prepare('SELECT * FROM migration_completion WHERE completion_id = ?').get('legacy-discord-v1'));
    });
  };

  service.recordActivity = (input) => {
    const value = objectValue(input, 'Activity record');
    allowedKeys(value, ['activityId', 'topicId', 'logicalOperationId', 'transportRequestId', 'operationKind', 'outcome', 'observedRevision', 'createdAt', 'updatedAt'], 'Activity record');
    const activityId = requiredString(value.activityId, 'activityId');
    const logicalOperationId = requiredString(value.logicalOperationId, 'logicalOperationId');
    const transportRequestId = requiredString(value.transportRequestId, 'transportRequestId');
    const operationKind = requiredString(value.operationKind, 'operationKind');
    const outcome = enumValue(value.outcome, ['applied', 'not-applied', 'conflict', 'unknown'], 'outcome');
    const topicId = value.topicId === undefined || value.topicId === null ? null : requiredString(value.topicId, 'topicId');
    const createdAt = timestamp(value.createdAt, 'createdAt');
    const updatedAt = timestamp(value.updatedAt, 'updatedAt', createdAt);
    return mutate(null, (db) => {
      if (topicId !== null && !db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(topicId)) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
      const existing = db.prepare('SELECT * FROM activity_records WHERE logical_operation_id = ?').get(logicalOperationId);
      if (existing && (existing.topic_id !== topicId || existing.operation_kind !== operationKind)) throw new CommandCenterMetadataError('conflict', 'Activity logical operation identity cannot be rebound.');
      db.prepare(`INSERT INTO activity_records
        (activity_id, topic_id, logical_operation_id, transport_request_id, operation_kind, outcome, observed_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(logical_operation_id) DO UPDATE SET
          transport_request_id = excluded.transport_request_id,
          outcome = CASE WHEN activity_records.outcome IN ('unknown', 'not-applied') THEN excluded.outcome ELSE activity_records.outcome END,
          observed_revision = CASE WHEN activity_records.outcome IN ('unknown', 'not-applied') THEN excluded.observed_revision ELSE activity_records.observed_revision END,
          updated_at = CASE WHEN activity_records.outcome IN ('unknown', 'not-applied') THEN excluded.updated_at ELSE activity_records.updated_at END`).run(activityId, topicId, logicalOperationId, transportRequestId, operationKind, outcome, value.observedRevision ?? null, createdAt, updatedAt);
      return mapActivity(db.prepare('SELECT * FROM activity_records WHERE logical_operation_id = ?').get(logicalOperationId));
    });
  };
  service.getActivity = (activityId) => readOne('SELECT * FROM activity_records WHERE activity_id = ?', [requiredString(activityId, 'activityId')], mapActivity) || null;
  service.listActivity = (topicId = undefined) => topicId === undefined
    ? readMany('SELECT * FROM activity_records ORDER BY created_at, activity_id', [], mapActivity)
    : readMany('SELECT * FROM activity_records WHERE topic_id = ? ORDER BY created_at, activity_id', [requiredString(topicId, 'topicId')], mapActivity);

  // Small aliases keep the public operation vocabulary unsurprising without
  // adding a second storage path or an untyped generic update mechanism.
  service.setConventionState = service.setSourceConventionState;
  service.getConventionState = service.getSourceConventionState;
  service.createAttentionActivityLink = service.linkAttentionActivity;
  service.upsertPolicyVersion = service.setPolicyVersion;
  service.upsertProjectionBookkeeping = service.setProjectionBookkeeping;

  function projections() {
    assertOpen();
    if (!projectionService) projectionService = openCommandCenterProjectionService({ stateDir: resolvedStateDir, metadataService: service });
    return projectionService;
  }

  // Projection inputs are deliberately limited to authoritative sources.  The
  // metadata snapshot is always read from this validated owned database.
  service.deleteDerivedProjections = () => projections().delete();
  service.rebuildProjections = ({ authoritativeSources, onProgress } = {}) => projections().rebuild({ authoritativeSources, onProgress });
  service.getProjectionStatus = () => projections().getStatus();
  service.queryProjections = () => projections().queryProjections();

  return Object.freeze(service);
}

export function openCommandCenterMetadataService(options = {}) {
  const { stateDir, databasePath, capabilities } = options;
  const migrationHooks = process.env.NODE_ENV === 'test' ? options[migrationTestHooksSymbol] : undefined;
  if (databasePath !== undefined && (typeof databasePath !== 'string' || databasePath.trim() === '')) throw new TypeError('databasePath must be a non-empty string');
  if (databasePath === undefined && (typeof stateDir !== 'string' || stateDir.trim() === '')) throw new TypeError('stateDir must be a non-empty string');
  return createService(stateDir, databasePath, capabilities, migrationHooks);
}

export { metadataTableNames };
