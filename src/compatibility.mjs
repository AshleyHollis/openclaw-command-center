import canonical from './compatibility-tuple.json' with { type: 'json' };

export const compatibilityTuple = Object.freeze(canonical);

/** Command Center requires a bridge even though the host supports read-only tabs without one. */
export function assertCapabilityBridgeDeclaration(declaration) {
  const version = declaration?.protocolVersion;
  const { min, max } = canonical.capabilityBridgeProtocol;
  if (!Number.isInteger(version) || version < min || version > max) throw new Error('Command Center requires a capability bridge protocol supported by its release compatibility tuple.');
}

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
