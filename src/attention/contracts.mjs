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
  if (descriptor.parameterSchema.type !== 'object' || descriptor.parameterSchema.additionalProperties !== false) throw new TypeError('parameterSchema must be a closed object schema');
  validateParameterSchema(descriptor.parameterSchema);
  for (const [field, expected] of [['targetResolver', 'function'], ['executor', 'function'], ['authoritativeVerifier', 'function'], ['successTransition', 'function']]) if (typeof descriptor[field] !== expected) throw new TypeError(`${field} must be a function`);
  closed(descriptor.idempotency, ['idempotent', 'transientRetryable'], 'idempotency');
  if (typeof descriptor.idempotency.idempotent !== 'boolean' || typeof descriptor.idempotency.transientRetryable !== 'boolean') throw new TypeError('idempotency disclosure must be closed booleans');
  return Object.freeze(descriptor);
}

const schemaKeys = Object.freeze(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength']);
const schemaTypes = Object.freeze(['object', 'array', 'string', 'integer', 'number', 'boolean']);

function validateParameterSchema(schema, path = 'parameterSchema') {
  objectValue(schema, path);
  closed(schema, schemaKeys, path);
  if (schema.type !== undefined && !schemaTypes.includes(schema.type)) throw new TypeError(`${path}.type is unsupported`);
  if (schema.type === undefined && schema.enum === undefined) throw new TypeError(`${path} requires a type or enum`);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some((item) => item !== null && !['string', 'boolean'].includes(typeof item) && !(typeof item === 'number' && Number.isFinite(item))))) throw new TypeError(`${path}.enum must contain JSON primitive values`);
  if (schema.minLength !== undefined && (schema.type !== 'string' || !Number.isInteger(schema.minLength) || schema.minLength < 0)) throw new TypeError(`${path}.minLength requires a nonnegative string length`);
  if (schema.type === 'object') {
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new TypeError(`${path}.additionalProperties must be a boolean`);
    const properties = schema.properties === undefined ? {} : objectValue(schema.properties, `${path}.properties`);
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key)))) throw new TypeError(`${path}.required must name declared properties`);
    if (schema.items !== undefined) throw new TypeError(`${path}.items is unsupported for an object`);
    for (const [key, child] of Object.entries(properties)) validateParameterSchema(child, `${path}.properties.${key}`);
  } else if (schema.type === 'array') {
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) throw new TypeError(`${path} contains object-only constraints`);
    if (schema.items !== undefined) validateParameterSchema(schema.items, `${path}.items`);
  } else if (['properties', 'required', 'additionalProperties', 'items'].some((key) => schema[key] !== undefined)) throw new TypeError(`${path} contains constraints incompatible with its type`);
}

function validateInputValue(value, schema, path) {
  const valid = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'string' ? typeof value === 'string'
        : schema.type === 'integer' ? Number.isInteger(value)
          : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : schema.type === 'boolean' ? typeof value === 'boolean' : true;
  if (!valid) throw new TypeError(`${path} has an invalid type`);
  if (schema.enum !== undefined && !schema.enum.some((item) => Object.is(item, value))) throw new TypeError(`${path} has an invalid value`);
  if (schema.minLength !== undefined && value.length < schema.minLength) throw new TypeError(`${path} must have at least ${schema.minLength} characters`);
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) throw new TypeError(`${path} contains unsupported field ${key}`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new TypeError(`${path} is missing ${key}`);
    for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(value, key)) validateInputValue(value[key], child, `${path}.${key}`);
  }
  if (schema.type === 'array' && schema.items) for (let index = 0; index < value.length; index += 1) validateInputValue(value[index], schema.items, `${path}[${index}]`);
}

export function validateActionInput(descriptor, input = {}) {
  validateInputValue(input, descriptor.parameterSchema, 'action input');
  return Object.freeze(canonicalize(input));
}

export { occurrenceKeys, descriptorKeys };
