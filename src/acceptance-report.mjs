export const ACCEPTANCE_REPORT_VERSION = 1;

export const RELEASE_ROW_IDS = Object.freeze([
  'pinned-host-startup',
  'desktop-primary-journey',
  'mobile-accessibility-journey',
  'scale-performance',
  'degraded-bridge-grants',
  'degraded-source-availability',
  'recovery-only-compatibility',
  'destructive-migration-restoration',
  'privacy-artifact-output'
]);

function boundedError(error) {
  const value = String(error?.message || error || 'unknown failure')
    .replace(/([?#&](?:token|password|secret|key)=)[^&#\s]+/giu, '$1[redacted]')
    .replace(/(\b(?:token|password|secret|key)=)[^\s,;]+/giu, '$1[redacted]')
    .slice(0, 300);
  return value || 'unknown failure';
}

export async function runAcceptanceRows(rows) {
  const configured = new Map(rows.map((row) => [row.id, row]));
  const results = [];
  for (const id of RELEASE_ROW_IDS) {
    const row = configured.get(id);
    if (!row || typeof row.run !== 'function') {
      results.push(Object.freeze({ id, outcome: 'failed', error: 'release row is not configured' }));
      continue;
    }
    try {
      const evidence = await row.run();
      results.push(Object.freeze({ id, outcome: 'passed', evidence: evidence ?? null }));
    } catch (error) {
      results.push(Object.freeze({ id, outcome: 'failed', error: boundedError(error) }));
    }
  }
  return Object.freeze(results);
}

export function createAcceptanceReport({ buildDigest, rows, finalization }) {
  if (typeof buildDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(buildDigest)) throw new TypeError('Acceptance report requires the exact build digest.');
  if (!Array.isArray(rows) || rows.length !== RELEASE_ROW_IDS.length || rows.some((row, index) => row.id !== RELEASE_ROW_IDS[index])) throw new TypeError('Acceptance report requires all release rows in canonical order.');
  const finalizationResults = Array.isArray(finalization) ? finalization.map(({ phase, error }) => Object.freeze({ phase, outcome: error ? 'failed' : 'passed', ...(error ? { error: boundedError(error) } : {}) })) : [];
  const passed = rows.every((row) => row.outcome === 'passed') && finalizationResults.every((result) => result.outcome === 'passed');
  return Object.freeze({ schemaVersion: ACCEPTANCE_REPORT_VERSION, buildDigest, outcome: passed ? 'passed' : 'failed', rows: Object.freeze([...rows]), finalization: Object.freeze(finalizationResults) });
}

export function assertAcceptanceReportPassed(report) {
  if (report.outcome !== 'passed') {
    const failures = [...report.rows.filter((row) => row.outcome !== 'passed').map((row) => row.id), ...report.finalization.filter((row) => row.outcome !== 'passed').map((row) => row.phase)];
    throw new Error(`Release acceptance failed in: ${failures.join(', ')}`);
  }
  return true;
}
