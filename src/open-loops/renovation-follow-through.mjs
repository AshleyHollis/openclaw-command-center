import { createHash } from 'node:crypto';

const requirementKinds = new Set(['purchase', 'return', 'refund', 'resale', 'installation', 'prerequisite']);
const fulfilmentKinds = new Set(['delivered', 'installed']);
const dispositionKinds = new Set(['return', 'refund', 'resale']);
const hash = value => createHash('sha256').update(value).digest('hex');

function fail(message) { throw new TypeError(message); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function closed(value, keys, label) { for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} contains unsupported field ${key}`); }
function text(value, label, maximum = 300) { if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail(`${label} must be a non-blank string`); return value.trim(); }
function instant(value, label) { const result = text(value, label, 64); if (Number.isNaN(Date.parse(result))) fail(`${label} must be an instant`); return result; }
function optionalInstant(value, label) { return value === undefined ? undefined : instant(value, label); }
function reference(value, label, kinds) {
  const result = object(value, label);
  closed(result, ['kind', 'namespace', 'id', 'label'], label);
  const kind = text(result.kind, `${label}.kind`, 80);
  if (kinds && !kinds.has(kind)) fail(`${label}.kind is unsupported`);
  return Object.freeze({ kind, namespace: text(result.namespace, `${label}.namespace`), id: text(result.id, `${label}.id`), ...(result.label === undefined ? {} : { label: text(result.label, `${label}.label`, 200) }) });
}
function source(value) {
  const result = object(value, 'source');
  closed(result, ['system', 'kind', 'externalId', 'version'], 'source');
  return Object.freeze({ system: text(result.system, 'source.system', 80), kind: text(result.kind, 'source.kind', 80), externalId: text(result.externalId, 'source.externalId', 500), version: text(result.version, 'source.version') });
}
function identity(value) { return `${value.kind}:${hash(JSON.stringify([value.namespace, value.id])).slice(0, 40)}`; }
function observationId(prefix, value) { return `${prefix}:${hash(`${value.system}\u0000${value.kind}\u0000${value.externalId}\u0000${value.version}`).slice(0, 40)}`; }
function entity(value, evidence) { return Object.freeze({ kind: value.kind, id: `${value.namespace}:${value.id}`, ...(value.label ? { label: value.label } : {}), evidence: Object.freeze(evidence) }); }
function quietAttention(currentEvidence = true) { return Object.freeze({ actions: Object.freeze([]), activated: false, currentEvidence }); }

export function stableRenovationRequirementId(requirement) {
  return `renovation-requirement:${identity(reference(requirement, 'requirement', requirementKinds))}`;
}

export function planRenovationRequirement(input) {
  const value = object(input, 'renovation requirement');
  closed(value, ['schemaVersion', 'source', 'requirement', 'stage', 'occurredAt', 'observedAt', 'historicalBaseline', 'topicId', 'title', 'dueAt'], 'renovation requirement');
  if (value.schemaVersion !== 1) fail('renovation requirement is unsupported');
  const requirement = reference(value.requirement, 'requirement', requirementKinds);
  const stage = value.stage === undefined ? undefined : reference(value.stage, 'stage', new Set(['renovation-stage']));
  if ((requirement.kind === 'prerequisite') !== (stage !== undefined)) fail('only a prerequisite requirement may name a stage');
  const sourceValue = source(value.source);
  const observedAt = instant(value.observedAt, 'observedAt');
  const dueAt = optionalInstant(value.dueAt, 'dueAt');
  const id = observationId('renovation-requirement', sourceValue);
  const stableSubjectId = stableRenovationRequirementId(requirement);
  return Object.freeze({
    observation: Object.freeze({ schemaVersion: 1, observationId: id, source: sourceValue, type: 'general', occurredAt: instant(value.occurredAt, 'occurredAt'), observedAt, historicalBaseline: value.historicalBaseline === true, ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }), entityRefs: Object.freeze([entity(requirement, ['exact-requirement-id']), ...(stage ? [entity(stage, ['exact-stage-id'])] : [])]), facts: Object.freeze({ eventKind: 'requirement-recorded', requirementKind: requirement.kind, requirementNamespace: requirement.namespace, requirementId: requirement.id, ...(stage ? { stageNamespace: stage.namespace, stageId: stage.id } : {}) }) }),
    loop: Object.freeze({ schemaVersion: 1, loopId: `loop:${hash(`general\u0000${stableSubjectId}`).slice(0, 40)}`, kind: 'general', stableSubjectId, title: text(value.title, 'title'), ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }), state: 'waiting', ...(dueAt ? { dueAt } : {}), expectedEvent: requirement.kind === 'purchase' ? 'explicitly linked purchase' : requirement.kind === 'installation' ? 'installation' : requirement.kind === 'prerequisite' ? 'stage completion or prerequisite resolution' : `${requirement.kind} completion`, attention: quietAttention(value.historicalBaseline !== true), evidenceObservationIds: Object.freeze([id]), revision: 1 })
  });
}

export function planPurchasedItemReconciliation(input) {
  const value = object(input, 'purchased item reconciliation');
  closed(value, ['schemaVersion', 'source', 'requirement', 'purchase', 'occurredAt', 'observedAt', 'historicalBaseline', 'topicId'], 'purchased item reconciliation');
  if (value.schemaVersion !== 1) fail('purchased item reconciliation is unsupported');
  const requirement = reference(value.requirement, 'requirement', new Set(['purchase']));
  const purchase = reference(value.purchase, 'purchase', new Set(['purchase']));
  const sourceValue = source(value.source);
  return Object.freeze({ requirementStableSubjectId: stableRenovationRequirementId(requirement), observation: Object.freeze({ schemaVersion: 1, observationId: observationId('renovation-purchase', sourceValue), source: sourceValue, type: 'order', occurredAt: instant(value.occurredAt, 'occurredAt'), observedAt: instant(value.observedAt, 'observedAt'), historicalBaseline: value.historicalBaseline === true, ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }), entityRefs: Object.freeze([entity(requirement, ['explicit-satisfies-requirement']), entity(purchase, ['exact-purchase-id'])]), facts: Object.freeze({ eventKind: 'item-purchased', requirementNamespace: requirement.namespace, requirementId: requirement.id, purchaseNamespace: purchase.namespace, purchaseId: purchase.id }) }) });
}

export function planPurchasedItemCorrection(input) {
  const value = object(input, 'purchased item correction');
  closed(value, ['schemaVersion', 'source', 'requirement', 'purchase', 'occurredAt', 'observedAt', 'topicId', 'rationale'], 'purchased item correction');
  if (value.schemaVersion !== 1) fail('purchased item correction is unsupported');
  const requirement = reference(value.requirement, 'requirement', new Set(['purchase']));
  const purchase = reference(value.purchase, 'purchase', new Set(['purchase']));
  const sourceValue = source(value.source);
  return Object.freeze({
    requirementStableSubjectId: stableRenovationRequirementId(requirement),
    purchase,
    observation: Object.freeze({
      schemaVersion: 1,
      observationId: observationId('renovation-purchase-correction', sourceValue),
      source: sourceValue,
      type: 'order',
      occurredAt: instant(value.occurredAt, 'occurredAt'),
      observedAt: instant(value.observedAt, 'observedAt'),
      historicalBaseline: false,
      ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }),
      entityRefs: Object.freeze([entity(requirement, ['exact-requirement-id']), entity(purchase, ['explicitly-unlinked-purchase'])]),
      facts: Object.freeze({ eventKind: 'purchase-relationship-corrected', requirementNamespace: requirement.namespace, requirementId: requirement.id, purchaseNamespace: purchase.namespace, purchaseId: purchase.id, rationale: text(value.rationale, 'rationale', 1000) })
    })
  });
}

export function planReplacementDisposition(input) {
  const value = object(input, 'replacement disposition');
  closed(value, ['schemaVersion', 'source', 'replacementPurchase', 'replacedItem', 'obligation', 'occurredAt', 'observedAt', 'historicalBaseline', 'topicId', 'title', 'dueAt'], 'replacement disposition');
  if (value.schemaVersion !== 1) fail('replacement disposition is unsupported');
  const replacement = reference(value.replacementPurchase, 'replacementPurchase', new Set(['purchase']));
  const replaced = reference(value.replacedItem, 'replacedItem', new Set(['renovation-item']));
  const obligation = reference(value.obligation, 'obligation', dispositionKinds);
  const sourceValue = source(value.source);
  const id = observationId('renovation-replacement', sourceValue);
  const stableSubjectId = stableRenovationRequirementId(obligation);
  const attention = Object.freeze({ actions: Object.freeze(['Open source', `Mark ${obligation.kind} complete`, 'Defer']), activated: false, currentEvidence: value.historicalBaseline !== true });
  return Object.freeze({ observation: Object.freeze({ schemaVersion: 1, observationId: id, source: sourceValue, type: 'order', occurredAt: instant(value.occurredAt, 'occurredAt'), observedAt: instant(value.observedAt, 'observedAt'), historicalBaseline: value.historicalBaseline === true, ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }), entityRefs: Object.freeze([entity(replacement, ['exact-replacement-purchase']), entity(replaced, ['exact-replaced-item']), entity(obligation, ['explicit-disposition-obligation'])]), facts: Object.freeze({ eventKind: 'replacement-purchased', replacementNamespace: replacement.namespace, replacementPurchaseId: replacement.id, replacedItemNamespace: replaced.namespace, replacedItemId: replaced.id, dispositionKind: obligation.kind, obligationNamespace: obligation.namespace, obligationId: obligation.id }) }), loop: Object.freeze({ schemaVersion: 1, loopId: `loop:${hash(`general\u0000${stableSubjectId}`).slice(0, 40)}`, kind: 'general', stableSubjectId, title: text(value.title, 'title'), ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }), state: 'confirmed', dueAt: instant(value.dueAt, 'dueAt'), expectedEvent: `${obligation.kind} completion`, attention, evidenceObservationIds: Object.freeze([id]), revision: 1 }) });
}

export function planRenovationFulfilment(input) {
  const value = object(input, 'renovation fulfilment');
  closed(value, ['schemaVersion', 'source', 'requirement', 'fulfilmentKind', 'installationRequired', 'occurredAt', 'observedAt', 'historicalBaseline', 'topicId'], 'renovation fulfilment');
  if (value.schemaVersion !== 1 || !fulfilmentKinds.has(value.fulfilmentKind) || typeof value.installationRequired !== 'boolean') fail('renovation fulfilment is unsupported');
  const requirement = reference(value.requirement, 'requirement', new Set(['purchase', 'installation']));
  const sourceValue = source(value.source);
  return Object.freeze({ requirementStableSubjectId: stableRenovationRequirementId(requirement), resolves: value.fulfilmentKind === 'installed' || value.fulfilmentKind === 'delivered' && !value.installationRequired, expectedEvent: value.fulfilmentKind === 'delivered' && value.installationRequired ? 'installation' : undefined, observation: Object.freeze({ schemaVersion: 1, observationId: observationId(`renovation-${value.fulfilmentKind}`, sourceValue), source: sourceValue, type: 'delivery', occurredAt: instant(value.occurredAt, 'occurredAt'), observedAt: instant(value.observedAt, 'observedAt'), historicalBaseline: value.historicalBaseline === true, ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }), entityRefs: Object.freeze([entity(requirement, ['exact-requirement-id'])]), facts: Object.freeze({ eventKind: value.fulfilmentKind, requirementNamespace: requirement.namespace, requirementId: requirement.id, installationRequired: value.installationRequired }) }) });
}

export function planStageActivation(input) {
  const value = object(input, 'stage activation');
  closed(value, ['schemaVersion', 'source', 'stage', 'active', 'occurredAt', 'observedAt', 'topicId', 'actorId'], 'stage activation');
  if (value.schemaVersion !== 1 || typeof value.active !== 'boolean') fail('stage activation is unsupported');
  const stage = reference(value.stage, 'stage', new Set(['renovation-stage']));
  const sourceValue = source(value.source);
  return Object.freeze({ stageKey: `${stage.namespace}:${stage.id}`, observation: Object.freeze({ schemaVersion: 1, observationId: observationId('renovation-stage', sourceValue), source: sourceValue, type: 'general', occurredAt: instant(value.occurredAt, 'occurredAt'), observedAt: instant(value.observedAt, 'observedAt'), historicalBaseline: false, ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }), entityRefs: Object.freeze([entity(stage, ['explicit-stage-activation'])]), facts: Object.freeze({ eventKind: value.active ? 'stage-activated' : 'stage-deactivated', stageNamespace: stage.namespace, stageId: stage.id, active: value.active, ...(value.actorId === undefined ? {} : { actorId: text(value.actorId, 'actorId', 200) }) }) }) });
}

export function planRenovationDecisionConflict(input) {
  const value = object(input, 'renovation decision conflict');
  closed(value, ['schemaVersion', 'decisionId', 'source', 'conflictKind', 'occurredAt', 'observedAt', 'historicalBaseline', 'summary', 'recordedChoice', 'observedChoice', 'evidenceSelectors'], 'renovation decision conflict');
  if (value.schemaVersion !== 1 || !new Set(['revised-quote', 'purchase-vs-choice']).has(value.conflictKind)) fail('renovation decision conflict is unsupported');
  const recordedChoice = text(value.recordedChoice, 'recordedChoice', 500);
  const observedChoice = text(value.observedChoice, 'observedChoice', 500);
  const evidenceSelectors = value.evidenceSelectors ?? [];
  if (!Array.isArray(evidenceSelectors) || evidenceSelectors.length > 16) fail('evidenceSelectors is unsupported');
  return Object.freeze({ schemaVersion: 1, decisionId: text(value.decisionId, 'decisionId'), source: source(value.source), occurredAt: instant(value.occurredAt, 'occurredAt'), observedAt: instant(value.observedAt, 'observedAt'), historicalBaseline: value.historicalBaseline === true, summary: text(value.summary, 'summary', 1000), assumption: `Recorded choice: ${recordedChoice}; observed ${value.conflictKind === 'revised-quote' ? 'quote choice' : 'purchase choice'}: ${observedChoice}.`, assessment: recordedChoice === observedChoice ? 'unchanged' : 'contradicted', material: recordedChoice !== observedChoice, evidenceSelectors: Object.freeze(evidenceSelectors.map((item, index) => text(item, `evidenceSelectors[${index}]`))) });
}
