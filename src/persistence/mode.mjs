export const DeploymentMode = Object.freeze({
  Ready: 'Ready',
  Degraded: 'Degraded',
  RecoveryOnly: 'Recovery-only'
});

export const requiredValidationChecks = Object.freeze([
  'sqlite-integrity',
  'foreign-keys',
  'durable-schema',
  'required-indexes',
  'source-reference-invariants',
  'migration-ledger',
  'schema-range',
  'policy-versions',
  'plugin-build',
  'bridge-compatibility'
]);

export function evaluateMode(results, requiredChecks = requiredValidationChecks) {
  const byName = new Map((Array.isArray(results) ? results : []).filter(Boolean).map((result) => [result.name, result]));
  const failures = [];
  for (const name of requiredChecks) {
    const result = byName.get(name);
    if (!result) failures.push({ name, ok: false, critical: true, code: 'VALIDATION_CHECK_MISSING', guidance: 'Run complete persistence validation before enabling mutations.' });
    else if (result.ok !== true) failures.push(result);
  }
  for (const result of byName.values()) if (result.ok !== true && !failures.includes(result)) failures.push(result);
  if (failures.some((failure) => failure.critical !== false)) {
    return Object.freeze({ mode: DeploymentMode.RecoveryOnly, failures: Object.freeze(failures), disabledCapabilities: Object.freeze([]) });
  }
  if (failures.length) {
    const disabledCapabilities = [...new Set(failures.map((failure) => failure.capability).filter(Boolean))];
    return Object.freeze({ mode: DeploymentMode.Degraded, failures: Object.freeze(failures), disabledCapabilities: Object.freeze(disabledCapabilities) });
  }
  return Object.freeze({ mode: DeploymentMode.Ready, failures: Object.freeze([]), disabledCapabilities: Object.freeze([]) });
}
