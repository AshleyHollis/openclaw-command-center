import { normalizePaymentIdentity, resolvePaymentPredecessor } from './payment-identity.mjs';
import { loadIntakeSourceAccount } from './intake-accounting.mjs';
import { assertAcceptedChatEffect } from './accepted-chat-scope.mjs';
import { createHash } from 'node:crypto';
import { normalizeLoop, normalizeObservation } from './contracts.mjs';

const sourceKinds = new Set(['chat', 'note', 'email', 'manual']);
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
function subject(value) { return value.correlationId ? `commitment:${stable([value.topicId, value.correlationNamespace, value.correlationId])}` : legacySubject(value); }
function legacySubject(value) { return `commitment:${stable([value.sourceKind, value.sourceExternalId, value.obligationId])}`; }

export function normalizeCommitmentCapture(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('capture must be an object');
  const allowed = ['schemaVersion', 'logicalOperationId', 'sourceKind', 'sourceExternalId', 'sourceVersion', 'sourceReferenceId', 'sourcePath', 'sourceReferenceVersion', 'topicId', 'title', 'obligationId', 'obligationKind', 'correlationNamespace', 'correlationId', 'provenance', 'confidence', 'occurredAt', 'observedAt', 'historicalBaseline', 'dueAt', 'reviewAt', 'plannedAt', 'importance', 'importanceOrigin', 'effortMinutes', 'contexts', 'dependencies', 'paymentIdentity', 'classification'];
  const extra = Object.keys(input).find(key => !allowed.includes(key));
  if (extra) fail(`capture contains unsupported field ${extra}`);
  if (input.schemaVersion !== 1 || !sourceKinds.has(input.sourceKind) || !provenanceKinds.has(input.provenance)) fail('capture vocabulary is unsupported');
  if (input.classification !== undefined && (input.sourceKind !== 'chat' || input.classification !== 'decision')) fail('classification is supported only for accepted Chat decisions');
  if (input.obligationKind !== undefined && input.obligationKind !== 'payment') fail('obligationKind is unsupported');
  if (input.importance !== undefined && !importanceKinds.has(input.importance)) fail('importance is unsupported');
  if (input.importanceOrigin !== undefined && !['source', 'processing'].includes(input.importanceOrigin)) fail('capture cannot claim a user importance decision');
  if ((input.importance === undefined) !== (input.importanceOrigin === undefined)) fail('importance and importanceOrigin must be provided together');
  if ((input.sourceReferenceId === undefined) !== (input.sourcePath === undefined) || input.sourceReferenceVersion !== undefined && input.sourceReferenceId === undefined) fail('sourceReferenceId, sourcePath and sourceReferenceVersion must identify one evidence revision');
  if ((input.correlationNamespace === undefined) !== (input.correlationId === undefined)) fail('correlationNamespace and correlationId must be provided together');
  if (input.paymentIdentity !== undefined && (input.sourceKind !== 'email' || input.obligationKind !== 'payment' || input.provenance !== 'explicit' || input.historicalBaseline === true)) fail('paymentIdentity requires a current explicit email payment obligation');
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
    ...(input.classification === undefined ? {} : { classification: input.classification }),
    sourceExternalId: text(input.sourceExternalId, 'sourceExternalId', 500),
    sourceVersion: text(input.sourceVersion, 'sourceVersion', 300),
    ...(input.sourceReferenceId === undefined ? {} : { sourceReferenceId: text(input.sourceReferenceId, 'sourceReferenceId', 300) }),
    ...(input.sourcePath === undefined ? {} : { sourcePath: text(input.sourcePath, 'sourcePath', 500) }),
    ...(input.sourceReferenceVersion === undefined ? {} : { sourceReferenceVersion: text(input.sourceReferenceVersion, 'sourceReferenceVersion', 300) }),
    topicId: text(input.topicId, 'topicId', 300),
    title: text(input.title, 'title', 300),
    obligationId: text(input.obligationId, 'obligationId', 300),
    ...(input.obligationKind === undefined ? {} : { obligationKind: input.obligationKind }),
    ...(input.correlationId === undefined ? {} : { correlationNamespace: text(input.correlationNamespace, 'correlationNamespace', 120), correlationId: text(input.correlationId, 'correlationId', 300) }),
    provenance: input.provenance,
    ...(input.paymentIdentity === undefined ? {} : { paymentIdentity: normalizePaymentIdentity(input.paymentIdentity) }),
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

// Tool retries observe the same source again at a later wall-clock time. Keep
// the timestamps of its immutable evidence; all other intent still passes the
// owner's existing digest checks. This also preserves pre-existing receipts.
export function retainCommitmentCaptureTimestamps(metadata, input) {
  const value = normalizeCommitmentCapture(input);
  const observationId = `commitment-observation:${stable([value.sourceKind, value.sourceExternalId, value.sourceVersion, value.obligationId])}`;
  const retained = metadata.getOpenLoopObservation?.(observationId);
  return retained ? { ...value, occurredAt: retained.occurredAt, observedAt: retained.observedAt } : value;
}

export function planCommitmentCapture(input, existingLoop = null) {
  const value = normalizeCommitmentCapture(input);
  const loopKind = value.obligationKind === 'payment' ? 'payment' : 'general';
  if (existingLoop && existingLoop.kind !== loopKind) fail('capture cannot change an existing obligation kind');
  const observationId = `commitment-observation:${stable([value.sourceKind, value.sourceExternalId, value.sourceVersion, value.obligationId])}`;
  const observationVersion = `commitment:${stable([value.sourceVersion, value.obligationId])}`;
  const normalizedObservation = normalizeObservation({
    schemaVersion: 1,
    observationId,
    source: { system: 'command-center-capture', kind: value.sourceKind, externalId: value.sourceExternalId, version: observationVersion },
    type: loopKind === 'payment' ? 'payment-request' : 'general',
    occurredAt: value.occurredAt,
    observedAt: value.observedAt,
    historicalBaseline: value.historicalBaseline,
    topicId: value.topicId,
    entityRefs: [{ kind: 'obligation', id: value.obligationId }],
    facts: { ...(value.classification === undefined ? {} : { classification: value.classification }), ...(value.paymentIdentity === undefined ? {} : { paymentIdentity: value.paymentIdentity }), title: value.title, obligationId: value.obligationId, sourceVersion: value.sourceVersion, ...(loopKind === 'payment' ? { obligationKind: 'payment' } : {}), ...(value.correlationId === undefined ? {} : { correlationNamespace: value.correlationNamespace, correlationId: value.correlationId }), provenance: value.provenance, ...(value.confidence === undefined ? {} : { confidence: value.confidence }), ...(value.sourceReferenceId === undefined ? {} : { sourceReferenceId: value.sourceReferenceId, sourcePath: value.sourcePath, ...(value.sourceReferenceVersion === undefined ? {} : { sourceReferenceVersion: value.sourceReferenceVersion }) }) }
  });
  const { digest: _digest, ...observation } = normalizedObservation;
  const stableSubjectId = subject(value);
  const suggestion = value.provenance !== 'explicit';
  const priorAttention = existingLoop?.attention ?? {};
  const preserveUserImportance = priorAttention.importanceOrigin === 'user';
  const attention = {
    actions: suggestion ? ['Review suggestion', 'Accept', 'Move to Someday', 'Drop'] : loopKind === 'payment' ? ['Open bill', 'Record payment status'] : ['Open source', 'Plan', 'Start', 'Complete'],
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
    loopId: existingLoop?.loopId ?? `open-loop:${stable([loopKind, stableSubjectId])}`,
    kind: loopKind,
    stableSubjectId,
    title: existingLoop?.title ?? value.title,
    topicId: value.topicId,
    state: existingLoop?.state ?? (value.classification === 'decision' ? 'decision-needed' : suggestion ? 'suggested' : 'confirmed'),
    ...(loopKind === 'payment' ? { paymentState: existingLoop?.paymentState ?? (suggestion ? 'potential' : 'unpaid') } : {}),
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
      if (value.sourceKind === 'chat') assertAcceptedChatEffect(metadata, value, 'capture');
      if (value.sourceReferenceId) {
        const reference = metadata.getSourceReference?.(value.sourceReferenceId);
        if (!reference || reference.topicId !== value.topicId || !['note', 'document'].includes(reference.sourceKind)) throw new TypeError('capture source reference is not exactly owned by the Topic');
        if (sourceService?.notesRead && reference.sourceKind === 'note') {
          const retained = await sourceService.notesRead({ schemaVersion: 1, topicId: value.topicId, referenceId: value.sourceReferenceId, path: value.sourcePath, ...(value.sourceReferenceVersion === undefined ? {} : { observedRevision: value.sourceReferenceVersion }) });
          if (value.sourceKind === 'chat' && (retained?.revision !== value.sourceReferenceVersion || retained?.path !== value.sourcePath || retained?.sourceReference?.referenceId !== value.sourceReferenceId || retained?.sourceReference?.topicId !== value.topicId || retained?.sourceReference?.sourceKind !== 'note')) throw new TypeError('The accepted Chat Note revision or exact reference changed');
          if (value.sourceKind === 'chat') assertAcceptedChatEffect(metadata, value, 'capture');
          if (value.paymentIdentity && retained?.revision !== value.sourceReferenceVersion) throw new TypeError('The accepted payment Note revision changed');
        }
      }
      const relation = value.paymentIdentity?.predecessor;
      if (relation) {
        if (!sourceService?.notesRead || !sourceService?.requireTopicService || !sourceService?.assertExactNoteReference) throw new TypeError('Payment predecessor requires the current exact source authority owner');
        const semanticKey = value.correlationId ? JSON.stringify([value.correlationNamespace, value.correlationId]) : JSON.stringify([value.sourceExternalId, value.obligationId]);
        const predecessor = resolvePaymentPredecessor({ metadata, loadAccount: loadIntakeSourceAccount, relation, semanticKey });
        const facts = predecessor.observation.facts;
        const evidence = { schemaVersion: 1, topicId: predecessor.loop.topicId, referenceId: facts.sourceReferenceId, path: facts.sourcePath, observedRevision: facts.sourceReferenceVersion };
        sourceService.requireTopicService({ topicId: predecessor.loop.topicId });
        const retained = await sourceService.notesRead(evidence);
        if (retained?.revision !== facts.sourceReferenceVersion) throw new TypeError('The original predecessor Note revision changed');
        const fresh = resolvePaymentPredecessor({ metadata, loadAccount: loadIntakeSourceAccount, relation, semanticKey });
        if (fresh.loop.revision !== predecessor.loop.revision) throw new TypeError('Payment predecessor changed during capture');
        sourceService.requireTopicService({ topicId: predecessor.loop.topicId });
        sourceService.assertExactNoteReference(evidence, { read: true });
        sourceService.requireTopicService({ topicId: value.topicId });
        sourceService.assertExactNoteReference({ schemaVersion: 1, topicId: value.topicId, referenceId: value.sourceReferenceId, path: value.sourcePath, observedRevision: value.sourceReferenceVersion }, { read: true });
      }
      const stableSubjectId = subject(value);
      const loopKind = value.obligationKind === 'payment' ? 'payment' : 'general';
      const current = metadata.findOpenLoopBySubject(loopKind, stableSubjectId);
      const otherKind = metadata.findOpenLoopBySubject(loopKind === 'payment' ? 'general' : 'payment', stableSubjectId);
      const legacy = value.correlationId ? metadata.findCommitmentLoopsByLegacyObligation?.(value.topicId, value.obligationId) ?? [] : [];
      const distinctLegacy = legacy.filter(loop => loop.loopId !== current?.loopId);
      const sameSourceLegacy = value.correlationId ? metadata.findOpenLoopBySubject('general', legacySubject(value)) : null;
      if (otherKind || loopKind === 'payment' && sameSourceLegacy || distinctLegacy.length > 1 || current && distinctLegacy.length || !current && distinctLegacy.length && !sameSourceLegacy) throw new TypeError('capture correlation requires explicit duplicate review');
      const existing = current ?? sameSourceLegacy ?? null;
      const planned = planCommitmentCapture(value, existing);
      if (value.sourceKind === 'chat') assertAcceptedChatEffect(metadata, value, 'capture');
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
