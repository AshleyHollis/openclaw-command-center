import { createHash } from 'node:crypto';
import { parseClarificationProposal } from '../open-loops/clarification-proposal.mjs';

export const CLARIFICATION_PROPOSAL_OPERATION = 'open-loop.clarification-proposal.v1';

export function clarificationProposalOperationId(clarificationObservationId) {
  if (typeof clarificationObservationId !== 'string' || !clarificationObservationId.trim()) throw new TypeError('An exact clarification is required.');
  return `clarification-proposal:${createHash('sha256').update(clarificationObservationId).digest('hex')}`;
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
