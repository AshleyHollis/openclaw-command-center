import { planDecisionChallenge, planDecisionRecord } from '../open-loops/decision-memory.mjs';

export function installDecisionMemory(service, { ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  const input = (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['schemaVersion', 'logicalOperationId', 'expectedRevision', field].includes(key)) || value.schemaVersion !== 1 || typeof value.logicalOperationId !== 'string' || value.logicalOperationId.trim() === '' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) fail('decision-memory-invalid');
    return value;
  };
  const planned = (planner, value) => { try { return planner(value); } catch (error) { fail('decision-memory-invalid', error.message); } };

  service.recordDecisionMemory = raw => {
    const value = input(raw, 'decision');
    const plan = planned(planDecisionRecord, value.decision);
    const operationKind = 'decision-memory';
    const replay = service.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: value.logicalOperationId, operationKind, intent: value });
    if (replay) return Object.freeze({ schemaVersion: 1, disposition: 'duplicate', observation: replay.observation, decision: Object.freeze({ loop: replay.loop, evidence: Object.freeze(replay.loop.evidenceObservationIds.map(id => service.getOpenLoopObservation(id))) }) });
    const existing = service.findOpenLoopBySubject('decision', `decision:${plan.decisionId}`);
    if ((existing?.revision ?? 0) !== value.expectedRevision) fail('open-loop-stale-revision');
    for (const observationId of plan.sourceObservationIds) if (!service.getOpenLoopObservation(observationId)) fail('decision-memory-source-missing');
    for (const relatedId of [plan.observation.facts.supersedesDecisionId, plan.observation.facts.supersededByDecisionId].filter(Boolean)) if (!service.findOpenLoopBySubject('decision', `decision:${relatedId}`)) fail('decision-memory-related-missing');
    const evidenceObservationIds = [...new Set([...(existing?.evidenceObservationIds ?? []), ...plan.sourceObservationIds, plan.observation.observationId])];
    const next = { ...plan.loop, loopId: existing?.loopId ?? plan.loop.loopId, evidenceObservationIds, revision: value.expectedRevision + 1 };
    const reconciled = service.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: value.logicalOperationId, operationKind, intent: value, expectedRevision: value.expectedRevision, observation: plan.observation, loop: next, evidenceRoles: Object.fromEntries(evidenceObservationIds.filter(id => !(existing?.evidenceObservationIds ?? []).includes(id)).map(id => [id, id === plan.observation.observationId ? 'resolution' : 'update'])), updatedAt: plan.observation.observedAt });
    return Object.freeze({ schemaVersion: 1, disposition: 'applied', observation: reconciled.observation, decision: Object.freeze({ loop: reconciled.loop, evidence: reconciled.loop.evidenceObservationIds.map(id => service.getOpenLoopObservation(id)) }) });
  };

  service.challengeDecisionMemory = raw => {
    const value = input(raw, 'challenge');
    const plan = planned(planDecisionChallenge, value.challenge);
    const operationKind = 'decision-challenge';
    const replay = service.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: value.logicalOperationId, operationKind, intent: value });
    if (replay) return Object.freeze({ schemaVersion: 1, disposition: 'duplicate', observation: replay.observation, decision: Object.freeze({ loop: replay.loop, evidence: Object.freeze(replay.loop.evidenceObservationIds.map(id => service.getOpenLoopObservation(id))) }) });
    const loop = service.findOpenLoopBySubject('decision', `decision:${plan.decisionId}`);
    if (!loop) fail('decision-memory-missing');
    if (loop.revision !== value.expectedRevision) fail('open-loop-stale-revision');
    const actionable = plan.observation.historicalBaseline !== true && plan.observation.facts.material === true && plan.observation.facts.assessment === 'contradicted';
    const ambiguous = plan.observation.historicalBaseline !== true && plan.observation.facts.assessment === 'ambiguous';
    const next = {
      ...loop,
      state: actionable ? 'decision-needed' : ambiguous ? 'uncertain' : loop.state,
      attention: actionable ? { reason: 'material-change', whyNow: 'New evidence contradicts a stated assumption; the existing decision remains unchanged until explicitly revised.', actions: ['Open decision', 'Review evidence', 'Record revised decision'], materialRevision: `${plan.observation.source.externalId}:${plan.observation.source.version}`, activated: true, currentEvidence: true } : ambiguous ? { actions: ['Open decision', 'Review evidence'], activated: false, currentEvidence: true } : loop.attention,
      evidenceObservationIds: [...loop.evidenceObservationIds, plan.observation.observationId],
      revision: loop.revision + 1
    };
    const reconciled = service.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: value.logicalOperationId, operationKind, intent: value, expectedRevision: loop.revision, observation: plan.observation, loop: next, evidenceRoles: { [plan.observation.observationId]: actionable || ambiguous ? 'conflict' : 'update' }, updatedAt: plan.observation.observedAt });
    return Object.freeze({ schemaVersion: 1, disposition: 'applied', observation: reconciled.observation, decision: Object.freeze({ loop: reconciled.loop, evidence: reconciled.loop.evidenceObservationIds.map(id => service.getOpenLoopObservation(id)) }) });
  };

  service.getDecisionMemory = decisionId => {
    if (typeof decisionId !== 'string' || decisionId.trim() === '') fail('decision-memory-invalid');
    const loop = service.findOpenLoopBySubject('decision', `decision:${decisionId.trim()}`);
    if (!loop) return null;
    const evidence = Object.freeze(loop.evidenceObservationIds.map(id => service.getOpenLoopObservation(id)));
    const currentRecord = evidence.filter(item => item?.source?.kind === 'explicit-decision' && item?.facts?.decisionId === decisionId.trim()).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.observationId.localeCompare(right.observationId)).at(-1);
    return Object.freeze({ loop, evidence, ...(currentRecord ? { currentRecord } : {}) });
  };
  service.listDecisionMemories = () => Object.freeze(service.listOpenLoops().filter(loop => loop.kind === 'decision' && loop.stableSubjectId.startsWith('decision:')).map(loop => service.getDecisionMemory(loop.stableSubjectId.slice('decision:'.length))));
  service.listCurrentDecisionMemories = () => {
    const memories = service.listDecisionMemories();
    const superseded = new Set(memories.flatMap(memory => memory.currentRecord?.facts?.supersedesDecisionId ? [memory.currentRecord.facts.supersedesDecisionId] : []));
    return Object.freeze(memories.filter(memory => memory.currentRecord?.facts?.status !== 'superseded' && !superseded.has(memory.currentRecord?.facts?.decisionId)));
  };
}
