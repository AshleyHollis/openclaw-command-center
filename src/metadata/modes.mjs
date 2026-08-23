export const optionalCapabilities = Object.freeze(['notes', 'sessions', 'scheduler', 'activity', 'analysis', 'attention', 'search']);

const capabilityLabels = Object.freeze({ notes: 'Notes', sessions: 'Sessions', scheduler: 'scheduler', activity: 'Activity', analysis: 'Topic Analysis', attention: 'Attention', search: 'derived search' });
const capabilityRemediation = Object.freeze({
  notes: 'Restore the Notes capability before changing Note Folder references.',
  sessions: 'Restore the Sessions capability before changing Session references.',
  scheduler: 'Restore the scheduler capability before changing Reminder schedule references.',
  activity: 'Restore Activity storage before recording automatic maintenance.',
  analysis: 'Restore Topic Analysis before running analysis operations.',
  attention: 'Restore Attention before acting on an Attention Item.',
  search: 'Restore derived search before querying live authoritative sources.'
});

export function normalizeCapabilities(input) {
  if (input === undefined) input = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('capabilities must be an object');
  for (const key of Object.keys(input)) if (!optionalCapabilities.includes(key)) throw new TypeError(`Unsupported capability: ${key}`);
  const normalized = {};
  for (const key of optionalCapabilities) {
    if (!(key in input)) { normalized[key] = Object.freeze({ available: false }); continue; }
    const value = input[key];
    if (value === true || value === 'available' || (value && typeof value === 'object' && value.available === true)) normalized[key] = Object.freeze({ available: true });
    else if (value === false || value === 'unavailable' || (value && typeof value === 'object' && value.available === false)) normalized[key] = Object.freeze({ available: false });
    else throw new TypeError(`Capability ${key} must report available or unavailable`);
  }
  return Object.freeze(normalized);
}

function diagnosticForCapability(capability) {
  return Object.freeze({
    code: `capability-${capability}-unavailable`,
    mode: 'degraded',
    capability,
    summary: `${capabilityLabels[capability]} capability is unavailable.`,
    explanation: `${capabilityLabels[capability]} capability is unavailable.`,
    remediation: capabilityRemediation[capability]
  });
}

export function evaluateOperatingMode({ core, capabilities }) {
  if (!core || core.mode === 'recovery-only') {
    return Object.freeze({
      mode: 'recovery-only',
      schemaVersion: core?.schemaVersion ?? null,
      diagnostics: Object.freeze([...(core?.diagnostics ?? [])]),
      unavailableCapabilities: Object.freeze([])
    });
  }
  if (core.mode !== 'ready' || core.schemaVersion !== 2) {
    const explanation = 'The core metadata state is not a declared compatible mode.';
    return Object.freeze({
      mode: 'recovery-only',
      schemaVersion: null,
      diagnostics: Object.freeze([Object.freeze({
        code: 'unknown-core-state', mode: 'recovery-only', capability: null,
        summary: explanation, explanation,
        remediation: 'Restart with a supported schema-2 core store before changing metadata.'
      })]),
      unavailableCapabilities: Object.freeze([])
    });
  }
  const unavailable = optionalCapabilities.filter((capability) => capabilities[capability]?.available !== true);
  const diagnostics = unavailable.map(diagnosticForCapability);
  return Object.freeze({
    mode: diagnostics.length > 0 ? 'degraded' : 'ready',
    schemaVersion: core.schemaVersion,
    diagnostics: Object.freeze(diagnostics),
    unavailableCapabilities: Object.freeze(unavailable)
  });
}
