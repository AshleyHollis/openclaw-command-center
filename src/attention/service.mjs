import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeOccurrence, occurrenceKey, ATTENTION_SCHEMA_VERSION, canonicalize, digest, validateActionInput } from './contracts.mjs';
import { episodeIdentity, episodeId, exactOccurrenceKey } from './identity.mjs';
import { deriveSeverity, isHigherSeverity, maxSeverity } from './severity.mjs';
import { assertTransition } from './state-machine.mjs';
import { eligibleSnoozeChoices, resolveSnoozeUntil, snoozeExpired } from './snooze.mjs';
import { createActionRegistry } from './actions.mjs';
import { executeWithReconciliation } from './execution.mjs';
import { orderAttentionEpisodes } from './ordering.mjs';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';

const DELIVERY_WINDOW_MS = 10 * 60 * 1000;
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;
const EMPTY_OBJECT = Object.freeze({});

export class AttentionServiceError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'AttentionServiceError'; this.code = code; Object.assign(this, details); }
}

function fail(code, message, details) { throw new AttentionServiceError(code, message, details); }
function nonBlank(value, field) { if (typeof value !== 'string' || value.trim() === '') fail('invalid-request', `${field} must be a non-blank string`); return value; }
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-request', `${field} must be an object`); return value; }
function timestamp(value, field) { const result = nonBlank(value, field); if (!Number.isFinite(Date.parse(result))) fail('invalid-request', `${field} must be an RFC 3339 instant`); return new Date(Date.parse(result)).toISOString(); }
function nowIso(now) { const value = typeof now === 'function' ? now() : now; return timestamp(value ?? new Date().toISOString(), 'now'); }
function json(value) { return JSON.stringify(canonicalize(value ?? EMPTY_OBJECT)); }
function parseJson(value, fallback = EMPTY_OBJECT) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function digestText(value) { return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`; }

function mapEpisode(row) {
  if (!row) return null;
  return Object.freeze({
    episodeId: row.episode_id,
    identityDigest: row.identity_digest,
    generation: row.generation,
    sourceCapabilityId: row.source_capability_id,
    stableSubjectId: row.stable_subject_id,
    attentionReason: row.attention_reason,
    state: row.state,
    severity: row.severity,
    attentionSince: row.attention_since,
    occurredAt: row.occurred_at,
    terminalAt: row.terminal_at,
    snoozedUntil: row.snoozed_until,
    revision: row.revision,
    topicId: row.topic_id,
    sourceReferenceId: row.source_reference_id,
    diagnosis: parseJson(row.diagnosis_json),
    evidenceFacts: parseJson(row.evidence_json),
    updatedAt: row.updated_at,
    createdAt: row.created_at
  });
}

function mapActivity(row) {
  if (!row) return null;
  return Object.freeze({
    activityId: row.activity_id,
    episodeId: row.episode_id,
    logicalOperationId: row.logical_operation_id,
    attemptId: row.attempt_id,
    topicId: row.topic_id,
    sourceReferenceId: row.source_reference_id,
    actorMode: row.actor_mode,
    actionId: row.action_id,
    operationKind: row.operation_kind,
    outcome: row.outcome,
    verificationRevision: row.verification_revision,
    occurredAt: row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapLegacyActivity(row) {
  if (!row) return null;
  const operationKind = row.operationKind ?? row.operation_kind;
  const observedRevision = row.observedRevision ?? row.observed_revision ?? null;
  let analysisEvidence = null;
  if (operationKind === 'topic-analysis.run' && observedRevision) {
    try {
      const parsed = JSON.parse(observedRevision);
      if (typeof parsed?.sourceReferenceId === 'string' && (parsed.sourceRevision === null || typeof parsed.sourceRevision === 'string')) analysisEvidence = parsed;
    } catch { /* pre-evidence analysis rows remain readable without inventing a source identity */ }
  }
  return Object.freeze({
    activityId: row.activityId ?? row.activity_id,
    episodeId: null,
    logicalOperationId: row.logicalOperationId ?? row.logical_operation_id,
    attemptId: null,
    topicId: row.topicId ?? row.topic_id ?? null,
    sourceReferenceId: analysisEvidence?.sourceReferenceId ?? null,
    actorMode: 'system',
    actionId: null,
    operationKind,
    outcome: row.outcome,
    verificationRevision: analysisEvidence ? analysisEvidence.sourceRevision : observedRevision,
    occurredAt: row.createdAt ?? row.created_at,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at
  });
}

function mapAttempt(row) {
  return row && Object.freeze({
    attemptId: row.attempt_id,
    episodeId: row.episode_id,
    logicalOperationId: row.logical_operation_id,
    actionId: row.action_id,
    expectedEpisodeRevision: row.expected_episode_revision,
    expectedSourceRevision: row.expected_source_revision,
    target: parseJson(row.target_json),
    parameters: parseJson(row.parameters_json),
    disclosureDigest: row.disclosure_digest,
    idempotentRetryable: row.idempotent_retryable === 1,
    retryCount: row.retry_count,
    state: row.state,
    outcome: row.outcome,
    verificationRevision: row.verification_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapApproval(row) {
  return row && Object.freeze({
    approvalId: row.approval_id,
    actionId: row.action_id,
    attemptId: row.attempt_id,
    episodeId: row.episode_id,
    episodeRevision: row.episode_revision,
    diagnosis: parseJson(row.diagnosis_json),
    target: parseJson(row.target_json),
    parameters: parseJson(row.parameters_json),
    planRevision: row.plan_revision,
    sideEffects: parseJson(row.side_effects_json, []),
    host: row.host,
    operatorId: row.operator_id,
    preconditionRevision: row.precondition_revision,
    policyRevision: row.policy_revision,
    disclosureDigest: row.disclosure_digest,
    expiresAt: row.expires_at,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function memoryStore() {
  return { episodes: new Map(), occurrences: new Map(), attempts: new Map(), approvals: new Map(), activities: new Map() };
}

function actionProjection(descriptor, episode, input = EMPTY_OBJECT) {
  const target = descriptor.targetResolver(episode, input);
  if (target === null || target === undefined) return null;
  return Object.freeze({
    actionId: descriptor.actionId,
    label: descriptor.label,
    kind: descriptor.kind,
    target,
    parameterSchema: descriptor.parameterSchema,
    sideEffects: [...descriptor.sideEffects],
    approvalMode: descriptor.approvalMode,
    idempotency: { ...descriptor.idempotency }
  });
}

function actionIdsForCapability(capability, episode) {
  const values = capability?.actions ?? [];
  return values.filter((descriptor) => descriptor.targetResolver(episode) !== null).slice(0, 3);
}

function defaultReminderDescriptors() {
  const target = (episode) => episode.sourceReferenceId ? { sourceReferenceId: episode.sourceReferenceId } : null;
  return [
    { actionId: 'reminder.complete', label: 'Reminder Complete', kind: 'mutation', targetResolver: target, parameterSchema: { type: 'object', properties: { expectedConfigRevision: { type: 'string', minLength: 1 } }, required: ['expectedConfigRevision'], additionalProperties: false }, sideEffects: ['Disables the exact linked reminder schedule.'], approvalMode: 'preauthorized', idempotency: { idempotent: true, transientRetryable: true }, executor: async () => ({}), authoritativeVerifier: async () => ({ outcome: 'unknown' }), successTransition: async () => 'Resolved' },
    { actionId: 'reminder.snooze', label: 'Reminder Snooze', kind: 'mutation', targetResolver: target, parameterSchema: { type: 'object', properties: { preset: { type: 'string' }, until: { type: 'string' }, expectedConfigRevision: { type: 'string', minLength: 1 } }, required: ['expectedConfigRevision'], additionalProperties: false }, sideEffects: ['Reschedules the exact linked reminder schedule.'], approvalMode: 'preauthorized', idempotency: { idempotent: true, transientRetryable: true }, executor: async () => ({}), authoritativeVerifier: async () => ({ outcome: 'unknown' }), successTransition: async () => 'Active' },
    { actionId: 'topic.open', label: 'Open Topic', kind: 'navigation', targetResolver: (episode) => episode.topicId ? { topicId: episode.topicId } : null, parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: [], approvalMode: 'never', idempotency: { idempotent: true, transientRetryable: false }, executor: async () => ({}), authoritativeVerifier: async () => true, successTransition: async () => 'Active' }
  ];
}

function presentationSnoozeDescriptor() {
  return { actionId: 'attention.snooze', label: 'Snooze', kind: 'mutation', targetResolver: (episode) => episode.episodeId ? { episodeId: episode.episodeId } : null, parameterSchema: { type: 'object', properties: { preset: { type: 'string' }, until: { type: 'string' } }, additionalProperties: false }, sideEffects: ['Suppresses Attention presentation until the disclosed instant.'], approvalMode: 'never', idempotency: { idempotent: true, transientRetryable: false }, executor: async () => ({}), authoritativeVerifier: async () => true, successTransition: async () => 'Active' };
}

function approvalDecisionDescriptors(approval) {
  const target = () => ({ approvalId: approval.approvalId, attemptId: approval.attemptId });
  const decision = (actionId, label, sideEffects) => ({ actionId, label, kind: 'mutation', targetResolver: target, parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects, approvalMode: 'never', idempotency: { idempotent: true, transientRetryable: false }, executor: async () => ({}), authoritativeVerifier: async () => ({ outcome: 'applied' }), successTransition: async () => 'Active' });
  return [
    decision('approval.approve', 'Approve', ['Consumes the exact disclosed approval attempt and executes it.']),
    decision('approval.reject', 'Reject', ['Rejects the exact disclosed approval attempt without source mutation.']),
    { ...defaultReminderDescriptors()[2], targetResolver: (episode) => episode.topicId ? { topicId: episode.topicId } : null }
  ];
}

export function createAttentionService({ metadata, now = () => new Date().toISOString(), timeZone = 'UTC', host, operatorId, sourceActions = {}, actionRegistry = createActionRegistry() } = {}) {
  if (!metadata?.databasePath) throw new TypeError('A durable metadata service is required for Attention lifecycle state.');
  const db = metadata?.databasePath ? new DatabaseSync(metadata.databasePath) : null;
  const memory = db ? null : memoryStore();
  const capabilities = new Map();
  const liveAttemptOwners = new Map();
  let closed = false;

  function assertWritable() {
    if (metadata.getOperatingStatus?.().mode === 'recovery-only') fail('recovery-only', 'Attention mutations are blocked in Recovery-only mode.');
  }

  function ownLiveAttempts(owners, operation) {
    const promise = Promise.resolve().then(operation);
    for (const owner of owners) liveAttemptOwners.set(owner.attemptId, { intentDigest: owner.intentDigest, operatorId: owner.operatorId, promise });
    const release = () => {
      for (const owner of owners) if (liveAttemptOwners.get(owner.attemptId)?.promise === promise) liveAttemptOwners.delete(owner.attemptId);
    };
    promise.then(release, release);
    return promise;
  }

  function actionIntentDigest(value) {
    return digest({
      episodeId: value.episodeId,
      expectedEpisodeRevision: value.expectedEpisodeRevision,
      expectedSourceRevision: value.expectedSourceRevision ?? null,
      topicId: value.topicId ?? null,
      sourceReferenceId: value.sourceReferenceId ?? null,
      actionId: value.actionId,
      approvalId: value.approvalId ?? null,
      input: value.input ?? EMPTY_OBJECT
    });
  }

  function persistedAttemptIntentDigest(attempt, episode) {
    return actionIntentDigest({
      episodeId: attempt.episodeId,
      expectedEpisodeRevision: attempt.expectedEpisodeRevision,
      expectedSourceRevision: latestOccurrence(attempt.episodeId)?.occurrence_version ?? latestOccurrence(attempt.episodeId)?.occurrenceVersion ?? null,
      topicId: episode?.topicId ?? null,
      sourceReferenceId: episode?.sourceReferenceId ?? null,
      actionId: attempt.actionId,
      approvalId: ['approval.approve', 'approval.reject'].includes(attempt.actionId) ? attempt.target?.approvalId ?? null : null,
      input: attempt.parameters
    });
  }

  function liveResult(attempt, intentDigest, authenticatedOperatorId) {
    const owner = liveAttemptOwners.get(attempt.attemptId);
    if (!owner) return null;
    if (owner.intentDigest !== intentDigest) fail('intent-mismatch', 'Logical operation ID was reused with a different live Attention action intent.');
    if (owner.operatorId !== authenticatedOperatorId) fail('conflict', 'Live Attention action operator does not match.');
    return owner.promise;
  }

  function assertOpen() { if (closed) fail('service-closed', 'Attention service is closed.'); }
  function transaction(callback) {
    assertOpen();
    assertWritable();
    if (!db) return callback(null);
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    try { const result = callback(db); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  function read(callback) { assertOpen(); return db ? callback(db) : callback(null); }
  function findById(id) { return db ? mapEpisode(db.prepare('SELECT * FROM attention_episodes WHERE episode_id = ?').get(id)) : memory.episodes.get(id) ?? null; }
  function listRows() { return db ? db.prepare('SELECT * FROM attention_episodes ORDER BY attention_since, episode_id').all().map(mapEpisode) : [...memory.episodes.values()]; }
  function findGenerations(identity) {
    return db ? db.prepare('SELECT * FROM attention_episodes WHERE identity_digest = ? ORDER BY generation DESC').all(identity.identityDigest).map(mapEpisode) : [...memory.episodes.values()].filter((episode) => episode.identityDigest === identity.identityDigest).sort((a, b) => b.generation - a.generation);
  }
  function findOccurrence(identityDigest, key) {
    if (db) return db.prepare('SELECT e.* FROM attention_episodes e JOIN attention_occurrences o ON o.episode_id = e.episode_id WHERE e.identity_digest = ? AND o.occurrence_key = ? ORDER BY e.generation DESC LIMIT 1').get(identityDigest, key);
    const match = [...memory.occurrences.values()].find((item) => item.identityDigest === identityDigest && item.occurrenceKey === key);
    return match ? findById(match.episodeId) : null;
  }
  function latestOccurrence(episodeIdValue) {
    if (db) return db.prepare('SELECT occurrence_version, occurred_at FROM attention_occurrences WHERE episode_id = ? ORDER BY occurred_at DESC, created_at DESC, occurrence_row_id DESC LIMIT 1').get(episodeIdValue) ?? null;
    return [...memory.occurrences.values()].filter((item) => item.episodeId === episodeIdValue).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }
  function saveEpisode(episode, { insert = false } = {}) {
    if (!db) { memory.episodes.set(episode.episodeId, Object.freeze({ ...episode })); return episode; }
    const sql = insert
      ? `INSERT INTO attention_episodes (episode_id, identity_digest, generation, source_capability_id, stable_subject_id, attention_reason, state, severity, attention_since, occurred_at, terminal_at, snoozed_until, revision, topic_id, source_reference_id, diagnosis_json, evidence_json, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `UPDATE attention_episodes SET state = ?, severity = ?, attention_since = ?, occurred_at = ?, terminal_at = ?, snoozed_until = ?, revision = ?, diagnosis_json = ?, evidence_json = ?, updated_at = ? WHERE episode_id = ?`;
    if (insert) db.prepare(sql).run(episode.episodeId, episode.identityDigest, episode.generation, episode.sourceCapabilityId, episode.stableSubjectId, episode.attentionReason, episode.state, episode.severity, episode.attentionSince, episode.occurredAt, episode.terminalAt, episode.snoozedUntil, episode.revision, episode.topicId, episode.sourceReferenceId, json(episode.diagnosis), json(episode.evidenceFacts), episode.updatedAt, episode.createdAt);
    else db.prepare(sql).run(episode.state, episode.severity, episode.attentionSince, episode.occurredAt, episode.terminalAt, episode.snoozedUntil, episode.revision, json(episode.diagnosis), json(episode.evidenceFacts), episode.updatedAt, episode.episodeId);
    return findById(episode.episodeId);
  }
  function saveOccurrence(episode, occurrence, derivedSeverity, verified) {
    const occurrenceIdentity = exactOccurrenceKey(occurrence);
    const row = { occurrenceRowId: `occurrence:${randomUUID()}`, episodeId: episode.episodeId, occurrenceKey: occurrenceIdentity, occurrenceVersion: occurrence.occurrenceVersion ?? null, occurredAt: occurrence.occurredAt, derivedSeverity, evidenceFacts: occurrence.evidenceFacts, transitionEvidence: verified ? occurrence.transitionEvidence : null, createdAt: nowIso(now), identityDigest: episode.identityDigest, episode };
    if (!db) { memory.occurrences.set(`${episode.episodeId}:${occurrenceIdentity}`, row); return row; }
    db.prepare('INSERT INTO attention_occurrences (occurrence_row_id, episode_id, occurrence_key, occurrence_version, occurred_at, derived_severity, evidence_json, transition_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.occurrenceRowId, row.episodeId, row.occurrenceKey, row.occurrenceVersion, row.occurredAt, row.derivedSeverity, json(row.evidenceFacts), row.transitionEvidence === null ? null : json(row.transitionEvidence), row.createdAt);
    return row;
  }
  function saveAttempt(attempt) {
    if (!db) { memory.attempts.set(attempt.logicalOperationId, { ...attempt }); return attempt; }
    db.prepare(`INSERT INTO attention_attempts (attempt_id, episode_id, logical_operation_id, action_id, expected_episode_revision, expected_source_revision, target_json, parameters_json, disclosure_digest, idempotent_retryable, retry_count, state, outcome, verification_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(attempt.attemptId, attempt.episodeId, attempt.logicalOperationId, attempt.actionId, attempt.expectedEpisodeRevision, attempt.expectedSourceRevision ?? null, json(attempt.target), json(attempt.parameters), attempt.disclosureDigest, attempt.idempotentRetryable ? 1 : 0, attempt.retryCount ?? 0, attempt.state, attempt.outcome ?? null, attempt.verificationRevision ?? null, attempt.createdAt, attempt.updatedAt);
    return mapAttempt(db.prepare('SELECT * FROM attention_attempts WHERE attempt_id = ?').get(attempt.attemptId));
  }
  function getAttempt(logicalOperationId) { return db ? mapAttempt(db.prepare('SELECT * FROM attention_attempts WHERE logical_operation_id = ?').get(logicalOperationId)) : memory.attempts.get(logicalOperationId) ?? null; }
  function getAttemptById(attemptId) { return db ? mapAttempt(db.prepare('SELECT * FROM attention_attempts WHERE attempt_id = ?').get(attemptId)) : [...memory.attempts.values()].find((value) => value.attemptId === attemptId) ?? null; }
  function updateAttempt(attemptId, patch) {
    if (!db) { const current = [...memory.attempts.values()].find((value) => value.attemptId === attemptId); if (!current) return null; const next = { ...current, ...patch }; memory.attempts.set(next.logicalOperationId, next); return next; }
    db.prepare('UPDATE attention_attempts SET state = ?, outcome = ?, verification_revision = ?, retry_count = ?, updated_at = ? WHERE attempt_id = ?').run(patch.state, patch.outcome ?? null, patch.verificationRevision ?? null, patch.retryCount ?? 0, patch.updatedAt, attemptId);
    return mapAttempt(db.prepare('SELECT * FROM attention_attempts WHERE attempt_id = ?').get(attemptId));
  }
  function saveActivity(value) {
    value = { ...value, occurredAt: value.occurredAt ?? value.createdAt };
    const existing = db ? db.prepare('SELECT * FROM attention_activity_records WHERE activity_id = ?').get(value.activityId) : memory.activities.get(value.activityId);
    if (existing) return db ? mapActivity(existing) : existing;
    if (!db) { const item = { ...value }; memory.activities.set(value.activityId, item); return Object.freeze(item); }
    db.prepare('INSERT INTO attention_activity_records (activity_id, episode_id, logical_operation_id, attempt_id, topic_id, source_reference_id, actor_mode, action_id, operation_kind, outcome, verification_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(value.activityId, value.episodeId, value.logicalOperationId, value.attemptId ?? null, value.topicId ?? null, value.sourceReferenceId ?? null, value.actorMode, value.actionId ?? null, value.operationKind, value.outcome, value.verificationRevision ?? null, value.createdAt, value.updatedAt);
    return mapActivity(db.prepare('SELECT * FROM attention_activity_records WHERE activity_id = ?').get(value.activityId));
  }
  function pendingApprovalForEpisode(episodeIdValue) {
    return db
      ? mapApproval(db.prepare("SELECT a.*, t.action_id FROM attention_approvals a JOIN attention_attempts t ON t.attempt_id = a.attempt_id WHERE a.episode_id = ? AND a.state IN ('pending', 'approved') ORDER BY a.created_at DESC, a.approval_id DESC LIMIT 1").get(episodeIdValue))
      : [...memory.approvals.values()].filter((item) => item.episodeId === episodeIdValue && ['pending', 'approved'].includes(item.state)).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.approvalId.localeCompare(left.approvalId))[0] ?? null;
  }
  function supersedeApproval(approval, clock = nowIso(now)) {
    if (!approval || !['pending', 'approved'].includes(approval.state)) return approval;
    return transaction(() => {
      const current = getApproval(approval.approvalId);
      if (!current || !['pending', 'approved'].includes(current.state)) return current;
      const attempt = getAttemptById(current.attemptId);
      if (attempt?.state === 'pending') updateAttempt(attempt.attemptId, { state: 'conflict', outcome: 'superseded', retryCount: attempt.retryCount ?? 0, updatedAt: clock });
      return updateApproval(current, 'superseded', clock);
    });
  }
  function expireApproval(approval, clock = nowIso(now)) {
    if (!approval || !['pending', 'approved'].includes(approval.state)) return approval;
    return transaction(() => {
      const current = getApproval(approval.approvalId);
      if (!current || !['pending', 'approved'].includes(current.state)) return current;
      const attempt = getAttemptById(current.attemptId);
      if (attempt?.state === 'pending') updateAttempt(attempt.attemptId, { state: 'failed', outcome: 'expired', retryCount: attempt.retryCount ?? 0, updatedAt: clock });
      return updateApproval(current, 'expired', clock);
    });
  }
  function projectedApprovalForEpisode(episode) {
    const approval = pendingApprovalForEpisode(episode.episodeId);
    if (!approval) return null;
    const clock = nowIso(now);
    if (Date.parse(clock) >= Date.parse(approval.expiresAt)) {
      if (metadata.getOperatingStatus?.().mode !== 'recovery-only') expireApproval(approval, clock);
      return null;
    }
    if (approval.episodeRevision === episode.revision) return approval;
    if (metadata.getOperatingStatus?.().mode !== 'recovery-only') supersedeApproval(approval);
    return null;
  }
  async function refreshApprovalForEpisode(episode, authenticatedOperatorId) {
    const approval = projectedApprovalForEpisode(episode);
    if (!approval) return null;
    if (metadata.getOperatingStatus?.().mode === 'recovery-only') return approval;
    if (host !== approval.host) { supersedeApproval(approval); return null; }
    if (authenticatedOperatorId !== undefined && authenticatedOperatorId !== approval.operatorId) { supersedeApproval(approval); return null; }
    const attempt = getAttemptById(approval.attemptId);
    const descriptor = attempt && sourceActionDescriptor(episode, attempt.actionId);
    if (!attempt || !descriptor) { supersedeApproval(approval); return null; }
    try {
      const target = descriptor.targetResolver(episode, attempt.parameters);
      const authorization = await currentAuthorizationContext(episode, descriptor, target, attempt.parameters);
      assertOpen();
      const refreshedClock = nowIso(now);
      if (Date.parse(refreshedClock) >= Date.parse(approval.expiresAt)) { expireApproval(approval, refreshedClock); return null; }
      const expectedDigest = digest({ episodeId: episode.episodeId, episodeRevision: episode.revision, diagnosis: approval.diagnosis, actionId: descriptor.actionId, target, parameters: attempt.parameters, planRevision: approval.planRevision, sideEffects: descriptor.sideEffects, host: approval.host, operatorId: approval.operatorId, preconditionRevision: approval.preconditionRevision, policyRevision: approval.policyRevision, expiresAt: approval.expiresAt });
      if (authorization.planRevision === approval.planRevision && authorization.policyRevision === approval.policyRevision && authorization.preconditionRevision === approval.preconditionRevision && approval.disclosureDigest === expectedDigest && attempt.disclosureDigest === approval.disclosureDigest) return approval;
    } catch {}
    supersedeApproval(approval);
    return null;
  }
  function approvalForAttempt(attemptId) {
    return db
      ? mapApproval(db.prepare('SELECT a.*, t.action_id FROM attention_approvals a JOIN attention_attempts t ON t.attempt_id = a.attempt_id WHERE a.attempt_id = ?').get(attemptId))
      : [...memory.approvals.values()].find((item) => item.attemptId === attemptId) ?? null;
  }
  function episodesWithActions(episodes) {
    return episodes.map((episode) => {
      const capability = capabilities.get(episode.sourceCapabilityId);
      const isReminder = episode.sourceCapabilityId === 'reminders' || capability?.sourceKind === 'reminder';
      const approval = projectedApprovalForEpisode(episode);
      let descriptors = approval ? approvalDecisionDescriptors(approval) : isReminder ? defaultReminderDescriptors() : actionIdsForCapability(capability, episode);
      if (episode.evidenceFacts?.actionOutcome === 'projection-failure') descriptors = descriptors.filter((descriptor) => descriptor.kind === 'navigation');
      if (!approval && descriptors.length < 3 && episode.state === 'Active' && episode.severity !== 'Critical' && episode.sourceKind !== 'approval' && !isReminder) descriptors = [...descriptors, presentationSnoozeDescriptor()];
      const actions = descriptors.map((descriptor) => actionProjection(descriptor, episode)).filter(Boolean);
    return Object.freeze({ ...episode, actions, eligibleSnoozeChoices: eligibleSnoozeChoices({ ...episode, sourceKind: capability?.sourceKind ?? episode.sourceKind, monitoring: capability?.monitoring === true }), notificationEligible: episode.state === 'Active' && episode.severity !== 'Critical' });
    });
  }
  function expireSnoozes(clock) {
    if (metadata.getOperatingStatus?.().mode === 'recovery-only') return false;
    return transaction((database) => {
      const episodes = listRows();
      for (const episode of episodes) if (snoozeExpired(episode, clock)) saveEpisode({ ...episode, state: assertTransition(episode.state, 'Active'), snoozedUntil: null, revision: episode.revision + 1, updatedAt: clock });
      return true;
    });
  }

  function registerSourceCapability(input) {
    const value = object(input, 'source capability');
    const allowed = ['sourceCapabilityId', 'sourceKind', 'monitoring', 'actions', 'verifyTransition', 'deriveEvidence', 'actionExecutor', 'preauthorizations', 'planRevision', 'policyRevision', 'preconditionReader'];
    if (Object.keys(value).some((key) => !allowed.includes(key))) fail('invalid-capability', 'Source capability contains unsupported field.');
    nonBlank(value.sourceCapabilityId, 'sourceCapabilityId');
    if (!Array.isArray(value.actions) || value.actions.length > 3) fail('invalid-capability', 'A source capability may register at most three actions.');
    const descriptors = value.actions.map((descriptor) => actionRegistry.register(descriptor));
    if (descriptors.some((descriptor) => descriptor.kind === 'mutation' && descriptor.approvalMode !== 'required')) fail('invalid-capability', 'Source-authored mutations require a fresh approval.');
    const preauthorizations = new Map();
    if ((value.preauthorizations ?? []).length) fail('invalid-capability', 'Only the built-in Reminder actions may be pre-authorized.');
    for (const authorization of value.preauthorizations ?? []) {
      if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) fail('invalid-capability', 'A preauthorization must be an object.');
      for (const key of Object.keys(authorization)) if (!['actionId', 'version', 'parameters', 'target', 'planRevision', 'policyRevision', 'preconditionRevision'].includes(key)) fail('invalid-capability', 'A preauthorization contains an unsupported field.');
      const descriptor = descriptors.find((item) => item.actionId === authorization.actionId);
      if (!descriptor || descriptor.approvalMode !== 'preauthorized') fail('invalid-capability', 'A preauthorization must bind a preauthorized action descriptor.');
      const parameters = validateActionInput(descriptor, authorization.parameters ?? {});
      const target = Object.freeze(canonicalize(object(authorization.target, 'preauthorization.target')));
      preauthorizations.set(descriptor.actionId, Object.freeze({
        actionId: descriptor.actionId,
        version: nonBlank(authorization.version, 'preauthorization.version'),
        parameters,
        target,
        planRevision: nonBlank(authorization.planRevision, 'preauthorization.planRevision'),
        policyRevision: nonBlank(authorization.policyRevision, 'preauthorization.policyRevision'),
        preconditionRevision: nonBlank(authorization.preconditionRevision, 'preauthorization.preconditionRevision')
      }));
    }
    const capability = Object.freeze({
      sourceCapabilityId: value.sourceCapabilityId,
      sourceKind: value.sourceKind ?? 'operational',
      // Capabilities registered before the monitoring declaration existed are
      // monitorable unless they explicitly opt out; new adapters declare this.
      monitoring: value.monitoring !== false,
      verifyTransition: typeof value.verifyTransition === 'function' ? value.verifyTransition : async () => false,
      deriveEvidence: typeof value.deriveEvidence === 'function' ? value.deriveEvidence : () => EMPTY_OBJECT,
      actions: Object.freeze(descriptors),
      preauthorizations,
      planRevision: value.planRevision ?? 'plan-v1',
      policyRevision: value.policyRevision ?? 'policy-v1',
      preconditionReader: typeof value.preconditionReader === 'function' ? value.preconditionReader : async () => ({ available: true, revision: 'precondition-v1' }),
      actionExecutor: value.actionExecutor
    });
    capabilities.set(capability.sourceCapabilityId, capability);
    return capability;
  }

  async function ingest(input) {
    assertWritable();
    const occurrence = normalizeOccurrence(input);
    const capability = capabilities.get(occurrence.sourceCapabilityId);
    if (!capability) fail('capability-unavailable', `Source capability ${occurrence.sourceCapabilityId} is not registered.`);
    if (occurrence.topicId && typeof metadata?.getTopic === 'function' && !metadata.getTopic(occurrence.topicId)) fail('not-found', 'The exact Attention Topic was not found.');
    if (occurrence.sourceReferenceId && typeof metadata?.getSourceReference === 'function') {
      const reference = metadata.getSourceReference(occurrence.sourceReferenceId);
      if (!reference || occurrence.topicId && reference.topicId !== occurrence.topicId) fail('conflict', 'The exact Attention Source Reference is not owned by the Topic.');
    }
    const verifiedTransition = await capability.verifyTransition(occurrence);
    const derivedFacts = await capability.deriveEvidence(occurrence);
    const effectiveOccurrence = Object.freeze({ ...occurrence, evidenceFacts: object(derivedFacts ?? EMPTY_OBJECT, 'derived evidenceFacts') });
    const severity = deriveSeverity(effectiveOccurrence.evidenceFacts, { verified: true });
    const identity = episodeIdentity(effectiveOccurrence);
    const occurrenceIdentity = occurrenceKey(effectiveOccurrence);
    const clock = nowIso(now);
    return transaction((database) => {
      const exact = findOccurrence(identity.identityDigest, occurrenceIdentity);
      const confirmedState = verifiedTransition && ['withdrawn', 'resolved'].includes(effectiveOccurrence.transitionEvidence?.state) ? (effectiveOccurrence.transitionEvidence.state === 'withdrawn' ? 'Withdrawn' : 'Resolved') : null;
      if (exact) {
        const episode = mapEpisode(exact) ?? exact;
        const activityId = confirmedState ? `activity:${digest({ episodeId: episode.episodeId, occurrence: occurrenceIdentity })}` : null;
        return Object.freeze({ episode, activity: activityId ? service.getActivity(activityId) : null, duplicate: true, ignored: false });
      }
      const generations = findGenerations(identity);
      const current = generations[0];
      if (confirmedState === 'Withdrawn' && (!current || ['Resolved', 'Withdrawn'].includes(current.state))) return Object.freeze({ episode: current ?? null, duplicate: false, ignored: true });
      if (current && ['Resolved', 'Withdrawn'].includes(current.state)) {
        const terminal = Date.parse(current.terminalAt ?? current.updatedAt);
        const withinWindow = Date.parse(clock) < terminal + DELIVERY_WINDOW_MS;
        const provedNewEpisode = (verifiedTransition && effectiveOccurrence.transitionEvidence?.state === 'active') || isHigherSeverity(severity, current.severity);
        if (withinWindow && !provedNewEpisode) return Object.freeze({ episode: current, duplicate: false, ignored: true });
      }
      if (current && !['Resolved', 'Withdrawn'].includes(current.state)) {
        const prior = latestOccurrence(current.episodeId);
        if (Date.parse(effectiveOccurrence.occurredAt) < Date.parse(current.occurredAt)) return Object.freeze({ episode: current, duplicate: false, ignored: true });
        if (effectiveOccurrence.occurredAt === current.occurredAt && prior?.occurrence_version && prior.occurrence_version !== (effectiveOccurrence.occurrenceVersion ?? null)) fail('conflict', 'Equal-time evidence cannot replace a confirmed source revision.');
      }
      const generation = current ? current.generation + 1 : 1;
      if (current && !['Resolved', 'Withdrawn'].includes(current.state) && (current.topicId !== (effectiveOccurrence.topicId ?? null) || current.sourceReferenceId !== (effectiveOccurrence.sourceReferenceId ?? null))) fail('conflict', 'Attention episode source linkage cannot be rebound.');
      const unresolvedActionOutcome = ['ambiguous', 'partial', 'projection-failure'].includes(current?.evidenceFacts?.actionOutcome) ? current.evidenceFacts.actionOutcome : null;
      const preservesSeverityBasis = current && isHigherSeverity(current.severity, severity);
      const severityEvidenceFacts = preservesSeverityBasis ? { ...effectiveOccurrence.evidenceFacts, ...current.evidenceFacts } : effectiveOccurrence.evidenceFacts;
      const nextEvidenceFacts = unresolvedActionOutcome ? { ...severityEvidenceFacts, actionOutcome: unresolvedActionOutcome } : severityEvidenceFacts;
      let episode = current && !['Resolved', 'Withdrawn'].includes(current.state)
        ? { ...current, state: current.state, severity: unresolvedActionOutcome ? 'Critical' : isHigherSeverity(severity, current.severity) ? severity : current.severity, occurredAt: effectiveOccurrence.occurredAt, revision: current.revision + 1, topicId: effectiveOccurrence.topicId ?? current.topicId, sourceReferenceId: effectiveOccurrence.sourceReferenceId ?? current.sourceReferenceId, diagnosis: { reason: effectiveOccurrence.attentionReason }, evidenceFacts: nextEvidenceFacts, updatedAt: clock }
        : { episodeId: episodeId(identity, generation), identityDigest: identity.identityDigest, generation, sourceCapabilityId: identity.sourceCapabilityId, stableSubjectId: identity.stableSubjectId, attentionReason: identity.attentionReason, state: confirmedState ?? 'Active', severity, attentionSince: effectiveOccurrence.occurredAt, occurredAt: effectiveOccurrence.occurredAt, terminalAt: confirmedState ? clock : null, snoozedUntil: null, revision: 1, topicId: effectiveOccurrence.topicId ?? null, sourceReferenceId: effectiveOccurrence.sourceReferenceId ?? null, diagnosis: { reason: effectiveOccurrence.attentionReason }, evidenceFacts: effectiveOccurrence.evidenceFacts, updatedAt: clock, createdAt: clock };
      if (episode.state === 'Snoozed' && severity === 'Critical') episode = { ...episode, state: assertTransition(episode.state, 'Active'), snoozedUntil: null };
      if (confirmedState && !['Resolved', 'Withdrawn'].includes(episode.state)) episode = { ...episode, state: assertTransition(episode.state, confirmedState), terminalAt: clock, snoozedUntil: null };
      saveEpisode(episode, { insert: !current || ['Resolved', 'Withdrawn'].includes(current.state) });
      saveOccurrence(episode, effectiveOccurrence, severity, verifiedTransition);
      const activity = confirmedState
        ? saveActivity({ activityId: `activity:${digest({ episodeId: episode.episodeId, occurrence: occurrenceIdentity })}`, episodeId: episode.episodeId, logicalOperationId: `transition:${digest({ episodeId: episode.episodeId, occurrence: occurrenceIdentity })}`, attemptId: null, topicId: episode.topicId, sourceReferenceId: episode.sourceReferenceId, actorMode: 'system', actionId: `source.${confirmedState.toLowerCase()}`, operationKind: `attention.${confirmedState.toLowerCase()}`, outcome: confirmedState.toLowerCase(), verificationRevision: effectiveOccurrence.occurrenceVersion ?? null, createdAt: clock, updatedAt: clock })
        : null;
      return Object.freeze({ episode: findById(episode.episodeId), activity, duplicate: false, ignored: false });
    });
  }

  function projectEpisode(episode, clock) {
    const capability = capabilities.get(episode.sourceCapabilityId);
    const evidence = episode.evidenceFacts ?? EMPTY_OBJECT;
    const hasActionFailure = ['failed', 'ambiguous', 'partial', 'projection-failure'].includes(evidence.actionOutcome);
    const sourceKind = hasActionFailure ? 'operational' : capability?.sourceKind ?? (episode.sourceReferenceId?.startsWith('reminder') ? 'reminder' : 'operational');
    const occurrence = latestOccurrence(episode.episodeId);
    return { ...episode, sourceKind, due: evidence.due === true || evidence.reminderDue === true, sourceRevision: occurrence?.occurrence_version ?? occurrence?.occurrenceVersion ?? null };
  }

  function list(input = {}) {
    object(input, 'Attention list request');
    if (input.schemaVersion !== undefined && input.schemaVersion !== ATTENTION_SCHEMA_VERSION) fail('unsupported-version', 'schemaVersion must be 1');
    if (Object.keys(input).some((key) => !['schemaVersion', 'topicId', 'now', 'limit'].includes(key))) fail('invalid-request', 'Attention list request contains unsupported field');
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) fail('invalid-request', 'limit must be between 1 and 100');
    const clock = nowIso(input.now ?? now);
    expireSnoozes(clock);
    const projected = listRows().filter((episode) => !input.topicId || episode.topicId === input.topicId).map((episode) => projectEpisode(episode, clock));
    const episodes = episodesWithActions(projected.filter((episode) => episode.state === 'Active' && !(episode.snoozedUntil && Date.parse(episode.snoozedUntil) > Date.parse(clock))));
    const orderedProjection = orderAttentionEpisodes(episodes, { now: clock });
    const buckets = orderedProjection.buckets;
    const ordered = orderedProjection.episodes;
    const resultLimit = input.limit ?? 100;
    const visible = ordered.slice(0, resultLimit);
    const visibleSet = new Set(visible.map((episode) => episode.episodeId));
    const limitedBuckets = buckets.map((bucket) => Object.freeze(bucket.filter((episode) => visibleSet.has(episode.episodeId))));
    const inProgress = projected.filter((episode) => episode.state === 'Action running').map((episode) => Object.freeze({ ...episode, actions: Object.freeze([]), eligibleSnoozeChoices: Object.freeze([]), notificationEligible: false })).sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt) || left.episodeId.localeCompare(right.episodeId)).slice(0, resultLimit);
    return Object.freeze({ schemaVersion: ATTENTION_SCHEMA_VERSION, revision: Math.max(0, ...projected.map((episode) => episode.revision)), buckets: Object.freeze(limitedBuckets), episodes: Object.freeze(visible), inProgress: Object.freeze(inProgress) });
  }

  function get(episodeIdValue) {
    const episode = findById(nonBlank(episodeIdValue, 'episodeId'));
    if (!episode) return null;
    const clock = nowIso(now);
    if (snoozeExpired(episode, clock)) { expireSnoozes(clock); return get(episode.episodeId); }
    return Object.freeze({ schemaVersion: ATTENTION_SCHEMA_VERSION, revision: episode.revision, episode: episodesWithActions([projectEpisode(episode, clock)])[0] });
  }

  function recordActionActivity(episode, attempt, action, outcome, verificationRevision = null, actorMode = 'manual', clock = nowIso(now)) {
    const activityId = `activity:${digest({ attemptId: attempt.attemptId, actionId: action.actionId, outcome, verificationRevision })}`;
    return saveActivity({ activityId, episodeId: episode.episodeId, logicalOperationId: attempt.logicalOperationId, attemptId: attempt.attemptId, topicId: episode.topicId, sourceReferenceId: episode.sourceReferenceId, actorMode, actionId: action.actionId, operationKind: action.actionId, outcome, verificationRevision, createdAt: clock, updatedAt: clock });
  }

  function activityForAttempt(attempt) {
    return db
      ? mapActivity(db.prepare('SELECT * FROM attention_activity_records WHERE attempt_id = ? ORDER BY created_at DESC, activity_id DESC LIMIT 1').get(attempt.attemptId))
      : [...memory.activities.values()].filter((item) => item.attemptId === attempt.attemptId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.activityId.localeCompare(left.activityId))[0] ?? null;
  }

  async function dispatchWithReconciliation({ episode, attempt, descriptor, target, parameters, executor, verifier, reconcileFirst = false, beforeRetry = null }) {
    let currentAttempt = attempt;
    try {
      const result = await executeWithReconciliation({
        attempt,
        descriptor,
        dispatch: async ({ attempt: dispatchAttempt, retry }) => {
          currentAttempt = dispatchAttempt;
          if (retry) currentAttempt = transaction(() => updateAttempt(dispatchAttempt.attemptId, { state: 'running', outcome: null, retryCount: dispatchAttempt.retryCount, updatedAt: nowIso(now) })) ?? dispatchAttempt;
          return executor({ episode, target, parameters, attempt: currentAttempt, logicalOperationId: currentAttempt.logicalOperationId, expectedEpisodeRevision: currentAttempt.expectedEpisodeRevision, retry });
        },
        reconcile: async ({ result, error, retry }) => {
          let observation;
          try { observation = await verifier({ episode, target, parameters, attempt: currentAttempt, actionId: descriptor.actionId, result, error, retry }); } catch { observation = { outcome: 'unknown' }; }
          if (observation === true) return { outcome: 'applied' };
          if (observation === false) return { outcome: 'not-applied' };
          if (observation && typeof observation === 'object') {
            if (observation.outcome) return observation;
            if (observation.matched === true) return { ...observation, outcome: 'applied' };
            if (observation.matched === false) return { ...observation, outcome: 'not-applied' };
          }
          return { outcome: 'unknown' };
        },
        reconcileFirst,
        beforeRetry
      });
      return { ...result, verification: result.observation, attempt: currentAttempt };
    } catch (error) {
      const outcome = error?.outcome ?? error?.code;
      const cause = error?.cause;
      throw Object.assign(error, {
        retryCount: currentAttempt.retryCount ?? 0,
        ambiguous: error?.ambiguous === true || cause?.ambiguous === true || ['partial', 'conflict', 'unknown'].includes(outcome),
        partial: error?.partial === true || cause?.partial === true || ['partial', 'conflict'].includes(outcome)
      });
    }
  }

  function actionDescriptor(episode, actionId) {
    const capability = capabilities.get(episode.sourceCapabilityId);
    const approval = projectedApprovalForEpisode(episode);
    if (approval) return approvalDecisionDescriptors(approval).find((item) => item.actionId === actionId) ?? null;
    const isReminder = capability?.sourceKind === 'reminder' || episode.sourceCapabilityId === 'reminders';
    const sourceKind = capability?.sourceKind ?? episode.sourceKind;
    let descriptors = isReminder ? defaultReminderDescriptors() : actionIdsForCapability(capability, episode);
    if (episode.evidenceFacts?.actionOutcome === 'projection-failure') descriptors = descriptors.filter((descriptor) => descriptor.kind === 'navigation');
    if (descriptors.length < 3 && episode.state === 'Active' && episode.severity !== 'Critical' && !isReminder) descriptors = [...descriptors, presentationSnoozeDescriptor()];
    return descriptors.find((item) => item.actionId === actionId) ?? null;
  }

  function sourceActionDescriptor(episode, actionId) {
    const capability = capabilities.get(episode.sourceCapabilityId);
    const isReminder = capability?.sourceKind === 'reminder' || episode.sourceCapabilityId === 'reminders';
    const descriptors = isReminder ? defaultReminderDescriptors() : actionIdsForCapability(capability, episode);
    return descriptors.find((item) => item.actionId === actionId) ?? null;
  }

  async function currentAuthorizationContext(episode, descriptor, target, parameters) {
    const capability = capabilities.get(episode.sourceCapabilityId);
    if (!capability) fail('capability-unavailable', 'The source capability is unavailable.');
    const planRevision = nonBlank(typeof capability.planRevision === 'function' ? await capability.planRevision({ episode, descriptor, target, parameters }) : capability.planRevision, 'planRevision');
    const policyRevision = nonBlank(typeof capability.policyRevision === 'function' ? await capability.policyRevision({ episode, descriptor, target, parameters }) : capability.policyRevision, 'policyRevision');
    let precondition;
    try { precondition = await capability.preconditionReader({ episode, descriptor, target, parameters }); } catch { fail('precondition-unavailable', 'The source precondition could not be read.'); }
    if (!precondition || precondition.available !== true) fail('precondition-unavailable', 'The source precondition could not be read.');
    return Object.freeze({ planRevision, policyRevision, preconditionRevision: nonBlank(precondition.revision, 'preconditionRevision') });
  }

  function preauthorizationDisclosure(preauthorization, authorization, descriptor, target, parameters) {
    if (!preauthorization
      || digest(preauthorization.parameters) !== digest(parameters)
      || digest(preauthorization.target) !== digest(target)
      || preauthorization.planRevision !== authorization.planRevision
      || preauthorization.policyRevision !== authorization.policyRevision
      || preauthorization.preconditionRevision !== authorization.preconditionRevision) return null;
    return digest({
      actionId: descriptor.actionId,
      target,
      parameters,
      sideEffects: descriptor.sideEffects,
      preauthorizationVersion: preauthorization.version,
      planRevision: preauthorization.planRevision,
      policyRevision: preauthorization.policyRevision,
      preconditionRevision: preauthorization.preconditionRevision
    });
  }

  function beginRunningAttempt({ episode, descriptor, logicalOperationId, expectedSourceRevision = null, target, parameters, disclosureDigest, clock, attempt: existingAttempt = null }) {
    return transaction(() => {
      const current = findById(episode.episodeId);
      if (!current || current.revision !== episode.revision || !['Active', 'Snoozed'].includes(current.state)) fail('conflict', 'Attention episode changed before action start.');
      saveEpisode({ ...current, state: assertTransition(current.state, 'Action running'), revision: current.revision + 1, updatedAt: clock });
      if (existingAttempt) return updateAttempt(existingAttempt.attemptId, { state: 'running', outcome: null, retryCount: existingAttempt.retryCount ?? 0, updatedAt: clock });
      return saveAttempt({ attemptId: `attempt:${randomUUID()}`, episodeId: current.episodeId, logicalOperationId, actionId: descriptor.actionId, expectedEpisodeRevision: current.revision, expectedSourceRevision, target, parameters, disclosureDigest, idempotentRetryable: descriptor.idempotency.idempotent && descriptor.idempotency.transientRetryable, state: 'running', retryCount: 0, createdAt: clock, updatedAt: clock });
    });
  }

  function completeAction(episode, attempt, descriptor, { result, verification, nextState, snoozedUntil = null }, clock) {
    return transaction(() => {
      const current = findById(episode.episodeId);
      if (current && ['Resolved', 'Withdrawn'].includes(current.state)) {
        const verificationRevision = verification?.revision ?? result?.observedRevision ?? null;
        const finalAttempt = updateAttempt(attempt.attemptId, { state: 'applied', outcome: 'applied', verificationRevision, retryCount: attempt.retryCount ?? 0, updatedAt: clock });
        const activity = recordActionActivity(current, finalAttempt, descriptor, current.state.toLowerCase(), verificationRevision, 'manual', clock);
        return Object.freeze({ status: 'applied', episode: current, attempt: finalAttempt, activity });
      }
      if (!current || current.state !== 'Action running' || current.revision < attempt.expectedEpisodeRevision + 1) fail('conflict', 'Attention action completion no longer matches the running attempt.');
      const { actionOutcome: _resolvedActionOutcome, ...resolvedEvidenceFacts } = current.evidenceFacts ?? EMPTY_OBJECT;
      const next = { ...current, state: assertTransition(current.state, nextState), terminalAt: ['Resolved', 'Withdrawn'].includes(nextState) ? clock : null, snoozedUntil, revision: current.revision + 1, evidenceFacts: resolvedEvidenceFacts, updatedAt: clock };
      saveEpisode(next);
      const verificationRevision = verification?.revision ?? result?.observedRevision ?? null;
      const finalAttempt = updateAttempt(attempt.attemptId, { state: 'applied', outcome: 'applied', verificationRevision, retryCount: attempt.retryCount ?? 0, updatedAt: clock });
      const outcome = nextState === 'Resolved' ? 'resolved' : nextState === 'Withdrawn' ? 'withdrawn' : 'applied';
      const activity = recordActionActivity(next, finalAttempt, descriptor, outcome, verificationRevision, 'manual', clock);
      return Object.freeze({ status: 'applied', episode: findById(next.episodeId), attempt: finalAttempt, activity });
    });
  }

  function recoverAppliedProjection(episode, attempt, descriptor, execution, clock) {
    return transaction(() => {
      const current = findById(episode.episodeId);
      const verificationRevision = execution.verification?.revision ?? execution.result?.observedRevision ?? null;
      const finalAttempt = updateAttempt(attempt.attemptId, { state: 'applied', outcome: 'applied', verificationRevision, retryCount: attempt.retryCount ?? 0, updatedAt: clock });
      if (current && ['Resolved', 'Withdrawn'].includes(current.state)) {
        const activity = recordActionActivity(current, finalAttempt, descriptor, 'applied', verificationRevision, 'manual', clock);
        return Object.freeze({ status: 'recovery-required', episode: current, attempt: finalAttempt, activity });
      }
      if (!current || current.state !== 'Action running' || current.revision < attempt.expectedEpisodeRevision + 1) fail('conflict', 'Verified action recovery no longer matches the running attempt.');
      const next = { ...current, state: assertTransition(current.state, 'Active'), severity: 'Critical', revision: current.revision + 1, evidenceFacts: { ...current.evidenceFacts, actionOutcome: 'projection-failure' }, updatedAt: clock };
      saveEpisode(next);
      const activity = recordActionActivity(next, finalAttempt, descriptor, 'applied', verificationRevision, 'manual', clock);
      return Object.freeze({ status: 'recovery-required', episode: findById(next.episodeId), attempt: finalAttempt, activity });
    });
  }

  async function executeStartedAction({ episode, attempt, descriptor, target, parameters, executor, verifier, clock, snoozedUntil = null, reconcileFirst = false, beforeRetry = null }) {
    let execution;
    try {
      execution = await dispatchWithReconciliation({ episode, attempt, descriptor, target, parameters, executor, verifier, reconcileFirst, beforeRetry });
    } catch (error) {
      return failAction(episode, { ...attempt, retryCount: error?.retryCount ?? attempt.retryCount }, descriptor, error, clock);
    }
    const finalAttempt = execution.attempt;
    try {
      let nextState;
      if (snoozedUntil) nextState = 'Snoozed';
      else {
        const transition = await descriptor.successTransition({ episode, target, parameters, attempt: finalAttempt, result: execution.result, verification: execution.verification });
        nextState = transition?.state ?? (transition === 'Resolved' ? 'Resolved' : 'Active');
      }
      if (!['Active', 'Snoozed', 'Resolved', 'Withdrawn'].includes(nextState)) throw new Error('Action success transition is invalid.');
      return completeAction(episode, finalAttempt, descriptor, { ...execution, nextState, snoozedUntil }, clock);
    } catch {
      return recoverAppliedProjection(episode, finalAttempt, descriptor, execution, clock);
    }
  }

  function executionHandlers(episode, descriptor, snoozedUntil = null) {
    if (descriptor.actionId === 'reminder.complete') {
      return {
        executor: ({ episode: sourceEpisode, parameters, logicalOperationId, expectedEpisodeRevision, retry }) => {
          if (typeof sourceActions.complete !== 'function') throw new Error('No reminder complete executor is registered.');
          return sourceActions.complete({ episode: sourceEpisode, parameters, logicalOperationId, expectedEpisodeRevision, retry });
        },
        verifier: typeof sourceActions.verify === 'function' ? sourceActions.verify : async () => ({ outcome: 'unknown' })
      };
    }
    if (descriptor.actionId === 'reminder.snooze') {
      return {
        executor: ({ episode: sourceEpisode, parameters, logicalOperationId, expectedEpisodeRevision, retry }) => {
          if (typeof sourceActions.snooze !== 'function') throw new Error('No reminder snooze executor is registered.');
          return sourceActions.snooze({ episode: sourceEpisode, parameters: { ...parameters, until: snoozedUntil }, logicalOperationId, expectedEpisodeRevision, retry });
        },
        verifier: typeof sourceActions.verify === 'function' ? sourceActions.verify : async () => ({ outcome: 'unknown' })
      };
    }
    if (descriptor.actionId === 'attention.snooze') return { executor: async () => ({}), verifier: async () => ({ outcome: 'applied' }) };
    return {
      executor: descriptor.executor ?? capabilities.get(episode.sourceCapabilityId)?.actionExecutor,
      verifier: descriptor.authoritativeVerifier
    };
  }

  function beginApprovalDecision(episode, approval, descriptor, logicalOperationId, expectedSourceRevision, clock) {
    return transaction(() => saveAttempt({
      attemptId: `attempt:${randomUUID()}`,
      episodeId: episode.episodeId,
      logicalOperationId,
      actionId: descriptor.actionId,
      expectedEpisodeRevision: episode.revision,
      expectedSourceRevision,
      target: { approvalId: approval.approvalId, attemptId: approval.attemptId },
      parameters: EMPTY_OBJECT,
      disclosureDigest: digest({ actionId: descriptor.actionId, approvalId: approval.approvalId, attemptId: approval.attemptId }),
      idempotentRetryable: false,
      state: 'running',
      retryCount: 0,
      createdAt: clock,
      updatedAt: clock
    }));
  }

  function finishApprovalDecision(decisionAttempt, outcome, clock) {
    return transaction(() => updateAttempt(decisionAttempt.attemptId, { state: 'applied', outcome, retryCount: 0, updatedAt: clock }));
  }

  async function resumeApprovalDecision(decisionAttempt, clock, authenticatedOperatorId = operatorId) {
    const approval = getApproval(decisionAttempt.target.approvalId);
    const approvedAttempt = getAttemptById(decisionAttempt.target.attemptId);
    if (!approval || !approvedAttempt || approval.attemptId !== approvedAttempt.attemptId) fail('conflict', 'The disclosed approval decision is unavailable.');
    if (approval.operatorId !== authenticatedOperatorId) fail('conflict', 'Approval operator does not match.');
    if (decisionAttempt.actionId === 'approval.reject') {
      const result = transaction(() => {
        if (approval.state === 'pending') {
          updateApproval(approval, 'rejected', clock);
          updateAttempt(approvedAttempt.attemptId, { state: 'failed', outcome: 'failed', retryCount: approvedAttempt.retryCount ?? 0, updatedAt: clock });
        } else if (approval.state !== 'rejected') fail('conflict', 'The approval can no longer be rejected.');
        const finalDecision = updateAttempt(decisionAttempt.attemptId, { state: 'applied', outcome: 'rejected', retryCount: 0, updatedAt: clock });
        const currentEpisode = findById(approval.episodeId);
        if (!currentEpisode || ['Resolved', 'Withdrawn'].includes(currentEpisode.state)) fail('conflict', 'The approval episode can no longer be withdrawn.');
        const withdrawn = { ...currentEpisode, state: assertTransition(currentEpisode.state, 'Withdrawn'), terminalAt: clock, snoozedUntil: null, revision: currentEpisode.revision + 1, updatedAt: clock };
        saveEpisode(withdrawn);
        return { episode: findById(withdrawn.episodeId), attempt: finalDecision, activity: recordActionActivity(withdrawn, finalDecision, { actionId: 'approval.reject' }, 'withdrawn', null, 'manual', clock) };
      });
      return Object.freeze({ status: 'applied', ...result, approval: getApproval(approval.approvalId) });
    }
    if (decisionAttempt.actionId !== 'approval.approve') fail('conflict', 'The approval decision action is invalid.');
    let result;
    if (['applied', 'failed', 'unknown', 'partial', 'not-applied', 'conflict'].includes(approvedAttempt.state)) {
      result = Object.freeze({ status: approvedAttempt.state === 'applied' ? 'applied' : approvedAttempt.state, episode: findById(approval.episodeId), attempt: approvedAttempt, activity: activityForAttempt(approvedAttempt) });
    } else if (approvedAttempt.state === 'running' && approval.state === 'consumed') {
      const current = findById(approval.episodeId);
      const descriptor = sourceActionDescriptor(current, approvedAttempt.actionId);
      if (!descriptor) fail('conflict', 'Approved action descriptor is unavailable.');
      const originalEpisode = { ...current, state: 'Active', revision: approvedAttempt.expectedEpisodeRevision };
      const handlers = executionHandlers(originalEpisode, descriptor, approvedAttempt.parameters.until ?? null);
      const prepared = { approval, episode: originalEpisode, attempt: approvedAttempt, descriptor, target: approvedAttempt.target, executionClock: clock, executionOperatorId: authenticatedOperatorId };
      result = await executeStartedAction({ episode: originalEpisode, attempt: approvedAttempt, descriptor, target: approvedAttempt.target, parameters: approvedAttempt.parameters, ...handlers, clock, snoozedUntil: approvedAttempt.parameters.until ?? null, reconcileFirst: true, beforeRetry: approvedRetryGate(prepared) });
    } else {
      result = await executeApproval({ approvalId: approval.approvalId }, authenticatedOperatorId);
    }
    finishApprovalDecision(decisionAttempt, result.status, clock);
    return result;
  }

  async function act(input = {}) {
    assertWritable();
    const value = object(input, 'Attention action request');
    const allowed = ['schemaVersion', 'logicalOperationId', 'episodeId', 'expectedEpisodeRevision', 'expectedSourceRevision', 'topicId', 'sourceReferenceId', 'actionId', 'input', 'approvalId', 'requestId', 'authenticatedOperatorId'];
    if (Object.keys(value).some((key) => !allowed.includes(key))) fail('invalid-request', 'Attention action request contains unsupported field');
    if (value.schemaVersion !== ATTENTION_SCHEMA_VERSION) fail('unsupported-version', 'schemaVersion must be 1');
    const logicalOperationId = nonBlank(value.logicalOperationId, 'logicalOperationId');
    const authenticatedOperatorId = value.authenticatedOperatorId === undefined ? operatorId : nonBlank(value.authenticatedOperatorId, 'authenticatedOperatorId');
    if (!isCanonicalUuid(logicalOperationId)) fail('invalid-request', 'logicalOperationId must be a canonical UUID.');
    const requestIntentDigest = actionIntentDigest(value);
    const existingAttempt = getAttempt(logicalOperationId);
    if (existingAttempt) {
      if (existingAttempt.episodeId !== value.episodeId || existingAttempt.actionId !== value.actionId || existingAttempt.expectedEpisodeRevision !== value.expectedEpisodeRevision || existingAttempt.expectedSourceRevision !== (value.expectedSourceRevision ?? null)) fail('intent-mismatch', 'Logical operation ID was reused with a different Attention action intent.');
      if (['approval.approve', 'approval.reject'].includes(existingAttempt.actionId) && value.approvalId !== existingAttempt.target.approvalId) fail('intent-mismatch', 'Logical operation ID was reused with a different approval reference.');
      const replayEpisode = findById(existingAttempt.episodeId);
      if (value.topicId !== undefined && value.topicId !== replayEpisode?.topicId || value.sourceReferenceId !== undefined && value.sourceReferenceId !== replayEpisode?.sourceReferenceId) fail('intent-mismatch', 'Logical operation ID was reused with different source linkage.');
      const ownedResult = liveResult(existingAttempt, requestIntentDigest, authenticatedOperatorId);
      if (ownedResult) return ownedResult;
      if (['approval.approve', 'approval.reject'].includes(existingAttempt.actionId)) {
        const approval = getApproval(existingAttempt.target.approvalId);
        const approvedAttempt = approval ? getAttemptById(approval.attemptId) : null;
        if (existingAttempt.state !== 'running') {
          const replayAttempt = existingAttempt.actionId === 'approval.approve' ? approvedAttempt ?? existingAttempt : existingAttempt;
          const replayStatus = existingAttempt.actionId === 'approval.approve'
            ? existingAttempt.outcome ?? replayAttempt.outcome ?? (replayAttempt.state === 'applied' ? 'applied' : replayAttempt.state)
            : existingAttempt.state === 'applied' ? 'applied' : existingAttempt.state;
          return Object.freeze({ status: replayStatus, episode: replayEpisode, attempt: replayAttempt, activity: activityForAttempt(replayAttempt), ...(approval ? { approval } : {}) });
        }
        const owners = [{ attemptId: existingAttempt.attemptId, intentDigest: requestIntentDigest, operatorId: authenticatedOperatorId }];
        if (approvedAttempt?.state === 'running') owners.push({ attemptId: approvedAttempt.attemptId, intentDigest: persistedAttemptIntentDigest(approvedAttempt, replayEpisode), operatorId: approval.operatorId });
        return ownLiveAttempts(owners, () => resumeApprovalDecision(existingAttempt, nowIso(now), authenticatedOperatorId));
      }
      const existingApproval = approvalForAttempt(existingAttempt.attemptId);
      const replayDescriptor = replayEpisode && (existingApproval ? sourceActionDescriptor(replayEpisode, value.actionId) : actionDescriptor(replayEpisode, value.actionId));
      if (!replayDescriptor) fail('intent-mismatch', 'Logical operation ID was reused with an unavailable action.');
      const replayParameters = validateActionInput(replayDescriptor, value.input ?? {});
      const replayTarget = replayDescriptor.targetResolver(replayEpisode, replayParameters);
      if (digest(replayTarget) !== digest(existingAttempt.target) || digest(replayParameters) !== digest(Object.fromEntries(Object.entries(existingAttempt.parameters).filter(([key]) => key !== 'until' || Object.hasOwn(replayParameters, 'until'))))) fail('intent-mismatch', 'Logical operation ID was reused with different action parameters.');
      if (replayDescriptor.approvalMode === 'never') {
        const persistedParameters = ['reminder.snooze', 'attention.snooze'].includes(replayDescriptor.actionId) ? existingAttempt.parameters : replayParameters;
        const replayDigest = digest({ actionId: replayDescriptor.actionId, target: replayTarget, parameters: persistedParameters, sideEffects: replayDescriptor.sideEffects });
        if (existingAttempt.disclosureDigest !== replayDigest && !['reminder.snooze', 'attention.snooze'].includes(replayDescriptor.actionId)) fail('intent-mismatch', 'Logical operation ID was reused with different action parameters.');
      }
      if (existingApproval?.state === 'pending') return Object.freeze({ status: 'approval-required', episode: replayEpisode, approval: existingApproval });
      if (existingAttempt.state === 'running') {
        const originalEpisode = { ...replayEpisode, state: 'Active', revision: existingAttempt.expectedEpisodeRevision };
        const persistedSnoozedUntil = ['reminder.snooze', 'attention.snooze'].includes(replayDescriptor.actionId) ? existingAttempt.parameters.until ?? null : null;
        const handlers = executionHandlers(originalEpisode, replayDescriptor, persistedSnoozedUntil);
        let beforeRetry = async () => {
          const currentEpisode = findById(existingAttempt.episodeId);
          const currentSourceRevision = latestOccurrence(existingAttempt.episodeId)?.occurrence_version ?? latestOccurrence(existingAttempt.episodeId)?.occurrenceVersion ?? null;
          if (!currentEpisode || currentEpisode.state !== 'Action running' || currentEpisode.revision !== existingAttempt.expectedEpisodeRevision + 1 || currentSourceRevision !== existingAttempt.expectedSourceRevision) fail('conflict', 'Persisted Attention evidence or source revision changed before retry.');
        };
        if (existingApproval?.state === 'consumed') {
          if (existingApproval.operatorId !== authenticatedOperatorId) fail('conflict', 'Approval operator does not match.');
          beforeRetry = approvedRetryGate({ approval: existingApproval, episode: originalEpisode, attempt: existingAttempt, descriptor: replayDescriptor, target: existingAttempt.target, executionOperatorId: authenticatedOperatorId });
        } else if (replayDescriptor.approvalMode === 'preauthorized') {
          beforeRetry = async () => {
            const currentEpisode = findById(existingAttempt.episodeId);
            if (!currentEpisode || currentEpisode.state !== 'Action running' || currentEpisode.revision !== existingAttempt.expectedEpisodeRevision + 1) fail('conflict', 'Preauthorized Attention evidence changed before retry.');
            const currentDescriptor = sourceActionDescriptor(currentEpisode, replayDescriptor.actionId);
            if (!currentDescriptor) fail('conflict', 'Preauthorized action descriptor is unavailable before retry.');
            const currentTarget = currentDescriptor.targetResolver(currentEpisode, replayParameters);
            const currentSourceRevision = latestOccurrence(currentEpisode.episodeId)?.occurrence_version ?? latestOccurrence(currentEpisode.episodeId)?.occurrenceVersion ?? null;
            const builtInReminder = ['reminder.complete', 'reminder.snooze'].includes(currentDescriptor.actionId) && (currentEpisode.sourceCapabilityId === 'reminders' || capabilities.get(currentEpisode.sourceCapabilityId)?.sourceKind === 'reminder');
            const preauthorization = capabilities.get(currentEpisode.sourceCapabilityId)?.preauthorizations?.get(currentDescriptor.actionId);
            const authorization = await currentAuthorizationContext(currentEpisode, currentDescriptor, currentTarget, replayParameters);
            const replayDigest = builtInReminder
              ? digest({ actionId: currentDescriptor.actionId, target: currentTarget, parameters: replayParameters, sideEffects: currentDescriptor.sideEffects, sourceRevision: currentSourceRevision })
              : preauthorizationDisclosure(preauthorization, authorization, currentDescriptor, currentTarget, replayParameters);
            if (!replayDigest || existingAttempt.disclosureDigest !== replayDigest) fail('conflict', 'Preauthorized action policy or preconditions changed before retry.');
          };
        }
        return ownLiveAttempts([{ attemptId: existingAttempt.attemptId, intentDigest: requestIntentDigest, operatorId: authenticatedOperatorId }], () => executeStartedAction({ episode: originalEpisode, attempt: existingAttempt, descriptor: replayDescriptor, target: existingAttempt.target, parameters: existingAttempt.parameters, ...handlers, clock: nowIso(now), snoozedUntil: persistedSnoozedUntil, reconcileFirst: true, beforeRetry }));
      }
      return Object.freeze({ status: existingAttempt.state === 'applied' ? 'applied' : existingAttempt.state, episode: findById(existingAttempt.episodeId), attempt: existingAttempt, activity: activityForAttempt(existingAttempt) });
    }
    const episode = findById(nonBlank(value.episodeId, 'episodeId'));
    if (!episode) fail('not-found', 'Attention episode was not found.');
    if (value.expectedEpisodeRevision !== episode.revision) fail('conflict', 'Attention episode revision is stale.', { currentRevision: episode.revision, expectedRevision: value.expectedEpisodeRevision });
    if (episode.topicId && value.topicId === undefined) fail('invalid-request', 'Attention action requires the exact Topic identity.');
    if (value.topicId !== undefined && value.topicId !== episode.topicId) fail('conflict', 'Attention Topic identity is stale.');
    if (episode.sourceReferenceId && value.sourceReferenceId === undefined) fail('invalid-request', 'Attention action requires the exact Source Reference identity.');
    if (value.sourceReferenceId !== undefined && value.sourceReferenceId !== episode.sourceReferenceId) fail('conflict', 'Attention Source Reference identity is stale.');
    await refreshApprovalForEpisode(episode, authenticatedOperatorId);
    if (['approval.approve', 'approval.reject'].includes(value.actionId)) {
      const namedApproval = getApproval(nonBlank(value.approvalId, 'approvalId'));
      if (namedApproval?.state === 'expired') fail('approval-expired', 'Approval has expired.');
    }
    const descriptor = actionDescriptor(episode, nonBlank(value.actionId, 'actionId'));
    if (!descriptor) fail('invalid-action', 'The Attention action is not registered for this episode.');
    const parameters = validateActionInput(descriptor, value.input ?? {});
    const sourceRevision = latestOccurrence(episode.episodeId)?.occurrence_version ?? latestOccurrence(episode.episodeId)?.occurrenceVersion ?? null;
    if (descriptor.kind === 'mutation' && sourceRevision !== null && value.expectedSourceRevision !== sourceRevision) fail(value.expectedSourceRevision === undefined ? 'invalid-request' : 'conflict', 'Attention source revision is stale.', { currentRevision: sourceRevision, expectedRevision: value.expectedSourceRevision ?? null });
    if (['reminder.complete', 'reminder.snooze'].includes(descriptor.actionId)) {
      if (sourceRevision === null) fail('precondition-unavailable', 'Reminder mutation requires an authoritative scheduler revision.');
      if (value.expectedSourceRevision !== sourceRevision || parameters.expectedConfigRevision !== sourceRevision) fail('conflict', 'Reminder configuration revision does not match the trusted episode source revision.');
    }
    const clock = nowIso(now);
    if (descriptor.kind === 'navigation') return Object.freeze({ status: 'applied', episode, navigation: actionProjection(descriptor, episode, parameters) });
    if (!['Active', 'Snoozed'].includes(episode.state)) fail('conflict', 'Only presentable Attention episodes can run actions.');
    if (descriptor.actionId === 'approval.approve') {
      const approval = getApproval(nonBlank(value.approvalId, 'approvalId'));
      if (approval?.episodeId !== episode.episodeId) fail('conflict', 'The approval is not bound to this episode.');
      if (!approval) fail('conflict', 'The disclosed approval is no longer actionable.');
      const prepared = await prepareApprovalExecution(approval.approvalId, authenticatedOperatorId);
      const { runningAttempt, decisionAttempt, executionClock } = commitPreparedApproval(prepared, { logicalOperationId, expectedSourceRevision: value.expectedSourceRevision ?? null });
      return ownLiveAttempts([
        { attemptId: decisionAttempt.attemptId, intentDigest: requestIntentDigest, operatorId: authenticatedOperatorId },
        { attemptId: runningAttempt.attemptId, intentDigest: persistedAttemptIntentDigest(runningAttempt, episode), operatorId: authenticatedOperatorId }
      ], async () => {
        const result = await runPreparedApproval({ ...prepared, executionClock }, runningAttempt);
        finishApprovalDecision(decisionAttempt, result.status, executionClock);
        return result;
      });
    }
    if (descriptor.actionId === 'approval.reject') {
      const approval = getApproval(nonBlank(value.approvalId, 'approvalId'));
      if (approval?.episodeId !== episode.episodeId) fail('conflict', 'The approval is not bound to this episode.');
      if (!approval) fail('conflict', 'The disclosed approval is no longer pending.');
      const decisionAttempt = beginApprovalDecision(episode, approval, descriptor, logicalOperationId, value.expectedSourceRevision ?? null, clock);
      return ownLiveAttempts([{ attemptId: decisionAttempt.attemptId, intentDigest: requestIntentDigest, operatorId: authenticatedOperatorId }], () => resumeApprovalDecision(decisionAttempt, clock, authenticatedOperatorId));
    }
    if (descriptor.approvalMode === 'required') return Object.freeze({ status: 'approval-required', episode, approval: await createApproval({ episodeId: episode.episodeId, expectedEpisodeRevision: episode.revision, actionId: descriptor.actionId, parameters, logicalOperationId, authenticatedOperatorId }) });
    const target = descriptor.targetResolver(episode, parameters);
    let disclosureDigest = digest({ actionId: descriptor.actionId, target, parameters, sideEffects: descriptor.sideEffects });
    let beforeRetry = async () => {
      const currentEpisode = findById(episode.episodeId);
      const currentSourceRevision = latestOccurrence(episode.episodeId)?.occurrence_version ?? latestOccurrence(episode.episodeId)?.occurrenceVersion ?? null;
      if (!currentEpisode || currentEpisode.state !== 'Action running' || currentEpisode.revision !== episode.revision + 1 || currentSourceRevision !== sourceRevision) fail('conflict', 'Attention evidence or source revision changed before retry.');
    };
    if (descriptor.approvalMode === 'preauthorized') {
      const builtInReminder = ['reminder.complete', 'reminder.snooze'].includes(descriptor.actionId) && (episode.sourceCapabilityId === 'reminders' || capabilities.get(episode.sourceCapabilityId)?.sourceKind === 'reminder');
      const preauthorization = builtInReminder
        ? { actionId: descriptor.actionId, version: 'reminder-direct-v1', parameters, target, planRevision: 'reminder-direct-v1', policyRevision: 'reminder-direct-v1', preconditionRevision: sourceRevision }
        : capabilities.get(episode.sourceCapabilityId)?.preauthorizations?.get(descriptor.actionId);
      const authorization = await currentAuthorizationContext(episode, descriptor, target, parameters);
      disclosureDigest = builtInReminder ? digest({ actionId: descriptor.actionId, target, parameters, sideEffects: descriptor.sideEffects, sourceRevision }) : preauthorizationDisclosure(preauthorization, authorization, descriptor, target, parameters);
      if (!disclosureDigest) fail('approval-required', 'This action has no exact server-side preauthorization.');
      const authorizedDigest = disclosureDigest;
      beforeRetry = async () => {
        const currentEpisode = findById(episode.episodeId);
        const currentSourceRevision = latestOccurrence(episode.episodeId)?.occurrence_version ?? latestOccurrence(episode.episodeId)?.occurrenceVersion ?? null;
        if (!currentEpisode || currentEpisode.state !== 'Action running' || currentEpisode.revision !== attempt.expectedEpisodeRevision + 1) fail('conflict', 'Preauthorized Attention evidence changed before retry.');
        const currentDescriptor = sourceActionDescriptor(currentEpisode, descriptor.actionId);
        if (!currentDescriptor) fail('conflict', 'Preauthorized action descriptor is unavailable before retry.');
        const currentTarget = currentDescriptor.targetResolver(currentEpisode, parameters);
        const currentPreauthorization = builtInReminder
          ? { actionId: descriptor.actionId, version: 'reminder-direct-v1', parameters, target: currentTarget, planRevision: 'reminder-direct-v1', policyRevision: 'reminder-direct-v1', preconditionRevision: currentSourceRevision }
          : capabilities.get(episode.sourceCapabilityId)?.preauthorizations?.get(descriptor.actionId);
        const currentAuthorization = await currentAuthorizationContext(currentEpisode, currentDescriptor, currentTarget, parameters);
        const currentDigest = builtInReminder ? digest({ actionId: currentDescriptor.actionId, target: currentTarget, parameters, sideEffects: currentDescriptor.sideEffects, sourceRevision: currentSourceRevision }) : preauthorizationDisclosure(currentPreauthorization, currentAuthorization, currentDescriptor, currentTarget, parameters);
        if (!currentDigest || currentDigest !== authorizedDigest) fail('conflict', 'Preauthorized action policy or preconditions changed before retry.');
      };
    }
    let snoozedUntil = null;
    if (descriptor.actionId === 'reminder.snooze' || descriptor.actionId === 'attention.snooze') {
      if (episode.severity === 'Critical') fail('invalid-action', 'Critical episodes cannot be snoozed.');
      if (capabilities.get(episode.sourceCapabilityId)?.monitoring !== true) fail('invalid-action', 'This source cannot continue monitoring while snoozed.');
      if (episode.state !== 'Active') fail('invalid-action', 'Only Active episodes can be snoozed.');
      if (Object.hasOwn(parameters, 'preset') === Object.hasOwn(parameters, 'until')) fail('invalid-request', 'Snooze requires exactly one of preset or until.');
      snoozedUntil = resolveSnoozeUntil(parameters.preset ?? (parameters.until ? { until: parameters.until } : undefined), clock, timeZone);
    }
    const attemptParameters = snoozedUntil ? { ...parameters, until: snoozedUntil } : parameters;
    const attempt = beginRunningAttempt({ episode, descriptor, logicalOperationId, expectedSourceRevision: value.expectedSourceRevision ?? null, target, parameters: attemptParameters, disclosureDigest, clock });
    const handlers = executionHandlers(episode, descriptor, snoozedUntil);
    if (typeof handlers.executor !== 'function' || typeof handlers.verifier !== 'function') return failAction(episode, attempt, descriptor, new Error('No action executor or verifier is registered.'), clock);
    return ownLiveAttempts([{ attemptId: attempt.attemptId, intentDigest: requestIntentDigest, operatorId: authenticatedOperatorId }], () => executeStartedAction({ episode, attempt, descriptor, target, parameters: attemptParameters, ...handlers, clock, snoozedUntil, beforeRetry }));
  }

  function failAction(episode, attempt, descriptor, error, clock) {
    return transaction(() => {
      const partial = error?.partial === true || error?.outcome === 'partial' || error?.code === 'partial';
      const ambiguous = partial || error?.ambiguous === true || ['unknown', 'conflict', 'timeout'].includes(error?.code);
      const failureOutcome = partial ? 'partial' : ambiguous ? 'unknown' : 'failed';
      const actionOutcome = partial ? 'partial' : ambiguous ? 'ambiguous' : 'failed';
      const current = findById(episode.episodeId);
      if (current && ['Resolved', 'Withdrawn'].includes(current.state)) {
        const finalAttempt = updateAttempt(attempt.attemptId, { state: failureOutcome, outcome: failureOutcome, retryCount: error?.retryCount ?? attempt.retryCount ?? 0, updatedAt: clock });
        const activity = recordActionActivity(current, finalAttempt, descriptor, failureOutcome, null, 'manual', clock);
        return Object.freeze({ status: failureOutcome, episode: current, attempt: finalAttempt, activity });
      }
      if (!current || current.state !== 'Action running' || current.revision < attempt.expectedEpisodeRevision + 1) fail('conflict', 'Attention action failure no longer matches the running attempt.');
      const next = { ...current, state: assertTransition(current.state, 'Active'), severity: ambiguous ? 'Critical' : isHigherSeverity('High', current.severity) ? 'High' : current.severity, revision: current.revision + 1, evidenceFacts: { ...current.evidenceFacts, actionOutcome }, updatedAt: clock };
      saveEpisode(next); const finalAttempt = updateAttempt(attempt.attemptId, { state: failureOutcome, outcome: failureOutcome, retryCount: error?.retryCount ?? attempt.retryCount ?? 0, updatedAt: clock });
      if (error?.approvalId && ['expired', 'superseded'].includes(error.approvalInvalidationState)) {
        const approval = getApproval(error.approvalId);
        if (approval?.state === 'consumed' && approval.attemptId === attempt.attemptId) updateApproval(approval, error.approvalInvalidationState, clock);
      }
      const activity = recordActionActivity(next, finalAttempt, descriptor, failureOutcome, null, 'manual', clock);
      return Object.freeze({ status: failureOutcome, episode: findById(next.episodeId), attempt: finalAttempt, activity });
    });
  }

  function snooze(input) { return act({ ...input, actionId: input.actionId ?? 'attention.snooze' }); }

  async function createApproval(input = {}) {
    assertWritable();
    const value = object(input, 'approval request');
    const allowed = ['episodeId', 'expectedEpisodeRevision', 'actionId', 'parameters', 'logicalOperationId', 'authenticatedOperatorId'];
    if (Object.keys(value).some((key) => !allowed.includes(key))) fail('invalid-request', 'Approval request contains unsupported field.');
    const episode = findById(nonBlank(value.episodeId, 'episodeId'));
    if (!episode || episode.revision !== value.expectedEpisodeRevision) fail('conflict', 'Approval episode revision is stale.');
    const descriptor = actionDescriptor(episode, nonBlank(value.actionId, 'actionId'));
    if (!descriptor || descriptor.kind !== 'mutation') fail('invalid-action', 'Approval action is not a registered mutation.');
    const parameters = validateActionInput(descriptor, value.parameters ?? {});
    const createdAt = nowIso(now); const expiresAt = new Date(Date.parse(createdAt) + APPROVAL_WINDOW_MS).toISOString();
    const target = descriptor.targetResolver(episode, parameters);
    const approvalLogicalOperationId = nonBlank(value.logicalOperationId, 'logicalOperationId');
    if (!isCanonicalUuid(approvalLogicalOperationId)) fail('invalid-request', 'logicalOperationId must be a canonical UUID.');
    const { planRevision, preconditionRevision, policyRevision } = await currentAuthorizationContext(episode, descriptor, target, parameters);
    let boundHost;
    let boundOperator;
    try {
      boundHost = nonBlank(host, 'host');
      boundOperator = nonBlank(value.authenticatedOperatorId ?? operatorId, 'operatorId');
    } catch {
      fail('identity-unavailable', 'Approval creation requires explicit host and authenticated operator identities.');
    }
    const disclosureDigest = digest({ episodeId: episode.episodeId, episodeRevision: episode.revision, diagnosis: episode.diagnosis, actionId: descriptor.actionId, target, parameters, planRevision, sideEffects: descriptor.sideEffects, host: boundHost, operatorId: boundOperator, preconditionRevision, policyRevision, expiresAt });
    return transaction(() => {
      const current = findById(episode.episodeId);
      if (!current || current.revision !== episode.revision || !['Active', 'Snoozed'].includes(current.state)) fail('conflict', 'Attention episode changed before approval creation.');
      const attempt = saveAttempt({ attemptId: `attempt:${randomUUID()}`, episodeId: episode.episodeId, logicalOperationId: approvalLogicalOperationId, actionId: descriptor.actionId, expectedEpisodeRevision: episode.revision, expectedSourceRevision: latestOccurrence(episode.episodeId)?.occurrence_version ?? latestOccurrence(episode.episodeId)?.occurrenceVersion ?? null, target, parameters, disclosureDigest, idempotentRetryable: descriptor.idempotency.idempotent && descriptor.idempotency.transientRetryable, state: 'pending', retryCount: 0, createdAt, updatedAt: createdAt });
      const approval = { approvalId: `approval:${randomUUID()}`, actionId: descriptor.actionId, attemptId: attempt.attemptId, episodeId: episode.episodeId, episodeRevision: episode.revision, diagnosis: episode.diagnosis, target, parameters, planRevision, sideEffects: descriptor.sideEffects, host: boundHost, operatorId: boundOperator, preconditionRevision, policyRevision, disclosureDigest, expiresAt, state: 'pending', createdAt, updatedAt: createdAt };
      if (!db) memory.approvals.set(approval.approvalId, approval);
      else db.prepare('INSERT INTO attention_approvals (approval_id, attempt_id, episode_id, episode_revision, diagnosis_json, target_json, parameters_json, plan_revision, side_effects_json, host, operator_id, precondition_revision, policy_revision, disclosure_digest, expires_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(approval.approvalId, approval.attemptId, approval.episodeId, approval.episodeRevision, json(approval.diagnosis), json(approval.target), json(approval.parameters), approval.planRevision, json(approval.sideEffects), approval.host, approval.operatorId, approval.preconditionRevision, approval.policyRevision, approval.disclosureDigest, approval.expiresAt, approval.state, approval.createdAt, approval.updatedAt);
      return Object.freeze({ ...approval });
    });
  }

  function getApproval(approvalId) { return db ? mapApproval(db.prepare('SELECT a.*, t.action_id FROM attention_approvals a JOIN attention_attempts t ON t.attempt_id = a.attempt_id WHERE a.approval_id = ?').get(approvalId)) : memory.approvals.get(approvalId) ?? null; }
  function updateApproval(approval, state, clock) { assertWritable(); if (!db) { const next = { ...approval, state, updatedAt: clock }; memory.approvals.set(approval.approvalId, next); return next; } db.prepare('UPDATE attention_approvals SET state = ?, updated_at = ? WHERE approval_id = ?').run(state, clock, approval.approvalId); return getApproval(approval.approvalId); }
  function approve(input) { const value = object(input, 'approval approval request'); if (Object.keys(value).some((key) => !['approvalId', 'operatorId'].includes(key))) fail('invalid-request', 'Approval request contains unsupported field.'); const approval = getApproval(nonBlank(value.approvalId, 'approvalId')); if (!approval) fail('not-found', 'Approval was not found.'); if (approval.state !== 'pending') fail('conflict', 'Only pending approvals can be approved.'); const clock = nowIso(now); if (Date.parse(clock) >= Date.parse(approval.expiresAt)) { updateApproval(approval, 'expired', clock); fail('approval-expired', 'Approval has expired.'); } if (approval.operatorId !== (value.operatorId ?? operatorId)) fail('conflict', 'Approval operator does not match.'); return updateApproval(approval, 'approved', clock); }
  function reject(input) { const value = object(input, 'approval rejection request'); if (Object.keys(value).some((key) => !['approvalId', 'operatorId'].includes(key))) fail('invalid-request', 'Approval rejection contains unsupported field.'); const approval = getApproval(nonBlank(value.approvalId, 'approvalId')); if (!approval) fail('not-found', 'Approval was not found.'); if (approval.state !== 'pending') fail('conflict', 'Only pending approvals can be rejected.'); const clock = nowIso(now); if (Date.parse(clock) >= Date.parse(approval.expiresAt)) { updateApproval(approval, 'expired', clock); fail('approval-expired', 'Approval has expired.'); } if (approval.operatorId !== (value.operatorId ?? operatorId)) fail('conflict', 'Approval operator does not match.'); return updateApproval(approval, 'rejected', clock); }
  async function prepareApprovalExecution(approvalId, authenticatedOperatorId = operatorId) {
    const approval = getApproval(nonBlank(approvalId, 'approvalId'));
    if (!approval) fail('not-found', 'Approval was not found.');
    if (approval.state === 'expired') fail('approval-expired', 'Approval has expired.');
    if (!['pending', 'approved'].includes(approval.state)) fail('conflict', 'Approval is not actionable or was already consumed.');
    const executionClock = nowIso(now);
    if (Date.parse(executionClock) >= Date.parse(approval.expiresAt)) { updateApproval(approval, 'expired', executionClock); fail('approval-expired', 'Approval has expired.'); }
    if (authenticatedOperatorId !== approval.operatorId) fail('conflict', 'Approval operator does not match.');
    if (host !== approval.host) fail('conflict', 'Approval host does not match.');
    const episode = findById(approval.episodeId);
    if (!episode || episode.revision !== approval.episodeRevision) {
      supersedeApproval(approval, executionClock);
      fail('conflict', 'Approved Attention evidence changed.');
    }
    const attempt = db ? mapAttempt(db.prepare('SELECT * FROM attention_attempts WHERE attempt_id = ?').get(approval.attemptId)) : memory.attempts.get(approval.attemptId);
    if (!attempt) {
      supersedeApproval(approval, executionClock);
      fail('conflict', 'Approval attempt is unavailable.');
    }
    const descriptor = sourceActionDescriptor(episode, attempt.actionId);
    if (!descriptor) {
      supersedeApproval(approval, executionClock);
      fail('conflict', 'Approved action descriptor is unavailable.');
    }
    let target;
    let authorization;
    try {
      target = descriptor.targetResolver(episode, attempt.parameters);
      authorization = await currentAuthorizationContext(episode, descriptor, target, attempt.parameters);
    } catch (error) {
      supersedeApproval(approval, executionClock);
      throw error;
    }
    if (authorization.planRevision !== approval.planRevision || authorization.policyRevision !== approval.policyRevision || authorization.preconditionRevision !== approval.preconditionRevision) {
      supersedeApproval(approval, executionClock);
      fail('conflict', 'Approved action preconditions changed.');
    }
    const expectedDigest = digest({ episodeId: episode.episodeId, episodeRevision: episode.revision, diagnosis: approval.diagnosis, actionId: descriptor.actionId, target, parameters: attempt.parameters, planRevision: approval.planRevision, sideEffects: descriptor.sideEffects, host: approval.host, operatorId: approval.operatorId, preconditionRevision: approval.preconditionRevision, policyRevision: approval.policyRevision, expiresAt: approval.expiresAt });
    if (approval.disclosureDigest !== expectedDigest || attempt.disclosureDigest !== approval.disclosureDigest) {
      supersedeApproval(approval, executionClock);
      fail('conflict', 'Approved action disclosure changed.');
    }
    return { approval, episode, attempt, descriptor, target, executionClock, executionOperatorId: authenticatedOperatorId };
  }
  function failReservedApproval(approval, state, code, message) {
    fail(code, message, { approvalId: approval.approvalId, approvalInvalidationState: state });
  }
  async function assertApprovedExecutionCurrent({ approval, episode, attempt, target, executionOperatorId }, phase) {
    const driftCode = phase === 'retry' ? 'conflict' : 'approval-drift';
    let clock = nowIso(now);
    const currentApproval = getApproval(approval.approvalId);
    const currentAttempt = getAttemptById(attempt.attemptId);
    if (!currentApproval || currentApproval.state !== 'consumed' || currentApproval.attemptId !== attempt.attemptId || !currentAttempt || currentAttempt.state !== 'running') fail(driftCode, `Approval is no longer reserved before ${phase}.`);
    if (Date.parse(clock) >= Date.parse(currentApproval.expiresAt)) {
      failReservedApproval(currentApproval, 'expired', 'approval-expired', `Approval expired before ${phase}.`);
    }
    if (host !== currentApproval.host || executionOperatorId !== currentApproval.operatorId) {
      failReservedApproval(currentApproval, 'superseded', driftCode, `Approved action host or operator changed before ${phase}.`);
    }
    const currentEpisode = findById(episode.episodeId);
    if (!currentEpisode || currentEpisode.state !== 'Action running' || currentEpisode.revision !== currentApproval.episodeRevision + 1) {
      failReservedApproval(currentApproval, 'superseded', driftCode, `Approved Attention evidence changed before ${phase}.`);
    }
    const currentDescriptor = sourceActionDescriptor(currentEpisode, currentAttempt.actionId);
    if (!currentDescriptor) {
      failReservedApproval(currentApproval, 'superseded', driftCode, `Approved action descriptor is unavailable before ${phase}.`);
    }
    let currentTarget;
    let authorization;
    try {
      currentTarget = currentDescriptor.targetResolver(currentEpisode, currentAttempt.parameters);
      authorization = await currentAuthorizationContext(currentEpisode, currentDescriptor, currentTarget, currentAttempt.parameters);
    } catch {
      failReservedApproval(currentApproval, 'superseded', driftCode, `Approved action authorization context is unavailable before ${phase}.`);
    }
    clock = nowIso(now);
    if (Date.parse(clock) >= Date.parse(currentApproval.expiresAt)) {
      failReservedApproval(currentApproval, 'expired', 'approval-expired', `Approval expired before ${phase}.`);
    }
    const expectedDigest = digest({ episodeId: episode.episodeId, episodeRevision: currentApproval.episodeRevision, diagnosis: currentApproval.diagnosis, actionId: currentDescriptor.actionId, target: currentTarget, parameters: currentAttempt.parameters, planRevision: authorization.planRevision, sideEffects: currentDescriptor.sideEffects, host: currentApproval.host, operatorId: currentApproval.operatorId, preconditionRevision: authorization.preconditionRevision, policyRevision: authorization.policyRevision, expiresAt: currentApproval.expiresAt });
    if (digest(currentTarget) !== digest(target) || digest(currentAttempt.target) !== digest(target) || digest(currentAttempt.parameters) !== digest(attempt.parameters) || expectedDigest !== currentApproval.disclosureDigest || currentAttempt.disclosureDigest !== currentApproval.disclosureDigest) {
      failReservedApproval(currentApproval, 'superseded', driftCode, `Approved action policy or preconditions changed before ${phase}.`);
    }
  }
  function approvedRetryGate(prepared) {
    return () => assertApprovedExecutionCurrent(prepared, 'retry');
  }
  function commitPreparedApproval({ approval, episode, attempt, executionClock }, decision = null) {
    const committed = transaction(() => {
      const commitClock = nowIso(now);
      const currentApproval = getApproval(approval.approvalId);
      const currentEpisode = findById(episode.episodeId);
      if (['pending', 'approved'].includes(currentApproval?.state) && Date.parse(commitClock) >= Date.parse(currentApproval.expiresAt)) {
        updateApproval(currentApproval, 'expired', commitClock);
        return { expired: true };
      }
      if (!['pending', 'approved'].includes(currentApproval?.state) || currentEpisode?.revision !== episode.revision) fail('conflict', 'Approved action changed before execution.');
      let decisionAttempt = null;
      if (decision) decisionAttempt = saveAttempt({ attemptId: `attempt:${randomUUID()}`, episodeId: episode.episodeId, logicalOperationId: decision.logicalOperationId, actionId: 'approval.approve', expectedEpisodeRevision: episode.revision, expectedSourceRevision: decision.expectedSourceRevision ?? null, target: { approvalId: approval.approvalId, attemptId: attempt.attemptId }, parameters: EMPTY_OBJECT, disclosureDigest: digest({ actionId: 'approval.approve', approvalId: approval.approvalId, attemptId: attempt.attemptId }), idempotentRetryable: false, state: 'running', retryCount: 0, createdAt: commitClock, updatedAt: commitClock });
      updateApproval(currentApproval, 'consumed', commitClock);
      saveEpisode({ ...currentEpisode, state: assertTransition(currentEpisode.state, 'Action running'), revision: currentEpisode.revision + 1, updatedAt: commitClock });
      const runningAttempt = updateAttempt(attempt.attemptId, { state: 'running', outcome: null, retryCount: attempt.retryCount ?? 0, updatedAt: commitClock });
      return { runningAttempt, decisionAttempt, executionClock: commitClock };
    });
    if (committed.expired) fail('approval-expired', 'Approval has expired.');
    return committed;
  }
  async function runPreparedApproval(prepared, runningAttempt) {
    const { episode, descriptor, target, attempt, executionClock } = prepared;
    const handlers = executionHandlers(episode, descriptor);
    if (typeof handlers.executor !== 'function' || typeof handlers.verifier !== 'function') return failAction(episode, runningAttempt, descriptor, new Error('No action executor or verifier is registered.'), executionClock);
    try { await assertApprovedExecutionCurrent(prepared, 'dispatch'); }
    catch (error) { return failAction(episode, runningAttempt, descriptor, error, nowIso(now)); }
    return executeStartedAction({ episode, attempt: runningAttempt, descriptor, target, parameters: attempt.parameters, ...handlers, clock: executionClock, beforeRetry: approvedRetryGate(prepared) });
  }
  async function executeApproval(input, authenticatedOperatorId = operatorId) {
    const prepared = await prepareApprovalExecution(input.approvalId, authenticatedOperatorId);
    const { runningAttempt, executionClock } = commitPreparedApproval(prepared);
    return runPreparedApproval({ ...prepared, executionClock }, runningAttempt);
  }

  const service = {
    registerSourceCapability,
    registerCapability: registerSourceCapability,
    ingest,
    ingestOccurrence: ingest,
    list,
    listEpisodes: list,
    get,
    getEpisode: get,
    async refreshApprovals(input = {}) {
      object(input, 'Attention approval refresh request');
      if (Object.keys(input).some((key) => !['topicId', 'episodeId', 'authenticatedOperatorId'].includes(key))) fail('invalid-request', 'Attention approval refresh request contains unsupported field');
      const candidates = input.episodeId ? [findById(input.episodeId)].filter(Boolean) : listRows().filter((episode) => !input.topicId || episode.topicId === input.topicId);
      for (const episode of candidates) await refreshApprovalForEpisode(episode, input.authenticatedOperatorId);
    },
    sourceOccurrenceContext(input = {}) {
      const identity = episodeIdentity(normalizeOccurrence({ ...input, schemaVersion: 1, occurrenceId: 'context-only', occurredAt: '1970-01-01T00:00:00.000Z', evidenceFacts: {} }));
      const current = findGenerations(identity)[0] ?? null;
      return current ? Object.freeze({ generation: current.generation, state: current.state }) : null;
    },
    allEpisodes() { return listRows(); },
    act,
    attentionAct: act,
    createApproval,
    approve,
    reject,
    executeApproval,
    listActivity(input = {}) {
      const { schemaVersion = ATTENTION_SCHEMA_VERSION, topicId, episodeId: filterEpisodeId, offset = 0, limit = 50 } = object(input, 'Activity list request');
      if (schemaVersion !== ATTENTION_SCHEMA_VERSION) fail('unsupported-version', 'schemaVersion must be 1');
      if (Object.keys(input).some((key) => !['schemaVersion', 'topicId', 'episodeId', 'offset', 'limit'].includes(key))) fail('invalid-request', 'Activity list request contains unsupported field');
      if (!Number.isInteger(offset) || offset < 0) fail('invalid-request', 'offset must be a non-negative integer');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid-request', 'limit must be between 1 and 100');
      const boundedRows = (table, mapper) => {
        if (!db) return [];
        const clauses = []; const parameters = [];
        if (topicId) { clauses.push('topic_id = ?'); parameters.push(topicId); }
        if (filterEpisodeId && table === 'attention_activity_records') { clauses.push('episode_id = ?'); parameters.push(filterEpisodeId); }
        if (filterEpisodeId && table === 'activity_records') return [];
        parameters.push(offset + limit + 1);
        return db.prepare(`SELECT * FROM ${table} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, activity_id DESC LIMIT ?`).all(...parameters).map(mapper);
      };
      const attentionRows = db ? boundedRows('attention_activity_records', mapActivity) : [...memory.activities.values()].filter((item) => (!topicId || item.topicId === topicId) && (!filterEpisodeId || item.episodeId === filterEpisodeId));
      const legacyRows = filterEpisodeId ? [] : db ? boundedRows('activity_records', mapLegacyActivity) : typeof metadata?.listActivity === 'function' ? metadata.listActivity(topicId).map(mapLegacyActivity) : [];
      const rows = [...new Map([...attentionRows, ...legacyRows].map((row) => [row.activityId, row])).values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.activityId.localeCompare(left.activityId));
      const page = rows.slice(offset, offset + limit);
      const hasMore = rows.length > offset + limit;
      return Object.freeze({ schemaVersion: 1, records: Object.freeze(page), nextOffset: hasMore ? offset + page.length : null, hasMore });
    },
    getActivity(activityId) { const id = nonBlank(activityId, 'activityId'); return (db ? mapActivity(db.prepare('SELECT * FROM attention_activity_records WHERE activity_id = ?').get(id)) : [...memory.activities.values()].find((item) => item.activityId === id)) ?? mapLegacyActivity(metadata?.getActivity?.(id)); },
    close() { if (closed) return; closed = true; db?.close(); }
  };
  return Object.freeze(service);
}

export { DELIVERY_WINDOW_MS, APPROVAL_WINDOW_MS };
