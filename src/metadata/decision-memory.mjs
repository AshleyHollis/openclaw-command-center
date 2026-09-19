import { createHash } from 'node:crypto';
import { planDecisionChallenge, planDecisionRecord } from '../open-loops/decision-memory.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export function installDecisionMemory(service, { ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  const input = (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['schemaVersion', 'logicalOperationId', 'expectedRevision', field].includes(key)) || value.schemaVersion !== 1 || typeof value.logicalOperationId !== 'string' || value.logicalOperationId.trim() === '' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) fail('decision-memory-invalid');
    return value;
  };
  const planned = (planner, value) => { try { return planner(value); } catch (error) { fail('decision-memory-invalid', error.message); } };
  const ids = (prefix, logicalOperationId) => {
    const digest = hash(logicalOperationId.trim()).slice(0, 40);
    return { observe: `${prefix}:observe:${digest}`, reconcile: `${prefix}:reconcile:${digest}` };
  };

  service.recordDecisionMemory = raw => {
    const value = input(raw, 'decision');
    const plan = planned(planDecisionRecord, value.decision);
    const existing = service.findOpenLoopBySubject('decision', `decision:${plan.decisionId}`);
    if (existing?.evidenceObservationIds.includes(plan.observation.observationId) && service.getOpenLoopObservation(plan.observation.observationId)) return Object.freeze({ schemaVersion: 1, disposition: 'duplicate', observation: service.getOpenLoopObservation(plan.observation.observationId), decision: service.getDecisionMemory(plan.decisionId) });
    if ((existing?.revision ?? 0) !== value.expectedRevision) fail('open-loop-stale-revision');
    for (const observationId of plan.sourceObservationIds) if (!service.getOpenLoopObservation(observationId)) fail('decision-memory-source-missing');
    const operation = ids('decision-memory', value.logicalOperationId);
    const observed = service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: operation.observe, observation: plan.observation });
    const evidenceObservationIds = [...new Set([...(existing?.evidenceObservationIds ?? []), ...plan.sourceObservationIds, plan.observation.observationId])];
    const next = { ...plan.loop, loopId: existing?.loopId ?? plan.loop.loopId, evidenceObservationIds, revision: value.expectedRevision + 1 };
    const reconciled = service.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: operation.reconcile, expectedRevision: value.expectedRevision, loop: next, evidenceRoles: Object.fromEntries(evidenceObservationIds.filter(id => !(existing?.evidenceObservationIds ?? []).includes(id)).map(id => [id, id === plan.observation.observationId ? 'resolution' : 'update'])), updatedAt: plan.observation.observedAt });
    return Object.freeze({ schemaVersion: 1, disposition: 'applied', observation: observed.observation, decision: Object.freeze({ loop: reconciled.loop, evidence: reconciled.loop.evidenceObservationIds.map(id => service.getOpenLoopObservation(id)) }) });
  };

  service.challengeDecisionMemory = raw => {
    const value = input(raw, 'challenge');
    const plan = planned(planDecisionChallenge, value.challenge);
    const loop = service.findOpenLoopBySubject('decision', `decision:${plan.decisionId}`);
    if (!loop) fail('decision-memory-missing');
    if (loop.evidenceObservationIds.includes(plan.observation.observationId) && service.getOpenLoopObservation(plan.observation.observationId)) return Object.freeze({ schemaVersion: 1, disposition: 'duplicate', observation: service.getOpenLoopObservation(plan.observation.observationId), decision: service.getDecisionMemory(plan.decisionId) });
    if (loop.revision !== value.expectedRevision) fail('open-loop-stale-revision');
    const operation = ids('decision-challenge', value.logicalOperationId);
    const observed = service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: operation.observe, observation: plan.observation });
    const actionable = plan.observation.historicalBaseline !== true && plan.observation.facts.material === true && plan.observation.facts.assessment === 'contradicted';
    const ambiguous = plan.observation.historicalBaseline !== true && plan.observation.facts.assessment === 'ambiguous';
    const next = {
      ...loop,
      state: actionable ? 'decision-needed' : ambiguous ? 'uncertain' : loop.state,
      attention: actionable ? { reason: 'material-change', whyNow: 'New evidence contradicts a stated assumption; the existing decision remains unchanged until explicitly revised.', actions: ['Open decision', 'Review evidence', 'Record revised decision'], materialRevision: `${plan.observation.source.externalId}:${plan.observation.source.version}`, activated: true, currentEvidence: true } : ambiguous ? { actions: ['Open decision', 'Review evidence'], activated: false, currentEvidence: true } : loop.attention,
      evidenceObservationIds: [...loop.evidenceObservationIds, plan.observation.observationId],
      revision: loop.revision + 1
    };
    const reconciled = service.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: operation.reconcile, expectedRevision: loop.revision, loop: next, evidenceRoles: { [plan.observation.observationId]: actionable || ambiguous ? 'conflict' : 'update' }, updatedAt: plan.observation.observedAt });
    return Object.freeze({ schemaVersion: 1, disposition: 'applied', observation: observed.observation, decision: Object.freeze({ loop: reconciled.loop, evidence: reconciled.loop.evidenceObservationIds.map(id => service.getOpenLoopObservation(id)) }) });
  };

  service.getDecisionMemory = decisionId => {
    if (typeof decisionId !== 'string' || decisionId.trim() === '') fail('decision-memory-invalid');
    const loop = service.findOpenLoopBySubject('decision', `decision:${decisionId.trim()}`);
    return loop ? Object.freeze({ loop, evidence: Object.freeze(loop.evidenceObservationIds.map(id => service.getOpenLoopObservation(id))) }) : null;
  };
  service.listDecisionMemories = () => Object.freeze(service.listOpenLoops().filter(loop => loop.kind === 'decision' && loop.stableSubjectId.startsWith('decision:')).map(loop => service.getDecisionMemory(loop.stableSubjectId.slice('decision:'.length))));
}
