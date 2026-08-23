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
