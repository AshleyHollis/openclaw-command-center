import { planMessageIntake } from '../open-loops/message-intake.mjs';

export function installMessageIntake(service, { ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  const merge = (existing, candidate, historicalBaseline, disposition) => {
    const evidenceObservationIds = [...new Set([...existing.evidenceObservationIds, ...candidate.evidenceObservationIds])];
    const incomingCurrent = !historicalBaseline;
    const paymentConflict = incomingCurrent && existing.kind === 'payment' && (
      existing.state === 'resolved' && ['confirmed-obligation', 'source-reminder'].includes(disposition)
      || disposition === 'source-reminder' && candidate.amount !== undefined && existing.amount !== undefined && (candidate.amount !== existing.amount || candidate.currency !== existing.currency)
      || disposition === 'source-reminder' && candidate.dueAt !== undefined && existing.dueAt !== undefined && candidate.dueAt !== existing.dueAt
    );
    if (historicalBaseline) return { ...existing, evidenceObservationIds, revision: existing.revision + 1 };
    if (paymentConflict) return {
      ...existing,
      state: 'uncertain',
      paymentState: 'uncertain',
      attention: {
        reason: 'evidence-conflict',
        whyNow: 'Current source evidence conflicts with the recorded payment obligation.',
        actions: ['Open bill', 'Review payment evidence', 'Keep recorded outcome'],
        activated: true,
        currentEvidence: true
      },
      evidenceObservationIds,
      revision: existing.revision + 1
    };
    if (existing.state === 'suggested' && candidate.state === 'confirmed') return { ...candidate, loopId: existing.loopId, evidenceObservationIds, revision: existing.revision + 1 };
    const materialChange = incomingCurrent && candidate.state === 'confirmed' && (
      candidate.amount !== existing.amount || candidate.currency !== existing.currency || candidate.dueAt !== existing.dueAt
    );
    return {
      ...existing,
      ...(materialChange ? {
        amount: candidate.amount,
        currency: candidate.currency,
        dueAt: candidate.dueAt,
        attention: {
          reason: 'material-change',
          whyNow: 'Current source evidence materially changed this open loop.',
          actions: candidate.attention?.actions ?? existing.attention?.actions ?? ['Open original', 'Review change'],
          activated: true,
          currentEvidence: true
        }
      } : {}),
      evidenceObservationIds,
      revision: existing.revision + 1
    };
  };

  service.ingestIncomingMessage = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['schemaVersion', 'logicalOperationId', 'message'].includes(key)) || input.schemaVersion !== 1 || typeof input.logicalOperationId !== 'string' || input.logicalOperationId.trim() === '' || input.logicalOperationId.length > 300) fail('message-intake-invalid');
    const rootId = input.logicalOperationId.trim();
    const plan = planMessageIntake(input.message);
    const { digest: _observationDigest, ...observation } = plan.observation;
    const operationKind = 'message-intake';
    const replay = service.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: rootId, operationKind, intent: input.message });
    if (replay) return Object.freeze({ ...replay, disposition: 'duplicate' });
    if (!plan.loop) {
      const changed = service.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: rootId, operationKind, intent: input.message, expectedRevision: 0, observation, loop: null, updatedAt: plan.observation.observedAt });
      return Object.freeze({ schemaVersion: 1, disposition: 'informational', observation: changed.observation, loop: null });
    }
    const existing = service.findOpenLoopBySubject(plan.loop.kind, plan.loop.stableSubjectId);
    const loop = existing ? merge(existing, plan.loop, plan.observation.historicalBaseline, input.message.disposition) : plan.loop;
    const newObservationId = plan.observation.observationId;
    const conflict = loop.attention?.reason === 'evidence-conflict';
    const result = service.applyOpenLoopChange({
      schemaVersion: 1,
      logicalOperationId: rootId,
      operationKind,
      intent: input.message,
      expectedRevision: existing?.revision ?? 0,
      observation,
      loop,
      evidenceRoles: { [newObservationId]: conflict ? 'conflict' : existing ? 'update' : 'origin' },
      updatedAt: plan.observation.observedAt
    });
    return Object.freeze({ schemaVersion: 1, disposition: result.disposition, observation: result.observation, loop: result.loop });
  };
}
