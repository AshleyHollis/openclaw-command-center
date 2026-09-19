import { createHash } from 'node:crypto';

const decisionStatuses = new Set(['tentative', 'confirmed', 'rejected', 'superseded']);
const assessments = new Set(['unchanged', 'ambiguous', 'contradicted']);
const hash = value => createHash('sha256').update(value).digest('hex');

function fail(message) { throw new TypeError(message); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function closed(value, keys, label) { for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} contains unsupported field ${key}`); }
function text(value, label, maximum = 500) { if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail(`${label} must be a non-blank string`); return value.trim(); }
function instant(value, label) { const result = text(value, label, 64); if (Number.isNaN(Date.parse(result))) fail(`${label} must be an instant`); return result; }
function strings(value, label, maximum = 16, itemMaximum = 500) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must contain at most ${maximum} values`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, itemMaximum));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates`);
  return result;
}
function subject(value) {
  const result = object(value, 'subject');
  closed(result, ['kind', 'id', 'label'], 'subject');
  return Object.freeze({ kind: text(result.kind, 'subject.kind', 80), id: text(result.id, 'subject.id', 300), ...(result.label === undefined ? {} : { label: text(result.label, 'subject.label', 200) }) });
}

export function planDecisionRecord(input) {
  const value = object(input, 'decision record');
  closed(value, ['schemaVersion', 'decisionId', 'status', 'decidedAt', 'actorId', 'subject', 'topicId', 'chosenOption', 'alternatives', 'rationale', 'assumptions', 'sourceObservationIds', 'supersedesDecisionId', 'supersededByDecisionId'], 'decision record');
  if (value.schemaVersion !== 1 || !decisionStatuses.has(value.status)) fail('decision status is unsupported');
  const decisionId = text(value.decisionId, 'decisionId', 300);
  const decidedAt = instant(value.decidedAt, 'decidedAt');
  const actorId = text(value.actorId, 'actorId', 200);
  const relatedSubject = subject(value.subject);
  const chosenOption = value.chosenOption === undefined ? undefined : text(value.chosenOption, 'chosenOption', 500);
  if (value.status === 'confirmed' && chosenOption === undefined) fail('a confirmed decision requires chosenOption');
  const alternatives = strings(value.alternatives, 'alternatives', 16, 500);
  const assumptions = strings(value.assumptions, 'assumptions', 24, 1000);
  const sourceObservationIds = strings(value.sourceObservationIds, 'sourceObservationIds', 24, 300);
  const rationale = value.rationale === undefined ? undefined : text(value.rationale, 'rationale', 2000);
  const supersedesDecisionId = value.supersedesDecisionId === undefined ? undefined : text(value.supersedesDecisionId, 'supersedesDecisionId', 300);
  const supersededByDecisionId = value.supersededByDecisionId === undefined ? undefined : text(value.supersededByDecisionId, 'supersededByDecisionId', 300);
  if (supersedesDecisionId && supersededByDecisionId || supersedesDecisionId === decisionId || supersededByDecisionId === decisionId) fail('decision supersession relationship is invalid');
  if ((value.status === 'superseded') !== (supersededByDecisionId !== undefined)) fail('superseded decisions require supersededByDecisionId, and other statuses cannot use it');
  const observationId = `decision:${hash(JSON.stringify({ decisionId, decidedAt, actorId, status: value.status, chosenOption, alternatives, rationale, assumptions, sourceObservationIds, supersedesDecisionId, supersededByDecisionId })).slice(0, 40)}`;
  const title = relatedSubject.label ?? `Decision about ${relatedSubject.kind} ${relatedSubject.id}`;
  return Object.freeze({
    schemaVersion: 1,
    decisionId,
    sourceObservationIds: Object.freeze(sourceObservationIds),
    observation: Object.freeze({
      schemaVersion: 1,
      observationId,
      source: Object.freeze({ system: 'command-center', kind: 'explicit-decision', externalId: decisionId, version: observationId }),
      type: 'decision-evidence',
      occurredAt: decidedAt,
      observedAt: decidedAt,
      historicalBaseline: false,
      ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId', 300) }),
      entityRefs: Object.freeze([{ ...relatedSubject, evidence: Object.freeze(['explicit-user-decision']) }]),
      facts: Object.freeze({ decisionId, status: value.status, actorId, ...(chosenOption === undefined ? {} : { chosenOption }), alternatives, ...(rationale === undefined ? {} : { rationale }), assumptions, sourceObservationIds, ...(supersedesDecisionId === undefined ? {} : { supersedesDecisionId }), ...(supersededByDecisionId === undefined ? {} : { supersededByDecisionId }) })
    }),
    loop: Object.freeze({
      schemaVersion: 1,
      loopId: `loop:${hash(`decision\u0000decision:${decisionId}`).slice(0, 40)}`,
      kind: 'decision',
      stableSubjectId: `decision:${decisionId}`,
      title,
      ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId', 300) }),
      state: value.status === 'tentative' ? 'suggested' : 'resolved',
      attention: Object.freeze({ actions: Object.freeze([]), activated: false, currentEvidence: true }),
      evidenceObservationIds: Object.freeze([observationId, ...sourceObservationIds]),
      revision: 1
    })
  });
}

export function planDecisionChallenge(input) {
  const value = object(input, 'decision challenge');
  closed(value, ['schemaVersion', 'decisionId', 'source', 'occurredAt', 'observedAt', 'historicalBaseline', 'summary', 'assumption', 'assessment', 'material', 'evidenceSelectors'], 'decision challenge');
  if (value.schemaVersion !== 1 || !assessments.has(value.assessment) || typeof value.material !== 'boolean') fail('decision challenge is unsupported');
  const source = object(value.source, 'source');
  closed(source, ['system', 'kind', 'externalId', 'version'], 'source');
  const sourceValue = Object.freeze({ system: text(source.system, 'source.system', 80), kind: text(source.kind, 'source.kind', 80), externalId: text(source.externalId, 'source.externalId', 500), version: text(source.version, 'source.version', 300) });
  const evidenceSelectors = strings(value.evidenceSelectors, 'evidenceSelectors', 24, 300);
  const decisionId = text(value.decisionId, 'decisionId', 300);
  return Object.freeze({
    schemaVersion: 1,
    decisionId,
    observation: Object.freeze({
      schemaVersion: 1,
      observationId: `decision-challenge:${hash(`${sourceValue.system}\u0000${sourceValue.kind}\u0000${sourceValue.externalId}\u0000${sourceValue.version}`).slice(0, 40)}`,
      source: sourceValue,
      type: 'general',
      occurredAt: instant(value.occurredAt, 'occurredAt'),
      observedAt: instant(value.observedAt, 'observedAt'),
      historicalBaseline: value.historicalBaseline === true,
      entityRefs: Object.freeze([{ kind: 'decision', id: decisionId, evidence: Object.freeze(evidenceSelectors) }]),
      facts: Object.freeze({ decisionId, summary: text(value.summary, 'summary', 1000), assumption: text(value.assumption, 'assumption', 1000), assessment: value.assessment, material: value.material, evidenceSelectors })
    })
  });
}
