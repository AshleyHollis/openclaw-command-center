import {
  planPurchasedItemReconciliation,
  planRenovationDecisionConflict,
  planRenovationFulfilment,
  planRenovationRequirement,
  planReplacementDisposition,
  planStageActivation
} from '../open-loops/renovation-follow-through.mjs';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

function command(raw, field) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['schemaVersion', 'logicalOperationId', 'expectedRevision', field].includes(key)) || raw.schemaVersion !== 1 || typeof raw.logicalOperationId !== 'string' || raw.logicalOperationId.trim() === '' || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) throw new TypeError('renovation-follow-through-invalid');
  return raw;
}

function updateExisting(service, value, plan, operationKind, transform) {
  const operationId = value.logicalOperationId.trim();
  const replay = service.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: operationId, operationKind, intent: value });
  if (replay) return replay;
  const existing = service.findOpenLoopBySubject('general', plan.requirementStableSubjectId);
  if (!existing) throw new TypeError('renovation-requirement-missing');
  if (existing.revision !== value.expectedRevision) throw new TypeError('renovation-requirement-stale-revision');
  const next = transform(existing);
  return service.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: operationId, operationKind, intent: value, expectedRevision: existing.revision, observation: plan.observation, loop: { ...next, evidenceObservationIds: [...existing.evidenceObservationIds, plan.observation.observationId], revision: existing.revision + 1 }, evidenceRoles: { [plan.observation.observationId]: next.state === 'resolved' ? 'resolution' : 'update' }, updatedAt: plan.observation.observedAt });
}

export function createRenovationFollowThrough(service) {
  if (!service || typeof service.applyOpenLoopChange !== 'function') throw new TypeError('open-loop metadata service is required');
  return freeze({
    recordRequirement(raw) {
      const value = command(raw, 'requirement');
      const plan = planRenovationRequirement(value.requirement);
      return service.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: value.logicalOperationId.trim(), operationKind: 'renovation-requirement', intent: value, expectedRevision: value.expectedRevision, observation: plan.observation, loop: { ...plan.loop, revision: value.expectedRevision + 1 }, evidenceRoles: { [plan.observation.observationId]: 'origin' }, updatedAt: plan.observation.observedAt });
    },
    reconcilePurchasedItem(raw) {
      const value = command(raw, 'reconciliation');
      const plan = planPurchasedItemReconciliation(value.reconciliation);
      return updateExisting(service, value, plan, 'renovation-purchase-reconciliation', existing => ({ ...existing, state: 'resolved', attention: { actions: [], activated: false, currentEvidence: plan.observation.historicalBaseline !== true }, expectedEvent: undefined }));
    },
    recordReplacementDisposition(raw) {
      const value = command(raw, 'replacement');
      const plan = planReplacementDisposition(value.replacement);
      return service.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: value.logicalOperationId.trim(), operationKind: 'renovation-replacement-disposition', intent: value, expectedRevision: value.expectedRevision, observation: plan.observation, loop: { ...plan.loop, revision: value.expectedRevision + 1 }, evidenceRoles: { [plan.observation.observationId]: 'origin' }, updatedAt: plan.observation.observedAt });
    },
    recordFulfilment(raw) {
      const value = command(raw, 'fulfilment');
      const plan = planRenovationFulfilment(value.fulfilment);
      return updateExisting(service, value, plan, 'renovation-fulfilment', existing => ({ ...existing, state: plan.resolves ? 'resolved' : 'monitoring', ...(plan.expectedEvent ? { expectedEvent: plan.expectedEvent } : { expectedEvent: undefined }), attention: { actions: [], activated: false, currentEvidence: plan.observation.historicalBaseline !== true } }));
    },
    recordStageActivation(raw) {
      const value = command(raw, 'activation');
      if (value.expectedRevision !== 0) throw new TypeError('stage activation does not use an open-loop revision');
      const plan = planStageActivation(value.activation);
      return service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: value.logicalOperationId.trim(), observation: plan.observation });
    },
    projectStagePrerequisites({ stage, topicId } = {}) {
      if (!stage || typeof stage.namespace !== 'string' || typeof stage.id !== 'string') throw new TypeError('exact stage identity is required');
      const activations = service.listOpenLoopObservations().filter(item => item.facts?.stageNamespace === stage.namespace && item.facts?.stageId === stage.id && ['stage-activated', 'stage-deactivated'].includes(item.facts?.eventKind)).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.observationId.localeCompare(right.observationId));
      const current = activations.at(-1);
      if (!current?.facts?.active) return freeze({ schemaVersion: 1, active: false, stage: { namespace: stage.namespace, id: stage.id }, items: [] });
      const items = service.listOpenLoops().filter(loop => !['resolved', 'cancelled'].includes(loop.state) && (topicId === undefined || loop.topicId === topicId)).filter(loop => loop.evidenceObservationIds.some(id => { const evidence = service.getOpenLoopObservation(id); return evidence?.facts?.eventKind === 'requirement-recorded' && evidence.facts.requirementKind === 'prerequisite' && evidence.facts.stageNamespace === stage.namespace && evidence.facts.stageId === stage.id; })).map(loop => freeze({ loop, reason: 'activated-blocker', whyNow: `${loop.title} blocks the explicitly activated stage.`, actions: ['Open source', 'Mark resolved', 'Defer'] }));
      return freeze({ schemaVersion: 1, active: true, stage: { namespace: stage.namespace, id: stage.id }, activationObservationId: current.observationId, items });
    },
    recordDecisionConflict(raw) {
      const value = command(raw, 'conflict');
      const challenge = planRenovationDecisionConflict(value.conflict);
      return service.challengeDecisionMemory({ schemaVersion: 1, logicalOperationId: value.logicalOperationId.trim(), expectedRevision: value.expectedRevision, challenge });
    }
  });
}
