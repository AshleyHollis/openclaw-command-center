import { createHash } from 'node:crypto';
import { normalizeLoop, normalizeObservation } from '../open-loops/contracts.mjs';
import { openLoopReminderOperationId, openLoopReminderReferenceId, planOpenLoopReminder } from '../open-loops/reminder-coordinator.mjs';
import { selectSupportingNoteTarget } from '../open-loops/supporting-note-target.mjs';
import { supportingNoteOperationId } from '../open-loops/supporting-note-annotation.mjs';
import { projectQuietInbox } from '../open-loops/quiet-attention.mjs';

const OBSERVE_OPERATION = 'open-loop.observe.v1';
const RECONCILE_OPERATION = 'open-loop.reconcile.v1';
// Atomic owner commands use the existing reconcile receipt family so schema 9
// remains byte-compatible; operationKind is part of the canonical root intent.
const CHANGE_OPERATION = RECONCILE_OPERATION;
const evidenceRoles = new Set(['origin', 'update', 'resolution', 'conflict']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export function installOpenLoopMetadata(service, { mutate, inspect, ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  const text = (value, field, maximum = 300) => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail('open-loop-intent-invalid', `${field} must be a non-blank string`);
    return value.trim();
  };
  const now = value => {
    const result = value ?? new Date().toISOString();
    if (typeof result !== 'string' || Number.isNaN(Date.parse(result))) fail('open-loop-intent-invalid', 'observedAt must be a valid instant');
    return result;
  };
  const closed = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('open-loop-intent-invalid');
    return value;
  };
  function operation(db, id, kind, intentDigest) {
    const row = db.prepare('SELECT * FROM open_loop_operations WHERE logical_operation_id = ?').get(id);
    if (!row) return null;
    if (row.operation_kind !== kind || row.intent_digest !== intentDigest) fail('open-loop-intent-mismatch', 'The logical operation ID was already used for another intent.');
    try {
      // Prepared Note bytes are private effect intent, never part of a replayed
      // user-decision response or a public bridge result.
      const { supportingNoteIntent: _privateIntent, ...result } = JSON.parse(row.result_json);
      return freeze(result);
    } catch { fail('open-loop-receipt-invalid'); }
  }
  function receipt(db, id, kind, intentDigest, result, createdAt) {
    db.prepare("INSERT INTO open_loop_operations (logical_operation_id, operation_kind, intent_digest, state, result_json, created_at) VALUES (?, ?, ?, 'applied', ?, ?)").run(id, kind, intentDigest, JSON.stringify(result), createdAt);
    return freeze(result);
  }
  function mapObservation(row) {
    if (!row) return null;
    return freeze({
      schemaVersion: 1,
      observationId: row.observation_id,
      source: { system: row.source_system, kind: row.source_kind, externalId: row.external_source_id, version: row.source_version },
      type: row.observation_type,
      occurredAt: row.occurred_at,
      observedAt: row.observed_at,
      historicalBaseline: row.historical_baseline === 1,
      ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
      entityRefs: JSON.parse(row.entity_refs_json),
      facts: JSON.parse(row.facts_json),
      digest: row.observation_digest
    });
  }
  function mapLoop(db, row) {
    if (!row) return null;
    const evidenceObservationIds = db.prepare('SELECT observation_id FROM open_loop_evidence WHERE loop_id = ? ORDER BY observation_id').all(row.loop_id).map(item => item.observation_id);
    const attention = JSON.parse(row.attention_json);
    const dateTiming = row.due_at === null ? db.prepare(`SELECT json_extract(o.facts_json, '$.dueDate') AS due_date, json_extract(o.facts_json, '$.dueTimeZone') AS due_time_zone
      FROM open_loop_evidence e JOIN source_observations o ON o.observation_id = e.observation_id
      WHERE e.loop_id = ? AND json_type(o.facts_json, '$.dueDate') = 'text' AND json_type(o.facts_json, '$.dueTimeZone') = 'text'
      ORDER BY e.linked_at DESC, e.observation_id DESC LIMIT 1`).get(row.loop_id) : null;
    return freeze({
      schemaVersion: 1,
      loopId: row.loop_id,
      kind: row.loop_kind,
      stableSubjectId: row.stable_subject_id,
      title: row.title,
      ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
      state: row.state,
      ...(row.payment_state === null ? {} : { paymentState: row.payment_state }),
      ...(row.amount_minor === null ? {} : { amount: row.amount_minor, currency: row.currency }),
      ...(row.due_at === null ? {} : { dueAt: row.due_at }),
      ...(dateTiming?.due_date ? { dueDate: dateTiming.due_date, dueTimeZone: dateTiming.due_time_zone } : {}),
      ...(row.review_at === null ? {} : { reviewAt: row.review_at }),
      ...(row.expected_event === null ? {} : { expectedEvent: row.expected_event }),
      ...(Object.keys(attention).length === 0 ? {} : { attention }),
      evidenceObservationIds,
      revision: row.revision
    });
  }
  function storeObservation(db, observation) {
    const existingById = db.prepare('SELECT * FROM source_observations WHERE observation_id = ?').get(observation.observationId);
    const existingBySource = db.prepare('SELECT * FROM source_observations WHERE source_system = ? AND source_kind = ? AND external_source_id = ? AND source_version = ?').get(observation.source.system, observation.source.kind, observation.source.externalId, observation.source.version);
    const existing = existingById ?? existingBySource;
    if (existing && existing.observation_digest !== observation.digest) fail('open-loop-observation-conflict', 'An immutable source observation changed without a new source version.');
    if (existingById && existingBySource && existingById.observation_id !== existingBySource.observation_id) fail('open-loop-observation-conflict');
    if (observation.topicId && !db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(observation.topicId)) fail('open-loop-topic-missing');
    if (!existing) db.prepare(`INSERT INTO source_observations (observation_id, source_system, source_kind, external_source_id, source_version, observation_type, occurred_at, observed_at, historical_baseline, topic_id, entity_refs_json, facts_json, observation_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(observation.observationId, observation.source.system, observation.source.kind, observation.source.externalId, observation.source.version, observation.type, observation.occurredAt, observation.observedAt, observation.historicalBaseline ? 1 : 0, observation.topicId ?? null, JSON.stringify(observation.entityRefs), JSON.stringify(observation.facts), observation.digest, observation.observedAt);
    return { existing: Boolean(existing), observation: mapObservation(existing ?? db.prepare('SELECT * FROM source_observations WHERE observation_id = ?').get(observation.observationId)) };
  }
  function storeLoop(db, loop, expectedRevision, roles, updatedAt, userDecision = false) {
    const existing = db.prepare('SELECT * FROM open_loops WHERE loop_id = ?').get(loop.loopId);
    if ((existing?.revision ?? 0) !== expectedRevision) fail('open-loop-stale-revision', 'The open loop revision is stale.');
    if (existing && !userDecision) {
      const attention = JSON.parse(existing.attention_json);
      const retainedDecisionId = attention.pendingClarificationId && attention.priorUserActionOperationId;
      const prior = db.prepare(`SELECT json_extract(op.result_json, '$.followUpIntent.action') AS action,
          journal.state AS native_state,
          json_extract(op.result_json, '$.supportingNoteTarget.status') AS note_status,
          json_extract(op.result_json, '$.supportingNoteOutcome.status') AS note_outcome
        FROM open_loop_operations op
        JOIN source_observations observation ON observation.source_system = 'command-center'
          AND observation.source_kind IN ('user-decision', 'processor-interpretation')
          AND observation.external_source_id = op.logical_operation_id
          AND observation.observation_id = json_extract(op.result_json, '$.observation.observationId')
        LEFT JOIN operation_journal journal ON journal.logical_operation_id = json_extract(op.result_json, '$.followUpIntent.logicalOperationId')
        WHERE op.operation_kind = ? AND op.state = 'applied'
          AND json_extract(op.result_json, '$.loop.loopId') = ?
          AND (op.logical_operation_id = ? OR (? IS NULL AND json_extract(op.result_json, '$.loop.revision') = ?))
        ORDER BY op.created_at DESC, op.logical_operation_id DESC LIMIT 1`).get(CHANGE_OPERATION, loop.loopId,
        retainedDecisionId ?? null, retainedDecisionId ?? null, existing.revision);
      if (prior && (!['none', 'blocked', 'conflict', null].includes(prior.action) && prior.native_state !== 'applied'
        || prior.note_status === 'ready' && prior.note_outcome !== 'completed')) {
        fail('open-loop-follow-up-pending', 'The accepted follow-up must settle before this open loop can advance.');
      }
    }
    const owner = db.prepare('SELECT loop_id FROM open_loops WHERE loop_kind = ? AND stable_subject_id = ?').get(loop.kind, loop.stableSubjectId);
    if (owner && owner.loop_id !== loop.loopId) fail('open-loop-subject-conflict');
    if (loop.topicId && !db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(loop.topicId)) fail('open-loop-topic-missing');
    if (loop.evidenceObservationIds.some(id => !db.prepare('SELECT 1 FROM source_observations WHERE observation_id = ?').get(id))) fail('open-loop-evidence-missing');
    if (loop.dueDate && !loop.evidenceObservationIds.some(id => {
      const facts = db.prepare('SELECT facts_json FROM source_observations WHERE observation_id = ?').get(id);
      if (!facts) return false;
      const value = JSON.parse(facts.facts_json);
      return value.dueDate === loop.dueDate && value.dueTimeZone === loop.dueTimeZone;
    })) fail('open-loop-evidence-missing', 'A date-only due date requires matching evidence with its timezone.');
    const oldEvidence = existing ? db.prepare('SELECT observation_id FROM open_loop_evidence WHERE loop_id = ?').all(loop.loopId).map(item => item.observation_id) : [];
    if (oldEvidence.some(id => !loop.evidenceObservationIds.includes(id))) fail('open-loop-evidence-removal', 'Evidence links are append-only.');
    const values = [loop.kind, loop.stableSubjectId, loop.title, loop.topicId ?? null, loop.state, loop.paymentState ?? null, loop.amount ?? null, loop.currency ?? null, loop.dueAt ?? null, loop.reviewAt ?? null, loop.expectedEvent ?? null, JSON.stringify(loop.attention ?? {}), loop.revision, updatedAt, loop.loopId];
    if (existing) db.prepare(`UPDATE open_loops SET loop_kind=?, stable_subject_id=?, title=?, topic_id=?, state=?, payment_state=?, amount_minor=?, currency=?, due_at=?, review_at=?, expected_event=?, attention_json=?, revision=?, updated_at=? WHERE loop_id=?`).run(...values);
    else db.prepare(`INSERT INTO open_loops (loop_kind, stable_subject_id, title, topic_id, state, payment_state, amount_minor, currency, due_at, review_at, expected_event, attention_json, revision, updated_at, loop_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values, updatedAt);
    for (const observationId of loop.evidenceObservationIds) db.prepare(`INSERT INTO open_loop_evidence (loop_id, observation_id, evidence_role, linked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(loop_id, observation_id) DO UPDATE SET evidence_role=excluded.evidence_role`).run(loop.loopId, observationId, roles[observationId] ?? (existing ? 'update' : 'origin'), updatedAt);
    return { disposition: existing ? 'updated' : 'created', loop: mapLoop(db, db.prepare('SELECT * FROM open_loops WHERE loop_id = ?').get(loop.loopId)) };
  }
  function followUpIntent(db, logicalOperationId, operationKind, loop) {
    if (!loop || !(operationKind.startsWith('decision-') || operationKind === 'payment-status')) return undefined;
    const referenceId = openLoopReminderReferenceId(loop.loopId);
    const row = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(referenceId);
    const sourceReference = row ? { referenceId: row.reference_id, topicId: row.topic_id, sourceSystem: row.source_system,
      sourceKind: row.source_kind, externalSourceId: row.external_source_id } : null;
    const base = { schemaVersion: 1, logicalOperationId: openLoopReminderOperationId(logicalOperationId),
      loopId: loop.loopId, loopRevision: loop.revision, referenceId,
      ...(row?.last_observed_revision ? { expectedConfigRevision: row.last_observed_revision } : {}) };
    try {
      const plan = planOpenLoopReminder({ loop, sourceReference });
      if (!row && ['none', 'create'].includes(plan.action)) {
        const predecessorRow = db.prepare(`SELECT result_json FROM open_loop_operations
          WHERE state = 'applied' AND json_extract(result_json, '$.loop.loopId') = ?
            AND json_extract(result_json, '$.followUpIntent.action') = 'create'
          ORDER BY json_extract(result_json, '$.loop.revision') DESC LIMIT 1`).get(loop.loopId);
        const predecessor = predecessorRow && JSON.parse(predecessorRow.result_json)?.followUpIntent;
        if (predecessor) {
          return { ...base, action: plan.action === 'create' ? 'reschedule-pending-create' : 'cancel-pending-create',
            topicId: predecessor.topicId, ...(plan.declaration ? { declaration: plan.declaration } : {}),
            predecessor: { logicalOperationId: predecessor.logicalOperationId,
              loopRevision: predecessor.loopRevision, declaration: predecessor.declaration } };
        }
      }
      if (row && ['cancel', 'reschedule'].includes(plan.action)) {
        const predecessorRow = db.prepare(`SELECT json_extract(op.result_json, '$.followUpIntent.logicalOperationId') AS native_operation_id,
            json_extract(op.result_json, '$.followUpIntent.action') AS native_action, journal.state AS native_state
          FROM open_loop_operations op
          JOIN operation_journal journal ON journal.logical_operation_id = json_extract(op.result_json, '$.followUpIntent.logicalOperationId')
          WHERE op.state = 'applied' AND json_extract(op.result_json, '$.loop.loopId') = ?
            AND json_extract(op.result_json, '$.loop.revision') = ?
          ORDER BY op.created_at DESC LIMIT 1`).get(loop.loopId, loop.revision - 1);
        if (row.last_observed_revision && predecessorRow?.native_action === 'reschedule'
          && ['pending', 'unknown', 'not-applied'].includes(predecessorRow.native_state)) {
          return { ...base, action: plan.action === 'cancel' ? 'cancel-after-update' : 'reschedule-after-update',
            topicId: plan.topicId, ...(plan.declaration ? { declaration: plan.declaration } : {}),
            predecessor: { logicalOperationId: predecessorRow.native_operation_id,
              expectedConfigRevision: row.last_observed_revision } };
        }
      }
      if (['cancel', 'reschedule'].includes(plan.action) && !row?.last_observed_revision) {
        return { ...base, action: 'conflict', reason: 'scheduler-revision-unavailable' };
      }
      return { ...base, action: plan.action, ...(plan.topicId ? { topicId: plan.topicId } : {}),
        ...(plan.declaration ? { declaration: plan.declaration } : {}), ...(plan.reason ? { reason: plan.reason } : {}) };
    } catch {
      // A user decision must still commit when its existing native Reminder
      // binding is inconsistent; follow-up remains a visible conflict.
      return { ...base, action: 'conflict', reason: 'reminder-binding-conflict' };
    }
  }
  function supportingNoteTarget(db, operationKind, loop) {
    if (!loop || !(operationKind.startsWith('decision-') || operationKind === 'payment-status')) return undefined;
    const selected = selectSupportingNoteTarget({ loop,
      observations: loop.evidenceObservationIds.map(id => mapObservation(db.prepare('SELECT * FROM source_observations WHERE observation_id = ?').get(id))),
      getSourceReference: id => {
        const row = db.prepare('SELECT * FROM source_references WHERE reference_id = ?').get(id);
        return row && { referenceId: row.reference_id, topicId: row.topic_id, sourceSystem: row.source_system,
          sourceKind: row.source_kind, observedRevision: row.last_observed_revision };
      } });
    return selected.status === 'none' ? undefined : selected;
  }

  service.applyOpenLoopChange = input => {
    const value = closed(input, ['schemaVersion', 'logicalOperationId', 'operationKind', 'intent', 'expectedRevision', 'observation', 'loop', 'evidenceRoles', 'updatedAt']);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) fail('open-loop-intent-invalid');
    const logicalOperationId = text(value.logicalOperationId, 'logicalOperationId');
    const operationKind = text(value.operationKind, 'operationKind', 100);
    const observation = normalizeObservation(value.observation);
    const loop = value.loop === null ? null : normalizeLoop(value.loop);
    if (loop && loop.revision !== value.expectedRevision + 1) fail('open-loop-revision-invalid');
    const roles = value.evidenceRoles ?? {};
    if (!roles || typeof roles !== 'object' || Array.isArray(roles) || Object.values(roles).some(role => !evidenceRoles.has(role)) || loop && Object.keys(roles).some(id => !loop.evidenceObservationIds.includes(id))) fail('open-loop-intent-invalid');
    const intent = { schemaVersion: 1, logicalOperationId, operationKind, intent: canonical(value.intent) };
    const intentDigest = digest(intent);
    const updatedAt = now(value.updatedAt ?? observation.observedAt);
    return mutate(null, db => {
      const replay = operation(db, logicalOperationId, CHANGE_OPERATION, intentDigest);
      if (replay) return replay;
      const stored = storeObservation(db, observation);
      const changed = loop ? storeLoop(db, loop, value.expectedRevision, roles, updatedAt,
        operationKind.startsWith('decision-') || operationKind === 'payment-status' || operationKind === 'clarification-submit') : null;
      if (operationKind === 'clarification-submit' && changed?.loop.attention?.priorUserActionOperationId) {
        const predecessorId = changed.loop.attention.priorUserActionOperationId;
        const prior = db.prepare('SELECT result_json FROM open_loop_operations WHERE logical_operation_id = ? AND operation_kind = ? AND state = ?')
          .get(predecessorId, CHANGE_OPERATION, 'applied');
        if (prior) {
          const result = JSON.parse(prior.result_json);
          if (result.loop?.loopId === changed.loop.loopId && result.supportingNoteTarget?.status === 'ready'
            && result.supportingNoteOutcome?.status !== 'completed' && result.supportingNoteOutcome?.status !== 'conflict') {
            db.prepare('UPDATE open_loop_operations SET result_json = ? WHERE logical_operation_id = ? AND result_json = ?')
              .run(JSON.stringify({ ...result, supportingNoteOutcome: { schemaVersion: 1, status: 'conflict', reason: 'superseded-by-clarification' } }),
                predecessorId, prior.result_json);
          }
        }
      }
      const pendingFollowUp = followUpIntent(db, logicalOperationId, operationKind, changed?.loop);
      const noteTarget = supportingNoteTarget(db, operationKind, changed?.loop);
      return receipt(db, logicalOperationId, CHANGE_OPERATION, intentDigest, { schemaVersion: 1, disposition: stored.existing && !changed ? 'duplicate' : changed?.disposition ?? 'inserted', observation: stored.observation, loop: changed?.loop ?? null,
        ...(pendingFollowUp ? { followUpIntent: pendingFollowUp } : {}), ...(noteTarget ? { supportingNoteTarget: noteTarget } : {}) }, updatedAt);
    });
  };
  service.replayOpenLoopChange = input => {
    const value = closed(input, ['schemaVersion', 'logicalOperationId', 'operationKind', 'intent']);
    if (value.schemaVersion !== 1) fail('open-loop-intent-invalid');
    const logicalOperationId = text(value.logicalOperationId, 'logicalOperationId');
    const operationKind = text(value.operationKind, 'operationKind', 100);
    const intentDigest = digest({ schemaVersion: 1, logicalOperationId, operationKind, intent: canonical(value.intent) });
    return inspect(db => operation(db, logicalOperationId, CHANGE_OPERATION, intentDigest));
  };

  service.ingestOpenLoopObservation = input => {
    const value = closed(input, ['schemaVersion', 'logicalOperationId', 'observation']);
    if (value.schemaVersion !== 1) fail('open-loop-intent-invalid');
    const logicalOperationId = text(value.logicalOperationId, 'logicalOperationId');
    const observation = normalizeObservation(value.observation);
    const intent = { schemaVersion: 1, logicalOperationId, observation };
    const intentDigest = digest(intent);
    return mutate(null, db => {
      const replay = operation(db, logicalOperationId, OBSERVE_OPERATION, intentDigest);
      if (replay) return replay;
      const existingById = db.prepare('SELECT * FROM source_observations WHERE observation_id = ?').get(observation.observationId);
      const existingBySource = db.prepare('SELECT * FROM source_observations WHERE source_system = ? AND source_kind = ? AND external_source_id = ? AND source_version = ?').get(observation.source.system, observation.source.kind, observation.source.externalId, observation.source.version);
      const existing = existingById ?? existingBySource;
      if (existing && existing.observation_digest !== observation.digest) fail('open-loop-observation-conflict', 'An immutable source observation changed without a new source version.');
      if (existingById && existingBySource && existingById.observation_id !== existingBySource.observation_id) fail('open-loop-observation-conflict');
      if (observation.topicId && !db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(observation.topicId)) fail('open-loop-topic-missing');
      const createdAt = now(observation.observedAt);
      if (!existing) db.prepare(`INSERT INTO source_observations (observation_id, source_system, source_kind, external_source_id, source_version, observation_type, occurred_at, observed_at, historical_baseline, topic_id, entity_refs_json, facts_json, observation_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(observation.observationId, observation.source.system, observation.source.kind, observation.source.externalId, observation.source.version, observation.type, observation.occurredAt, observation.observedAt, observation.historicalBaseline ? 1 : 0, observation.topicId ?? null, JSON.stringify(observation.entityRefs), JSON.stringify(observation.facts), observation.digest, createdAt);
      const result = { schemaVersion: 1, disposition: existing ? 'duplicate' : 'inserted', observation: mapObservation(existing ?? db.prepare('SELECT * FROM source_observations WHERE observation_id = ?').get(observation.observationId)) };
      return receipt(db, logicalOperationId, OBSERVE_OPERATION, intentDigest, result, createdAt);
    });
  };

  service.reconcileOpenLoop = input => {
    const value = closed(input, ['schemaVersion', 'logicalOperationId', 'expectedRevision', 'loop', 'evidenceRoles', 'updatedAt']);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) fail('open-loop-intent-invalid');
    const logicalOperationId = text(value.logicalOperationId, 'logicalOperationId');
    const loop = normalizeLoop(value.loop);
    if (loop.revision !== value.expectedRevision + 1) fail('open-loop-revision-invalid', 'The next loop revision must be exactly one greater than expectedRevision.');
    const roles = value.evidenceRoles ?? {};
    if (!roles || typeof roles !== 'object' || Array.isArray(roles) || Object.keys(roles).some(id => !loop.evidenceObservationIds.includes(id)) || Object.values(roles).some(role => !evidenceRoles.has(role))) fail('open-loop-intent-invalid');
    const intent = { schemaVersion: 1, logicalOperationId, expectedRevision: value.expectedRevision, loop, evidenceRoles: canonical(roles) };
    const intentDigest = digest(intent);
    const updatedAt = now(value.updatedAt);
    return mutate(null, db => {
      const replay = operation(db, logicalOperationId, RECONCILE_OPERATION, intentDigest);
      if (replay) return replay;
      const changed = storeLoop(db, loop, value.expectedRevision, roles, updatedAt);
      const result = { schemaVersion: 1, disposition: changed.disposition, loop: changed.loop };
      return receipt(db, logicalOperationId, RECONCILE_OPERATION, intentDigest, result, updatedAt);
    });
  };

  service.getOpenLoopObservation = observationId => inspect(db => mapObservation(db.prepare('SELECT * FROM source_observations WHERE observation_id = ?').get(text(observationId, 'observationId'))));
  service.listOpenLoopObservations = () => inspect(db => db.prepare('SELECT * FROM source_observations ORDER BY observed_at, observation_id').all().map(mapObservation));
  service.listEntityCorrections = targetObservationId => inspect(db => {
    const rows = db.prepare("SELECT * FROM source_observations WHERE source_system = 'command-center' AND source_kind = 'entity-correction' AND json_extract(facts_json, '$.targetObservationId') = ? ORDER BY occurred_at, observation_id LIMIT 101").all(text(targetObservationId, 'targetObservationId'));
    if (rows.length > 100) fail('entity-correction-limit', 'The correction history exceeds the bounded review limit.');
    return rows.map(mapObservation);
  });
  service.getOpenLoop = loopId => inspect(db => mapLoop(db, db.prepare('SELECT * FROM open_loops WHERE loop_id = ?').get(text(loopId, 'loopId'))));
  service.previewOpenLoopSupportingNoteTarget = loopId => inspect(db => {
    const loop = mapLoop(db, db.prepare('SELECT * FROM open_loops WHERE loop_id = ?').get(text(loopId, 'loopId')));
    return loop ? supportingNoteTarget(db, 'payment-status', loop) ?? freeze({ schemaVersion: 1, status: 'none' }) : null;
  });
  // The decision owner commits this receipt with its loop revision. Enumerating
  // those receipts after a restart identifies decisions whose follow-up needs
  // inspection without accepting a stale earlier decision.
  service.listOpenLoopUserActionReceiptsPage = (input = {}) => {
    const value = closed(input, ['cursor', 'limit']);
    const limit = value.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('open-loop-intent-invalid');
    const cursor = value.cursor === undefined ? '' : text(value.cursor, 'cursor');
    return inspect(db => {
      const rows = db.prepare(`SELECT op.logical_operation_id, op.result_json, l.revision AS current_revision,
          json_extract(l.attention_json, '$.priorUserActionOperationId') = op.logical_operation_id
            AND json_type(l.attention_json, '$.pendingClarificationId') = 'text' AS recoverable
        FROM open_loop_operations op
        JOIN source_observations o ON o.source_system = 'command-center'
          AND o.source_kind IN ('user-decision', 'processor-interpretation') AND o.external_source_id = op.logical_operation_id
          AND o.observation_id = json_extract(op.result_json, '$.observation.observationId')
        LEFT JOIN open_loops l ON l.loop_id = json_extract(op.result_json, '$.loop.loopId')
        WHERE op.operation_kind = ? AND op.state = 'applied' AND op.logical_operation_id > ?
        ORDER BY op.logical_operation_id LIMIT ?`).all(CHANGE_OPERATION, cursor, limit + 1);
      const hasMore = rows.length > limit;
      const actions = rows.slice(0, limit).map(row => {
        let result;
        try { result = JSON.parse(row.result_json); } catch { fail('open-loop-receipt-invalid'); }
        if (!result?.loop?.loopId || !Number.isSafeInteger(result.loop.revision)) fail('open-loop-receipt-invalid');
        return { logicalOperationId: row.logical_operation_id, loop: result.loop,
          current: row.current_revision === result.loop.revision, recoverable: row.recoverable === 1 };
      });
      return freeze({ schemaVersion: 1, actions, hasMore, nextCursor: hasMore ? actions.at(-1).logicalOperationId : null });
    });
  };
  service.getOpenLoopUserActionReceipt = logicalOperationId => inspect(db => {
    const row = db.prepare(`SELECT op.result_json, l.revision AS current_revision,
        json_extract(l.attention_json, '$.priorUserActionOperationId') = op.logical_operation_id
          AND json_type(l.attention_json, '$.pendingClarificationId') = 'text' AS recoverable
      FROM open_loop_operations op
      JOIN source_observations o ON o.source_system = 'command-center'
        AND o.source_kind IN ('user-decision', 'processor-interpretation') AND o.external_source_id = op.logical_operation_id
        AND o.observation_id = json_extract(op.result_json, '$.observation.observationId')
      LEFT JOIN open_loops l ON l.loop_id = json_extract(op.result_json, '$.loop.loopId')
      WHERE op.logical_operation_id = ? AND op.operation_kind = ? AND op.state = 'applied'`).get(text(logicalOperationId, 'logicalOperationId'), CHANGE_OPERATION);
    if (!row) return null;
    let result;
    try { result = JSON.parse(row.result_json); } catch { fail('open-loop-receipt-invalid'); }
    if (!result?.loop?.loopId || !Number.isSafeInteger(result.loop.revision) || !result.observation?.facts?.actorId) fail('open-loop-receipt-invalid');
    return freeze({ schemaVersion: 1, logicalOperationId, loop: result.loop,
      ...(result.followUpIntent ? { followUpIntent: result.followUpIntent } : {}),
      ...(result.supportingNoteTarget ? { supportingNoteTarget: result.supportingNoteTarget } : {}),
      actorId: result.observation.facts.actorId, current: row.current_revision === result.loop.revision,
      recoverable: row.recoverable === 1 });
  });
  service.getCurrentOpenLoopUserActionReceipt = loopId => inspect(db => {
    const row = db.prepare(`SELECT op.logical_operation_id, op.result_json
      FROM open_loops l
      JOIN open_loop_operations op ON op.operation_kind = ? AND op.state = 'applied'
        AND json_extract(op.result_json, '$.loop.loopId') = l.loop_id
        AND json_extract(op.result_json, '$.loop.revision') = l.revision
      JOIN source_observations o ON o.source_system = 'command-center'
        AND o.source_kind IN ('user-decision', 'processor-interpretation') AND o.external_source_id = op.logical_operation_id
        AND o.observation_id = json_extract(op.result_json, '$.observation.observationId')
      WHERE l.loop_id = ? ORDER BY op.created_at DESC, op.logical_operation_id DESC LIMIT 1`).get(CHANGE_OPERATION, text(loopId, 'loopId'));
    if (!row) return null;
    let result;
    try { result = JSON.parse(row.result_json); } catch { fail('open-loop-receipt-invalid'); }
    if (!result?.loop?.loopId || !Number.isSafeInteger(result.loop.revision)) fail('open-loop-receipt-invalid');
    return freeze({ schemaVersion: 1, logicalOperationId: row.logical_operation_id, loop: result.loop,
      ...(result.followUpIntent ? { followUpIntent: result.followUpIntent } : {}),
      ...(result.supportingNoteTarget ? { supportingNoteTarget: result.supportingNoteTarget } : {}) });
  });
  service.getOpenLoopSupportingNoteIntent = decisionOperationId => inspect(db => {
    const row = db.prepare(`SELECT op.result_json, l.revision AS current_revision
      FROM open_loop_operations op
      JOIN source_observations o ON o.source_system = 'command-center'
        AND o.source_kind IN ('user-decision', 'processor-interpretation') AND o.external_source_id = op.logical_operation_id
        AND o.observation_id = json_extract(op.result_json, '$.observation.observationId')
      LEFT JOIN open_loops l ON l.loop_id = json_extract(op.result_json, '$.loop.loopId')
      WHERE op.logical_operation_id = ? AND op.operation_kind = ? AND op.state = 'applied'`).get(text(decisionOperationId, 'decisionOperationId'), CHANGE_OPERATION);
    if (!row) return null;
    let result;
    try { result = JSON.parse(row.result_json); } catch { fail('open-loop-receipt-invalid'); }
    if (!result?.loop?.loopId || !Number.isSafeInteger(result.loop.revision)) fail('open-loop-receipt-invalid');
    if (result.supportingNoteIntent) {
      const intent = result.supportingNoteIntent;
      if (intent.logicalOperationId !== supportingNoteOperationId(decisionOperationId)
        || JSON.stringify(canonical(intent.target)) !== JSON.stringify(canonical(result.supportingNoteTarget?.target))
        || !/^sha256:[a-f0-9]{64}$/u.test(intent.textDigest)
        || (typeof intent.text === 'string'
          ? `sha256:${createHash('sha256').update(intent.text).digest('hex')}` !== intent.textDigest
          : result.supportingNoteOutcome?.status !== 'completed')) fail('open-loop-receipt-invalid');
    }
    return freeze({ schemaVersion: 1, loopId: result.loop.loopId, loopRevision: result.loop.revision,
      current: row.current_revision === result.loop.revision,
      target: result.supportingNoteTarget ?? { schemaVersion: 1, status: 'none' },
      observation: result.observation,
      ...(result.supportingNoteOutcome ? { outcome: result.supportingNoteOutcome } : {}),
      ...(result.supportingNoteIntent ? { intent: result.supportingNoteIntent } : {}) });
  });
  service.prepareOpenLoopSupportingNoteIntent = input => {
    const value = closed(input, ['schemaVersion', 'decisionOperationId', 'expectedLoopRevision', 'target', 'text']);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.expectedLoopRevision) || value.expectedLoopRevision < 1
      || typeof value.text !== 'string' || !value.text.trim()) fail('open-loop-note-intent-invalid');
    const decisionOperationId = text(value.decisionOperationId, 'decisionOperationId');
    return mutate(null, db => {
      const row = db.prepare(`SELECT result_json FROM open_loop_operations
        WHERE logical_operation_id = ? AND operation_kind = ? AND state = 'applied'`).get(decisionOperationId, CHANGE_OPERATION);
      if (!row) fail('open-loop-decision-missing');
      let result;
      try { result = JSON.parse(row.result_json); } catch { fail('open-loop-receipt-invalid'); }
      if (!result?.observation?.facts?.actorId || result.observation.source?.externalId !== decisionOperationId
        || result.loop?.revision !== value.expectedLoopRevision || result.supportingNoteTarget?.status !== 'ready'
        || JSON.stringify(canonical(result.supportingNoteTarget.target)) !== JSON.stringify(canonical(value.target))) {
        fail('open-loop-note-intent-mismatch');
      }
      const current = db.prepare('SELECT revision FROM open_loops WHERE loop_id = ?').get(result.loop.loopId);
      if (current?.revision !== value.expectedLoopRevision) fail('open-loop-stale-revision');
      const prepared = { schemaVersion: 1, logicalOperationId: supportingNoteOperationId(decisionOperationId),
        target: result.supportingNoteTarget.target, text: value.text,
        textDigest: `sha256:${createHash('sha256').update(value.text).digest('hex')}` };
      if (result.supportingNoteIntent) {
        if (JSON.stringify(canonical(result.supportingNoteIntent)) !== JSON.stringify(canonical(prepared))) fail('open-loop-note-intent-mismatch');
        return freeze(result.supportingNoteIntent);
      }
      const updated = db.prepare('UPDATE open_loop_operations SET result_json = ? WHERE logical_operation_id = ? AND result_json = ?')
        .run(JSON.stringify({ ...result, supportingNoteIntent: prepared }), decisionOperationId, row.result_json);
      if (updated.changes !== 1) fail('open-loop-note-intent-conflict');
      return freeze(prepared);
    });
  };
  service.recordOpenLoopSupportingNoteOutcome = input => {
    const value = closed(input, ['schemaVersion', 'decisionOperationId', 'expectedLoopRevision', 'status', 'reason', 'observedRevision']);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.expectedLoopRevision)
      || !['completed', 'conflict', 'unknown', 'unavailable'].includes(value.status)
      || value.reason !== undefined && (typeof value.reason !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(value.reason))) {
      fail('open-loop-note-outcome-invalid');
    }
    const decisionOperationId = text(value.decisionOperationId, 'decisionOperationId');
    return mutate(null, db => {
      const row = db.prepare(`SELECT result_json FROM open_loop_operations
        WHERE logical_operation_id = ? AND operation_kind = ? AND state = 'applied'`).get(decisionOperationId, CHANGE_OPERATION);
      if (!row) fail('open-loop-decision-missing');
      let result;
      try { result = JSON.parse(row.result_json); } catch { fail('open-loop-receipt-invalid'); }
      if (result.loop?.revision !== value.expectedLoopRevision || result.supportingNoteTarget?.status !== 'ready') fail('open-loop-note-outcome-invalid');
      const current = db.prepare('SELECT revision FROM open_loops WHERE loop_id = ?').get(result.loop.loopId);
      if (current?.revision !== value.expectedLoopRevision) fail('open-loop-stale-revision');
      if (value.status === 'completed' && !result.supportingNoteIntent) fail('open-loop-note-outcome-invalid');
      if (value.status === 'completed') {
        const effect = db.prepare('SELECT operation_kind, state, observed_revision FROM operation_journal WHERE logical_operation_id = ?')
          .get(result.supportingNoteIntent.logicalOperationId);
        if (effect?.operation_kind !== 'notes.edit' || effect.state !== 'applied'
          || !effect.observed_revision || effect.observed_revision !== value.observedRevision) fail('open-loop-note-outcome-invalid');
      }
      const outcome = { schemaVersion: 1, status: value.status,
        ...(value.reason ? { reason: value.reason } : {}),
        ...(value.observedRevision ? { observedRevision: text(value.observedRevision, 'observedRevision', 300) } : {}) };
      if (result.supportingNoteOutcome?.status === 'completed') {
        if (JSON.stringify(canonical(result.supportingNoteOutcome)) !== JSON.stringify(canonical(outcome))) fail('open-loop-note-outcome-conflict');
        return freeze(result.supportingNoteOutcome);
      }
      if (JSON.stringify(canonical(result.supportingNoteOutcome)) === JSON.stringify(canonical(outcome))) return freeze(outcome);
      const retainedIntent = value.status === 'completed'
        ? { ...result.supportingNoteIntent, text: undefined }
        : result.supportingNoteIntent;
      const updated = db.prepare('UPDATE open_loop_operations SET result_json = ? WHERE logical_operation_id = ? AND result_json = ?')
        .run(JSON.stringify({ ...result, supportingNoteIntent: retainedIntent, supportingNoteOutcome: outcome }), decisionOperationId, row.result_json);
      if (updated.changes !== 1) fail('open-loop-note-outcome-conflict');
      return freeze(outcome);
    });
  };
  service.findOpenLoopBySubject = (kind, stableSubjectId) => inspect(db => mapLoop(db, db.prepare('SELECT * FROM open_loops WHERE loop_kind = ? AND stable_subject_id = ?').get(text(kind, 'kind', 80), text(stableSubjectId, 'stableSubjectId', 500))));
  service.findCommitmentLoopsByLegacyObligation = (topicId, obligationId) => inspect(db => {
    const rows = db.prepare(`SELECT DISTINCT l.* FROM source_observations o
      JOIN open_loop_evidence e ON e.observation_id = o.observation_id
      JOIN open_loops l ON l.loop_id = e.loop_id
      WHERE l.loop_kind = 'general' AND l.topic_id = ? AND o.source_system = 'command-center-capture'
        AND json_extract(o.facts_json, '$.obligationId') = ?
      ORDER BY l.loop_id LIMIT 3`).all(text(topicId, 'topicId'), text(obligationId, 'obligationId'));
    return rows.map(row => mapLoop(db, row));
  });
  service.findOpenLoopsBySource = (system, kind, externalId, limit = 2) => {
    const boundedLimit = Number(limit);
    if (!Number.isSafeInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 10) fail('open-loop-intent-invalid');
    return inspect(db => db.prepare(`SELECT DISTINCT l.* FROM source_observations o
      JOIN open_loop_evidence e ON e.observation_id = o.observation_id
      JOIN open_loops l ON l.loop_id = e.loop_id
      WHERE o.source_system = ? AND o.source_kind = ? AND o.external_source_id = ?
      ORDER BY l.loop_id LIMIT ?`).all(text(system, 'source.system', 80), text(kind, 'source.kind', 80), text(externalId, 'source.externalId', 500), boundedLimit).map(row => mapLoop(db, row)));
  };
  service.listOpenLoops = () => inspect(db => db.prepare('SELECT * FROM open_loops ORDER BY updated_at, loop_id').all().map(row => mapLoop(db, row)));
  service.listOpenLoopsPage = ({ offset = 0, limit = 50, cursor } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor !== undefined && (typeof cursor !== 'string' || cursor.trim() === '')) fail('open-loop-intent-invalid');
    return inspect(db => {
      const total = db.prepare('SELECT COUNT(*) AS total FROM open_loops').get().total;
      const rows = cursor === undefined
        ? db.prepare('SELECT * FROM open_loops ORDER BY loop_id LIMIT ? OFFSET ?').all(limit + 1, offset)
        : db.prepare('SELECT * FROM open_loops WHERE loop_id > ? ORDER BY loop_id LIMIT ?').all(cursor, limit + 1);
      const hasMore = rows.length > limit;
      const loops = rows.slice(0, limit).map(row => mapLoop(db, row));
      return freeze({ schemaVersion: 1, loops, total, offset, nextOffset: hasMore ? offset + loops.length : null, nextCursor: hasMore ? loops.at(-1).loopId : null, hasMore });
    });
  };
  service.getQuietAttentionInbox = options => projectQuietInbox(service.listOpenLoops(), options);
}

export { OBSERVE_OPERATION, RECONCILE_OPERATION };
