import { sourceError } from './errors.mjs';

export const SOURCE_CAPABILITIES = Object.freeze(['notes', 'sessions', 'scheduler', 'activity', 'analysis', 'attention', 'search']);

export function normalizeSourceCapabilities(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw sourceError('invalid-capability', 'capabilities must be an object');
  for (const key of Object.keys(input)) if (!SOURCE_CAPABILITIES.includes(key)) throw sourceError('invalid-capability', `Unsupported capability: ${key}`);
  const result = {};
  for (const key of SOURCE_CAPABILITIES) {
    if (!(key in input)) { result[key] = Object.freeze({ available: false }); continue; }
    const value = input[key];
    if (value === true || value === 'available' || value?.available === true) result[key] = Object.freeze({ available: true });
    else if (value === false || value === 'unavailable' || value?.available === false || value === 'missing') result[key] = Object.freeze({ available: false });
    else throw sourceError('invalid-capability', `Capability ${key} must report available or unavailable`);
  }
  return Object.freeze(result);
}
export function requireCapability(capabilities, capability) {
  if (capabilities?.[capability]?.available !== true) throw sourceError('capability-unavailable', `${capability} capability is unavailable.`, { capability });
}

export function capabilityDiagnostics(capabilities = {}) {
  return Object.freeze(SOURCE_CAPABILITIES.filter((key) => capabilities[key]?.available === false).map((capability) => Object.freeze({
    code: `capability-${capability}-unavailable`,
    capability,
    mode: 'degraded',
    summary: `${capability} capability is unavailable.`,
    explanation: `${capability} capability is unavailable.`,
    remediation: `Restore the ${capability} capability before using dependent operations.`
  })));
}

export function createSourceCapabilityRegistry({ attention } = {}) {
  if (!attention || typeof attention.registerSourceCapability !== 'function' || typeof attention.ingest !== 'function') throw sourceError('invalid-capability', 'Attention service is required.');
  const registered = new Set();
  return Object.freeze({
    register(capability) {
      const id = String(capability?.sourceCapabilityId ?? '').trim();
      if (!id) throw sourceError('invalid-capability', 'sourceCapabilityId must be a non-blank string.');
      if (registered.has(id)) throw sourceError('invalid-capability', 'Source capability is already registered.');
      attention.registerSourceCapability(capability);
      registered.add(id);
      return id;
    },
    ingest(occurrence) {
      if (!registered.has(occurrence?.sourceCapabilityId)) throw sourceError('capability-unavailable', 'Source capability is not registered.', { capability: occurrence?.sourceCapabilityId });
      return attention.ingest(occurrence);
    }
  });
}
