import { isDeepStrictEqual } from 'node:util';
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
  for (const method of ['applyOpenLoopChange', 'replayOpenLoopChange', 'findOpenLoopBySubject', 'findOpenLoopsBySource', 'getOpenLoopObservation']) {
    if (typeof service?.[method] !== 'function') fail('selected-source-owner-missing', `Selected-source intake requires the existing ${method} owner method.`);
  }

  function loopForUnavailableSource(plan) {
    const source = plan.observation.source;
    const matches = service.findOpenLoopsBySource(source.system, source.kind, source.externalId, 2);
    return matches.length === 1 ? matches[0] : null;
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

  const sameImmutableSourceFact = (existing, candidate) => existing
    && isDeepStrictEqual(existing.source, candidate.source)
    && existing.type === candidate.type
    && existing.occurredAt === candidate.occurredAt
    && existing.topicId === candidate.topicId
    && isDeepStrictEqual(existing.entityRefs, candidate.entityRefs)
    && isDeepStrictEqual(existing.facts, candidate.facts);

  const prepareSelectedSourceBatch = input => {
    let planned;
    try { planned = planSelectedSourceBatch(input); } catch (error) { fail('selected-source-intake-invalid', error.message); }
    return freeze({
      schemaVersion: 1,
      batch: {
        schemaVersion: 1,
        logicalOperationId: planned.batch.logicalOperationId,
        authorization: planned.batch.authorization,
        baselineThrough: planned.batch.baselineThrough,
        window: planned.batch.window
      },
      checkpoint: planned.checkpoint,
      plans: planned.plans.map(plan => {
        const { content: _content, ...selection } = plan.selection;
        return { schemaVersion: 1, selection, observation: plan.observation, loop: plan.loop, freshness: plan.freshness };
      })
    });
  };

  const applyPreparedSelectedSourceBatch = planned => {
    if (planned?.schemaVersion !== 1 || planned?.batch?.schemaVersion !== 1 || !Array.isArray(planned.plans) || !planned.plans.length || !planned.checkpoint) fail('selected-source-intake-invalid', 'Prepared selected-source intake is invalid.');
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
      const priorObservation = service.getOpenLoopObservation(plan.observation.observationId);
      if (sameImmutableSourceFact(priorObservation, plan.observation)) {
        const linkedLoop = plan.loop
          ? service.findOpenLoopBySubject(plan.loop.kind, plan.loop.stableSubjectId)
          : loopForUnavailableSource(plan);
        const { digest: _digest, ...observation } = priorObservation;
        const recorded = service.applyOpenLoopChange({
          schemaVersion: 1,
          logicalOperationId: rootId,
          operationKind: 'selected-source-intake',
          intent,
          expectedRevision: 0,
          observation,
          loop: null,
          updatedAt: plan.observation.observedAt
        });
        results.push(freeze({ ...recorded, disposition: 'duplicate', observation: priorObservation, loop: linkedLoop ?? null, freshness: plan.freshness }));
        continue;
      }
      const { digest: _digest, ...observation } = plan.observation;
      let loop = null;
      let existing = null;
      if (plan.loop) {
        existing = service.findOpenLoopBySubject(plan.loop.kind, plan.loop.stableSubjectId);
        loop = existing ? merge(existing, plan.loop, plan) : plan.loop;
      } else if (plan.freshness.status === 'unavailable') {
        existing = loopForUnavailableSource(plan);
        if (existing?.evidenceObservationIds.includes(plan.observation.observationId)) existing = null;
        else if (existing) loop = { ...existing, evidenceObservationIds: [...new Set([...existing.evidenceObservationIds, plan.observation.observationId])], revision: existing.revision + 1 };
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

  const ingestSelectedSourceBatch = input => applyPreparedSelectedSourceBatch(prepareSelectedSourceBatch(input));

  return freeze({ prepareSelectedSourceBatch, applyPreparedSelectedSourceBatch, ingestSelectedSourceBatch });
}

export function installSelectedSourceIntake(service, options) {
  const intake = createSelectedSourceIntake(service, options);
  if (!Object.isExtensible(service)) throw new TypeError('Selected-source intake must be installed before the metadata service is frozen.');
  service.prepareSelectedSourceBatch = intake.prepareSelectedSourceBatch;
  service.applyPreparedSelectedSourceBatch = intake.applyPreparedSelectedSourceBatch;
  service.ingestSelectedSourceBatch = intake.ingestSelectedSourceBatch;
  return service;
}
