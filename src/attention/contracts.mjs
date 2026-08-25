import { createHash } from 'node:crypto';

export const ATTENTION_SCHEMA_VERSION = 1;
export const ATTENTION_STATES = Object.freeze(['Active', 'Snoozed', 'Action running', 'Resolved', 'Withdrawn']);
export const ATTENTION_SEVERITIES = Object.freeze(['Routine', 'High', 'Critical']);
export const ACTION_KINDS = Object.freeze(['navigation', 'mutation']);
export const APPROVAL_MODES = Object.freeze(['never', 'required', 'preauthorized']);

const occurrenceKeys = Object.freeze([
  'schemaVersion', 'sourceCapabilityId', 'stableSubjectId', 'attentionReason',
  'occurrenceId', 'unversioned', 'occurrenceVersion', 'occurredAt', 'topicId', 'sourceReferenceId',
  'evidenceFacts', 'transitionEvidence'
]);

const descriptorKeys = Object.freeze([
  'actionId', 'label', 'kind', 'targetResolver', 'parameterSchema', 'sideEffects',
  'approvalMode', 'idempotency', 'executor', 'authoritativeVerifier', 'successTransition'
]);

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function nonBlank(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-blank string`);
  return value;
}

function timestamp(value, field) {
  const result = nonBlank(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(result) || Number.isNaN(Date.parse(result))) throw new TypeError(`${field} must be an RFC 3339 instant`);
  return result;
}

function closed(value, keys, label) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, clone(item)]));
  return value;
}

export function canonicalize(value) {
  return clone(value);
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

export function normalizeOccurrence(input) {
  const value = objectValue(input, 'normalized occurrence');
  closed(value, occurrenceKeys, 'normalized occurrence');
  if (value.schemaVersion !== ATTENTION_SCHEMA_VERSION) throw new TypeError('schemaVersion must be 1');
  const hasOccurrenceId = typeof value.occurrenceId === 'string' && value.occurrenceId.trim() !== '';
  const isExplicitlyUnversioned = value.unversioned === true;
  if (hasOccurrenceId === isExplicitlyUnversioned) throw new TypeError('provide exactly one of occurrenceId or unversioned: true');
  if (isExplicitlyUnversioned && value.occurrenceVersion !== undefined) throw new TypeError('an explicitly unversioned occurrence cannot provide occurrenceVersion');
  const occurrence = {
    schemaVersion: ATTENTION_SCHEMA_VERSION,
    sourceCapabilityId: nonBlank(value.sourceCapabilityId, 'sourceCapabilityId'),
    stableSubjectId: nonBlank(value.stableSubjectId, 'stableSubjectId'),
    attentionReason: nonBlank(value.attentionReason, 'attentionReason'),
    occurredAt: timestamp(value.occurredAt, 'occurredAt'),
    ...(hasOccurrenceId ? { occurrenceId: nonBlank(value.occurrenceId, 'occurrenceId') } : { unversioned: true }),
    ...(value.occurrenceVersion === undefined ? {} : { occurrenceVersion: nonBlank(value.occurrenceVersion, 'occurrenceVersion') }),
    ...(value.topicId === undefined ? {} : { topicId: nonBlank(value.topicId, 'topicId') }),
    ...(value.sourceReferenceId === undefined ? {} : { sourceReferenceId: nonBlank(value.sourceReferenceId, 'sourceReferenceId') }),
    evidenceFacts: objectValue(value.evidenceFacts ?? {}, 'evidenceFacts'),
    ...(value.transitionEvidence === undefined || value.transitionEvidence === null ? {} : { transitionEvidence: objectValue(value.transitionEvidence, 'transitionEvidence') })
  };
  if (Object.hasOwn(value, 'severity') || Object.hasOwn(value, 'impactRank')) throw new TypeError('normalized occurrence does not accept severity');
  return Object.freeze(canonicalize(occurrence));
}

export const normalizeSourceOccurrence = normalizeOccurrence;
export const validateOccurrence = normalizeOccurrence;

export function occurrenceKey(occurrence) {
  return occurrence.occurrenceId
    ? `id:${occurrence.occurrenceId}`
    : `digest:${digest({ sourceCapabilityId: occurrence.sourceCapabilityId, stableSubjectId: occurrence.stableSubjectId, attentionReason: occurrence.attentionReason, occurredAt: occurrence.occurredAt, evidenceFacts: occurrence.evidenceFacts, transitionEvidence: occurrence.transitionEvidence })}`;
}

export function validateActionDescriptor(input) {
  const value = objectValue(input, 'action descriptor');
  closed(value, descriptorKeys, 'action descriptor');
  const descriptor = {
    actionId: nonBlank(value.actionId, 'actionId'),
    label: nonBlank(value.label, 'label'),
    kind: value.kind,
    targetResolver: value.targetResolver,
    parameterSchema: objectValue(value.parameterSchema, 'parameterSchema'),
    sideEffects: Array.isArray(value.sideEffects) ? value.sideEffects.map((item) => nonBlank(item, 'side effect')) : (() => { throw new TypeError('sideEffects must be an array'); })(),
    approvalMode: value.approvalMode,
    idempotency: objectValue(value.idempotency, 'idempotency'),
    executor: value.executor,
    authoritativeVerifier: value.authoritativeVerifier,
    successTransition: value.successTransition
  };
  if (!ACTION_KINDS.includes(descriptor.kind)) throw new TypeError('kind must be navigation or mutation');
  if (!APPROVAL_MODES.includes(descriptor.approvalMode)) throw new TypeError('approvalMode is invalid');
  if (descriptor.parameterSchema.type !== 'object' || descriptor.parameterSchema.additionalProperties !== false || (descriptor.parameterSchema.required !== undefined && !Array.isArray(descriptor.parameterSchema.required))) throw new TypeError('parameterSchema must be a closed object schema');
  for (const [field, expected] of [['targetResolver', 'function'], ['executor', 'function'], ['authoritativeVerifier', 'function'], ['successTransition', 'function']]) if (typeof descriptor[field] !== expected) throw new TypeError(`${field} must be a function`);
  closed(descriptor.idempotency, ['idempotent', 'transientRetryable'], 'idempotency');
  if (typeof descriptor.idempotency.idempotent !== 'boolean' || typeof descriptor.idempotency.transientRetryable !== 'boolean') throw new TypeError('idempotency disclosure must be closed booleans');
  return Object.freeze(descriptor);
}

export function validateActionInput(descriptor, input = {}) {
  const value = objectValue(input, 'action input');
  const properties = descriptor.parameterSchema.properties ?? {};
  const allowed = Object.keys(properties);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`action input contains unsupported field ${key}`);
  if (descriptor.parameterSchema.required) for (const key of descriptor.parameterSchema.required) if (!Object.hasOwn(value, key)) throw new TypeError(`action input is missing ${key}`);
  for (const [key, schema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key) || !schema || schema.type === undefined) continue;
    const valid = schema.type === 'string' ? typeof value[key] === 'string'
      : schema.type === 'integer' ? Number.isInteger(value[key])
        : schema.type === 'number' ? typeof value[key] === 'number' && Number.isFinite(value[key])
          : schema.type === 'boolean' ? typeof value[key] === 'boolean'
            : schema.type === 'object' ? value[key] !== null && typeof value[key] === 'object' && !Array.isArray(value[key])
              : schema.type === 'array' ? Array.isArray(value[key])
                : true;
    if (!valid || schema.minLength !== undefined && value[key].length < schema.minLength) throw new TypeError(`action input field ${key} has an invalid type`);
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.includes(value[key]))) throw new TypeError(`action input field ${key} has an invalid value`);
  }
  return Object.freeze(canonicalize(value));
}

export { occurrenceKeys, descriptorKeys };
