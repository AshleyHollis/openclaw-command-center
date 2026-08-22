import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  COMMAND_CENTER_SCHEMA_VERSION,
  SOURCE_SCHEMA_VERSION,
  conventionAspects,
  conventionStates,
  inspectSchema,
  metadataSchemaSql,
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
    referenceId: row.reference_id,
    topicId: row.topic_id,
    sourceSystem: row.source_system,
    sourceKind: row.source_kind,
    externalSourceId: row.external_source_id,
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

function validateCurrentV2(databasePath, stateDir) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const baseFailure = inspectSchemaOneDatabase(database, COMMAND_CENTER_SCHEMA_VERSION);
    if (baseFailure) return baseFailure;
    const ledger = validateMigrationLedger(database);
    let material;
    try { material = readRecoveryMaterial(stateDir); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
    if (ledger.rows.length === 0) {
      if (material.exists) return coreFailure('unexpected-recovery-material', 'Recovery material exists without a committed migration ledger.', 'Repair storage through the external recovery workflow before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
    } else {
      if (!material.exists) return coreFailure('recovery-material-missing', 'The committed migration recovery material is missing.', 'Restore the retained recovery directory before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
      if (material.manifest.snapshotId !== ledger.rows[0].snapshot_id) return coreFailure('recovery-ledger-mismatch', 'The migration ledger does not identify the retained recovery snapshot.', 'Restore matching recovery material before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
      if (!ledger.valid) return coreFailure('migration-ledger-invalid', 'The migration ledger is not an exact record of the supported migration.', 'Restore a verified database and matching recovery material before allowing metadata mutations.', COMMAND_CENTER_SCHEMA_VERSION);
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
    if (schemaVersion !== COMMAND_CENTER_SCHEMA_VERSION) {
      if (schemaVersion !== SOURCE_SCHEMA_VERSION) return coreFailure('unversioned-schema', 'The existing Command Center database is not a declared migratable schema.', 'Use the separate migration or recovery workflow before writing metadata.', null);
      const sourceFailure = inspectSchemaOneDatabase(database, SOURCE_SCHEMA_VERSION);
      if (sourceFailure) return sourceFailure;
    }
  } finally {
    closeQuietly(database);
  }

  // Current-schema validation performs a full integrity check. Release the
  // lightweight classification handle before opening that validation handle.
  if (schemaVersion === COMMAND_CENTER_SCHEMA_VERSION) return validateCurrentV2(databasePath, stateDir);

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
  } catch (error) {
    closeQuietly(migrationDatabase);
    return coreFailure('migration-failed', 'The schema-1 to schema-2 migration was rolled back and the store remains recovery-only.', 'Retry startup with the retained verified snapshot or restore the prior compatible release.', SOURCE_SCHEMA_VERSION);
  } finally {
    closeQuietly(migrationDatabase);
  }
  migrationHooks?.afterDatabaseCommit?.();
  try {
    markRecoveryCommitted(material);
  } catch (error) {
    return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION);
  }
  return validateCurrentV2(databasePath, stateDir);
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
  return Object.freeze({ mode: 'ready', schemaVersion: COMMAND_CENTER_SCHEMA_VERSION, diagnostics: Object.freeze([]) });
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
  } catch (error) {
    core = phase === 'inspection' && isStorageAccessError(error)
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
    if (operating.mode !== 'ready') throw new CommandCenterMetadataError('metadata-not-ready', 'Command Center metadata is not ready for projection.', { mode: operating.mode });
    database.exec('BEGIN');
    try {
      const snapshot = {
        topics: database.prepare('SELECT topic_id AS topicId, para_category AS paraCategory, lifecycle, created_at AS createdAt, updated_at AS updatedAt FROM topics ORDER BY topic_id').all(),
        sourceReferences: database.prepare('SELECT reference_id AS referenceId, topic_id AS topicId, source_system AS sourceSystem, source_kind AS sourceKind, external_source_id AS externalSourceId, created_at AS createdAt, updated_at AS updatedAt FROM source_references ORDER BY referenceId').all(),
        sourceConventionState: database.prepare('SELECT reference_id AS referenceId, aspect, state, updated_at AS updatedAt FROM source_convention_state ORDER BY referenceId, aspect').all(),
        presentationPreferences: database.prepare('SELECT topic_id AS topicId, display_label AS displayLabel, sort_order AS sortOrder, collapsed, updated_at AS updatedAt FROM presentation_preferences ORDER BY topicId').all().map((row) => ({ ...row, collapsed: row.collapsed === 1 })),
        attentionActivityLinks: database.prepare('SELECT link_id AS linkId, attention_id AS attentionId, activity_id AS activityId, topic_id AS topicId, created_at AS createdAt FROM attention_activity_links ORDER BY linkId').all(),
        proposalStates: database.prepare('SELECT proposal_id AS proposalId, topic_id AS topicId, state, revision, created_at AS createdAt, updated_at AS updatedAt FROM proposal_states ORDER BY proposalId').all(),
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
    allowedKeys(value, ['referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'createdAt', 'updatedAt'], 'source reference');
    return {
      referenceId: requiredString(value.referenceId, 'referenceId'),
      topicId: requiredString(value.topicId, 'topicId'),
      sourceSystem: requiredString(value.sourceSystem, 'sourceSystem'),
      sourceKind: requiredString(value.sourceKind, 'sourceKind'),
      externalSourceId: requiredString(value.externalSourceId, 'externalSourceId'),
      createdAt: value.createdAt === undefined ? undefined : timestamp(value.createdAt, 'createdAt'),
      updatedAt: value.updatedAt === undefined ? undefined : timestamp(value.updatedAt, 'updatedAt')
    };
  }

  function insertSourceReference(db, value, now) {
    const topic = db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(value.topicId);
    if (!topic) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
    db.prepare('INSERT INTO source_references (reference_id, topic_id, source_system, source_kind, external_source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(value.referenceId, value.topicId, value.sourceSystem, value.sourceKind, value.externalSourceId, value.createdAt ?? now, value.updatedAt ?? value.createdAt ?? now);
    return mapSourceReference(db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(value.referenceId));
  }

  service.createSourceReference = (input) => {
    const value = referenceInput(input);
    return mutate(capabilityForSourceSystem(value.sourceSystem), (db) => insertSourceReference(db, value, timestamp(undefined, 'createdAt')));
  };

  service.updateSourceReference = (input) => {
    const value = objectValue(input, 'source reference update');
    allowedKeys(value, ['referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'updatedAt'], 'source reference update');
    const referenceId = requiredString(value.referenceId, 'referenceId');
    return mutate(null, (db) => {
      const current = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(referenceId);
      if (!current) throw new CommandCenterMetadataError('not-found', 'Source Reference was not found.');
      for (const [field, column] of [['topicId', 'topic_id'], ['sourceSystem', 'source_system'], ['sourceKind', 'source_kind'], ['externalSourceId', 'external_source_id']]) {
        if (value[field] !== undefined && value[field] !== current[column]) throw new CommandCenterMetadataError('identity-change', 'Source Reference identity is immutable.');
      }
      mutateCapabilityInsideTransaction(current.source_system);
      const updatedAt = timestamp(value.updatedAt, 'updatedAt');
      db.prepare('UPDATE source_references SET updated_at = ? WHERE reference_id = ?').run(updatedAt, referenceId);
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

  service.getProjectionBookkeeping = (projectionId) => readOne('SELECT * FROM projection_bookkeeping WHERE projection_id = ?', [requiredString(projectionId, 'projectionId')], mapProjection) || null;
  service.listProjectionBookkeeping = () => readMany('SELECT * FROM projection_bookkeeping ORDER BY projection_id', [], mapProjection);

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
