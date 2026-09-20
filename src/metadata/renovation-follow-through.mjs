import {
  planPurchasedItemReconciliation,
  planPurchasedItemCorrection,
  planRenovationDecisionConflict,
  planRenovationFulfilment,
  planRenovationRequirement,
  planReplacementDisposition,
  planStageActivation
} from '../open-loops/renovation-follow-through.mjs';
import { createHash } from 'node:crypto';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
const intentDigest = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;

function command(raw, field) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['schemaVersion', 'logicalOperationId', 'expectedRevision', 'actorId', field].includes(key)) || raw.schemaVersion !== 1 || typeof raw.logicalOperationId !== 'string' || raw.logicalOperationId.trim() === '' || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0 || typeof raw.actorId !== 'string' || raw.actorId.trim() === '') throw new TypeError('renovation-follow-through-invalid');
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
  const projectStagePrerequisites = ({ stage, topicId } = {}) => {
    if (!stage || typeof stage.namespace !== 'string' || typeof stage.id !== 'string') throw new TypeError('exact stage identity is required');
    const activations = service.listOpenLoopObservations().filter(item => item.facts?.stageNamespace === stage.namespace && item.facts?.stageId === stage.id && ['stage-activated', 'stage-deactivated'].includes(item.facts?.eventKind)).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.observationId.localeCompare(right.observationId));
    const current = activations.at(-1);
    if (!current?.facts?.active) return freeze({ schemaVersion: 1, active: false, stage: { namespace: stage.namespace, id: stage.id }, items: [] });
    const items = service.listOpenLoops().filter(loop => !['resolved', 'cancelled'].includes(loop.state) && (topicId === undefined || loop.topicId === topicId)).filter(loop => loop.evidenceObservationIds.some(id => { const evidence = service.getOpenLoopObservation(id); return evidence?.facts?.eventKind === 'requirement-recorded' && evidence.facts.requirementKind === 'prerequisite' && evidence.facts.stageNamespace === stage.namespace && evidence.facts.stageId === stage.id; })).map(loop => freeze({ loop, reason: 'activated-blocker', whyNow: `${loop.title} blocks the explicitly activated stage.`, actions: ['Open source', 'Mark resolved', 'Defer'] }));
    return freeze({ schemaVersion: 1, active: true, stage: { namespace: stage.namespace, id: stage.id }, activationObservationId: current.observationId, items });
  };
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
      return updateExisting(service, value, plan, 'renovation-fulfilment', existing => ({ ...existing, state: plan.resolves ? 'resolved' : 'monitoring', ...(plan.expectedEvent ? { expectedEvent: plan.expectedEvent } : { expectedEvent: undefined }), ...(plan.expectedAt ? { dueAt: plan.expectedAt } : {}), attention: { actions: [], activated: false, currentEvidence: plan.observation.historicalBaseline !== true } }));
    },
    recordStageActivation(raw) {
      const value = command(raw, 'activation');
      if (value.expectedRevision !== 0) throw new TypeError('stage activation does not use an open-loop revision');
      const plan = planStageActivation({ ...value.activation, actorId: value.actorId.trim() });
      return service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: value.logicalOperationId.trim(), observation: plan.observation });
    },
    projectStagePrerequisites,
    projectActiveStagePrerequisites({ topicId } = {}) {
      const stages = new Map();
      for (const item of service.listOpenLoopObservations()) {
        if (!['stage-activated', 'stage-deactivated'].includes(item.facts?.eventKind)) continue;
        const key = `${item.facts.stageNamespace}\u0000${item.facts.stageId}`;
        const previous = stages.get(key);
        if (!previous || Date.parse(previous.occurredAt) < Date.parse(item.occurredAt) || previous.occurredAt === item.occurredAt && previous.observationId.localeCompare(item.observationId) < 0) stages.set(key, item);
      }
      return freeze([...stages.values()].filter(item => item.facts.active === true).map(item => projectStagePrerequisites({ stage: { namespace: item.facts.stageNamespace, id: item.facts.stageId }, ...(topicId ? { topicId } : {}) })).filter(group => group.items.length > 0));
    },
    correctPurchasedItem(raw) {
      const value = command(raw, 'correction');
      const plan = planPurchasedItemCorrection(value.correction);
      return updateExisting(service, value, plan, 'renovation-purchase-correction', existing => {
        const active = new Set();
        const evidence = existing.evidenceObservationIds.map(id => service.getOpenLoopObservation(id)).filter(Boolean).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.observationId.localeCompare(right.observationId));
        for (const item of evidence) {
          const key = JSON.stringify([item.facts?.purchaseNamespace, item.facts?.purchaseId]);
          if (item.facts?.eventKind === 'item-purchased') active.add(key);
          if (item.facts?.eventKind === 'purchase-relationship-corrected') active.delete(key);
        }
        const target = JSON.stringify([plan.purchase.namespace, plan.purchase.id]);
        if (!active.delete(target) || existing.state !== 'resolved') throw new TypeError('renovation-purchase-relationship-missing');
        return active.size > 0
          ? { ...existing, state: 'resolved', expectedEvent: undefined, attention: { actions: [], activated: false, currentEvidence: true } }
          : { ...existing, state: 'waiting', expectedEvent: 'explicitly linked purchase', attention: { actions: [], activated: false, currentEvidence: true } };
      });
    },
    recordDecisionConflict(raw) {
      const value = command(raw, 'conflict');
      const planned = planRenovationDecisionConflict(value.conflict);
      const memory = service.getDecisionMemory(planned.decisionId);
      const alreadyReviewed = memory?.evidence?.some(item => item?.facts?.assumption === planned.assumption && item?.facts?.assessment === planned.assessment);
      const challenge = { ...planned, ...(alreadyReviewed ? { assessment: 'unchanged', material: false } : {}), actorId: value.actorId.trim() };
      return service.challengeDecisionMemory({ schemaVersion: 1, logicalOperationId: value.logicalOperationId.trim(), expectedRevision: value.expectedRevision, challenge });
    },
    reviseDecision(raw) {
      const value = command(raw, 'revision');
      const revision = value.revision;
      if (!revision || typeof revision !== 'object' || Array.isArray(revision) || Object.keys(revision).some(key => !['loopId', 'chosenOption', 'rationale', 'decidedAt'].includes(key)) || typeof revision.loopId !== 'string' || typeof revision.chosenOption !== 'string' || !revision.chosenOption.trim() || typeof revision.rationale !== 'string' || !revision.rationale.trim() || typeof revision.decidedAt !== 'string' || Number.isNaN(Date.parse(revision.decidedAt))) throw new TypeError('renovation-decision-revision-invalid');
      const operationKind = 'renovation-decision-revision';
      const digest = intentDigest(value);
      const previous = service.getOperation(value.logicalOperationId.trim());
      if (previous && (previous.operationKind !== operationKind || previous.intentDigest !== digest)) throw new TypeError('renovation-decision-revision-intent-mismatch');
      if (previous?.state === 'applied') return freeze({ ...JSON.parse(previous.resultIdentity), disposition: 'duplicate' });
      let childCommand = previous?.resultIdentity ? JSON.parse(previous.resultIdentity).childCommand : null;
      if (childCommand) {
        const result = service.recordDecisionMemory(childCommand);
        const response = { schemaVersion: 1, disposition: result.disposition, loop: result.decision.loop };
        service.recordOperation({ ...previous, state: 'applied', resultStatus: result.disposition, resultIdentity: JSON.stringify(response), observedRevision: String(result.decision.loop.revision), updatedAt: revision.decidedAt });
        return freeze(response);
      }
      const loop = service.getOpenLoop(revision.loopId);
      if (!loop || loop.kind !== 'decision' || !loop.stableSubjectId.startsWith('decision:')) throw new TypeError('renovation-decision-missing');
      const decisionId = loop.stableSubjectId.slice('decision:'.length);
      const memory = service.getDecisionMemory(decisionId); const current = memory?.currentRecord; const subject = current?.entityRefs?.[0];
      if (!current || !subject) throw new TypeError('renovation-decision-evidence-missing');
      const conflictObservationId = memory.evidence.filter(item => item?.source?.kind !== 'explicit-decision').at(-1)?.observationId;
      childCommand = { schemaVersion: 1, logicalOperationId: value.logicalOperationId.trim(), expectedRevision: value.expectedRevision, decision: { schemaVersion: 1, decisionId, status: 'confirmed', decidedAt: revision.decidedAt, actorId: value.actorId.trim(), subject: { kind: subject.kind, id: subject.id, ...(subject.label ? { label: subject.label } : {}) }, ...(loop.topicId ? { topicId: loop.topicId } : {}), chosenOption: revision.chosenOption.trim(), alternatives: [...new Set([...(current.facts.alternatives ?? []), current.facts.chosenOption].filter(option => option && option !== revision.chosenOption.trim()))], rationale: revision.rationale.trim(), assumptions: current.facts.assumptions ?? [], sourceObservationIds: [conflictObservationId].filter(Boolean) } };
      const pending = service.recordOperation({ logicalOperationId: value.logicalOperationId.trim(), transportRequestId: value.logicalOperationId.trim(), intentDigest: digest, operationKind, state: 'pending', resultStatus: 'pending', resultIdentity: JSON.stringify({ childCommand }), observedRevision: String(value.expectedRevision), createdAt: revision.decidedAt, updatedAt: revision.decidedAt });
      const result = service.recordDecisionMemory(childCommand);
      const response = { schemaVersion: 1, disposition: result.disposition, loop: result.decision.loop };
      service.recordOperation({ ...pending, state: 'applied', resultStatus: result.disposition, resultIdentity: JSON.stringify(response), observedRevision: String(result.decision.loop.revision), updatedAt: revision.decidedAt });
      return freeze(response);
    }
  });
}
