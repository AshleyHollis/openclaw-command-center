import { planSelectedSourceBatch } from '../open-loops/selected-source-intake.mjs';

const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export function createSelectedSourceIntake(service, { ErrorType = TypeError } = {}) {
  const fail = (code, message = code) => {
    if (ErrorType === TypeError) throw new TypeError(message);
    throw new ErrorType(code, message);
  };
  for (const method of ['applyOpenLoopChange', 'replayOpenLoopChange', 'findOpenLoopBySubject']) {
    if (typeof service?.[method] !== 'function') fail('selected-source-owner-missing', `Selected-source intake requires the existing ${method} owner method.`);
  }

  function merge(existing, candidate, plan) {
    const evidenceObservationIds = [...new Set([...existing.evidenceObservationIds, ...candidate.evidenceObservationIds])];
    if (plan.observation.historicalBaseline) return { ...existing, evidenceObservationIds, revision: existing.revision + 1 };
    if (existing.kind === 'payment' && existing.state === 'resolved') return {
      ...existing,
      state: 'uncertain',
      paymentState: 'uncertain',
      attention: {
        reason: 'evidence-conflict',
        whyNow: 'Current selected-source evidence conflicts with the recorded payment outcome.',
        actions: ['Open original', 'Review payment evidence', 'Keep recorded outcome'],
        activated: true,
        currentEvidence: true
      },
      evidenceObservationIds,
      revision: existing.revision + 1
    };
    if (existing.state === 'suggested') return { ...candidate, loopId: existing.loopId, evidenceObservationIds, revision: existing.revision + 1 };
    const materialChange = candidate.amount !== existing.amount || candidate.currency !== existing.currency || candidate.dueAt !== existing.dueAt;
    return {
      ...existing,
      ...(materialChange ? {
        amount: candidate.amount,
        currency: candidate.currency,
        dueAt: candidate.dueAt,
        attention: {
          reason: 'material-change',
          whyNow: 'A newer selected source version materially changed this payment obligation.',
          actions: candidate.attention?.actions ?? existing.attention?.actions ?? ['Open original', 'Review change'],
          activated: true,
          currentEvidence: true
        }
      } : {}),
      evidenceObservationIds,
      revision: existing.revision + 1
    };
  }

  const ingestSelectedSourceBatch = input => {
    let planned;
    try { planned = planSelectedSourceBatch(input); } catch (error) { fail('selected-source-intake-invalid', error.message); }
    const results = [];
    for (const [index, plan] of planned.plans.entries()) {
      const rootId = `${planned.batch.logicalOperationId}:${index}:${plan.observation.observationId}`;
      const intent = {
        schemaVersion: 1,
        authorization: planned.batch.authorization,
        baselineThrough: planned.batch.baselineThrough,
        selection: plan.selection
      };
      const replay = service.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: rootId, operationKind: 'selected-source-intake', intent });
      if (replay) {
        results.push(freeze({ ...replay, disposition: 'duplicate', freshness: plan.freshness }));
        continue;
      }
      const { digest: _digest, ...observation } = plan.observation;
      let loop = null;
      let existing = null;
      if (plan.loop) {
        existing = service.findOpenLoopBySubject(plan.loop.kind, plan.loop.stableSubjectId);
        loop = existing ? merge(existing, plan.loop, plan) : plan.loop;
      }
      const changed = service.applyOpenLoopChange({
        schemaVersion: 1,
        logicalOperationId: rootId,
        operationKind: 'selected-source-intake',
        intent,
        expectedRevision: existing?.revision ?? 0,
        observation,
        loop,
        ...(loop ? { evidenceRoles: { [plan.observation.observationId]: existing ? 'update' : 'origin' } } : {}),
        updatedAt: plan.observation.observedAt
      });
      results.push(freeze({ ...changed, freshness: plan.freshness }));
    }
    return freeze({
      schemaVersion: 1,
      disposition: results.every(result => result.disposition === 'duplicate') ? 'duplicate' : 'applied',
      results,
      checkpoint: planned.checkpoint,
      freshness: {
        status: planned.checkpoint.freshness,
        lastObservedAt: planned.checkpoint.lastObservedAt,
        ...(planned.checkpoint.lastAvailableAt ? { lastAvailableAt: planned.checkpoint.lastAvailableAt } : {})
      },
      hasMore: planned.batch.window.hasMore
    });
  };

  return freeze({ ingestSelectedSourceBatch });
}

export function installSelectedSourceIntake(service, options) {
  const intake = createSelectedSourceIntake(service, options);
  if (!Object.isExtensible(service)) throw new TypeError('Selected-source intake must be installed before the metadata service is frozen.');
  service.ingestSelectedSourceBatch = intake.ingestSelectedSourceBatch;
  return service;
}
