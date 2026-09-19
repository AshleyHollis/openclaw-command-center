import { createHash } from 'node:crypto';
import { normalizeLoop, normalizeObservation } from './contracts.mjs';

const SOURCE_KINDS = new Set(['document', 'session']);
const AVAILABILITY = new Set(['available', 'unavailable']);
const UNAVAILABLE_REASONS = new Set(['not-found', 'permission-revoked', 'temporarily-unavailable', 'version-replaced']);
const MAX_BATCH_SIZE = 20;
const MAX_CONTENT_BYTES = 32 * 1024;

const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
    : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const digest = value => `sha256:${hash(value)}`;
const stableId = parts => hash(parts).slice(0, 32);
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

function fail(message) { throw new TypeError(message); }
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}
function closed(value, keys, field) {
  object(value, field);
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra) fail(`${field} contains unsupported field ${extra}`);
  return value;
}
function text(value, field, maximum = 300) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) fail(`${field} must be a bounded non-blank string`);
  return value.trim();
}
function instant(value, field) {
  const result = text(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(result) || Number.isNaN(Date.parse(result))) fail(`${field} must be an RFC 3339 instant`);
  return result;
}
function optionalInstant(value, field) { return value === undefined ? undefined : instant(value, field); }
function enumValue(value, values, field) {
  if (!values.has(value)) fail(`${field} is unsupported`);
  return value;
}
function boundedContent(value) {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BYTES) fail(`content must be non-blank and at most ${MAX_CONTENT_BYTES} bytes`);
  return value.replace(/\r\n?/gu, '\n');
}

function labelled(content, label, maximum = 300) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = content.match(new RegExp(`^${escaped}\\s*:\\s*(.+)$`, 'imu'));
  if (!match) return undefined;
  return text(match[1], label, maximum);
}

function labelledAny(content, labels, maximum = 300) {
  for (const label of labels) {
    const value = labelled(content, label, maximum);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseAmount(content) {
  const raw = labelledAny(content, ['Amount due', 'Total due', 'Balance due'], 80);
  if (!raw) return {};
  const match = raw.match(/^([A-Z]{3})\s+([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(?:\.([0-9]{2}))?$/u);
  if (!match) return {};
  const major = Number(match[2].replaceAll(',', ''));
  const minor = Number(match[3] ?? '00');
  const amount = major * 100 + minor;
  if (!Number.isSafeInteger(amount)) return {};
  return { amount, currency: match[1] };
}

function interpretAvailableContent(content) {
  const invoiceId = labelledAny(content, ['Invoice', 'Invoice number', 'Invoice no.', 'Invoice #'], 300);
  const accountId = labelledAny(content, ['Account', 'Account number'], 300);
  const authorityId = labelled(content, 'Authority', 300);
  const payee = labelledAny(content, ['Payee', 'Supplier', 'Vendor', 'Biller'], 200);
  const purpose = labelledAny(content, ['Purpose', 'Description', 'For'], 300);
  const dueRaw = labelledAny(content, ['Due', 'Due date', 'Payment due'], 64);
  const dueAt = dueRaw && /^\d{4}-\d{2}-\d{2}T/u.test(dueRaw) && !Number.isNaN(Date.parse(dueRaw)) ? instant(dueRaw, 'Due') : undefined;
  const amount = parseAmount(content);
  const explicitPaymentRequest = /(?:^|[.!?]\s+)(?:please pay|payment is due)\b/iu.test(content) || /^(?:Amount due|Total due|Balance due)\s*:/imu.test(content);
  if (!invoiceId || !explicitPaymentRequest) return freeze({ kind: 'informational' });
  return freeze({
    kind: 'payment-request',
    invoiceId,
    ...(accountId ? { accountId } : {}),
    ...(authorityId ? { authorityId } : {}),
    ...(payee ? { payee } : {}),
    ...(purpose ? { purpose } : {}),
    ...amount,
    ...(dueAt ? { dueAt } : {})
  });
}

function normalizeAuthorization(input) {
  const value = closed(input, ['scopeId', 'sourceSystem', 'sourceKind', 'resourceId'], 'authorization');
  return freeze({
    scopeId: text(value.scopeId, 'authorization.scopeId', 300),
    sourceSystem: text(value.sourceSystem, 'authorization.sourceSystem', 80),
    sourceKind: enumValue(value.sourceKind, SOURCE_KINDS, 'authorization.sourceKind'),
    resourceId: text(value.resourceId, 'authorization.resourceId', 500)
  });
}

function laneIdFor(authorization) {
  return `selected-source:${stableId([authorization.scopeId, authorization.sourceSystem, authorization.sourceKind, authorization.resourceId])}`;
}

export function normalizeSelectedSourceCheckpoint(input, authorization) {
  if (input === undefined || input === null) return null;
  const value = closed(input, ['schemaVersion', 'laneId', 'scopeId', 'sourceSystem', 'sourceKind', 'resourceId', 'cursor', 'processedCount', 'lastObservedAt', 'lastAvailableAt', 'freshness', 'digest'], 'checkpoint');
  const normalized = {
    schemaVersion: 1,
    laneId: text(value.laneId, 'checkpoint.laneId', 300),
    scopeId: text(value.scopeId, 'checkpoint.scopeId', 300),
    sourceSystem: text(value.sourceSystem, 'checkpoint.sourceSystem', 80),
    sourceKind: enumValue(value.sourceKind, SOURCE_KINDS, 'checkpoint.sourceKind'),
    resourceId: text(value.resourceId, 'checkpoint.resourceId', 500),
    cursor: text(value.cursor, 'checkpoint.cursor', 500),
    processedCount: Number(value.processedCount),
    lastObservedAt: instant(value.lastObservedAt, 'checkpoint.lastObservedAt'),
    ...(value.lastAvailableAt === undefined ? {} : { lastAvailableAt: instant(value.lastAvailableAt, 'checkpoint.lastAvailableAt') }),
    freshness: enumValue(value.freshness, new Set(['available', 'unavailable']), 'checkpoint.freshness')
  };
  if (!Number.isSafeInteger(normalized.processedCount) || normalized.processedCount < 0) fail('checkpoint.processedCount must be a non-negative safe integer');
  const expectedDigest = digest(normalized);
  if (value.digest !== expectedDigest) fail('checkpoint digest does not match its canonical contents');
  const expectedLane = laneIdFor(authorization);
  if (normalized.laneId !== expectedLane || normalized.scopeId !== authorization.scopeId || normalized.sourceSystem !== authorization.sourceSystem || normalized.sourceKind !== authorization.sourceKind || normalized.resourceId !== authorization.resourceId) fail('checkpoint does not belong to this authorized source lane');
  return freeze({ ...normalized, digest: expectedDigest });
}

function normalizeSelection(input, authorization) {
  const value = closed(input, ['version', 'occurredAt', 'observedAt', 'availability', 'unavailableReason', 'content', 'correctsVersion', 'topicId'], 'selection');
  const availability = enumValue(value.availability, AVAILABILITY, 'selection.availability');
  if (availability === 'available' && (value.content === undefined || value.unavailableReason !== undefined)) fail('available selections require content and cannot include unavailableReason');
  if (availability === 'unavailable' && (value.content !== undefined || value.unavailableReason === undefined)) fail('unavailable selections require unavailableReason and cannot include content');
  const version = text(value.version, 'selection.version', 300);
  const correctsVersion = value.correctsVersion === undefined ? undefined : text(value.correctsVersion, 'selection.correctsVersion', 300);
  if (correctsVersion === version) fail('a source version cannot correct itself');
  return freeze({
    version,
    occurredAt: instant(value.occurredAt, 'selection.occurredAt'),
    observedAt: instant(value.observedAt, 'selection.observedAt'),
    availability,
    ...(availability === 'available' ? { content: boundedContent(value.content) } : { unavailableReason: enumValue(value.unavailableReason, UNAVAILABLE_REASONS, 'selection.unavailableReason') }),
    ...(correctsVersion ? { correctsVersion } : {}),
    ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'selection.topicId', 300) }),
    source: freeze({ system: authorization.sourceSystem, kind: authorization.sourceKind, externalId: authorization.resourceId, version })
  });
}

export function normalizeSelectedSourceBatch(input) {
  const value = closed(input, ['schemaVersion', 'logicalOperationId', 'authorization', 'baselineThrough', 'checkpoint', 'window', 'selections'], 'selected-source batch');
  if (value.schemaVersion !== 1) fail('selected-source batch schemaVersion must be 1');
  const authorization = normalizeAuthorization(value.authorization);
  const checkpoint = normalizeSelectedSourceCheckpoint(value.checkpoint, authorization);
  const window = closed(value.window, ['cursor', 'nextCursor', 'hasMore'], 'window');
  const cursor = text(window.cursor, 'window.cursor', 500);
  const nextCursor = text(window.nextCursor, 'window.nextCursor', 500);
  if (typeof window.hasMore !== 'boolean') fail('window.hasMore must be boolean');
  if (checkpoint && checkpoint.cursor !== cursor) fail('window cursor must continue from the supplied checkpoint');
  if (!Array.isArray(value.selections) || value.selections.length < 1 || value.selections.length > MAX_BATCH_SIZE) fail(`selections must contain between 1 and ${MAX_BATCH_SIZE} items`);
  const selections = value.selections.map(item => normalizeSelection(item, authorization));
  const identities = selections.map(item => `${item.source.externalId}\u0000${item.version}`);
  if (new Set(identities).size !== identities.length) fail('a batch cannot repeat a source version');
  for (let index = 1; index < selections.length; index += 1) {
    if (Date.parse(selections[index].observedAt) < Date.parse(selections[index - 1].observedAt)) fail('selections must be ordered by observedAt');
  }
  return freeze({
    schemaVersion: 1,
    logicalOperationId: text(value.logicalOperationId, 'logicalOperationId', 300),
    authorization,
    baselineThrough: instant(value.baselineThrough, 'baselineThrough'),
    checkpoint,
    window: freeze({ cursor, nextCursor, hasMore: window.hasMore }),
    selections: freeze(selections)
  });
}

export function planSelectedSourceSelection(selectionInput, { authorization: authorizationInput, baselineThrough }) {
  const authorization = normalizeAuthorization(authorizationInput);
  const selection = normalizeSelection(selectionInput, authorization);
  const historicalBaseline = Date.parse(selection.occurredAt) <= Date.parse(instant(baselineThrough, 'baselineThrough'));
  const sourceIdentity = [selection.source.system, selection.source.kind, selection.source.externalId, selection.source.version];
  const observationId = `selected-source-observation:${stableId(sourceIdentity)}`;
  const provenance = {
    authorization: {
      scopeId: authorization.scopeId,
      sourceSystem: authorization.sourceSystem,
      sourceKind: authorization.sourceKind,
      resourceId: authorization.resourceId
    },
    availability: selection.availability,
    ...(selection.correctsVersion ? { correctsVersion: selection.correctsVersion } : {})
  };

  if (selection.availability === 'unavailable') {
    const observation = normalizeObservation({
      schemaVersion: 1,
      observationId,
      source: selection.source,
      type: 'general',
      occurredAt: selection.occurredAt,
      observedAt: selection.observedAt,
      historicalBaseline,
      ...(selection.topicId ? { topicId: selection.topicId } : {}),
      facts: { ...provenance, unavailableReason: selection.unavailableReason }
    });
    return freeze({ schemaVersion: 1, selection, interpretation: null, observation, loop: null, freshness: { status: 'unavailable', observedAt: selection.observedAt } });
  }

  const interpretation = interpretAvailableContent(selection.content);
  const contentDigest = digest(selection.content);
  const facts = { ...provenance, contentDigest, interpretation };
  const entityRefs = interpretation.kind === 'payment-request'
    ? Object.entries({ invoice: interpretation.invoiceId, account: interpretation.accountId }).flatMap(([kind, id]) => id ? [{ kind, id, evidence: [`content:${contentDigest}`] }] : [])
    : [];
  const observation = normalizeObservation({
    schemaVersion: 1,
    observationId,
    source: selection.source,
    type: interpretation.kind === 'payment-request' ? 'bill' : 'general',
    occurredAt: selection.occurredAt,
    observedAt: selection.observedAt,
    historicalBaseline,
    ...(selection.topicId ? { topicId: selection.topicId } : {}),
    entityRefs,
    facts
  });
  if (interpretation.kind !== 'payment-request') return freeze({ schemaVersion: 1, selection, interpretation, observation, loop: null, freshness: { status: 'available', observedAt: selection.observedAt } });

  const authority = interpretation.authorityId ?? authorization.sourceSystem;
  const account = interpretation.accountId ?? 'unscoped';
  const stableSubjectId = `invoice:${stableId([authority, account, interpretation.invoiceId])}`;
  const actions = ['Open original', 'Record payment', 'Remind me', 'Review or query'];
  const currentEvidence = !historicalBaseline;
  const title = ['Pay', interpretation.purpose ?? 'invoice', interpretation.payee ? `from ${interpretation.payee}` : ''].filter(Boolean).join(' ');
  const loop = normalizeLoop({
    schemaVersion: 1,
    loopId: `open-loop:${stableId(['payment', stableSubjectId])}`,
    kind: 'payment',
    stableSubjectId,
    title,
    ...(selection.topicId ? { topicId: selection.topicId } : {}),
    state: 'confirmed',
    paymentState: 'unpaid',
    ...(interpretation.amount === undefined ? {} : { amount: interpretation.amount, currency: interpretation.currency }),
    ...(interpretation.dueAt === undefined ? {} : { dueAt: interpretation.dueAt }),
    attention: interpretation.dueAt === undefined && currentEvidence
      ? { reason: 'material-change', whyNow: 'The selected source explicitly requests payment and has no accepted due date.', actions, activated: true, currentEvidence: true }
      : { actions, activated: true, currentEvidence },
    evidenceObservationIds: [observation.observationId],
    revision: 1
  });
  return freeze({ schemaVersion: 1, selection, interpretation, observation, loop, freshness: { status: 'available', observedAt: selection.observedAt } });
}

export function createSelectedSourceCheckpoint({ authorization: authorizationInput, cursor, previous, plans }) {
  const authorization = normalizeAuthorization(authorizationInput);
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > MAX_BATCH_SIZE) fail('checkpoint plans must be a bounded non-empty array');
  const latest = plans.at(-1);
  const available = [...plans].reverse().find(plan => plan.freshness.status === 'available');
  const prior = normalizeSelectedSourceCheckpoint(previous, authorization);
  const normalized = {
    schemaVersion: 1,
    laneId: laneIdFor(authorization),
    scopeId: authorization.scopeId,
    sourceSystem: authorization.sourceSystem,
    sourceKind: authorization.sourceKind,
    resourceId: authorization.resourceId,
    cursor: text(cursor, 'cursor', 500),
    processedCount: (prior?.processedCount ?? 0) + plans.length,
    lastObservedAt: latest.freshness.observedAt,
    ...((available?.freshness.observedAt ?? prior?.lastAvailableAt) ? { lastAvailableAt: available?.freshness.observedAt ?? prior.lastAvailableAt } : {}),
    freshness: latest.freshness.status
  };
  return freeze({ ...normalized, digest: digest(normalized) });
}

export function planSelectedSourceBatch(input) {
  const batch = normalizeSelectedSourceBatch(input);
  const plans = batch.selections.map(selection => {
    const { source: _source, ...rawSelection } = selection;
    return planSelectedSourceSelection(rawSelection, { authorization: batch.authorization, baselineThrough: batch.baselineThrough });
  });
  const checkpoint = createSelectedSourceCheckpoint({ authorization: batch.authorization, cursor: batch.window.nextCursor, previous: batch.checkpoint, plans });
  return freeze({ schemaVersion: 1, batch, plans: freeze(plans), checkpoint });
}

export const SELECTED_SOURCE_BATCH_LIMIT = MAX_BATCH_SIZE;
export const SELECTED_SOURCE_CONTENT_LIMIT = MAX_CONTENT_BYTES;
