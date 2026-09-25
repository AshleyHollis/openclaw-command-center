import { createHash } from 'node:crypto';
import { parseClarificationProposal } from '../open-loops/clarification-proposal.mjs';

export const CLARIFICATION_PROPOSAL_OPERATION = 'open-loop.clarification-proposal.v1';
export const CLARIFICATION_WORKER_DISPOSITION_OPERATION = 'open-loop.clarification-worker-disposition.v1';

export function clarificationProposalOperationId(clarificationObservationId) {
  if (typeof clarificationObservationId !== 'string' || !clarificationObservationId.trim()) throw new TypeError('An exact clarification is required.');
  return `clarification-proposal:${createHash('sha256').update(clarificationObservationId).digest('hex')}`;
}

function dispositionId(clarificationObservationId) {
  return `clarification-disposition:${createHash('sha256').update(clarificationObservationId).digest('hex')}`;
}

export function installClarificationProposalMetadata(service, { mutate, inspect, ErrorType }) {
  const fail = (code, message) => { throw new ErrorType(code, message); };
  const decode = row => {
    if (!row) return null;
    let accepted;
    try { accepted = JSON.parse(row.result_identity); } catch { fail('clarification-proposal-corrupt', 'The accepted clarification proposal is unreadable.'); }
    if (accepted?.schemaVersion !== 1 || accepted.clarificationObservationId !== row.observed_revision)
      fail('clarification-proposal-corrupt', 'The accepted clarification identity differs.');
    return Object.freeze(accepted);
  };
  service.getClarificationProposal = clarificationObservationId => {
    const id = clarificationProposalOperationId(clarificationObservationId);
    return inspect(db => decode(db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ? AND operation_kind = ? AND state = ?')
      .get(id, CLARIFICATION_PROPOSAL_OPERATION, 'applied')));
  };
  service.getClarificationWorkerDisposition = clarificationObservationId => inspect(db => {
    const row = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ? AND operation_kind = ? AND state = ?')
      .get(dispositionId(clarificationObservationId), CLARIFICATION_WORKER_DISPOSITION_OPERATION, 'applied');
    if (!row) return null;
    let value;
    try { value = JSON.parse(row.result_identity); } catch { fail('clarification-disposition-corrupt', 'The saved worker disposition is unreadable.'); }
    if (value?.schemaVersion !== 1 || value.clarificationObservationId !== clarificationObservationId
      || !['review-required', 'failed', 'recovered'].includes(value.status))
      fail('clarification-disposition-corrupt', 'The saved worker disposition identity differs.');
    return Object.freeze(value);
  });
  service.recordClarificationWorkerDisposition = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['loopId', 'clarificationObservationId', 'status', 'code', 'updatedAt'].includes(key))
      || typeof input.loopId !== 'string' || !input.loopId.trim()
      || typeof input.clarificationObservationId !== 'string' || !input.clarificationObservationId.trim()
      || !['review-required', 'failed', 'recovered'].includes(input.status)
      || input.code !== undefined && (typeof input.code !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(input.code))
      || typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt)))
      fail('clarification-disposition-invalid', 'The worker disposition needs a linked clarification and bounded outcome.');
    const id = dispositionId(input.clarificationObservationId);
    const identity = JSON.stringify({ schemaVersion: 1, loopId: input.loopId,
      clarificationObservationId: input.clarificationObservationId, status: input.status,
      ...(input.code ? { code: input.code } : {}), updatedAt: input.updatedAt });
    const digest = createHash('sha256').update(`${input.loopId}\0${input.clarificationObservationId}`).digest('hex');
    return mutate(null, db => {
      const evidence = db.prepare(`SELECT 1 FROM open_loop_evidence e JOIN source_observations o ON o.observation_id = e.observation_id
        WHERE e.loop_id = ? AND o.observation_id = ? AND o.source_system = 'command-center'
          AND o.source_kind = 'user-clarification' AND json_extract(o.facts_json, '$.eventKind') = 'clarification-submitted'`)
        .get(input.loopId, input.clarificationObservationId);
      if (!evidence) fail('clarification-disposition-superseded', 'The saved clarification evidence is unavailable.');
      const prior = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(id);
      if (prior && (prior.operation_kind !== CLARIFICATION_WORKER_DISPOSITION_OPERATION || prior.intent_digest !== digest))
        fail('clarification-disposition-conflict', 'A different clarification owns this worker disposition.');
      if (prior && prior.updated_at > input.updatedAt) return Object.freeze({ disposition: 'stale' });
      if (prior?.result_status === 'recovered' && input.status !== 'recovered') return Object.freeze({ disposition: 'duplicate' });
      db.prepare(`INSERT INTO operation_journal
        (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?)
        ON CONFLICT(logical_operation_id) DO UPDATE SET result_status = excluded.result_status,
          result_identity = excluded.result_identity, updated_at = excluded.updated_at`).run(id, id, digest,
        CLARIFICATION_WORKER_DISPOSITION_OPERATION, input.status, identity, input.clarificationObservationId,
        prior?.created_at ?? input.updatedAt, input.updatedAt);
      return Object.freeze({ disposition: prior ? 'updated' : 'recorded' });
    });
  };
  service.recordClarificationProposal = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['loopId', 'expectedRevision', 'clarificationObservationId', 'processorVersion', 'source', 'outcomeId', 'proposal', 'model', 'createdAt'].includes(key)))
      fail('clarification-proposal-invalid', 'The proposal record has unsupported fields.');
    const { loopId, expectedRevision, clarificationObservationId, processorVersion, source, outcomeId, proposal, model, createdAt } = input;
    if (typeof loopId !== 'string' || !loopId.trim() || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
      || typeof clarificationObservationId !== 'string' || !clarificationObservationId.trim()
      || typeof processorVersion !== 'string' || !processorVersion.trim()
      || !source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).sort().join(',') !== 'sourceExternalId,sourceKind,sourceVersion'
      || !['email', 'chat', 'note'].includes(source.sourceKind)
      || [source.sourceExternalId, source.sourceVersion, outcomeId, model].some(item => typeof item !== 'string' || !item.trim())
      || !proposal || typeof proposal !== 'object' || Array.isArray(proposal)
      || !['clear', 'ambiguous'].includes(proposal.outcome)
      || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)))
      fail('clarification-proposal-invalid', 'The proposal record needs exact accepted identities.');
    const id = clarificationProposalOperationId(clarificationObservationId);
    return mutate(null, db => {
      const evidence = db.prepare(`SELECT o.facts_json FROM open_loop_evidence e JOIN source_observations o ON o.observation_id = e.observation_id
        WHERE e.loop_id = ? AND o.observation_id = ? AND o.source_system = 'command-center' AND o.source_kind = 'user-clarification'
          AND json_extract(o.facts_json, '$.eventKind') = 'clarification-submitted'`).get(loopId, clarificationObservationId);
      if (!evidence) fail('clarification-proposal-superseded', 'The saved clarification evidence is unavailable.');
      const words = JSON.parse(evidence.facts_json).rationale;
      const validatedProposal = parseClarificationProposal(JSON.stringify(proposal), words);
      const accepted = { schemaVersion: 1, loopId, expectedRevision, clarificationObservationId, processorVersion,
        source: { sourceKind: source.sourceKind, sourceExternalId: source.sourceExternalId, sourceVersion: source.sourceVersion },
        outcomeId, proposal: validatedProposal, model, createdAt };
      const serialized = JSON.stringify(accepted);
      const digest = createHash('sha256').update(serialized).digest('hex');
      const existing = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(id);
      if (existing) {
        if (existing.operation_kind !== CLARIFICATION_PROPOSAL_OPERATION || existing.intent_digest !== digest)
          fail('clarification-proposal-conflict', 'A different proposal already owns this saved clarification.');
        return Object.freeze({ disposition: 'duplicate', accepted: decode(existing) });
      }
      const loop = db.prepare('SELECT revision, attention_json FROM open_loops WHERE loop_id = ?').get(loopId);
      if (loop?.revision !== expectedRevision || JSON.parse(loop.attention_json).pendingClarificationId !== clarificationObservationId)
        fail('clarification-proposal-superseded', 'The saved clarification is no longer pending at that revision.');
      db.prepare(`INSERT INTO operation_journal
        (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?)`).run(id, id, digest, CLARIFICATION_PROPOSAL_OPERATION,
        proposal.outcome, serialized, clarificationObservationId, createdAt, createdAt);
      return Object.freeze({ disposition: 'recorded', accepted: Object.freeze(accepted) });
    });
  };
}
