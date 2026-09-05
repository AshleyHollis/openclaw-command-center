import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  COMMAND_CENTER_SCHEMA_VERSION,
  SCHEMA_SEVEN_COMMAND_CENTER_VERSION,
  SCHEMA_SIX_COMMAND_CENTER_VERSION,
  ATTENTION_METADATA_SCHEMA_VERSION,
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
  applyV5ToV6Migration,
  applyV6ToV7Migration,
  applyV7ToV8Migration,
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
import { proposalIdentity, sanitizedPublicValue } from '../topics/analysis-evidence.mjs';

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

function strictInstant(value, field) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) throw new CommandCenterMetadataError('invalid-value', `${field} must be an RFC 3339 instant`);
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
  return row && { topicId: row.topic_id, paraCategory: row.para_category, lifecycle: row.lifecycle, revision: row.revision, name: row.name, activatedAt: row.activated_at, createdAt: row.created_at, updatedAt: row.updated_at };
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
  return row && { referenceId: row.reference_id, aspect: row.aspect, state: row.state, expectedValue: row.expected_value, updatedAt: row.updated_at };
}

function jsonValue(value, fallback = null) { try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; } }
function mapLocator(row) { return row && { referenceId: row.reference_id, locator: row.locator, locatorVersion: row.locator_version, ownership: row.ownership, observedRevision: row.observed_revision, updatedAt: row.updated_at }; }
function mapTopicOperation(row) { return row && { logicalOperationId: row.logical_operation_id, topicId: row.topic_id, operationKind: row.operation_kind, state: row.state, currentStep: row.current_step, intent: jsonValue(row.intent_json, {}), result: jsonValue(row.result_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapRecovery(row) { return row && { recoveryId: row.recovery_id, topicId: row.topic_id, referenceId: row.reference_id, sourceKind: row.source_kind, state: row.state, revision: row.revision, lastLocator: row.last_locator, lastIdentity: row.last_identity, failure: row.failure, diagnostics: jsonValue(row.diagnostics_json, []), createdAt: row.created_at, updatedAt: row.updated_at }; }

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

function mapAnalysisSettings(row) {
  return row && { schemaVersion: row.schema_version, enabled: row.enabled === 1, weekday: row.weekday, localTime: row.local_time, timeZone: row.time_zone, revision: row.revision, nextDueAt: row.next_due_at };
}
function mapAnalysisRun(row) {
  return row && { runId: row.run_id, schemaVersion: row.schema_version, trigger: row.trigger, outcome: row.outcome, baselineCursor: jsonValue(row.baseline_cursor_json, {}), successCursor: jsonValue(row.success_cursor_json), changedCount: row.changed_count, evaluatedCount: row.evaluated_count, proposalCount: row.proposal_count, retainedOverflowCount: row.retained_overflow_count, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error };
}
function mapWatermark(row) { return row && { subjectId: row.subject_id, subjectType: row.subject_type, topicId: row.topic_id, observedRevision: row.observed_revision, lastSuccessRunId: row.last_success_run_id, updatedAt: row.updated_at }; }
function mapEvidence(row) { return row && { evidenceId: row.evidence_id, proposalId: row.proposal_id, sourceId: row.source_id, sourceRevision: row.source_revision, fact: row.fact, material: row.material === 1, ...(row.kind ? { kind: row.kind } : {}), observedAt: row.observed_at }; }
function mapTopicProposal(row) {
  return row && { schemaVersion: row.schema_version, proposalId: row.proposal_id, revision: row.revision, predecessorId: row.predecessor_id, successorId: row.successor_id, operation: row.operation,
    affectedTopicIds: jsonValue(row.affected_topic_ids_json, []), affectedSourceIds: jsonValue(row.affected_source_ids_json, []), plannedSourceIds: jsonValue(row.planned_source_ids_json, []), before: jsonValue(row.before_json, {}), after: jsonValue(row.after_json, {}), rationale: row.rationale,
    provenance: jsonValue(row.provenance_json, {}), searchRetrievalConsequences: jsonValue(row.consequences_json, {}), dependencies: jsonValue(row.dependencies_json, []), blockers: jsonValue(row.blockers_json, []), reversibility: jsonValue(row.reversibility_json, {}), materialEvidenceDigest: row.material_digest, state: row.state, decisionRevision: row.decision_revision, suppressedDigest: row.suppressed_digest, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapTopicReview(row) { return row && { reviewId: row.review_id, subject: row.review_id, schemaVersion: row.schema_version, episodeRevision: row.episode_revision, state: row.state, snoozedUntil: row.snoozed_until, groups: jsonValue(row.groups_json, []), retainedBlockers: jsonValue(row.retained_blockers_json, []), applicationSummary: jsonValue(row.application_summary_json, {}), updatedAt: row.updated_at }; }
function mapApplicationPlan(row) { return row && { applicationId: row.application_id, schemaVersion: row.schema_version, planRevision: row.plan_revision, reviewRevision: row.review_revision, currentProposalRevisions: jsonValue(row.current_proposals_json, []), approvedProposalRevisions: jsonValue(row.approved_proposals_json, []), dependencies: jsonValue(row.dependencies_json, {}), status: row.status, outcomes: jsonValue(row.outcomes_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapApplicationStep(row) { return row && { applicationId: row.application_id, stepId: row.step_id, proposalId: row.proposal_id, logicalOperationId: row.logical_operation_id, operationKind: row.operation_kind, intent: jsonValue(row.intent_json, {}), preconditions: jsonValue(row.preconditions_json, {}), compensation: jsonValue(row.compensation_json, {}), state: row.state, outcome: jsonValue(row.outcome_json), updatedAt: row.updated_at }; }

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
    } else if (schemaVersion === ATTENTION_METADATA_SCHEMA_VERSION) {
      const priorFailure = inspectSchemaOneDatabase(database, ATTENTION_METADATA_SCHEMA_VERSION);
      if (priorFailure) return priorFailure;
    } else if (schemaVersion === PRIOR_COMMAND_CENTER_SCHEMA_VERSION) {
      const priorFailure = inspectSchemaOneDatabase(database, PRIOR_COMMAND_CENTER_SCHEMA_VERSION);
      if (priorFailure) return priorFailure;
    } else if (schemaVersion === SCHEMA_SIX_COMMAND_CENTER_VERSION) {
      const currentFailure = inspectSchemaOneDatabase(database, SCHEMA_SIX_COMMAND_CENTER_VERSION);
      if (currentFailure) return currentFailure;
    } else if (schemaVersion === SCHEMA_SEVEN_COMMAND_CENTER_VERSION) {
      const priorFailure = inspectSchemaOneDatabase(database, SCHEMA_SEVEN_COMMAND_CENTER_VERSION);
      if (priorFailure) return priorFailure;
    } else if (schemaVersion !== COMMAND_CENTER_SCHEMA_VERSION) return coreFailure('unversioned-schema', 'The existing Command Center database is not a declared migratable schema.', 'Use the separate migration or recovery workflow before writing metadata.', null);
  } finally {
    closeQuietly(database);
  }

  // Current-schema validation performs a full integrity check. Release the
  // lightweight classification handle before opening that validation handle.
  if (schemaVersion === COMMAND_CENTER_SCHEMA_VERSION) return validateCurrentSchema(databasePath, stateDir);

  if (schemaVersion === SCHEMA_SEVEN_COMMAND_CENTER_VERSION) {
    let material;
    try {
      material = readRecoveryMaterial(stateDir);
      if (!material.exists) material = ensureRecoverySnapshot({ stateDir, databasePath, sourceSchemaVersion: SCHEMA_SEVEN_COMMAND_CENTER_VERSION });
    } catch (error) { return recoveryFailure(error, SCHEMA_SEVEN_COMMAND_CENTER_VERSION); }
    let migrationDatabase;
    try {
      migrationDatabase = new DatabaseSync(databasePath);
      migrationDatabase.exec('PRAGMA foreign_keys = ON;');
      applyV7ToV8Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    } catch {
      return coreFailure('migration-failed', 'The schema-7 to schema-8 migration was rolled back and the store remains recovery-only.', 'Retry startup with the current supported release before allowing metadata mutations.', SCHEMA_SEVEN_COMMAND_CENTER_VERSION);
    } finally { closeQuietly(migrationDatabase); }
    migrationHooks?.afterDatabaseCommit?.();
    try { markRecoveryCommitted(material); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
    return validateCurrentSchema(databasePath, stateDir);
  }

  if (schemaVersion === SCHEMA_SIX_COMMAND_CENTER_VERSION) {
    let material;
    try {
      material = readRecoveryMaterial(stateDir);
      if (!material.exists) material = ensureRecoverySnapshot({ stateDir, databasePath, sourceSchemaVersion: SCHEMA_SIX_COMMAND_CENTER_VERSION });
    } catch (error) { return recoveryFailure(error, SCHEMA_SIX_COMMAND_CENTER_VERSION); }
    let migrationDatabase;
    try {
      migrationDatabase = new DatabaseSync(databasePath);
      migrationDatabase.exec('PRAGMA foreign_keys = ON;');
      applyV6ToV7Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV7ToV8Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    } catch {
      return coreFailure('migration-failed', 'The schema-6 to schema-7 migration was rolled back and the store remains recovery-only.', 'Retry startup with the current supported release before allowing metadata mutations.', SCHEMA_SIX_COMMAND_CENTER_VERSION);
    } finally { closeQuietly(migrationDatabase); }
    migrationHooks?.afterDatabaseCommit?.();
    try { markRecoveryCommitted(material); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
    return validateCurrentSchema(databasePath, stateDir);
  }

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
      applyV5ToV6Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV6ToV7Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV7ToV8Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    } catch {
      return coreFailure('migration-failed', 'The schema-4 to schema-5 migration was rolled back and the store remains recovery-only.', 'Retry startup with the current supported release before allowing metadata mutations.', PRIOR_COMMAND_CENTER_SCHEMA_VERSION);
    } finally { closeQuietly(migrationDatabase); }
    migrationHooks?.afterDatabaseCommit?.();
    try { markRecoveryCommitted(material); } catch (error) { return recoveryFailure(error, COMMAND_CENTER_SCHEMA_VERSION); }
    return validateCurrentSchema(databasePath, stateDir);
  }

  if (schemaVersion === ATTENTION_METADATA_SCHEMA_VERSION) {
    let material;
    try {
      material = readRecoveryMaterial(stateDir);
      if (!material.exists) material = ensureRecoverySnapshot({ stateDir, databasePath, sourceSchemaVersion: ATTENTION_METADATA_SCHEMA_VERSION });
    } catch (error) { return recoveryFailure(error, ATTENTION_METADATA_SCHEMA_VERSION); }
    let migrationDatabase;
    try {
      migrationDatabase = new DatabaseSync(databasePath);
      migrationDatabase.exec('PRAGMA foreign_keys = ON;');
      applyV4ToV5Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV5ToV6Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV6ToV7Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV7ToV8Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    } catch {
      return coreFailure('migration-failed', 'The schema-4 to schema-6 migration was rolled back and the store remains recovery-only.', 'Retry startup with the current supported release before allowing metadata mutations.', ATTENTION_METADATA_SCHEMA_VERSION);
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
      applyV5ToV6Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV6ToV7Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV7ToV8Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
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
      applyV5ToV6Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV6ToV7Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
      applyV7ToV8Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
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
    applyV5ToV6Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    applyV6ToV7Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
    applyV7ToV8Migration(migrationDatabase, { snapshotId: material.manifest.snapshotId, hooks: migrationHooks });
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
      // Runtime writes may briefly overlap an external read snapshot. Wait at the
      // SQLite lock boundary; never replay the operation or change journal mode.
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;');
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
    allowedKeys(value, ['topicId', 'name', 'paraCategory', 'lifecycle', 'revision', 'expectedRevision', 'activatedAt', 'createdAt', 'updatedAt'], 'topic');
    const result = {};
    if (!partial || value.topicId !== undefined) result.topicId = requiredString(value.topicId, 'topicId');
    if (!partial || value.paraCategory !== undefined) result.paraCategory = enumValue(value.paraCategory, paraCategories, 'paraCategory');
    if (!partial || value.lifecycle !== undefined) result.lifecycle = enumValue(value.lifecycle, topicLifecycles, 'lifecycle');
    if (!partial || value.name !== undefined) result.name = requiredString(value.name ?? value.topicId, 'name');
    if (value.revision !== undefined) result.revision = integerValue(value.revision, 'revision', { minimum: 0 });
    if (value.expectedRevision !== undefined) result.expectedRevision = integerValue(value.expectedRevision, 'expectedRevision', { minimum: 0 });
    if (value.activatedAt !== undefined) result.activatedAt = value.activatedAt === null ? null : timestamp(value.activatedAt, 'activatedAt');
    if (value.createdAt !== undefined) result.createdAt = timestamp(value.createdAt, 'createdAt');
    if (value.updatedAt !== undefined) result.updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return result;
  }

  service.createTopic = (input) => {
    const value = topicInput(input);
    const now = timestamp(undefined, 'createdAt');
    return mutate(null, (db) => {
      const createdAt = value.createdAt ?? now;
      db.prepare('INSERT INTO topics (topic_id, para_category, lifecycle, revision, name, activated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(value.topicId, value.paraCategory, value.lifecycle, value.revision ?? 0, value.name, value.activatedAt ?? (value.lifecycle === 'active' ? createdAt : null), createdAt, value.updatedAt ?? createdAt);
      return mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(value.topicId));
    });
  };

  service.updateTopic = (input) => {
    const value = topicInput(input, { partial: true });
    if (!value.topicId) throw new CommandCenterMetadataError('invalid-value', 'topicId is required');
    if (!value.paraCategory && !value.lifecycle && value.activatedAt === undefined) throw new CommandCenterMetadataError('invalid-value', 'topic classification update is empty');
    const updatedAt = value.updatedAt ?? timestamp(undefined, 'updatedAt');
    return mutate(null, (db) => {
      const current = db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(value.topicId);
      if (!current) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
      if (value.expectedRevision !== undefined && value.expectedRevision !== current.revision) throw new CommandCenterMetadataError('conflict', 'Topic revision is stale.');
      const activatedAt = current.activated_at ?? value.activatedAt ?? (value.lifecycle === 'active' ? updatedAt : null);
      db.prepare('UPDATE topics SET para_category = ?, lifecycle = ?, activated_at = ?, revision = revision + 1, updated_at = ? WHERE topic_id = ?').run(value.paraCategory ?? current.para_category, value.lifecycle ?? current.lifecycle, activatedAt, updatedAt, value.topicId);
      return mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(value.topicId));
    });
  };

  service.getTopic = (topicId) => readOne('SELECT * FROM topics WHERE topic_id = ?', [requiredString(topicId, 'topicId')], mapTopic) || null;
  service.listTopics = () => readMany('SELECT * FROM topics ORDER BY topic_id', [], mapTopic);
  service.listUsableTopics = () => readMany("SELECT * FROM topics WHERE lifecycle = 'active' ORDER BY topic_id", [], mapTopic);
  service.getTopicName = (topicId) => service.getTopic(topicId)?.name ?? null;
  service.setTopicName = ({ topicId, name, expectedRevision, updatedAt } = {}) => mutate(null, (db) => {
    const current = db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(requiredString(topicId, 'topicId'));
    if (!current) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
    if (current.revision !== integerValue(expectedRevision, 'expectedRevision', { minimum: 0 })) throw new CommandCenterMetadataError('conflict', 'Topic revision is stale.');
    db.prepare('UPDATE topics SET name = ?, revision = revision + 1, updated_at = ? WHERE topic_id = ?').run(requiredString(name, 'name'), timestamp(updatedAt, 'updatedAt'), topicId);
    return mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(topicId));
  });
  service.deleteTopic = (topicId) => {
    requiredString(topicId, 'topicId');
    return mutate(null, (db) => {
      const topic = db.prepare('SELECT activated_at FROM topics WHERE topic_id = ?').get(topicId);
      if (topic?.activated_at) throw new CommandCenterMetadataError('unsupported-operation', 'An activated Topic cannot be permanently deleted.');
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
    if (value.sourceSystem === 'openclaw' && value.sourceKind === 'session') {
      const owner = db.prepare(`SELECT reference.reference_id FROM source_references AS reference LEFT JOIN source_locators AS locator ON locator.reference_id = reference.reference_id
        WHERE reference.source_system = 'openclaw' AND reference.source_kind = 'session' AND locator.locator = ? LIMIT 1`).get(value.externalSourceId);
      if (owner) throw new CommandCenterMetadataError('conflict', 'Session identity is already owned by another Source Reference locator.');
    }
    db.prepare('INSERT INTO source_references (reference_id, topic_id, source_system, source_kind, external_source_id, last_observed_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(value.referenceId, value.topicId, value.sourceSystem, value.sourceKind, value.externalSourceId, value.observedRevision, value.createdAt ?? now, value.updatedAt ?? value.createdAt ?? now);
    return mapSourceReference(db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(value.referenceId));
  }

  service.createSourceReference = (input) => {
    const value = referenceInput(input);
    return mutate(capabilityForSourceSystem(value.sourceSystem), (db) => insertSourceReference(db, value, timestamp(undefined, 'createdAt')));
  };

  service.observeSourceReferences = (inputs = []) => {
    if (!Array.isArray(inputs)) throw new CommandCenterMetadataError('invalid-value', 'Source Reference observations must be an array.');
    const values = inputs.map(referenceInput);
    return mutate(null, (db) => {
      const now = timestamp(undefined, 'updatedAt');
      return values.map((value) => {
        const current = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(value.referenceId);
        if (!current) {
          mutateCapabilityInsideTransaction(value.sourceSystem);
          return insertSourceReference(db, value, now);
        }
        for (const [field, column] of [['topicId', 'topic_id'], ['sourceSystem', 'source_system'], ['sourceKind', 'source_kind'], ['externalSourceId', 'external_source_id']]) {
          if (value[field] !== current[column]) throw new CommandCenterMetadataError('identity-change', 'Source Reference identity is immutable.');
        }
        mutateCapabilityInsideTransaction(current.source_system);
        db.prepare('UPDATE source_references SET last_observed_revision = ?, updated_at = ? WHERE reference_id = ?').run(value.observedRevision, value.updatedAt ?? now, value.referenceId);
        return mapSourceReference(db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(value.referenceId));
      });
    });
  };

  service.createMigrationTopicBinding = ({ topic: topicInputValue, reference: referenceInputValue } = {}) => {
    const topic = topicInput(topicInputValue);
    const reference = referenceInput(referenceInputValue);
    if (topic.lifecycle !== 'provisioning' || reference.topicId !== topic.topicId || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note_folder') throw new CommandCenterMetadataError('invalid-value', 'Migration Topic bootstrap requires its exact provisioning Note Folder binding.');
    return mutate('notes', (db) => {
      const now = topic.createdAt ?? timestamp(undefined, 'createdAt');
      db.prepare('INSERT INTO topics (topic_id, para_category, lifecycle, revision, name, activated_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, NULL, ?, ?)').run(topic.topicId, topic.paraCategory, topic.lifecycle, topic.name, now, topic.updatedAt ?? now);
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
      throw new CommandCenterMetadataError('unsupported-operation', 'A durable Source Reference cannot be deleted directly; only an exact unactivated Provisioning rollback may remove it.');
    });
  };

  service.deleteProvisioningSourceReference = (input = {}) => {
    const value = objectValue(input, 'Provisioning Source Reference deletion');
    allowedKeys(value, ['referenceId', 'topicId', 'expectedTopicRevision', 'provisioningOperationId'], 'Provisioning Source Reference deletion');
    const referenceId = requiredString(value.referenceId, 'referenceId');
    const topicId = requiredString(value.topicId, 'topicId');
    const expectedTopicRevision = integerValue(value.expectedTopicRevision, 'expectedTopicRevision', { minimum: 0 });
    const provisioningOperationId = requiredString(value.provisioningOperationId, 'provisioningOperationId');
    return mutate(null, (db) => {
      const topic = db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(topicId);
      if (!topic) throw new CommandCenterMetadataError('not-found', 'Topic was not found.');
      if (topic.lifecycle !== 'provisioning' || topic.activated_at !== null) throw new CommandCenterMetadataError('unsupported-operation', 'Only an unactivated Provisioning Topic may remove a Source Reference.');
      if (topic.revision !== expectedTopicRevision) throw new CommandCenterMetadataError('conflict', 'Topic revision is stale.');
      const operation = db.prepare('SELECT * FROM topic_operations WHERE logical_operation_id = ?').get(provisioningOperationId);
      if (!operation || operation.topic_id !== topicId || operation.operation_kind !== 'topics.create' || operation.state === 'applied') throw new CommandCenterMetadataError('conflict', 'The exact durable Provisioning operation does not authorize Source Reference cleanup.');
      const current = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(referenceId);
      if (!current || current.topic_id !== topicId) throw new CommandCenterMetadataError('conflict', 'The Source Reference is not owned by the exact Provisioning Topic.');
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
    allowedKeys(value, ['referenceId', 'aspect', 'state', 'expectedValue', 'updatedAt'], 'convention state');
    const referenceId = requiredString(value.referenceId, 'referenceId');
    const aspect = enumValue(value.aspect, conventionAspects, 'aspect');
    const state = enumValue(value.state, conventionStates, 'state');
    return mutate(null, (db) => {
      const reference = db.prepare('SELECT source_system FROM source_references WHERE reference_id = ?').get(referenceId);
      if (!reference) throw new CommandCenterMetadataError('not-found', 'Source Reference was not found.');
      mutateCapabilityInsideTransaction(reference.source_system);
      const updatedAt = timestamp(value.updatedAt, 'updatedAt');
      db.prepare('INSERT INTO source_convention_state (reference_id, aspect, state, expected_value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(reference_id, aspect) DO UPDATE SET state = excluded.state, expected_value = excluded.expected_value, updated_at = excluded.updated_at').run(referenceId, aspect, state, value.expectedValue ?? null, updatedAt);
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
      const affected = [];
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
        const persisted = db.prepare(`INSERT INTO migration_occurrences (source_channel_id, occurrence_id, occurrence_digest, display_order, destination_message_id, destination_anchor_json, destination_anchor_digest) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_channel_id, occurrence_id) DO UPDATE SET destination_message_id = COALESCE(migration_occurrences.destination_message_id, excluded.destination_message_id), destination_anchor_json = COALESCE(migration_occurrences.destination_anchor_json, excluded.destination_anchor_json), destination_anchor_digest = COALESCE(migration_occurrences.destination_anchor_digest, excluded.destination_anchor_digest)
          RETURNING *`).get(channelId, occurrenceId, occurrenceDigest, displayOrder, destinationMessageId, destinationAnchorJson, destinationAnchorDigest);
        affected.push(mapMigrationOccurrence(persisted));
      }
      return affected;
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
      db.prepare("UPDATE topics SET lifecycle = 'active', activated_at = COALESCE(activated_at, ?), revision = revision + 1, updated_at = ? WHERE topic_id = ?").run(completedAt, completedAt, channel.topic_id);
      db.prepare("UPDATE migration_channels SET phase = 'complete', failure_code = NULL, failure_summary = NULL, updated_at = ? WHERE source_channel_id = ?").run(completedAt, sourceChannelId);
      return mapMigrationChannel(db.prepare('SELECT * FROM migration_channels WHERE source_channel_id = ?').get(sourceChannelId));
    });
  };

  service.reconcileCompletedLegacyDiscordTopics = ({ configDigest, verifiedTopicCount, verifiedAt } = {}) => {
    const ownershipMarker = `legacy-discord-owner:${requiredString(configDigest, 'configDigest')}`;
    const expectedCount = integerValue(verifiedTopicCount, 'verifiedTopicCount', { minimum: 0 });
    const completedAt = timestamp(verifiedAt, 'verifiedAt');
    return mutate(null, (db) => {
      const topics = db.prepare(`SELECT DISTINCT topic.*, state.status AS migration_session_status, state.is_primary AS migration_session_is_primary FROM topics topic
        JOIN source_references folder ON folder.topic_id = topic.topic_id
        JOIN source_references session ON session.topic_id = topic.topic_id AND session.reference_id = replace(folder.reference_id, 'migration:folder:', 'migration:session:')
        JOIN session_state state ON state.reference_id = session.reference_id
        WHERE folder.source_system = 'obsidian' AND folder.source_kind = 'note_folder' AND folder.reference_id LIKE 'migration:folder:%' AND folder.last_observed_revision = ?
          AND session.source_system = 'openclaw' AND session.source_kind = 'session'
          AND session.external_source_id = 'agent:main:command-center:legacy-discord:' || substr(folder.reference_id, length('migration:folder:') + 1)
          AND state.session_id IS NOT NULL
        ORDER BY topic.topic_id`).all(ownershipMarker);
      if (topics.length !== expectedCount) throw new CommandCenterMetadataError('conflict', `Completed migration Topic ownership count ${topics.length} does not match ${expectedCount}.`);
      for (const topic of topics) {
        if (topic.lifecycle !== 'active') throw new CommandCenterMetadataError('conflict', 'Completed migration Topic is not active.');
        if (topic.revision >= 1 && topic.activated_at) continue;
        if (topic.revision !== 0 || topic.activated_at !== null) throw new CommandCenterMetadataError('conflict', 'Completed migration Topic activation metadata is inconsistent.');
        if (topic.migration_session_status !== 'open' || topic.migration_session_is_primary !== 1) throw new CommandCenterMetadataError('conflict', 'Legacy activation repair requires its original open Primary Session binding.');
        db.prepare('UPDATE topics SET activated_at = ?, revision = 1, updated_at = ? WHERE topic_id = ? AND lifecycle = ? AND revision = 0 AND activated_at IS NULL').run(completedAt, completedAt, topic.topic_id, 'active');
      }
      return topics.map((topic) => mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(topic.topic_id)));
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
    const outcome = enumValue(value.outcome, ['applied', 'failed', 'not-applied', 'conflict', 'unknown'], 'outcome');
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

  // Topic Analysis and Review use their own closed, JSON-at-the-edge records.
  // The JSON columns are deliberately not a generic metadata escape hatch:
  // each public writer below has an explicit field allowlist and bounded data.
  service.getTopicAnalysisSettings = () => readOne('SELECT * FROM topic_analysis_settings WHERE settings_id = ?', ['global'], mapAnalysisSettings) || null;
  service.setTopicAnalysisSettings = (input = {}) => mutate(null, (db) => {
    allowedKeys(input, ['schemaVersion', 'settingsId', 'enabled', 'weekday', 'localTime', 'timeZone', 'revision', 'expectedRevision', 'nextDueAt', 'initialized', 'updatedAt'], 'Topic Analysis settings');
    if (input.schemaVersion !== 1 || (input.settingsId !== undefined && input.settingsId !== 'global')) throw new CommandCenterMetadataError('unsupported-version', 'Topic Analysis settings schemaVersion or identity is invalid.');
    const current = db.prepare('SELECT * FROM topic_analysis_settings WHERE settings_id = ?').get('global');
    if (current && input.expectedRevision !== undefined && input.expectedRevision !== current.revision) throw new CommandCenterMetadataError('conflict', 'Topic Analysis settings revision is stale.');
    const now = timestamp(input.updatedAt, 'updatedAt');
    const revision = input.revision ?? (current?.revision ?? 0) + 1;
    const values = ['global', 1, input.enabled ?? (current ? current.enabled === 1 : true), input.weekday ?? (current?.weekday ?? 1), input.localTime ?? (current?.local_time ?? '07:00'), input.timeZone ?? (current?.time_zone ?? 'UTC'), revision, input.nextDueAt ?? current?.next_due_at ?? null, input.initialized ?? (current?.initialized === 1 ? true : false), now];
    if (!Number.isInteger(values[3]) || values[3] < 1 || values[3] > 7 || typeof values[4] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(values[4]) || typeof values[5] !== 'string' || !values[5].trim() || typeof values[2] !== 'boolean' || !Number.isInteger(values[6]) || values[6] < 1 || typeof values[8] !== 'boolean' || (values[7] !== null && (typeof values[7] !== 'string' || !Number.isFinite(Date.parse(values[7])))) ) throw new CommandCenterMetadataError('invalid-value', 'Topic Analysis settings are invalid.');
    try { new Intl.DateTimeFormat('en-US', { timeZone: values[5] }).format(); } catch { throw new CommandCenterMetadataError('invalid-value', 'Topic Analysis timeZone must be a valid IANA timezone.'); }
    db.prepare(`INSERT INTO topic_analysis_settings (settings_id, schema_version, enabled, weekday, local_time, time_zone, revision, next_due_at, initialized, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(settings_id) DO UPDATE SET enabled=excluded.enabled, weekday=excluded.weekday, local_time=excluded.local_time, time_zone=excluded.time_zone, revision=excluded.revision, next_due_at=excluded.next_due_at, initialized=excluded.initialized, updated_at=excluded.updated_at`).run(values[0], values[1], values[2] ? 1 : 0, values[3], values[4], values[5], values[6], values[7], values[8] ? 1 : 0, values[9]);
    return mapAnalysisSettings(db.prepare('SELECT * FROM topic_analysis_settings WHERE settings_id = ?').get('global'));
  });
  service.getTopicAnalysisRun = (runId) => readOne('SELECT * FROM topic_analysis_runs WHERE run_id = ?', [requiredString(runId, 'runId')], mapAnalysisRun) || null;
  service.listTopicAnalysisRuns = () => readMany('SELECT * FROM topic_analysis_runs ORDER BY started_at, run_id', [], mapAnalysisRun);
  service.recordTopicAnalysisRun = (input = {}) => mutate(null, (db) => {
    allowedKeys(input, ['runId', 'schemaVersion', 'trigger', 'outcome', 'baselineCursor', 'successCursor', 'changedCount', 'evaluatedCount', 'proposalCount', 'retainedOverflowCount', 'startedAt', 'finishedAt', 'error'], 'Topic Analysis run');
    if (input.schemaVersion !== 1 || !['weekly', 'manual', 'catch-up'].includes(input.trigger) || !['running', 'success', 'failed'].includes(input.outcome)) throw new CommandCenterMetadataError('invalid-value', 'Topic Analysis run contract is invalid.');
    const runId = requiredString(input.runId, 'runId');
    const current = db.prepare('SELECT * FROM topic_analysis_runs WHERE run_id = ?').get(runId);
    const counts = [input.changedCount ?? 0, input.evaluatedCount ?? 0, input.proposalCount ?? 0, input.retainedOverflowCount ?? 0];
    if (counts.some((value) => !Number.isInteger(value) || value < 0) || (input.error !== undefined && (typeof input.error !== 'string' || input.error.length > 300))) throw new CommandCenterMetadataError('invalid-value', 'Topic Analysis run counts or error are invalid.');
    const values = [runId, 1, input.trigger, input.outcome, JSON.stringify(input.baselineCursor ?? {}), input.successCursor === undefined || input.successCursor === null ? null : JSON.stringify(input.successCursor), ...counts, strictInstant(input.startedAt, 'startedAt'), input.finishedAt === undefined || input.finishedAt === null ? null : strictInstant(input.finishedAt, 'finishedAt'), input.error ?? null];
    if (current && current.trigger !== input.trigger) throw new CommandCenterMetadataError('intent-mismatch', 'Analysis run identity cannot be rebound.');
    db.prepare(`INSERT INTO topic_analysis_runs (run_id, schema_version, trigger, outcome, baseline_cursor_json, success_cursor_json, changed_count, evaluated_count, proposal_count, retained_overflow_count, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET outcome=excluded.outcome, success_cursor_json=excluded.success_cursor_json, changed_count=excluded.changed_count, evaluated_count=excluded.evaluated_count, proposal_count=excluded.proposal_count, retained_overflow_count=excluded.retained_overflow_count, finished_at=excluded.finished_at, error=excluded.error`).run(...values);
    return mapAnalysisRun(db.prepare('SELECT * FROM topic_analysis_runs WHERE run_id = ?').get(runId));
  });
  service.getTopicAnalysisWatermark = (subjectId) => readOne('SELECT * FROM topic_analysis_watermarks WHERE subject_id = ?', [requiredString(subjectId, 'subjectId')], mapWatermark) || null;
  service.listTopicAnalysisWatermarks = () => readMany('SELECT * FROM topic_analysis_watermarks ORDER BY subject_type, subject_id', [], mapWatermark);
  service.setTopicAnalysisWatermarks = (items = []) => mutate(null, (db) => {
    if (!Array.isArray(items) || items.length > 5000) throw new CommandCenterMetadataError('invalid-value', 'Watermarks must be a bounded array.');
    for (const item of items) {
      allowedKeys(item, ['subjectId', 'subjectType', 'topicId', 'observedRevision', 'lastSuccessRunId', 'updatedAt'], 'watermark');
      if (!['topic', 'source'].includes(item.subjectType)) throw new CommandCenterMetadataError('invalid-value', 'Watermark subjectType is invalid.');
      if (typeof item.subjectId !== 'string' || !item.subjectId.trim() || (item.subjectType === 'topic' && item.subjectId !== `topic:${item.topicId}`) || (item.subjectType === 'source' && !item.subjectId.startsWith('source:'))) throw new CommandCenterMetadataError('invalid-value', 'Watermark subject identity is invalid.');
      if (item.lastSuccessRunId !== undefined && item.lastSuccessRunId !== null && !isNonBlankString(item.lastSuccessRunId)) throw new CommandCenterMetadataError('invalid-value', 'Watermark run identity is invalid.');
      db.prepare(`INSERT INTO topic_analysis_watermarks (subject_id, subject_type, topic_id, observed_revision, last_success_run_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(subject_id) DO UPDATE SET subject_type=excluded.subject_type, topic_id=excluded.topic_id, observed_revision=excluded.observed_revision, last_success_run_id=excluded.last_success_run_id, updated_at=excluded.updated_at`).run(requiredString(item.subjectId, 'subjectId'), item.subjectType, requiredString(item.topicId, 'topicId'), requiredString(item.observedRevision, 'observedRevision'), item.lastSuccessRunId ?? null, timestamp(item.updatedAt, 'updatedAt'));
    }
    return service.listTopicAnalysisWatermarks();
  });
  service.getTopicAnalysisCursor = () => readOne('SELECT * FROM topic_analysis_cursors WHERE cursor_id = ?', ['global'], (row) => row && { cursorId: row.cursor_id, nextTopicId: row.next_topic_id, nextSourceId: row.next_source_id, updatedAt: row.updated_at }) || null;
  service.setTopicAnalysisCursor = (input = {}) => mutate(null, (db) => {
    allowedKeys(input, ['nextTopicId', 'nextSourceId', 'updatedAt'], 'analysis cursor');
    const now = timestamp(input.updatedAt, 'updatedAt');
    db.prepare(`INSERT INTO topic_analysis_cursors (cursor_id, next_topic_id, next_source_id, updated_at) VALUES ('global', ?, ?, ?)
      ON CONFLICT(cursor_id) DO UPDATE SET next_topic_id=excluded.next_topic_id, next_source_id=excluded.next_source_id, updated_at=excluded.updated_at`).run(input.nextTopicId ?? null, input.nextSourceId ?? null, now);
    return service.getTopicAnalysisCursor();
  });
  service.listTopicAnalysisEvidence = (proposalId, { currentOnly = false } = {}) => {
    const where = currentOnly ? ' AND current = 1' : '';
    return proposalId === undefined ? readMany(`SELECT * FROM topic_analysis_evidence WHERE 1 = 1${where} ORDER BY proposal_id, evidence_id`, [], mapEvidence) : readMany(`SELECT * FROM topic_analysis_evidence WHERE proposal_id = ?${where} ORDER BY evidence_id`, [requiredString(proposalId, 'proposalId')], mapEvidence);
  };
  service.setTopicAnalysisEvidence = (proposalId, items = []) => mutate(null, (db) => {
    const id = requiredString(proposalId, 'proposalId');
    if (!Array.isArray(items) || items.length > 8) throw new CommandCenterMetadataError('invalid-value', 'A proposal may retain at most eight evidence facts.');
    if (!db.prepare('SELECT 1 FROM topic_proposals WHERE proposal_id = ?').get(id)) throw new CommandCenterMetadataError('not-found', 'Topic proposal was not found.');
    if (new Set(items.map((item) => item?.evidenceId)).size !== items.length) throw new CommandCenterMetadataError('invalid-value', 'Evidence identities must be distinct.');
    db.prepare('UPDATE topic_analysis_evidence SET current = 0 WHERE proposal_id = ?').run(id);
    for (const item of items) {
      allowedKeys(item, ['evidenceId', 'sourceId', 'sourceRevision', 'fact', 'material', 'kind', 'observedAt'], 'evidence');
      const fact = requiredString(item.fact, 'fact').trim().replace(/\s+/gu, ' '); const sourceId = requiredString(item.sourceId, 'sourceId'); const sourceRevision = requiredString(item.sourceRevision, 'sourceRevision');
      if (!item.material || fact.length > 320 || (item.kind !== undefined && (typeof item.kind !== 'string' || !item.kind.trim() || item.kind.length > 80))) throw new CommandCenterMetadataError('invalid-value', 'Evidence must be material and bounded.');
      const reference = db.prepare('SELECT last_observed_revision FROM source_references WHERE reference_id = ?').get(sourceId);
      const locator = db.prepare('SELECT observed_revision FROM source_locators WHERE reference_id = ?').get(sourceId);
      if (!reference) throw new CommandCenterMetadataError('source-recovery', 'Evidence Source identity was not found.');
      const observed = locator?.observed_revision ?? reference.last_observed_revision ?? `unobserved:${sourceId}`;
      if (sourceRevision !== observed) throw new CommandCenterMetadataError('conflict', 'Evidence Source revision is stale.');
      const evidenceId = requiredString(item.evidenceId, 'evidenceId'); const existing = db.prepare('SELECT proposal_id, source_id, source_revision, fact, material, kind FROM topic_analysis_evidence WHERE evidence_id = ?').get(evidenceId);
      if (existing && (existing.proposal_id !== id || existing.source_id !== sourceId || existing.source_revision !== sourceRevision || existing.fact !== fact || existing.material !== 1 || existing.kind !== (item.kind ?? null))) throw new CommandCenterMetadataError('intent-mismatch', 'Evidence identity cannot be rebound.');
      db.prepare(`INSERT INTO topic_analysis_evidence (evidence_id, proposal_id, source_id, source_revision, fact, material, kind, observed_at, current) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)
        ON CONFLICT(evidence_id) DO UPDATE SET proposal_id=excluded.proposal_id, source_id=excluded.source_id, source_revision=excluded.source_revision, fact=excluded.fact, material=excluded.material, kind=excluded.kind, observed_at=excluded.observed_at, current=1`).run(requiredString(item.evidenceId, 'evidenceId'), id, sourceId, sourceRevision, fact, item.kind ?? null, strictInstant(item.observedAt, 'observedAt'));
    }
    return service.listTopicAnalysisEvidence(id);
  });
  service.getTopicProposal = (proposalId) => readOne('SELECT * FROM topic_proposals WHERE proposal_id = ?', [requiredString(proposalId, 'proposalId')], mapTopicProposal) || null;
  service.listTopicProposals = () => readMany('SELECT * FROM topic_proposals ORDER BY proposal_id', [], mapTopicProposal);
  service.saveTopicProposal = (input = {}) => mutate(null, (db) => {
    const allowed = ['schemaVersion', 'proposalId', 'revision', 'predecessorId', 'successorId', 'operation', 'affectedTopicIds', 'affectedSourceIds', 'plannedSourceIds', 'before', 'after', 'rationale', 'provenance', 'searchRetrievalConsequences', 'dependencies', 'blockers', 'reversibility', 'materialEvidenceDigest', 'state', 'decisionRevision', 'suppressedDigest', 'createdAt', 'updatedAt'];
    allowedKeys(input, allowed, 'Topic proposal');
    if (input.schemaVersion !== 1 || !['create', 'archive', 'restore', 'recategorize'].includes(input.operation) || !['pending', 'approved', 'adjusted', 'kept', 'suppressed', 'superseded', 'applied', 'failed', 'blocked'].includes(input.state)) throw new CommandCenterMetadataError('invalid-value', 'Topic proposal contract is invalid.');
    const id = requiredString(input.proposalId, 'proposalId');
    const affectedTopicIds = sanitizedPublicValue(input.affectedTopicIds ?? [], 'affectedTopicIds', { maxString: 160 }); const affectedSourceIds = sanitizedPublicValue(input.affectedSourceIds ?? [], 'affectedSourceIds', { maxString: 160 }); const plannedSourceIds = sanitizedPublicValue(input.plannedSourceIds ?? [], 'plannedSourceIds', { maxString: 160 });
    const before = sanitizedPublicValue(input.before ?? {}, 'before'); const after = sanitizedPublicValue(input.after ?? {}, 'after'); const rationale = sanitizedPublicValue(input.rationale, 'rationale', { maxString: 2000 }); const provenance = sanitizedPublicValue(input.provenance ?? {}, 'provenance'); const consequences = sanitizedPublicValue(input.searchRetrievalConsequences ?? {}, 'searchRetrievalConsequences'); const dependencies = sanitizedPublicValue(input.dependencies ?? [], 'dependencies', { maxString: 160 }); const blockers = sanitizedPublicValue(input.blockers ?? [], 'blockers'); const reversibility = sanitizedPublicValue(input.reversibility ?? {}, 'reversibility');
    const identity = proposalIdentity({ operation: input.operation, affectedTopicIds, affectedSourceIds, plannedSourceIds, before, after });
    if (id !== identity) throw new CommandCenterMetadataError('identity-change', 'Topic proposal identity is not canonical.');
    const current = db.prepare('SELECT * FROM topic_proposals WHERE proposal_id = ?').get(id);
    if (current && input.revision < current.revision) throw new CommandCenterMetadataError('conflict', 'Topic proposal revision is stale.');
    const createdAt = current?.created_at ?? timestamp(input.createdAt, 'createdAt'); const updatedAt = timestamp(input.updatedAt, 'updatedAt', createdAt);
    db.prepare(`INSERT INTO topic_proposals (proposal_id, schema_version, revision, predecessor_id, successor_id, operation, affected_topic_ids_json, affected_source_ids_json, planned_source_ids_json, before_json, after_json, rationale, provenance_json, consequences_json, dependencies_json, blockers_json, reversibility_json, material_digest, state, decision_revision, suppressed_digest, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET revision=excluded.revision, predecessor_id=excluded.predecessor_id, successor_id=excluded.successor_id, operation=excluded.operation, affected_topic_ids_json=excluded.affected_topic_ids_json, affected_source_ids_json=excluded.affected_source_ids_json, planned_source_ids_json=excluded.planned_source_ids_json, before_json=excluded.before_json, after_json=excluded.after_json, rationale=excluded.rationale, provenance_json=excluded.provenance_json, consequences_json=excluded.consequences_json, dependencies_json=excluded.dependencies_json, blockers_json=excluded.blockers_json, reversibility_json=excluded.reversibility_json, material_digest=excluded.material_digest, state=excluded.state, decision_revision=excluded.decision_revision, suppressed_digest=excluded.suppressed_digest, updated_at=excluded.updated_at`).run(id, input.revision ?? (current?.revision ?? 0) + 1, input.predecessorId ?? current?.predecessor_id ?? null, input.successorId ?? current?.successor_id ?? null, input.operation, JSON.stringify(affectedTopicIds), JSON.stringify(affectedSourceIds), JSON.stringify(plannedSourceIds), JSON.stringify(before), JSON.stringify(after), rationale, JSON.stringify(provenance), JSON.stringify(consequences), JSON.stringify(dependencies), JSON.stringify(blockers), JSON.stringify(reversibility), requiredString(input.materialEvidenceDigest, 'materialEvidenceDigest'), input.state, input.decisionRevision ?? null, input.suppressedDigest ?? null, createdAt, updatedAt);
    return mapTopicProposal(db.prepare('SELECT * FROM topic_proposals WHERE proposal_id = ?').get(id));
  });
  service.getTopicReview = () => readOne('SELECT * FROM topic_reviews WHERE review_id = ?', ['topic-review:global'], mapTopicReview) || null;
  service.saveTopicReview = (input = {}) => mutate(null, (db) => {
    allowedKeys(input, ['schemaVersion', 'episodeRevision', 'state', 'snoozedUntil', 'groups', 'retainedBlockers', 'applicationSummary', 'updatedAt'], 'Topic Review');
    if (input.schemaVersion !== 1 || !['Active', 'Snoozed', 'Resolved'].includes(input.state)) throw new CommandCenterMetadataError('invalid-value', 'Topic Review contract is invalid.');
    const current = db.prepare('SELECT * FROM topic_reviews WHERE review_id = ?').get('topic-review:global');
    const revision = input.episodeRevision ?? (current?.episode_revision ?? 0) + 1; const now = timestamp(input.updatedAt, 'updatedAt');
    db.prepare(`INSERT INTO topic_reviews (review_id, schema_version, episode_revision, state, snoozed_until, groups_json, retained_blockers_json, application_summary_json, updated_at) VALUES ('topic-review:global', 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_id) DO UPDATE SET episode_revision=excluded.episode_revision, state=excluded.state, snoozed_until=excluded.snoozed_until, groups_json=excluded.groups_json, retained_blockers_json=excluded.retained_blockers_json, application_summary_json=excluded.application_summary_json, updated_at=excluded.updated_at`).run(revision, input.state, input.snoozedUntil ?? current?.snoozed_until ?? null, JSON.stringify(input.groups ?? []), JSON.stringify(input.retainedBlockers ?? []), JSON.stringify(input.applicationSummary ?? {}), now);
    return mapTopicReview(db.prepare('SELECT * FROM topic_reviews WHERE review_id = ?').get('topic-review:global'));
  });
  service.getTopicApplicationPlan = (applicationId) => readOne('SELECT * FROM topic_application_plans WHERE application_id = ?', [requiredString(applicationId, 'applicationId')], mapApplicationPlan) || null;
  service.listTopicApplicationPlans = () => readMany('SELECT * FROM topic_application_plans ORDER BY created_at, application_id', [], mapApplicationPlan);
  service.saveTopicApplicationPlan = (input = {}) => mutate(null, (db) => {
    allowedKeys(input, ['applicationId', 'schemaVersion', 'planRevision', 'reviewRevision', 'currentProposalRevisions', 'approvedProposalRevisions', 'dependencies', 'status', 'outcomes', 'createdAt', 'updatedAt'], 'Application plan');
    if (input.schemaVersion !== 1 || !Number.isInteger(input.reviewRevision) || input.reviewRevision < 0 || !Array.isArray(input.currentProposalRevisions) || !['preview', 'running', 'complete', 'failed'].includes(input.status)) throw new CommandCenterMetadataError('invalid-value', 'Application plan contract is invalid.');
    const id = requiredString(input.applicationId, 'applicationId'); const current = db.prepare('SELECT * FROM topic_application_plans WHERE application_id = ?').get(id); const now = timestamp(input.updatedAt, 'updatedAt');
    if (current && (current.plan_revision !== input.planRevision || current.review_revision !== input.reviewRevision || current.current_proposals_json !== JSON.stringify(input.currentProposalRevisions) || current.approved_proposals_json !== JSON.stringify(input.approvedProposalRevisions ?? []) || current.dependencies_json !== JSON.stringify(input.dependencies ?? {}))) throw new CommandCenterMetadataError('conflict', 'Application plans are immutable once created.');
    db.prepare(`INSERT INTO topic_application_plans (application_id, schema_version, plan_revision, review_revision, current_proposals_json, approved_proposals_json, dependencies_json, status, outcomes_json, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(application_id) DO UPDATE SET plan_revision=excluded.plan_revision, review_revision=excluded.review_revision, current_proposals_json=excluded.current_proposals_json, approved_proposals_json=excluded.approved_proposals_json, dependencies_json=excluded.dependencies_json, status=excluded.status, outcomes_json=excluded.outcomes_json, updated_at=excluded.updated_at`).run(id, requiredString(input.planRevision, 'planRevision'), input.reviewRevision, JSON.stringify(input.currentProposalRevisions), JSON.stringify(input.approvedProposalRevisions ?? []), JSON.stringify(input.dependencies ?? {}), input.status, JSON.stringify(input.outcomes ?? {}), current?.created_at ?? now, now);
    return mapApplicationPlan(db.prepare('SELECT * FROM topic_application_plans WHERE application_id = ?').get(id));
  });
  service.listTopicApplicationSteps = (applicationId) => readMany('SELECT * FROM topic_application_steps WHERE application_id = ? ORDER BY step_id', [requiredString(applicationId, 'applicationId')], mapApplicationStep);
  service.saveTopicApplicationStep = (input = {}) => mutate(null, (db) => {
    allowedKeys(input, ['applicationId', 'stepId', 'proposalId', 'logicalOperationId', 'operationKind', 'intent', 'preconditions', 'compensation', 'state', 'outcome', 'updatedAt'], 'Application step');
    if (!['pending', 'running', 'applied', 'failed', 'blocked', 'compensated', 'source-recovery', 'ambiguous'].includes(input.state)) throw new CommandCenterMetadataError('invalid-value', 'Application step state is invalid.');
    const existing = db.prepare('SELECT * FROM topic_application_steps WHERE application_id = ? AND step_id = ?').get(requiredString(input.applicationId, 'applicationId'), requiredString(input.stepId, 'stepId'));
    if (existing && (existing.proposal_id !== input.proposalId || existing.logical_operation_id !== input.logicalOperationId || existing.intent_json !== JSON.stringify(input.intent ?? {}) || existing.preconditions_json !== JSON.stringify(input.preconditions ?? {}) || existing.compensation_json !== JSON.stringify(input.compensation ?? {}))) throw new CommandCenterMetadataError('intent-mismatch', 'Application step intent is immutable.');
    db.prepare(`INSERT INTO topic_application_steps (application_id, step_id, proposal_id, logical_operation_id, operation_kind, intent_json, preconditions_json, compensation_json, state, outcome_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(application_id, step_id) DO UPDATE SET state=excluded.state, outcome_json=excluded.outcome_json, updated_at=excluded.updated_at`).run(requiredString(input.applicationId, 'applicationId'), requiredString(input.stepId, 'stepId'), requiredString(input.proposalId, 'proposalId'), requiredString(input.logicalOperationId, 'logicalOperationId'), requiredString(input.operationKind, 'operationKind'), JSON.stringify(input.intent ?? {}), JSON.stringify(input.preconditions ?? {}), JSON.stringify(input.compensation ?? {}), input.state, input.outcome === undefined ? null : JSON.stringify(input.outcome), timestamp(input.updatedAt, 'updatedAt'));
    return mapApplicationStep(db.prepare('SELECT * FROM topic_application_steps WHERE application_id = ? AND step_id = ?').get(input.applicationId, input.stepId));
  });

  service.setSourceLocator = (input = {}) => mutate(null, (db) => {
    const referenceId = requiredString(input.referenceId, 'referenceId');
    if (!db.prepare('SELECT 1 FROM source_references WHERE reference_id = ?').get(referenceId)) throw new CommandCenterMetadataError('not-found', 'Source Reference was not found.');
    const existing = db.prepare('SELECT * FROM source_locators WHERE reference_id = ?').get(referenceId);
    const locatorVersion = input.locatorVersion ?? (existing ? existing.locator_version + (existing.locator === input.locator && existing.observed_revision === (input.observedRevision ?? null) ? 0 : 1) : 1);
    if (existing && input.locatorVersion !== undefined && input.locatorVersion < existing.locator_version) throw new CommandCenterMetadataError('conflict', 'Source locator revision is stale.');
    db.prepare(`INSERT INTO source_locators (reference_id, locator, locator_version, ownership, observed_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(reference_id) DO UPDATE SET locator = excluded.locator, locator_version = excluded.locator_version, ownership = excluded.ownership, observed_revision = excluded.observed_revision, updated_at = excluded.updated_at`).run(referenceId, requiredString(input.locator, 'locator'), integerValue(locatorVersion, 'locatorVersion', { minimum: 1 }), input.ownership ?? existing?.ownership ?? 'external', input.observedRevision ?? null, timestamp(input.updatedAt, 'updatedAt'));
    return mapLocator(db.prepare('SELECT * FROM source_locators WHERE reference_id = ?').get(referenceId));
  });
  service.relocateNoteFolder = (input = {}) => mutate('notes', (db) => {
    const folder = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(requiredString(input.referenceId, 'referenceId'));
    const current = db.prepare('SELECT * FROM source_locators WHERE reference_id = ?').get(input.referenceId);
    if (!folder || folder.source_system !== 'obsidian' || folder.source_kind !== 'note_folder' || !current) throw new CommandCenterMetadataError('not-found', 'The exact Note Folder binding was not found.');
    const from = requiredString(input.from, 'from');
    const to = requiredString(input.to, 'to');
    if (!path.isAbsolute(from) || !path.isAbsolute(to) || from === to) throw new CommandCenterMetadataError('invalid-value', 'Note Folder relocation requires distinct absolute locators.');
    if (current.locator !== from || current.locator_version !== input.expectedLocatorVersion || current.observed_revision !== input.expectedSourceRevision) throw new CommandCenterMetadataError('conflict', 'Note Folder locator revision is stale.');
    const notes = db.prepare(`SELECT reference.*, locator.locator, locator.locator_version, locator.ownership, locator.observed_revision AS locator_revision
      FROM source_references AS reference LEFT JOIN source_locators AS locator ON locator.reference_id = reference.reference_id
      WHERE reference.source_system = 'obsidian' AND reference.source_kind = 'note'`).all();
    const moves = [];
    for (const note of notes) {
      if (note.topic_id !== folder.topic_id) continue;
      const effective = note.locator ?? note.external_source_id;
      if (!path.isAbsolute(effective)) continue;
      const relative = path.relative(from, effective);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      moves.push({ note, destination: `${to.replace(/[\\/]+$/u, '')}/${relative.split(path.sep).join('/')}` });
    }
    const destinations = new Set();
    const movingIds = new Set(moves.map(({ note }) => note.reference_id));
    const stationary = new Set(notes.filter((note) => !movingIds.has(note.reference_id)).map((note) => path.resolve(note.locator ?? note.external_source_id)));
    for (const { destination } of moves) {
      const exact = path.resolve(destination);
      if (destinations.has(exact) || stationary.has(exact)) throw new CommandCenterMetadataError('conflict', 'A relocated Note destination is already owned or ambiguous.');
      destinations.add(exact);
    }
    const now = timestamp(input.updatedAt, 'updatedAt');
    const save = db.prepare(`INSERT INTO source_locators (reference_id, locator, locator_version, ownership, observed_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(reference_id) DO UPDATE SET locator=excluded.locator, locator_version=excluded.locator_version, ownership=excluded.ownership, observed_revision=excluded.observed_revision, updated_at=excluded.updated_at`);
    for (const { note, destination } of moves) save.run(note.reference_id, destination, (note.locator_version ?? 0) + 1, note.ownership ?? 'external', note.locator_revision ?? note.last_observed_revision, now);
    save.run(folder.reference_id, to, current.locator_version + 1, current.ownership, current.observed_revision, now);
    return mapLocator(db.prepare('SELECT * FROM source_locators WHERE reference_id = ?').get(folder.reference_id));
  });
  service.getSourceLocator = (referenceId) => readOne('SELECT * FROM source_locators WHERE reference_id = ?', [requiredString(referenceId, 'referenceId')], mapLocator) || null;
  service.listSourceLocators = (topicId = undefined) => topicId === undefined
    ? readMany('SELECT * FROM source_locators ORDER BY reference_id', [], mapLocator)
    : readMany('SELECT locator.* FROM source_locators AS locator JOIN source_references AS reference ON reference.reference_id = locator.reference_id WHERE reference.topic_id = ? ORDER BY locator.reference_id', [requiredString(topicId, 'topicId')], mapLocator);

  service.recordTopicOperation = (input = {}) => mutate(null, (db) => {
    const logicalOperationId = requiredString(input.logicalOperationId, 'logicalOperationId');
    const existing = db.prepare('SELECT * FROM topic_operations WHERE logical_operation_id = ?').get(logicalOperationId);
    const intentJson = JSON.stringify(input.intent ?? {});
    if (existing && (existing.operation_kind !== input.operationKind || existing.intent_json !== intentJson)) throw new CommandCenterMetadataError('intent-mismatch', 'Logical operation ID was reused with a different intent.');
    const createdAt = existing?.created_at ?? timestamp(input.createdAt, 'createdAt');
    const updatedAt = timestamp(input.updatedAt, 'updatedAt');
    db.prepare(`INSERT INTO topic_operations (logical_operation_id, topic_id, operation_kind, state, current_step, intent_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(logical_operation_id) DO UPDATE SET topic_id = excluded.topic_id, state = excluded.state, current_step = excluded.current_step, result_json = excluded.result_json, updated_at = excluded.updated_at`).run(logicalOperationId, input.topicId ?? existing?.topic_id ?? null, requiredString(input.operationKind, 'operationKind'), input.state ?? 'pending', input.currentStep ?? 'pending', intentJson, input.result === undefined ? existing?.result_json ?? null : JSON.stringify(input.result), createdAt, updatedAt);
    return mapTopicOperation(db.prepare('SELECT * FROM topic_operations WHERE logical_operation_id = ?').get(logicalOperationId));
  });
  service.getTopicOperation = (logicalOperationId) => readOne('SELECT * FROM topic_operations WHERE logical_operation_id = ?', [requiredString(logicalOperationId, 'logicalOperationId')], mapTopicOperation) || null;
  service.listTopicOperations = (topicId = undefined) => topicId === undefined ? readMany('SELECT * FROM topic_operations ORDER BY created_at, logical_operation_id', [], mapTopicOperation) : readMany('SELECT * FROM topic_operations WHERE topic_id = ? ORDER BY created_at, logical_operation_id', [requiredString(topicId, 'topicId')], mapTopicOperation);

  service.recordSourceRecovery = (input = {}) => mutate(null, (db) => {
    const recoveryId = requiredString(input.recoveryId, 'recoveryId');
    const existing = db.prepare('SELECT * FROM source_recovery WHERE recovery_id = ?').get(recoveryId);
    const revision = existing ? existing.revision + (existing.state === input.state && existing.last_locator === (input.lastLocator ?? null) && existing.last_identity === (input.lastIdentity ?? null) ? 0 : 1) : 1;
    const now = timestamp(input.updatedAt, 'updatedAt');
    db.prepare(`INSERT INTO source_recovery (recovery_id, topic_id, reference_id, source_kind, state, revision, last_locator, last_identity, failure, diagnostics_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(recovery_id) DO UPDATE SET state = excluded.state, revision = excluded.revision, last_locator = excluded.last_locator, last_identity = excluded.last_identity, failure = excluded.failure, diagnostics_json = excluded.diagnostics_json, updated_at = excluded.updated_at`).run(recoveryId, requiredString(input.topicId, 'topicId'), requiredString(input.referenceId, 'referenceId'), input.sourceKind, input.state ?? 'required', revision, input.lastLocator ?? null, input.lastIdentity ?? null, String(input.failure ?? 'source verification failed').slice(0, 300), JSON.stringify(input.diagnostics ?? []), existing?.created_at ?? now, now);
    return mapRecovery(db.prepare('SELECT * FROM source_recovery WHERE recovery_id = ?').get(recoveryId));
  });
  service.listSourceRecovery = (topicId = undefined) => topicId === undefined ? readMany('SELECT * FROM source_recovery ORDER BY recovery_id', [], mapRecovery) : readMany('SELECT * FROM source_recovery WHERE topic_id = ? ORDER BY recovery_id', [requiredString(topicId, 'topicId')], mapRecovery);

  service.completeTopicProvisioning = (input = {}) => mutate(null, (db) => {
    const topic = db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(input.topicId);
    if (topic?.lifecycle === 'active' && topic.activated_at) {
      db.prepare("UPDATE topic_operations SET state = 'applied', current_step = 'complete', result_json = ?, updated_at = ? WHERE logical_operation_id = ?").run(JSON.stringify(input.result ?? {}), timestamp(input.updatedAt, 'updatedAt'), input.logicalOperationId);
      return { topic: mapTopic(topic), operation: mapTopicOperation(db.prepare('SELECT * FROM topic_operations WHERE logical_operation_id = ?').get(input.logicalOperationId)) };
    }
    if (!topic || topic.lifecycle !== 'provisioning' || topic.revision !== input.expectedRevision) throw new CommandCenterMetadataError('conflict', 'Topic activation revision is stale.');
    const updatedAt = timestamp(input.updatedAt, 'updatedAt');
    db.prepare("UPDATE topics SET lifecycle = 'active', activated_at = COALESCE(activated_at, ?), revision = revision + 1, updated_at = ? WHERE topic_id = ?").run(updatedAt, updatedAt, input.topicId);
    const operation = db.prepare('SELECT * FROM topic_operations WHERE logical_operation_id = ?').get(input.logicalOperationId);
    db.prepare("UPDATE topic_operations SET state = 'applied', current_step = 'complete', result_json = ?, updated_at = ? WHERE logical_operation_id = ?").run(JSON.stringify(input.result ?? {}), updatedAt, input.logicalOperationId);
    return Object.freeze({ topic: mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(input.topicId)), operation: mapTopicOperation(operation) });
  });

  service.applyFolderRecoveryBinding = ({ referenceId, locator, observedRevision, expectedSourceRevision, updatedAt } = {}) => {
    const current = service.getSourceLocator(referenceId);
    const recovery = service.listSourceRecovery().find((item) => item.referenceId === referenceId && item.state === 'required');
    if (!current || current.observedRevision !== expectedSourceRevision && recovery?.lastIdentity !== expectedSourceRevision) throw new CommandCenterMetadataError('conflict', 'Source locator revision is stale.');
    return service.setSourceLocator({ referenceId, locator, observedRevision, locatorVersion: current.locatorVersion + 1, ownership: 'external', updatedAt });
  };
  service.applySessionRecoveryRelink = ({ referenceId, sessionKey, sessionId, expectedSourceRevision, updatedAt } = {}) => mutate(null, (db) => {
    const current = db.prepare('SELECT * FROM source_locators WHERE reference_id = ?').get(referenceId);
    const state = db.prepare('SELECT * FROM session_state WHERE reference_id = ?').get(referenceId);
    if (!current || current.observed_revision !== expectedSourceRevision && state?.session_id !== expectedSourceRevision) throw new CommandCenterMetadataError('conflict', 'Session locator revision is stale.');
    const owner = db.prepare(`SELECT reference.reference_id FROM source_references AS reference LEFT JOIN source_locators AS locator ON locator.reference_id = reference.reference_id
      WHERE reference.source_system = 'openclaw' AND reference.source_kind = 'session' AND reference.reference_id <> ? AND (reference.external_source_id = ? OR locator.locator = ?) LIMIT 1`).get(referenceId, sessionKey, sessionKey);
    if (owner) throw new CommandCenterMetadataError('conflict', 'Session authority is already owned by another Source Reference.');
    db.prepare('UPDATE source_locators SET locator = ?, locator_version = locator_version + 1, observed_revision = ?, ownership = ?, updated_at = ? WHERE reference_id = ?').run(sessionKey, sessionId, 'external', timestamp(updatedAt, 'updatedAt'), referenceId);
    db.prepare('UPDATE session_state SET session_id = ?, updated_at = ? WHERE reference_id = ?').run(sessionId, timestamp(updatedAt, 'updatedAt'), referenceId);
    return mapLocator(db.prepare('SELECT * FROM source_locators WHERE reference_id = ?').get(referenceId));
  });
  service.completeTopicRecoveryMutation = (input = {}) => mutate(null, (db) => {
    const topic = db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(input.intent.topicId);
    if (!topic || topic.revision !== input.expectedRevision) throw new CommandCenterMetadataError('conflict', 'Topic revision is stale.');
    const recovery = input.recovery;
    const existing = db.prepare('SELECT * FROM source_recovery WHERE recovery_id = ?').get(recovery.recoveryId);
    const now = timestamp(input.updatedAt, 'updatedAt');
    db.prepare(`INSERT INTO source_recovery (recovery_id, topic_id, reference_id, source_kind, state, revision, last_locator, last_identity, failure, diagnostics_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(recovery_id) DO UPDATE SET state=excluded.state, revision=excluded.revision, last_locator=excluded.last_locator, last_identity=excluded.last_identity, failure=excluded.failure, diagnostics_json=excluded.diagnostics_json, updated_at=excluded.updated_at`).run(recovery.recoveryId, recovery.topicId, recovery.referenceId, recovery.sourceKind, recovery.state, (existing?.revision ?? 0) + 1, recovery.lastLocator ?? null, recovery.lastIdentity ?? null, recovery.failure, JSON.stringify(recovery.diagnostics ?? []), existing?.created_at ?? now, now);
    db.prepare('UPDATE topics SET revision = revision + 1, updated_at = ? WHERE topic_id = ?').run(now, input.intent.topicId);
    const updatedTopic = mapTopic(db.prepare('SELECT * FROM topics WHERE topic_id = ?').get(input.intent.topicId));
    const updatedRecovery = mapRecovery(db.prepare('SELECT * FROM source_recovery WHERE recovery_id = ?').get(recovery.recoveryId));
    const persistedResult = { ...(input.result ?? {}), recovery: updatedRecovery, topicRevision: updatedTopic.revision };
    db.prepare("UPDATE topic_operations SET state='applied', current_step='complete', result_json=?, updated_at=? WHERE logical_operation_id=?").run(JSON.stringify(persistedResult), now, input.logicalOperationId);
    return { topic: updatedTopic, recovery: updatedRecovery };
  });

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
