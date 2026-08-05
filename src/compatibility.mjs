import canonical from './compatibility-tuple.json' with { type: 'json' };

export const compatibilityTuple = Object.freeze(canonical);

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateCompatibility(candidate) {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'missing tuple' };
  if (!equal(candidate, canonical)) return { ok: false, reason: 'tuple differs from compatibility-tuple-v1' };
  return { ok: true };
}

export function assertCompatibility(candidate) {
  const result = validateCompatibility(candidate);
  if (!result.ok) throw new Error(`Incompatible Command Center host: ${result.reason}`);
}

/** The manifest/package mirror is deliberately checked rather than copied. */
export function assertDeclarativeMirror(mirror) {
  const result = validateCompatibility(mirror);
  if (!result.ok) throw new Error(`Compatibility mirror drift: ${result.reason}`);
}
