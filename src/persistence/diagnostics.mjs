import { DeploymentMode } from './mode.mjs';

const rollbackGuidance = 'Restore a verified broad-archive snapshot with the prior compatible Command Center release; automatic down-migrations are never attempted.';

export function diagnostic(name, ok, { code, capability, observed, supported, guidance, critical } = {}) {
  return Object.freeze({
    name,
    ok: ok === true,
    ...(code ? { code } : {}),
    ...(capability ? { capability } : {}),
    ...(observed !== undefined ? { observed } : {}),
    ...(supported !== undefined ? { supported } : {}),
    ...(guidance ? { guidance } : {}),
    ...(critical !== undefined ? { critical } : {})
  });
}

export function recoveryDiagnostic(code, { observed, supported } = {}) {
  return diagnostic('persistence-open', false, {
    code,
    observed,
    supported,
    critical: true,
    guidance: rollbackGuidance
  });
}

export function statusDiagnostics(evaluation, schemaVersion, checks = evaluation.failures) {
  return Object.freeze({
    mode: evaluation.mode,
    schemaVersion,
    writable: evaluation.mode !== DeploymentMode.RecoveryOnly,
    disabledCapabilities: evaluation.disabledCapabilities,
    checks,
    rollbackGuidance
  });
}

export { rollbackGuidance };
