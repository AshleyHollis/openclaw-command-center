export class SourceServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SourceServiceError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function sourceError(code, message, details = {}) {
  return new SourceServiceError(code, message, details);
}

export function errorResult(error, { requestId = null, logicalOperationId = null } = {}) {
  const trusted = error instanceof SourceServiceError;
  const allowedCodes = new Set(['invalid-request', 'unsupported-version', 'unauthenticated', 'capability-unavailable', 'source-recovery', 'unsafe-path', 'invalid-path', 'not-found', 'cross-topic', 'conflict', 'intent-mismatch', 'not-applied', 'unknown', 'recovery-only', 'unavailable']);
  const code = trusted && allowedCodes.has(error.code) ? error.code : 'unavailable';
  const status = ['conflict', 'not-applied', 'unknown', 'unavailable', 'recovery-only'].includes(code) ? code : 'unavailable';
  const safeMessages = {
    unavailable: 'The authoritative source request is unavailable.',
    unknown: 'Mutation delivery remains ambiguous.',
    'capability-unavailable': 'The requested authoritative source capability is unavailable.'
  };
  return Object.freeze({
    code,
    message: safeMessages[code] ?? String(error.message).slice(0, 300),
    details: Object.freeze({
      schemaVersion: 1,
      status,
      requestId,
      logicalOperationId,
      ...(trusted && error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
      ...(trusted && error.currentPath !== undefined ? { currentPath: error.currentPath } : {}),
      ...(trusted && error.capability !== undefined ? { capability: error.capability } : {})
    })
  });
}

export function assertNoUnexpectedKeys(value, keys, label = 'request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('invalid-request', `${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw sourceError('invalid-request', `${label} contains unsupported field ${key}`);
}

export function nonBlank(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw sourceError('invalid-request', `${field} must be a non-blank string`);
  return value;
}
