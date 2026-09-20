import { createHash } from 'node:crypto';

export const OPEN_LOOP_SCHEMA_VERSION = 1;
export const OBSERVATION_TYPES = Object.freeze([
  'bill', 'payment-request', 'payment-evidence', 'reply-request', 'reply-evidence',
  'quote', 'order', 'dispatch', 'delivery', 'appointment', 'decision-evidence', 'general'
]);
export const LOOP_KINDS = Object.freeze(['payment', 'response', 'order', 'decision', 'general']);
export const LOOP_STATES = Object.freeze([
  'suggested', 'confirmed', 'waiting', 'monitoring', 'decision-needed',
  'action-running', 'resolved', 'cancelled', 'uncertain'
]);
export const PAYMENT_STATES = Object.freeze([
  'potential', 'unpaid', 'partially-paid', 'payment-pending', 'paid',
  'disputed', 'cancelled', 'uncertain'
]);
export const ATTENTION_REASONS = Object.freeze([
  'response-requested', 'decision-requested', 'due-window', 'overdue',
  'material-change', 'activated-blocker', 'evidence-conflict', 'review-time'
]);

const observationKeys = Object.freeze([
  'schemaVersion', 'observationId', 'source', 'type', 'occurredAt', 'observedAt',
  'historicalBaseline', 'topicId', 'entityRefs', 'facts'
]);
const sourceKeys = Object.freeze(['system', 'kind', 'externalId', 'version']);
const entityKeys = Object.freeze(['kind', 'id', 'label', 'confidence', 'evidence']);
const loopKeys = Object.freeze([
  'schemaVersion', 'loopId', 'kind', 'stableSubjectId', 'title', 'topicId', 'state',
  'paymentState', 'amount', 'currency', 'dueAt', 'dueDate', 'dueTimeZone', 'reviewAt', 'expectedEvent',
  'attention', 'evidenceObservationIds', 'revision'
]);
const attentionKeys = Object.freeze([
  'reason', 'whyNow', 'actions', 'materialRevision', 'activated', 'currentEvidence',
  'importance', 'importanceOrigin', 'plannedAt', 'effortMinutes', 'contexts',
  'dependencies', 'provenance', 'confidence', 'lastConsideredAt', 'someday'
]);
const importanceValues = Object.freeze(['critical', 'high', 'normal', 'low']);
const importanceOrigins = Object.freeze(['user', 'source', 'processing']);
const provenanceValues = Object.freeze(['explicit', 'inferred', 'idea', 'quoted']);

function fail(message) { throw new TypeError(message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function closed(value, keys, label) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} contains unsupported field ${key}`);
}
function text(value, label, maximum = 300) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail(`${label} must be a non-blank string of at most ${maximum} characters`);
  return value.trim();
}
function optionalText(value, label, maximum = 300) { return value === undefined || value === null ? undefined : text(value, label, maximum); }
function timestamp(value, label) {
  const result = text(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(result) || Number.isNaN(Date.parse(result))) fail(`${label} must be an RFC 3339 instant`);
  return result;
}
function optionalTimestamp(value, label) { return value === undefined || value === null ? undefined : timestamp(value, label); }
function calendarDate(value, label) {
  const result = text(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)) fail(`${label} must be a calendar date`);
  const [year, month, day] = result.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) fail(`${label} must be a valid calendar date`);
  return result;
}
function timeZone(value, label) {
  const result = text(value, label, 100);
  try { new Intl.DateTimeFormat('en-US', { timeZone: result }).format(); } catch { fail(`${label} must be a valid IANA timezone`); }
  return result;
}
function boolean(value, label, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function boundedJson(value, label, maximum = 12 * 1024) {
  object(value, label);
  const result = canonical(value);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maximum) fail(`${label} exceeds ${maximum} bytes`);
  return result;
}
function uniqueStrings(value, label, maximum = 32) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array of at most ${maximum} values`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 300));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates`);
  return result;
}
function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }

export function normalizeObservation(input) {
  const value = object(input, 'observation');
  closed(value, observationKeys, 'observation');
  if (value.schemaVersion !== OPEN_LOOP_SCHEMA_VERSION) fail('observation schemaVersion must be 1');
  if (!OBSERVATION_TYPES.includes(value.type)) fail('observation type is unsupported');
  const source = object(value.source, 'observation source');
  closed(source, sourceKeys, 'observation source');
  if (value.entityRefs !== undefined && !Array.isArray(value.entityRefs)) fail('entityRefs must be an array');
  const entityRefs = value.entityRefs === undefined ? [] : value.entityRefs.map((candidate, index) => {
    const entity = object(candidate, `entityRefs[${index}]`);
    closed(entity, entityKeys, `entityRefs[${index}]`);
    const confidence = entity.confidence === undefined ? undefined : Number(entity.confidence);
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) fail(`entityRefs[${index}].confidence must be between 0 and 1`);
    return Object.freeze({
      kind: text(entity.kind, `entityRefs[${index}].kind`, 80),
      id: text(entity.id, `entityRefs[${index}].id`, 300),
      ...(entity.label === undefined ? {} : { label: text(entity.label, `entityRefs[${index}].label`, 200) }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(entity.evidence === undefined ? {} : { evidence: uniqueStrings(entity.evidence, `entityRefs[${index}].evidence`, 8) })
    });
  });
  if (entityRefs.length > 32) fail('entityRefs must contain at most 32 values');
  const normalized = {
    schemaVersion: 1,
    observationId: text(value.observationId, 'observationId', 300),
    source: Object.freeze({
      system: text(source.system, 'source.system', 80),
      kind: text(source.kind, 'source.kind', 80),
      externalId: text(source.externalId, 'source.externalId', 500),
      version: text(source.version, 'source.version', 300)
    }),
    type: value.type,
    occurredAt: timestamp(value.occurredAt, 'occurredAt'),
    observedAt: timestamp(value.observedAt, 'observedAt'),
    historicalBaseline: boolean(value.historicalBaseline, 'historicalBaseline'),
    ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId', 300) }),
    entityRefs: Object.freeze(entityRefs),
    facts: Object.freeze(boundedJson(value.facts ?? {}, 'facts'))
  };
  return Object.freeze({ ...normalized, digest: digest(normalized) });
}

export function exactCorrelationKeys(observation) {
  const value = normalizeObservation(observation);
  const facts = value.facts;
  const identifiers = [
    ['invoice', facts.invoiceId], ['account', facts.accountId], ['transaction', facts.transactionId],
    ['order', facts.orderId], ['appointment', facts.appointmentId], ['conversation', facts.conversationId]
  ].filter(([, candidate]) => typeof candidate === 'string' && candidate.trim() !== '');
  return Object.freeze(identifiers.map(([kind, candidate]) => `${kind}:${candidate.trim()}`));
}

export function normalizeLoop(input) {
  const value = object(input, 'open loop');
  closed(value, loopKeys, 'open loop');
  if (value.schemaVersion !== OPEN_LOOP_SCHEMA_VERSION) fail('open loop schemaVersion must be 1');
  if (!LOOP_KINDS.includes(value.kind)) fail('open loop kind is unsupported');
  if (!LOOP_STATES.includes(value.state)) fail('open loop state is unsupported');
  if (value.paymentState !== undefined && (!PAYMENT_STATES.includes(value.paymentState) || value.kind !== 'payment')) fail('paymentState is valid only for a payment loop');
  const amount = value.amount === undefined || value.amount === null ? undefined : Number(value.amount);
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) fail('amount must be a non-negative integer in minor currency units');
  const currency = value.currency === undefined ? undefined : text(value.currency, 'currency', 3).toUpperCase();
  if ((amount === undefined) !== (currency === undefined) || currency !== undefined && !/^[A-Z]{3}$/u.test(currency)) fail('amount and ISO currency must be provided together');
  const attention = value.attention === undefined ? undefined : (() => {
    const candidate = object(value.attention, 'attention');
    closed(candidate, attentionKeys, 'attention');
    if (candidate.reason !== undefined && !ATTENTION_REASONS.includes(candidate.reason)) fail('attention reason is unsupported');
    if (candidate.importance !== undefined && !importanceValues.includes(candidate.importance)) fail('attention importance is unsupported');
    if (candidate.importanceOrigin !== undefined && !importanceOrigins.includes(candidate.importanceOrigin)) fail('attention importance origin is unsupported');
    if ((candidate.importance === undefined) !== (candidate.importanceOrigin === undefined)) fail('attention importance and origin must be provided together');
    if (candidate.provenance !== undefined && !provenanceValues.includes(candidate.provenance)) fail('attention provenance is unsupported');
    const confidence = candidate.confidence === undefined ? undefined : Number(candidate.confidence);
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) fail('attention confidence must be between 0 and 1');
    const effortMinutes = candidate.effortMinutes === undefined ? undefined : Number(candidate.effortMinutes);
    if (effortMinutes !== undefined && (!Number.isSafeInteger(effortMinutes) || effortMinutes < 1 || effortMinutes > 10080)) fail('attention effortMinutes must be between 1 and 10080');
    return Object.freeze({
      ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
      ...(candidate.whyNow === undefined ? {} : { whyNow: text(candidate.whyNow, 'attention.whyNow', 500) }),
      actions: Object.freeze(uniqueStrings(candidate.actions ?? [], 'attention.actions', 8)),
      ...(candidate.materialRevision === undefined ? {} : { materialRevision: text(candidate.materialRevision, 'attention.materialRevision', 300) }),
      activated: boolean(candidate.activated, 'attention.activated'),
      currentEvidence: boolean(candidate.currentEvidence, 'attention.currentEvidence'),
      ...(candidate.importance === undefined ? {} : { importance: candidate.importance, importanceOrigin: candidate.importanceOrigin }),
      ...(candidate.plannedAt === undefined ? {} : { plannedAt: timestamp(candidate.plannedAt, 'attention.plannedAt') }),
      ...(effortMinutes === undefined ? {} : { effortMinutes }),
      contexts: Object.freeze(uniqueStrings(candidate.contexts ?? [], 'attention.contexts', 8)),
      dependencies: Object.freeze(uniqueStrings(candidate.dependencies ?? [], 'attention.dependencies', 16)),
      ...(candidate.provenance === undefined ? {} : { provenance: candidate.provenance }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(candidate.lastConsideredAt === undefined ? {} : { lastConsideredAt: timestamp(candidate.lastConsideredAt, 'attention.lastConsideredAt') }),
      someday: boolean(candidate.someday, 'attention.someday')
    });
  })();
  const revision = Number(value.revision ?? 1);
  if (!Number.isSafeInteger(revision) || revision < 1) fail('revision must be a positive safe integer');
  if ((value.dueDate === undefined) !== (value.dueTimeZone === undefined)) fail('dueDate and dueTimeZone must be provided together');
  if (value.dueAt !== undefined && value.dueDate !== undefined) fail('dueAt and dueDate are mutually exclusive');
  return Object.freeze({
    schemaVersion: 1,
    loopId: text(value.loopId, 'loopId', 300),
    kind: value.kind,
    stableSubjectId: text(value.stableSubjectId, 'stableSubjectId', 500),
    title: text(value.title, 'title', 300),
    ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId', 300) }),
    state: value.state,
    ...(value.paymentState === undefined ? {} : { paymentState: value.paymentState }),
    ...(amount === undefined ? {} : { amount, currency }),
    ...(value.dueAt === undefined ? {} : { dueAt: optionalTimestamp(value.dueAt, 'dueAt') }),
    ...(value.dueDate === undefined ? {} : { dueDate: calendarDate(value.dueDate, 'dueDate'), dueTimeZone: timeZone(value.dueTimeZone, 'dueTimeZone') }),
    ...(value.reviewAt === undefined ? {} : { reviewAt: optionalTimestamp(value.reviewAt, 'reviewAt') }),
    ...(value.expectedEvent === undefined ? {} : { expectedEvent: optionalText(value.expectedEvent, 'expectedEvent', 500) }),
    ...(attention === undefined ? {} : { attention }),
    evidenceObservationIds: Object.freeze(uniqueStrings(value.evidenceObservationIds ?? [], 'evidenceObservationIds')),
    revision
  });
}

export function observationDigest(value) { return normalizeObservation(value).digest; }
