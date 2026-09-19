import { createHash } from 'node:crypto';

const eventKinds = new Set([
  'quote-issued', 'quote-revised', 'order-placed', 'order-cancelled', 'dispatch',
  'delivery-partial', 'delivery-complete', 'installation-complete',
  'appointment-confirmed', 'appointment-revised'
]);
const subjectKinds = new Set(['quote', 'order', 'appointment']);
const amountBases = new Set(['including-tax', 'excluding-tax', 'unknown']);
const hash = value => createHash('sha256').update(value).digest('hex');

function fail(message) { throw new TypeError(message); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function closed(value, keys, label) { for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} contains unsupported field ${key}`); }
function text(value, label, maximum = 300) { if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail(`${label} must be a non-blank string`); return value.trim(); }
function instant(value, label) { const result = text(value, label, 64); if (Number.isNaN(Date.parse(result))) fail(`${label} must be an instant`); return result; }
function optionalInstant(value, label) { return value === undefined ? undefined : instant(value, label); }
function strings(value, label, maximum = 24) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must contain at most ${maximum} values`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 300));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates`);
  return result;
}

export function planTransactionEvent(input) {
  const value = object(input, 'transaction event');
  closed(value, ['schemaVersion', 'source', 'eventKind', 'subject', 'occurredAt', 'observedAt', 'historicalBaseline', 'topicId', 'summary', 'supplier', 'amount', 'currency', 'amountBasis', 'expectedAt', 'installationRequired', 'lineItemIds', 'materialChanges', 'evidenceSelectors'], 'transaction event');
  if (value.schemaVersion !== 1 || !eventKinds.has(value.eventKind)) fail('transaction event is unsupported');
  const source = object(value.source, 'source');
  closed(source, ['system', 'kind', 'externalId', 'version'], 'source');
  const subject = object(value.subject, 'subject');
  closed(subject, ['kind', 'namespace', 'id'], 'subject');
  if (!subjectKinds.has(subject.kind)) fail('subject.kind is unsupported');
  if (subject.kind === 'quote' && !value.eventKind.startsWith('quote-') || subject.kind === 'appointment' && !value.eventKind.startsWith('appointment-') || subject.kind === 'order' && (value.eventKind.startsWith('quote-') || value.eventKind.startsWith('appointment-'))) fail('eventKind does not match subject.kind');
  const amount = value.amount === undefined ? undefined : Number(value.amount);
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) fail('amount must be a non-negative integer');
  const currency = value.currency === undefined ? undefined : text(value.currency, 'currency', 3).toUpperCase();
  if ((amount === undefined) !== (currency === undefined) || currency !== undefined && !/^[A-Z]{3}$/u.test(currency)) fail('amount and ISO currency must be provided together');
  const amountBasis = value.amountBasis ?? (amount === undefined ? undefined : 'unknown');
  if (amountBasis !== undefined && !amountBases.has(amountBasis)) fail('amountBasis is unsupported');
  const occurredAt = instant(value.occurredAt, 'occurredAt');
  const observedAt = instant(value.observedAt, 'observedAt');
  const expectedAt = optionalInstant(value.expectedAt, 'expectedAt');
  const lineItemIds = strings(value.lineItemIds, 'lineItemIds');
  const materialChanges = strings(value.materialChanges, 'materialChanges', 12);
  const evidenceSelectors = strings(value.evidenceSelectors, 'evidenceSelectors');
  const subjectId = text(subject.id, 'subject.id', 300);
  const subjectNamespace = text(subject.namespace, 'subject.namespace', 300);
  const sourceValue = {
    system: text(source.system, 'source.system', 80),
    kind: source.kind === undefined ? 'transaction-event' : text(source.kind, 'source.kind', 80),
    externalId: text(source.externalId, 'source.externalId', 500),
    version: text(source.version, 'source.version', 300)
  };
  const observationId = `transaction:${hash(`${sourceValue.system}\u0000${sourceValue.kind}\u0000${sourceValue.externalId}\u0000${sourceValue.version}`).slice(0, 40)}`;
  const historicalBaseline = value.historicalBaseline === true;
  const observationType = value.eventKind.startsWith('quote-') ? 'quote' : value.eventKind === 'dispatch' ? 'dispatch' : value.eventKind.startsWith('delivery-') ? 'delivery' : value.eventKind.startsWith('appointment-') ? 'appointment' : 'order';
  const stableSubjectId = `${subject.kind}:${hash(JSON.stringify([subjectNamespace, subjectId])).slice(0, 40)}`;
  const loopKind = subject.kind === 'quote' || subject.kind === 'appointment' ? 'decision' : 'order';
  const title = text(value.summary, 'summary', 300);
  const isRevision = ['quote-revised', 'appointment-revised'].includes(value.eventKind);
  const isCancellation = value.eventKind === 'order-cancelled';
  const isPartial = value.eventKind === 'delivery-partial';
  const isComplete = value.eventKind === 'installation-complete' || value.eventKind === 'delivery-complete' && value.installationRequired !== true;
  const decisionNeeded = value.eventKind.startsWith('quote-') || value.eventKind.startsWith('appointment-');
  const state = isCancellation ? 'cancelled' : isComplete ? 'resolved' : decisionNeeded ? (isRevision ? 'decision-needed' : 'suggested') : value.eventKind === 'order-placed' ? 'confirmed' : 'monitoring';
  const expectedEvent = value.eventKind === 'dispatch' || isPartial ? 'remaining delivery' : value.eventKind === 'delivery-complete' && value.installationRequired === true ? 'installation' : decisionNeeded ? 'explicit decision' : value.eventKind === 'order-placed' ? 'dispatch or delivery' : undefined;
  const currentMaterialChange = !historicalBaseline && (isRevision || isCancellation || materialChanges.length > 0);
  const attention = currentMaterialChange ? {
    reason: 'material-change',
    whyNow: isCancellation ? 'The exact order source reports a cancellation.' : 'A newer source version changes information that may affect the existing plan.',
    actions: subject.kind === 'quote' ? ['Open quote', 'Compare versions', 'Record decision'] : subject.kind === 'appointment' ? ['Open appointment', 'Review change', 'Record decision'] : ['Open order', 'Review change', 'Remind me'],
    materialRevision: `${sourceValue.externalId}:${sourceValue.version}`,
    activated: true,
    currentEvidence: true
  } : { actions: [], activated: false, currentEvidence: !historicalBaseline };
  return Object.freeze({
    schemaVersion: 1,
    observation: Object.freeze({
      schemaVersion: 1,
      observationId,
      source: Object.freeze(sourceValue),
      type: observationType,
      occurredAt,
      observedAt,
      historicalBaseline,
      ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId', 300) }),
      entityRefs: Object.freeze([{ kind: subject.kind, id: `${subjectNamespace}:${subjectId}`, ...(value.supplier === undefined ? {} : { label: text(value.supplier, 'supplier', 200) }), evidence: Object.freeze(evidenceSelectors) }]),
      facts: Object.freeze({ eventKind: value.eventKind, subjectKind: subject.kind, subjectNamespace, subjectId, summary: title, ...(value.supplier === undefined ? {} : { supplier: text(value.supplier, 'supplier', 200) }), ...(amount === undefined ? {} : { amount, currency, amountBasis }), ...(expectedAt === undefined ? {} : { expectedAt }), installationRequired: value.installationRequired === true, lineItemIds, materialChanges, evidenceSelectors })
    }),
    loop: Object.freeze({
      schemaVersion: 1,
      loopId: `loop:${hash(`${loopKind}\u0000${stableSubjectId}`).slice(0, 40)}`,
      kind: loopKind,
      stableSubjectId,
      title,
      ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId', 300) }),
      state,
      ...(expectedAt === undefined ? {} : { dueAt: expectedAt }),
      ...(expectedEvent === undefined ? {} : { expectedEvent }),
      attention,
      evidenceObservationIds: Object.freeze([observationId]),
      revision: 1
    })
  });
}
