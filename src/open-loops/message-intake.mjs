import { createHash } from 'node:crypto';
import { normalizeLoop, normalizeObservation } from './contracts.mjs';

const dispositions = new Set(['informational', 'explicit-request', 'potential-obligation', 'confirmed-obligation', 'source-reminder']);
const requestKinds = new Set(['none', 'reply', 'payment', 'review', 'form', 'confirm-appointment']);
const channels = new Set(['email', 'sms']);
const keys = new Set([
  'schemaVersion', 'channel', 'source', 'occurredAt', 'observedAt', 'historicalBaseline', 'topicId',
  'disposition', 'requestKind', 'explicitRequest', 'summary', 'payee', 'purpose', 'amount',
  'currency', 'dueAt', 'deadlineAt', 'authorityId', 'invoiceId', 'accountId', 'obligationId', 'conversationId',
  'appointmentId', 'attachmentIds', 'evidenceSelectors'
]);
const sourceKeys = new Set(['system', 'externalId', 'version']);

function fail(message) { throw new TypeError(message); }
function text(value, field, maximum = 300) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail(`${field} must be a non-blank string of at most ${maximum} characters`);
  return value.trim();
}
function optionalText(value, field, maximum = 300) { return value === undefined || value === null ? undefined : text(value, field, maximum); }
function timestamp(value, field) {
  const result = text(value, field, 64);
  if (Number.isNaN(Date.parse(result))) fail(`${field} must be a valid instant`);
  return result;
}
function stringList(value, field, maximum) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(`${field} must be an array of at most ${maximum} strings`);
  const result = value.map((item, index) => text(item, `${field}[${index}]`, 300));
  if (new Set(result).size !== result.length) fail(`${field} must not contain duplicates`);
  return result;
}
function closed(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const extra = Object.keys(value).find(key => !allowed.has(key));
  if (extra) fail(`${field} contains unsupported field ${extra}`);
  return value;
}
function stableId(parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32); }

export function normalizeMessageIntake(input) {
  const value = closed(input, keys, 'message intake');
  if (value.schemaVersion !== 1 || !channels.has(value.channel) || !dispositions.has(value.disposition) || !requestKinds.has(value.requestKind)) fail('message intake vocabulary is unsupported');
  if (typeof value.explicitRequest !== 'boolean' || typeof value.historicalBaseline !== 'boolean') fail('message intake flags must be boolean');
  const source = closed(value.source, sourceKeys, 'message source');
  const amount = value.amount === undefined || value.amount === null ? undefined : Number(value.amount);
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) fail('amount must be a non-negative integer in minor currency units');
  const currency = optionalText(value.currency, 'currency', 3)?.toUpperCase();
  if ((amount === undefined) !== (currency === undefined) || currency !== undefined && !/^[A-Z]{3}$/u.test(currency)) fail('amount and ISO currency must be provided together');
  if (value.disposition === 'informational' && (value.explicitRequest || value.requestKind !== 'none')) fail('informational messages cannot claim a request');
  if (value.disposition === 'explicit-request' && (!value.explicitRequest || value.requestKind === 'none')) fail('explicit requests require an action kind');
  if (['potential-obligation', 'confirmed-obligation', 'source-reminder'].includes(value.disposition) && value.requestKind !== 'payment') fail('payment obligations require requestKind payment');
  if (value.requestKind === 'payment' && !['potential-obligation', 'confirmed-obligation', 'source-reminder'].includes(value.disposition)) fail('payment requests require an obligation disposition');
  if (value.dueAt !== undefined && value.requestKind !== 'payment') fail('dueAt belongs to a payment obligation');
  if (value.deadlineAt !== undefined && value.requestKind === 'payment') fail('payment deadlines use dueAt');
  return Object.freeze({
    schemaVersion: 1,
    channel: value.channel,
    source: Object.freeze({ system: text(source.system, 'source.system', 80), externalId: text(source.externalId, 'source.externalId', 500), version: text(source.version, 'source.version', 300) }),
    occurredAt: timestamp(value.occurredAt, 'occurredAt'),
    observedAt: timestamp(value.observedAt, 'observedAt'),
    historicalBaseline: value.historicalBaseline,
    ...(value.topicId === undefined ? {} : { topicId: text(value.topicId, 'topicId') }),
    disposition: value.disposition,
    requestKind: value.requestKind,
    explicitRequest: value.explicitRequest,
    summary: text(value.summary, 'summary'),
    ...(value.payee === undefined ? {} : { payee: text(value.payee, 'payee', 200) }),
    ...(value.purpose === undefined ? {} : { purpose: text(value.purpose, 'purpose', 300) }),
    ...(amount === undefined ? {} : { amount, currency }),
    ...(value.dueAt === undefined ? {} : { dueAt: timestamp(value.dueAt, 'dueAt') }),
    ...(value.deadlineAt === undefined ? {} : { deadlineAt: timestamp(value.deadlineAt, 'deadlineAt') }),
    ...Object.fromEntries(['authorityId', 'invoiceId', 'accountId', 'obligationId', 'conversationId', 'appointmentId'].flatMap(field => value[field] === undefined ? [] : [[field, text(value[field], field, 300)]])),
    attachmentIds: Object.freeze(stringList(value.attachmentIds, 'attachmentIds', 16)),
    evidenceSelectors: Object.freeze(stringList(value.evidenceSelectors, 'evidenceSelectors', 24))
  });
}

function subjectFor(value) {
  if (value.requestKind === 'payment') {
    const authority = value.authorityId ?? value.source.system;
    const account = value.accountId ?? 'unscoped';
    if (value.invoiceId) return `invoice:${stableId([authority, account, value.invoiceId])}`;
    if (value.obligationId) return `obligation:${stableId([authority, account, value.obligationId])}`;
  }
  if (value.conversationId) return `conversation:${value.conversationId}`;
  if (value.appointmentId) return `appointment:${value.appointmentId}`;
  return `source:${value.source.system}:${value.channel}:${value.source.externalId}`;
}

export function planMessageIntake(input) {
  const value = normalizeMessageIntake(input);
  const observationId = `message-observation:${stableId([value.source.system, value.channel, value.source.externalId, value.source.version])}`;
  const facts = {
    disposition: value.disposition,
    requestKind: value.requestKind,
    explicitRequest: value.explicitRequest,
    summary: value.summary,
    ...Object.fromEntries(['payee', 'purpose', 'amount', 'currency', 'dueAt', 'deadlineAt', 'authorityId', 'invoiceId', 'accountId', 'obligationId', 'conversationId', 'appointmentId'].flatMap(field => value[field] === undefined ? [] : [[field, value[field]]])),
    attachmentIds: value.attachmentIds,
    evidenceSelectors: value.evidenceSelectors
  };
  const observationType = value.requestKind === 'payment' ? (value.disposition === 'source-reminder' ? 'payment-request' : 'bill')
    : value.requestKind === 'reply' || value.requestKind === 'confirm-appointment' ? 'reply-request'
      : value.requestKind === 'none' ? 'general' : 'decision-evidence';
  const observation = normalizeObservation({
    schemaVersion: 1,
    observationId,
    source: { system: value.source.system, kind: value.channel, externalId: value.source.externalId, version: value.source.version },
    type: observationType,
    occurredAt: value.occurredAt,
    observedAt: value.observedAt,
    historicalBaseline: value.historicalBaseline,
    ...(value.topicId === undefined ? {} : { topicId: value.topicId }),
    entityRefs: [
      ...Object.entries({ invoice: value.invoiceId, account: value.accountId, obligation: value.obligationId, conversation: value.conversationId, appointment: value.appointmentId }).flatMap(([kind, id]) => id === undefined ? [] : [{ kind, id, evidence: value.evidenceSelectors }])
    ],
    facts
  });
  if (value.disposition === 'informational') return Object.freeze({ schemaVersion: 1, observation, loop: null });

  const subject = subjectFor(value);
  const currentEvidence = !value.historicalBaseline;
  const isPayment = value.requestKind === 'payment';
  const suggested = value.disposition === 'potential-obligation' || value.disposition === 'source-reminder';
  const actions = isPayment
    ? suggested ? ['Open original', 'Confirm obligation', 'Dismiss suggestion'] : ['Open bill', 'Record payment', 'Remind me', 'Review or query']
    : ['Open original', value.requestKind === 'reply' || value.requestKind === 'confirm-appointment' ? 'Draft reply' : 'Review request', 'Remind me'];
  let attention;
  if (!suggested && currentEvidence && (!isPayment || !value.dueAt)) attention = { reason: isPayment ? 'material-change' : value.requestKind === 'reply' || value.requestKind === 'confirm-appointment' ? 'response-requested' : 'decision-requested', whyNow: value.summary, actions, activated: true, currentEvidence: true };
  else attention = { actions, activated: !suggested, currentEvidence };
  const title = isPayment ? [suggested ? 'Review' : 'Pay', value.purpose ?? 'payment request', value.payee ? `from ${value.payee}` : ''].filter(Boolean).join(' ') : value.summary;
  const loop = normalizeLoop({
    schemaVersion: 1,
    loopId: `open-loop:${stableId([isPayment ? 'payment' : 'response', subject])}`,
    kind: isPayment ? 'payment' : value.requestKind === 'reply' || value.requestKind === 'confirm-appointment' ? 'response' : 'decision',
    stableSubjectId: subject,
    title,
    ...(value.topicId === undefined ? {} : { topicId: value.topicId }),
    state: suggested ? 'suggested' : 'confirmed',
    ...(isPayment ? { paymentState: suggested ? 'potential' : 'unpaid' } : {}),
    ...(value.amount === undefined ? {} : { amount: value.amount, currency: value.currency }),
    ...(value.dueAt === undefined ? {} : { dueAt: value.dueAt }),
    ...(value.deadlineAt === undefined ? {} : { dueAt: value.deadlineAt }),
    attention,
    evidenceObservationIds: [observation.observationId],
    revision: 1
  });
  return Object.freeze({ schemaVersion: 1, observation, loop });
}
