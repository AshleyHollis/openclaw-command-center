import { createHash } from 'node:crypto';
import { sourceError, assertNoUnexpectedKeys, nonBlank } from './errors.mjs';

export const SOURCE_REFERENCE_SCHEMA_VERSION = 1;
const referenceKeys = Object.freeze(['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt', 'updatedAt']);

export function validateSourceReference(value) {
  assertNoUnexpectedKeys(value, referenceKeys, 'Source Reference');
  if (value.version !== SOURCE_REFERENCE_SCHEMA_VERSION) throw sourceError('unsupported-version', 'Source Reference version must be 1.');
  const result = {
    version: 1,
    referenceId: nonBlank(value.referenceId, 'referenceId'),
    topicId: nonBlank(value.topicId, 'topicId'),
    sourceSystem: nonBlank(value.sourceSystem, 'sourceSystem'),
    sourceKind: nonBlank(value.sourceKind, 'sourceKind'),
    externalSourceId: nonBlank(value.externalSourceId, 'externalSourceId'),
    observedRevision: value.observedRevision,
    createdAt: nonBlank(value.createdAt, 'createdAt'),
    updatedAt: nonBlank(value.updatedAt, 'updatedAt')
  };
  if (result.observedRevision !== null && (typeof result.observedRevision !== 'string' || result.observedRevision.trim() === '')) {
    throw sourceError('invalid-request', 'observedRevision must be a source-issued string or null');
  }
  return Object.freeze(result);
}

export function createSourceReference(input) {
  const createdAt = input?.createdAt ?? new Date().toISOString();
  return validateSourceReference({ version: 1, observedRevision: null, ...input, createdAt, updatedAt: input?.updatedAt ?? createdAt });
}

export function sourceIdentity(reference) {
  const value = validateSourceReference(reference);
  return `${value.sourceSystem}\u0000${value.sourceKind}\u0000${value.externalSourceId}`;
}

export function sameSourceIdentity(left, right) {
  try { return sourceIdentity(left) === sourceIdentity(right); } catch { return false; }
}

export function revisionForBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function intentDigest(input) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    return value;
  };
  const canonical = JSON.stringify(canonicalize(input));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
