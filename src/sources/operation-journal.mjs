import { sourceError, nonBlank } from './errors.mjs';

export class OperationJournal {
  constructor({ metadata } = {}) {
    this.metadata = metadata;
    this.memory = new Map();
  }

  get(logicalOperationId) {
    return this.metadata?.getOperation?.(logicalOperationId) ?? this.memory.get(logicalOperationId) ?? null;
  }

  record(value) {
    const existing = this.get(value.logicalOperationId);
    if (existing && existing.intentDigest !== value.intentDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different intent.');
    if (this.metadata?.recordOperation) return this.metadata.recordOperation(value);
    const result = Object.freeze({ ...existing, ...value });
    this.memory.set(value.logicalOperationId, result);
    return result;
  }
}

export function isCanonicalUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

export function assertLogicalOperationId(value) {
  if (!isCanonicalUuid(value)) throw sourceError('invalid-request', 'logicalOperationId must be a canonical UUID.');
  return value.toLowerCase();
}

export function validateMutationEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('invalid-request', 'Mutation envelope must be an object.');
  const keys = ['version', 'transportRequestId', 'logicalOperationId', 'action', 'topicId', 'referenceId', 'input'];
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw sourceError('invalid-request', `Mutation envelope contains unsupported field ${key}`);
  if (value.version !== 1) throw sourceError('unsupported-version', 'Mutation envelope version must be 1.');
  const envelope = {
    version: 1,
    transportRequestId: nonBlank(value.transportRequestId, 'transportRequestId'),
    logicalOperationId: assertLogicalOperationId(value.logicalOperationId),
    action: nonBlank(value.action, 'action'),
    topicId: nonBlank(value.topicId, 'topicId'),
    ...(value.referenceId === undefined ? {} : { referenceId: nonBlank(value.referenceId, 'referenceId') }),
    input: value.input
  };
  if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input)) throw sourceError('invalid-request', 'Mutation envelope input must be an object.');
  return Object.freeze(envelope);
}

export function isAmbiguousMutationError(error) {
  return error?.ambiguous === true || ['timeout', 'unavailable', 'delivery-unknown', 'ambiguous'].includes(error?.code);
}

export function isRetryableReadError(error) {
  return ['timeout', 'unavailable'].includes(error?.code) || error?.retryable === true;
}
