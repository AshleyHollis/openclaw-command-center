import { compatibilityTuple } from '../compatibility.mjs';
import { bridgeProtocolResult } from './archive-bridge.mjs';
import { closeDatabase, openDatabase, serializeInitialization } from './database.mjs';
import { diagnostic, recoveryDiagnostic, statusDiagnostics } from './diagnostics.mjs';
import { prepareDatabaseLocation } from './location.mjs';
import { applyMigrations, catalogHead, migrationCatalog, readMigrationState } from './migrations.mjs';
import { DeploymentMode, evaluateMode } from './mode.mjs';
import { rebuildProjectionStructures, readTopicProjection } from './projections.mjs';
import { PLUGIN_BUILD, SUPPORTED_POLICY_VERSIONS } from './schema.mjs';
import { validateDatabase } from './validation.mjs';

export class PersistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

function now() { return new Date().toISOString(); }

function requireText(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) throw new PersistenceError('INVALID_METADATA', `${label} is invalid`);
  return value;
}

function assertMetadataOnly(value) {
  const forbidden = new Set(['body', 'noteBody', 'messages', 'transcript', 'history', 'canonicalHistory', 'schedule', 'job', 'jobs']);
  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) throw new PersistenceError('AUTHORITATIVE_SOURCE_PAYLOAD_FORBIDDEN', 'Authoritative source payloads are not stored by Command Center');
      visit(child);
    }
  };
  visit(value);
}

function emptyStatus(reason) {
  const evaluation = evaluateMode([reason], ['persistence-open']);
  return Object.freeze({
    mode: DeploymentMode.RecoveryOnly,
    schemaVersion: undefined,
    writable: false,
    disabledCapabilities: Object.freeze([]),
    checks: Object.freeze([reason]),
    diagnostics: statusDiagnostics(evaluation, undefined, Object.freeze([reason]))
  });
}

function resultStatus(validation) {
  return Object.freeze({
    mode: validation.evaluation.mode,
    schemaVersion: validation.schemaVersion,
    writable: validation.evaluation.mode !== DeploymentMode.RecoveryOnly,
    disabledCapabilities: validation.evaluation.disabledCapabilities,
    checks: validation.results,
    diagnostics: statusDiagnostics(validation.evaluation, validation.schemaVersion, validation.results)
  });
}

/**
 * The sole public Command Center metadata boundary. It requires a state
 * directory already resolved by OpenClaw and an OpenClaw broad-archive bridge;
 * it never discovers, reads, or modifies live authoritative source systems.
 */
export function createPersistenceService({
  stateDirectory,
  archiveBridge,
  compatibility = compatibilityTuple,
  pluginBuild = PLUGIN_BUILD,
  catalog = migrationCatalog,
  restored = false,
  beforeCommit
} = {}) {
  let database;
  let location;
  let initialization;
  let closed = false;
  let status = emptyStatus(recoveryDiagnostic(restored ? 'RESTORE_VALIDATION_REQUIRED' : 'INITIALIZATION_REQUIRED'));

  function assertReadable() {
    if (!database || closed) throw new PersistenceError('READ_UNAVAILABLE', 'Persistence metadata is unavailable; inspect recovery diagnostics');
  }

  function assertMutation(capability) {
    if (status.mode === DeploymentMode.RecoveryOnly) throw new PersistenceError('MUTATION_BLOCKED_RECOVERY_ONLY', 'Metadata mutations are blocked until recovery validation passes');
    assertReadable();
    if (capability && status.disabledCapabilities.includes(capability)) throw new PersistenceError('CAPABILITY_UNAVAILABLE', 'This optional capability is unavailable; inspect diagnostics');
  }

  function refreshValidation() {
    const validation = validateDatabase(database, { compatibility, archiveBridge, catalog, pluginBuild });
    status = resultStatus(validation);
    return status;
  }

  async function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        const bridge = bridgeProtocolResult(archiveBridge, compatibility?.capabilityBridgeProtocol || {});
        if (!bridge.compatible) {
          status = emptyStatus(recoveryDiagnostic('BRIDGE_PROTOCOL_INCOMPATIBLE', { observed: bridge.protocolVersion, supported: compatibility?.capabilityBridgeProtocol }));
          return getStatus();
        }
        location = await prepareDatabaseLocation(stateDirectory);
        await serializeInitialization(location.databasePath, async () => {
          database = openDatabase(location.databasePath);
          await applyMigrations(database, {
            catalog,
            pluginBuild,
            schemaRange: compatibility?.commandCenterSchema,
            archiveBridge,
            stateDirectory: location.stateDirectory,
            databasePath: location.databasePath,
            beforeCommit
          });
          refreshValidation();
        });
      } catch (error) {
        closeDatabase(database);
        database = undefined;
        const code = error?.code || 'PERSISTENCE_OPEN_FAILED';
        status = emptyStatus(recoveryDiagnostic(code));
      }
      return getStatus();
    })();
    return initialization;
  }

  function getStatus() {
    return Object.freeze({
      mode: status.mode,
      schemaVersion: status.schemaVersion,
      writable: status.writable,
      disabledCapabilities: Object.freeze([...status.disabledCapabilities]),
      checks: Object.freeze([...status.checks]),
      diagnostics: status.diagnostics
    });
  }

  function getDiagnostics() { return getStatus().diagnostics; }

  function createTopic({ topicId, title, paraCategory, lifecycleState = 'Provisioning', ...rest }) {
    assertMetadataOnly(rest);
    assertMutation();
    database.prepare('INSERT INTO topics (topic_id, title, para_category, lifecycle_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(requireText(topicId, 'Topic identifier', 160), requireText(title, 'Topic title'), requireText(paraCategory, 'PARA Category', 16), requireText(lifecycleState, 'Topic lifecycle', 16), now(), now());
    return getTopic(topicId);
  }

  function updateTopic({ topicId, title, paraCategory, lifecycleState, ...rest }) {
    assertMetadataOnly(rest);
    assertMutation();
    const existing = getTopic(topicId);
    if (!existing) throw new PersistenceError('TOPIC_NOT_FOUND', 'Topic metadata does not exist');
    database.prepare('UPDATE topics SET title = ?, para_category = ?, lifecycle_state = ?, updated_at = ? WHERE topic_id = ?')
      .run(title === undefined ? existing.title : requireText(title, 'Topic title'), paraCategory === undefined ? existing.para_category : requireText(paraCategory, 'PARA Category', 16), lifecycleState === undefined ? existing.lifecycle_state : requireText(lifecycleState, 'Topic lifecycle', 16), now(), requireText(topicId, 'Topic identifier', 160));
    return getTopic(topicId);
  }

  function getTopic(topicId) {
    assertReadable();
    return database.prepare('SELECT topic_id, title, para_category, lifecycle_state, created_at, updated_at FROM topics WHERE topic_id = ?').get(requireText(topicId, 'Topic identifier', 160)) || null;
  }

  function listTopics() {
    assertReadable();
    return database.prepare('SELECT topic_id, title, para_category, lifecycle_state, created_at, updated_at FROM topics ORDER BY topic_id').all();
  }

  function addSourceReference({ sourceReferenceId, topicId, sourceKind, sourceRole, opaqueIdentifier, verificationState = 'verified', isCurrent = true, originatingTopicId = null, ...rest }) {
    assertMetadataOnly(rest);
    assertMutation();
    database.prepare(`INSERT INTO source_references (source_reference_id, topic_id, source_kind, source_role, opaque_identifier, verification_state, is_current, originating_topic_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requireText(sourceReferenceId, 'Source Reference identifier', 160), requireText(topicId, 'Topic identifier', 160), requireText(sourceKind, 'Source kind', 32), requireText(sourceRole, 'Source role', 32), requireText(opaqueIdentifier, 'Opaque source identifier', 1024), requireText(verificationState, 'Source verification state', 16), Number(isCurrent === true), originatingTopicId === null ? null : requireText(originatingTopicId, 'Originating Topic identifier', 160), now());
    return getSourceReference(sourceReferenceId);
  }

  function getSourceReference(sourceReferenceId) {
    assertReadable();
    return database.prepare('SELECT source_reference_id, topic_id, source_kind, source_role, opaque_identifier, verification_state, is_current, originating_topic_id FROM source_references WHERE source_reference_id = ?').get(requireText(sourceReferenceId, 'Source Reference identifier', 160)) || null;
  }

  function setSourceVerification({ sourceReferenceId, verificationState }) {
    assertMutation();
    const changed = database.prepare('UPDATE source_references SET verification_state = ? WHERE source_reference_id = ?').run(requireText(verificationState, 'Source verification state', 16), requireText(sourceReferenceId, 'Source Reference identifier', 160));
    if (changed.changes !== 1) throw new PersistenceError('SOURCE_REFERENCE_NOT_FOUND', 'Source Reference metadata does not exist');
    refreshValidation();
    return getSourceReference(sourceReferenceId);
  }

  function replacePrimarySession({ topicId, sourceReferenceId }) {
    assertMutation();
    const source = getSourceReference(sourceReferenceId);
    if (!source || source.topic_id !== topicId || source.source_kind !== 'session' || source.is_current !== 1) throw new PersistenceError('PRIMARY_SESSION_INVALID', 'Primary Session must be a current Session Source Reference owned by this Topic');
    if (source.verification_state !== 'verified') throw new PersistenceError('SOURCE_UNRESOLVED', 'An unresolved or ambiguous Source Reference cannot become Primary Session');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare("UPDATE source_references SET source_role = 'topic_conversation' WHERE topic_id = ? AND source_role = 'primary_session' AND is_current = 1 AND source_reference_id != ?")
        .run(requireText(topicId, 'Topic identifier', 160), requireText(sourceReferenceId, 'Source Reference identifier', 160));
      database.prepare("UPDATE source_references SET source_role = 'primary_session' WHERE source_reference_id = ? AND topic_id = ?")
        .run(requireText(sourceReferenceId, 'Source Reference identifier', 160), requireText(topicId, 'Topic identifier', 160));
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* transaction was not opened */ }
      throw error;
    }
    return getSourceReference(sourceReferenceId);
  }

  function setConvention({ conventionKey, managementState }) {
    assertMutation();
    database.prepare(`INSERT INTO convention_state (convention_key, management_state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(convention_key) DO UPDATE SET management_state = excluded.management_state, updated_at = excluded.updated_at`)
      .run(requireText(conventionKey, 'Convention key', 160), requireText(managementState, 'Convention state', 16), now());
  }

  function setPreference({ preferenceKey, preferenceValue, ...rest }) {
    assertMetadataOnly(rest);
    assertMutation();
    database.prepare(`INSERT INTO presentation_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(preference_key) DO UPDATE SET preference_value = excluded.preference_value, updated_at = excluded.updated_at`)
      .run(requireText(preferenceKey, 'Preference key', 160), requireText(preferenceValue, 'Preference value', 2048), now());
  }

  function linkAttentionActivity({ linkId, topicId = null, attentionIdentifier, activityIdentifier, ...rest }) {
    assertMetadataOnly(rest);
    assertMutation();
    database.prepare('INSERT INTO attention_activity_links (link_id, topic_id, attention_identifier, activity_identifier, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(requireText(linkId, 'Link identifier', 160), topicId === null ? null : requireText(topicId, 'Topic identifier', 160), requireText(attentionIdentifier, 'Attention identifier'), requireText(activityIdentifier, 'Activity identifier'), now());
  }

  function createStructuralChangeProposal({ proposalId, topicId, changeKind, proposalState = 'proposed', ...rest }) {
    assertMetadataOnly(rest);
    assertMutation();
    database.prepare('INSERT INTO structural_change_proposals (proposal_id, topic_id, change_kind, proposal_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(requireText(proposalId, 'Proposal identifier', 160), requireText(topicId, 'Topic identifier', 160), requireText(changeKind, 'Structural Change kind', 32), requireText(proposalState, 'Proposal state', 16), now(), now());
  }

  function setPolicyVersion({ policyName, version }) {
    assertMutation();
    if (SUPPORTED_POLICY_VERSIONS[policyName] !== version) throw new PersistenceError('POLICY_VERSION_UNSUPPORTED', 'Unsupported policy versions cannot be persisted');
    database.prepare('UPDATE policy_versions SET version = ? WHERE policy_name = ?').run(version, policyName);
  }

  function rebuildProjections() {
    assertMutation();
    rebuildProjectionStructures(database);
    refreshValidation();
    return { rebuilt: true };
  }

  function getTopicProjection(topicId) {
    assertReadable();
    if (status.mode === DeploymentMode.RecoveryOnly) throw new PersistenceError('READ_UNAVAILABLE', 'Projection reads are unavailable during recovery-only mode');
    if (status.disabledCapabilities.includes('projections')) throw new PersistenceError('CAPABILITY_UNAVAILABLE', 'This optional capability is unavailable; inspect diagnostics');
    return readTopicProjection(database, requireText(topicId, 'Topic identifier', 160));
  }

  async function close() {
    if (closed) return;
    closed = true;
    closeDatabase(database);
    database = undefined;
  }

  return Object.freeze({
    initialize,
    getStatus,
    getDiagnostics,
    listTopics,
    getTopic,
    createTopic,
    updateTopic,
    addSourceReference,
    getSourceReference,
    setSourceVerification,
    replacePrimarySession,
    setConvention,
    setPreference,
    linkAttentionActivity,
    createStructuralChangeProposal,
    setPolicyVersion,
    rebuildProjections,
    getTopicProjection,
    close,
    // This read-only summary makes migration effects observable without test SQL.
    getMigrationStatus: () => {
      assertReadable();
      const migration = readMigrationState(database);
      return Object.freeze({ schemaVersion: migration.schemaVersion, ledger: Object.freeze(migration.ledger.map((entry) => Object.freeze({ ...entry }))), catalogHead: catalogHead(catalog) });
    }
  });
}
