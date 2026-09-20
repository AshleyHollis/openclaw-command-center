import { createHash } from 'node:crypto';
import { normalizeLoop, normalizeObservation } from './contracts.mjs';

const sourceKinds = new Set(['chat', 'note', 'email']);
const provenanceKinds = new Set(['explicit', 'inferred', 'idea', 'quoted']);
const importanceKinds = new Set(['critical', 'high', 'normal', 'low']);

function fail(message) { throw new TypeError(message); }
function text(value, field, maximum = 300) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail(`${field} must be a non-blank string`);
  return value.trim();
}
function instant(value, field) {
  const result = text(value, field, 64);
  if (Number.isNaN(Date.parse(result))) fail(`${field} must be a valid instant`);
  return result;
}
function stable(parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32); }

export function normalizeCommitmentCapture(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('capture must be an object');
  const allowed = ['schemaVersion', 'logicalOperationId', 'sourceKind', 'sourceExternalId', 'sourceVersion', 'sourceReferenceId', 'topicId', 'title', 'obligationId', 'provenance', 'confidence', 'occurredAt', 'observedAt', 'historicalBaseline', 'dueAt', 'reviewAt', 'plannedAt', 'importance', 'importanceOrigin', 'effortMinutes', 'contexts', 'dependencies'];
  const extra = Object.keys(input).find(key => !allowed.includes(key));
  if (extra) fail(`capture contains unsupported field ${extra}`);
  if (input.schemaVersion !== 1 || !sourceKinds.has(input.sourceKind) || !provenanceKinds.has(input.provenance)) fail('capture vocabulary is unsupported');
  if (input.importance !== undefined && !importanceKinds.has(input.importance)) fail('importance is unsupported');
  if (input.importanceOrigin !== undefined && !['source', 'processing'].includes(input.importanceOrigin)) fail('capture cannot claim a user importance decision');
  if ((input.importance === undefined) !== (input.importanceOrigin === undefined)) fail('importance and importanceOrigin must be provided together');
  const confidence = input.confidence === undefined ? undefined : Number(input.confidence);
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) fail('confidence must be between 0 and 1');
  const effortMinutes = input.effortMinutes === undefined ? undefined : Number(input.effortMinutes);
  if (effortMinutes !== undefined && (!Number.isSafeInteger(effortMinutes) || effortMinutes < 1 || effortMinutes > 10080)) fail('effortMinutes is invalid');
  const list = (value, field, maximum) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maximum) fail(`${field} is invalid`);
    const result = value.map((item, index) => text(item, `${field}[${index}]`, 120));
    if (new Set(result).size !== result.length) fail(`${field} contains duplicates`);
    return result;
  };
  return Object.freeze({
    schemaVersion: 1,
    logicalOperationId: text(input.logicalOperationId, 'logicalOperationId', 100),
    sourceKind: input.sourceKind,
    sourceExternalId: text(input.sourceExternalId, 'sourceExternalId', 500),
    sourceVersion: text(input.sourceVersion, 'sourceVersion', 300),
    ...(input.sourceReferenceId === undefined ? {} : { sourceReferenceId: text(input.sourceReferenceId, 'sourceReferenceId', 300) }),
    topicId: text(input.topicId, 'topicId', 300),
    title: text(input.title, 'title', 300),
    obligationId: text(input.obligationId, 'obligationId', 300),
    provenance: input.provenance,
    ...(confidence === undefined ? {} : { confidence }),
    occurredAt: instant(input.occurredAt, 'occurredAt'),
    observedAt: instant(input.observedAt, 'observedAt'),
    historicalBaseline: input.historicalBaseline === true,
    ...(input.dueAt === undefined ? {} : { dueAt: instant(input.dueAt, 'dueAt') }),
    ...(input.reviewAt === undefined ? {} : { reviewAt: instant(input.reviewAt, 'reviewAt') }),
    ...(input.plannedAt === undefined ? {} : { plannedAt: instant(input.plannedAt, 'plannedAt') }),
    ...(input.importance === undefined ? {} : { importance: input.importance, importanceOrigin: input.importanceOrigin }),
    ...(effortMinutes === undefined ? {} : { effortMinutes }),
    contexts: Object.freeze(list(input.contexts, 'contexts', 8)),
    dependencies: Object.freeze(list(input.dependencies, 'dependencies', 16))
  });
}

export function planCommitmentCapture(input, existingLoop = null) {
  const value = normalizeCommitmentCapture(input);
  const observationId = `commitment-observation:${stable([value.sourceKind, value.sourceExternalId, value.sourceVersion, value.obligationId])}`;
  const normalizedObservation = normalizeObservation({
    schemaVersion: 1,
    observationId,
    source: { system: 'command-center-capture', kind: value.sourceKind, externalId: value.sourceExternalId, version: value.sourceVersion },
    type: 'general',
    occurredAt: value.occurredAt,
    observedAt: value.observedAt,
    historicalBaseline: value.historicalBaseline,
    topicId: value.topicId,
    entityRefs: [{ kind: 'obligation', id: value.obligationId }],
    facts: { title: value.title, obligationId: value.obligationId, provenance: value.provenance, ...(value.confidence === undefined ? {} : { confidence: value.confidence }), ...(value.sourceReferenceId === undefined ? {} : { sourceReferenceId: value.sourceReferenceId }) }
  });
  const { digest: _digest, ...observation } = normalizedObservation;
  const stableSubjectId = `commitment:${stable([value.sourceKind, value.sourceExternalId, value.obligationId])}`;
  const suggestion = value.provenance !== 'explicit';
  const priorAttention = existingLoop?.attention ?? {};
  const preserveUserImportance = priorAttention.importanceOrigin === 'user';
  const attention = {
    actions: suggestion ? ['Review suggestion', 'Accept', 'Move to Someday', 'Drop'] : ['Open source', 'Plan', 'Start', 'Complete'],
    activated: false,
    currentEvidence: !value.historicalBaseline,
    provenance: value.provenance,
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(preserveUserImportance ? { importance: priorAttention.importance, importanceOrigin: 'user' } : value.importance === undefined ? {} : { importance: value.importance, importanceOrigin: value.importanceOrigin }),
    ...(priorAttention.plannedAt ? { plannedAt: priorAttention.plannedAt } : value.plannedAt ? { plannedAt: value.plannedAt } : {}),
    ...(priorAttention.effortMinutes ? { effortMinutes: priorAttention.effortMinutes } : value.effortMinutes ? { effortMinutes: value.effortMinutes } : {}),
    contexts: priorAttention.contexts?.length ? priorAttention.contexts : value.contexts,
    dependencies: priorAttention.dependencies?.length ? priorAttention.dependencies : value.dependencies,
    ...(priorAttention.lastConsideredAt ? { lastConsideredAt: priorAttention.lastConsideredAt } : {}),
    someday: priorAttention.someday === true
  };
  const loop = normalizeLoop({
    schemaVersion: 1,
    loopId: existingLoop?.loopId ?? `open-loop:${stable(['general', stableSubjectId])}`,
    kind: 'general',
    stableSubjectId,
    title: existingLoop?.title ?? value.title,
    topicId: value.topicId,
    state: existingLoop?.state ?? (suggestion ? 'suggested' : 'confirmed'),
    ...(existingLoop?.dueAt ? { dueAt: existingLoop.dueAt } : value.dueAt ? { dueAt: value.dueAt } : {}),
    ...(existingLoop?.reviewAt ? { reviewAt: existingLoop.reviewAt } : value.reviewAt ? { reviewAt: value.reviewAt } : {}),
    attention,
    evidenceObservationIds: [...new Set([...(existingLoop?.evidenceObservationIds ?? []), observationId])],
    revision: (existingLoop?.revision ?? 0) + 1
  });
  return Object.freeze({ value, observation, loop });
}

export function createCommitmentCaptureService({ metadata, sourceService } = {}) {
  if (!metadata) throw new TypeError('capture requires metadata ownership');
  return Object.freeze({
    async capture(input) {
      const value = normalizeCommitmentCapture(input);
      if (value.sourceReferenceId) {
        const reference = metadata.getSourceReference?.(value.sourceReferenceId);
        if (!reference || reference.topicId !== value.topicId || !['note', 'document'].includes(reference.sourceKind)) throw new TypeError('capture source reference is not exactly owned by the Topic');
        if (sourceService?.notesRead && reference.sourceKind === 'note') await sourceService.notesRead({ schemaVersion: 1, topicId: value.topicId, referenceId: value.sourceReferenceId });
      }
      const subject = `commitment:${stable([value.sourceKind, value.sourceExternalId, value.obligationId])}`;
      const existing = metadata.findOpenLoopBySubject('general', subject);
      const planned = planCommitmentCapture(value, existing);
      return metadata.applyOpenLoopChange({
        schemaVersion: 1,
        logicalOperationId: value.logicalOperationId,
        operationKind: 'commitment.capture.v1',
        intent: value,
        expectedRevision: existing?.revision ?? 0,
        observation: planned.observation,
        loop: planned.loop,
        evidenceRoles: { [planned.observation.observationId]: existing ? 'update' : 'origin' },
        updatedAt: value.observedAt
      });
    }
  });
}
