import { RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, releasePerformanceIdentity, validateReleasePerformanceBaseline } from './performance-baseline.mjs';

export const ACCEPTANCE_REPORT_VERSION = 1;
export const RELEASE_ROW_IDS = Object.freeze(['pinned-host-startup', 'desktop-primary-journey', 'mobile-accessibility-journey', 'scale-performance', 'degraded-bridge-grants', 'degraded-source-availability', 'recovery-only-compatibility', 'destructive-migration-restoration', 'privacy-artifact-output']);
export const FINALIZATION_PHASES = Object.freeze(['browser-close', 'host-stop', 'browser-traffic', 'host-traffic', 'child-traffic', 'build-digest']);

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_EVIDENCE_BYTES = 32_768;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function boundedError(error) {
  return String(error?.message || error || 'unknown failure')
    .replace(/([?#&](?:token|password|secret|key)=)[^&#\s]+/giu, '$1[redacted]')
    .replace(/(\b(?:token|password|secret|key)=)[^\s,;]+/giu, '$1[redacted]')
    .slice(0, 300) || 'unknown failure';
}

function invalid(message) { throw new TypeError(`Acceptance report evidence: ${message}`); }

function closed(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${label} contains unsupported field ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${label}.${key} is required`);
  return value;
}

function yes(value, label) { if (value !== true) invalid(`${label} must be true`); }
function nonempty(value, label, max = 256) { if (typeof value !== 'string' || value.length < 1 || value.length > max) invalid(`${label} must be a bounded non-empty string`); }
function exactMap(value, expected, label) {
  closed(value, Object.keys(expected), label);
  for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) invalid(`${label}.${key} does not match the frozen identity`);
}

function validatePassedEvidence(id, evidence, buildDigest, performanceBaseline) {
  let encoded;
  try { encoded = JSON.stringify(evidence); } catch { invalid(`${id} is not serializable`); }
  if (!encoded || Buffer.byteLength(encoded) > MAX_EVIDENCE_BYTES) invalid(`${id} is empty or unbounded`);
  if (evidence?.schemaVersion !== 1) invalid(`${id}.schemaVersion must be 1`);
  switch (id) {
    case 'pinned-host-startup': {
      closed(evidence, ['schemaVersion', 'hostReceipt', 'buildDigest', 'startupMigrationVerified', 'routeGrantObserved', 'scriptsOnlyFrame', 'secureOrigin', 'notificationLifecycle'], id);
      if (evidence.buildDigest !== buildDigest) invalid(`${id}.buildDigest is stale`);
      exactMap(evidence.hostReceipt, releasePerformanceIdentity.hostReceipt, `${id}.hostReceipt`);
      for (const key of ['startupMigrationVerified', 'routeGrantObserved', 'scriptsOnlyFrame']) yes(evidence[key], `${id}.${key}`);
      closed(evidence.secureOrigin, ['protocol', 'hostname', 'loopbackOnly'], `${id}.secureOrigin`);
      if (evidence.secureOrigin.protocol !== 'https:' || !evidence.secureOrigin.hostname.endsWith('.fictional.ts.net')) invalid(`${id}.secureOrigin is not fictional HTTPS`);
      yes(evidence.secureOrigin.loopbackOnly, `${id}.secureOrigin.loopbackOnly`);
      closed(evidence.notificationLifecycle, ['closedTabDelivered', 'cleared', 'bindingRevoked', 'bindingReconciled'], `${id}.notificationLifecycle`);
      for (const value of Object.values(evidence.notificationLifecycle)) yes(value, `${id}.notificationLifecycle`);
      return;
    }
    case 'desktop-primary-journey': {
      closed(evidence, ['schemaVersion', 'topicId', 'authoritativeReadback', 'actions'], id);
      nonempty(evidence.topicId, `${id}.topicId`);
      const readbacks = ['primarySession', 'conversation', 'closedConversation', 'note', 'attention', 'activity', 'topicReview'];
      closed(evidence.authoritativeReadback, readbacks, `${id}.authoritativeReadback`);
      for (const value of Object.values(evidence.authoritativeReadback)) yes(value, `${id}.authoritativeReadback`);
      if (!Array.isArray(evidence.actions) || evidence.actions.length < 12 || evidence.actions.length > 40 || evidence.actions.some((value) => typeof value !== 'string' || value.length > 80)) invalid(`${id}.actions is incomplete or unbounded`);
      return;
    }
    case 'mobile-accessibility-journey': {
      closed(evidence, ['schemaVersion', 'viewport', 'keyboardOnly', 'zoom200', 'forcedColors', 'reducedMotion', 'focusRestored', 'announcements', 'colorIndependent', 'minimumTargetCssPx', 'noPageOverflow', 'states'], id);
      exactMap(evidence.viewport, { width: 320, height: 900 }, `${id}.viewport`);
      for (const key of ['keyboardOnly', 'zoom200', 'forcedColors', 'reducedMotion', 'focusRestored', 'announcements', 'colorIndependent', 'noPageOverflow']) yes(evidence[key], `${id}.${key}`);
      if (evidence.minimumTargetCssPx < 44) invalid(`${id}.minimumTargetCssPx must be at least 44`);
      if (!Array.isArray(evidence.states) || evidence.states.length < 8 || evidence.states.length > 40) invalid(`${id}.states is incomplete or unbounded`);
      return;
    }
    case 'scale-performance': {
      closed(evidence, ['schemaVersion', 'fixtureIdentity', 'fixtureCounts', 'observations', 'thresholds', 'activityPage', 'search'], id);
      if (!DIGEST.test(evidence.fixtureIdentity)) invalid(`${id}.fixtureIdentity is invalid`);
      if (evidence.fixtureIdentity !== RELEASE_FIXTURE_IDENTITY) invalid(`${id}.fixtureIdentity does not match the release fixture`);
      exactMap(evidence.fixtureCounts, RELEASE_FIXTURE_COUNTS, `${id}.fixtureCounts`);
      closed(evidence.observations, RELEASE_MEASUREMENTS, `${id}.observations`);
      closed(evidence.thresholds, RELEASE_MEASUREMENTS, `${id}.thresholds`);
      exactMap(evidence.thresholds, performanceBaseline.thresholds, `${id}.thresholds`);
      for (const metric of RELEASE_MEASUREMENTS) {
        const observed = evidence.observations[metric];
        const threshold = evidence.thresholds[metric];
        if (typeof observed !== 'number' || !Number.isFinite(observed) || observed <= 0 || !Number.isSafeInteger(threshold) || threshold < 1 || observed > threshold) invalid(`${id}.${metric} exceeds its immutable first-observation ceiling`);
      }
      closed(evidence.activityPage, ['firstPageCount', 'secondPageCount', 'thirdPageCount', 'unique', 'orderPreserved'], `${id}.activityPage`);
      if (evidence.activityPage.firstPageCount !== 50 || evidence.activityPage.secondPageCount !== 50 || evidence.activityPage.thirdPageCount !== 1) invalid(`${id}.activityPage is incomplete`);
      yes(evidence.activityPage.unique, `${id}.activityPage.unique`); yes(evidence.activityPage.orderPreserved, `${id}.activityPage.orderPreserved`);
      closed(evidence.search, ['missingProjectionRebuilt', 'staleProjectionRebuilt', 'indexedQuery'], `${id}.search`);
      for (const value of Object.values(evidence.search)) yes(value, `${id}.search`);
      return;
    }
    case 'degraded-bridge-grants': {
      closed(evidence, ['schemaVersion', 'mode', 'safeReadObserved', 'mutationRejected', 'bridge'], id);
      if (evidence.mode !== 'degraded') invalid(`${id}.mode is stale`);
      yes(evidence.safeReadObserved, `${id}.safeReadObserved`); yes(evidence.mutationRejected, `${id}.mutationRejected`);
      closed(evidence.bridge, ['protocolVersion', 'writeGrant', 'observedFromBootstrap'], `${id}.bridge`);
      if (evidence.bridge.protocolVersion !== 1 || evidence.bridge.writeGrant !== false) invalid(`${id}.bridge is not degraded`);
      yes(evidence.bridge.observedFromBootstrap, `${id}.bridge.observedFromBootstrap`);
      return;
    }
    case 'degraded-source-availability': {
      closed(evidence, ['schemaVersion', 'mode', 'safeReadObserved', 'mutationRejected', 'source'], id);
      if (evidence.mode !== 'degraded') invalid(`${id}.mode is stale`);
      yes(evidence.safeReadObserved, `${id}.safeReadObserved`); yes(evidence.mutationRejected, `${id}.mutationRejected`);
      closed(evidence.source, ['capability', 'available', 'bindingObserved'], `${id}.source`);
      nonempty(evidence.source.capability, `${id}.source.capability`);
      if (evidence.source.available !== false) invalid(`${id}.source must be unavailable`);
      yes(evidence.source.bindingObserved, `${id}.source.bindingObserved`);
      return;
    }
    case 'recovery-only-compatibility': {
      closed(evidence, ['schemaVersion', 'mode', 'safeReadObserved', 'mutationsRejected', 'mismatches'], id);
      if (evidence.mode !== 'recovery-only') invalid(`${id}.mode is stale`);
      yes(evidence.safeReadObserved, `${id}.safeReadObserved`); yes(evidence.mutationsRejected, `${id}.mutationsRejected`);
      const required = ['host', 'build', 'pluginApi', 'bridgeProtocol', 'binding', 'schema'];
      if (!Array.isArray(evidence.mismatches) || evidence.mismatches.length !== required.length || required.some((value) => !evidence.mismatches.includes(value))) invalid(`${id}.mismatches is incomplete`);
      return;
    }
    case 'destructive-migration-restoration': {
      closed(evidence, ['schemaVersion', 'snapshotId', 'writesBlockedBeforeValidation', 'exactIdentityValidated', 'postValidationMutation', 'boundaries'], id);
      nonempty(evidence.snapshotId, `${id}.snapshotId`);
      for (const key of ['writesBlockedBeforeValidation', 'exactIdentityValidated', 'postValidationMutation']) yes(evidence[key], `${id}.${key}`);
      closed(evidence.boundaries, ['beforeCommit', 'afterCommitBeforeManifest'], `${id}.boundaries`);
      for (const value of Object.values(evidence.boundaries)) yes(value, `${id}.boundaries`);
      return;
    }
    case 'privacy-artifact-output': {
      closed(evidence, ['schemaVersion', 'repository', 'generated', 'capturedOutput', 'browserDiagnostics', 'hostDiagnostics', 'trafficFinalized'], id);
      for (const [key, value] of Object.entries(evidence)) if (key !== 'schemaVersion') yes(value, `${id}.${key}`);
      return;
    }
    default: invalid(`unknown row ${id}`);
  }
}

function validateStoredAcceptanceReport(report) {
  closed(report, ['schemaVersion', 'buildDigest', 'outcome', 'performanceBaseline', 'rows', 'finalization'], 'report');
  if (report.schemaVersion !== ACCEPTANCE_REPORT_VERSION) invalid('report.schemaVersion is unsupported');
  if (typeof report.buildDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(report.buildDigest)) invalid('report.buildDigest is invalid');
  const baseline = validateReleasePerformanceBaseline(report.performanceBaseline);
  if (baseline.pluginBuildDigest !== `sha256:${report.buildDigest}`) invalid('report.performanceBaseline is not bound to the exact build digest');
  if (!Array.isArray(report.rows) || report.rows.length !== RELEASE_ROW_IDS.length || report.rows.some((row, index) => row.id !== RELEASE_ROW_IDS[index])) invalid('report.rows are not in canonical order');
  for (const row of report.rows) {
    closed(row, row.outcome === 'passed' ? ['id', 'outcome', 'evidence'] : ['id', 'outcome', 'error'], `row.${row.id}`);
    if (row.outcome === 'passed') validatePassedEvidence(row.id, row.evidence, report.buildDigest, baseline);
    else if (row.outcome !== 'failed' || typeof row.error !== 'string' || row.error.length < 1 || row.error.length > 300) invalid(`row.${row.id} has an invalid failure`);
  }
  if (!Array.isArray(report.finalization) || report.finalization.length !== FINALIZATION_PHASES.length || report.finalization.some((entry, index) => entry.phase !== FINALIZATION_PHASES[index])) invalid('report.finalization is not in canonical order');
  for (const entry of report.finalization) {
    closed(entry, entry.outcome === 'passed' ? ['phase', 'outcome'] : ['phase', 'outcome', 'error'], `finalization.${entry.phase}`);
    if (entry.outcome !== 'passed' && (entry.outcome !== 'failed' || typeof entry.error !== 'string' || entry.error.length < 1 || entry.error.length > 300)) invalid(`finalization.${entry.phase} has an invalid outcome`);
  }
  const expectedOutcome = report.rows.every((row) => row.outcome === 'passed') && report.finalization.every((entry) => entry.outcome === 'passed') ? 'passed' : 'failed';
  if (report.outcome !== expectedOutcome) invalid('report.outcome does not match its evidence');
  return deepFreeze(report);
}

class RowCancellationFailure extends Error {}

export async function runAcceptanceRows(rows, { timeoutMs = 120_000, cleanupTimeoutMs = 1_000, maxConcurrency = 2, onProgress } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('Acceptance row timeout must be between 1 and 300000 ms.');
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 5_000) throw new TypeError('Acceptance row cleanup timeout must be between 1 and 5000 ms.');
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) throw new TypeError('Acceptance row concurrency must be between 1 and 4.');
  const configured = new Map(rows.map((row) => [row.id, row]));
  const run = async (id, controller = new AbortController()) => {
    const row = configured.get(id);
    if (!row || typeof row.run !== 'function') return Object.freeze({ id, outcome: 'failed', error: 'release row is not configured' });
    onProgress?.(Object.freeze({ id, phase: 'started' }));
    let timer;
    let abortListener;
    const task = Promise.resolve().then(() => row.run(controller.signal));
    try {
      const deadline = Symbol('deadline');
      const cancelled = Symbol('cancelled');
      const outcome = await Promise.race([
        task,
        new Promise((resolve) => { timer = setTimeout(() => resolve(deadline), timeoutMs); }),
        new Promise((resolve) => {
          abortListener = () => resolve(cancelled);
          controller.signal.addEventListener('abort', abortListener, { once: true });
        })
      ]);
      if (outcome === deadline || outcome === cancelled) {
        if (outcome === deadline) controller.abort(new Error(`Release row ${id} exceeded its ${timeoutMs} ms deadline`));
        const cleanupDeadline = Symbol('cleanup-deadline');
        let cleanupTimer;
        const cleanup = await Promise.race([task.then(() => true, () => true), new Promise((resolve) => { cleanupTimer = setTimeout(() => resolve(cleanupDeadline), cleanupTimeoutMs); })]);
        clearTimeout(cleanupTimer);
        if (cleanup === cleanupDeadline) throw new RowCancellationFailure(`Release row ${id} did not settle within ${cleanupTimeoutMs} ms after cancellation`);
        throw controller.signal.reason ?? new Error(`Release row ${id} was cancelled`);
      }
      const evidence = outcome;
      onProgress?.(Object.freeze({ id, phase: 'passed' }));
      return Object.freeze({ id, outcome: 'passed', evidence: evidence ?? null });
    } catch (error) {
      if (error instanceof RowCancellationFailure) throw error;
      onProgress?.(Object.freeze({ id, phase: 'failed' }));
      return Object.freeze({ id, outcome: 'failed', error: boundedError(error) });
    } finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  };
  const results = new Array(RELEASE_ROW_IDS.length);
  let nextIndex = 0;
  let cancellationFailure;
  const activeControllers = new Set();
  const originalRun = run;
  const trackedRun = async (id) => {
    const controller = new AbortController();
    activeControllers.add(controller);
    try {
      return await originalRun(id, controller);
    } finally {
      activeControllers.delete(controller);
    }
  };
  const worker = async () => {
    while (!cancellationFailure && nextIndex < RELEASE_ROW_IDS.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await trackedRun(RELEASE_ROW_IDS[index]);
      } catch (error) {
        cancellationFailure ??= error;
        for (const controller of activeControllers) controller.abort(error);
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(maxConcurrency, RELEASE_ROW_IDS.length) }, worker));
  if (cancellationFailure) throw cancellationFailure;
  return Object.freeze(results);
}

export function createAcceptanceReport({ buildDigest, rows, finalization, performanceBaseline }) {
  if (typeof buildDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(buildDigest)) throw new TypeError('Acceptance report requires the exact build digest.');
  const validatedBaseline = validateReleasePerformanceBaseline(performanceBaseline);
  if (validatedBaseline.pluginBuildDigest !== `sha256:${buildDigest}`) throw new TypeError('Acceptance report baseline is not bound to the exact build digest.');
  if (!Array.isArray(rows) || rows.length !== RELEASE_ROW_IDS.length || rows.some((row, index) => row.id !== RELEASE_ROW_IDS[index])) throw new TypeError('Acceptance report requires all release rows in canonical order.');
  for (const row of rows) {
    closed(row, row.outcome === 'passed' ? ['id', 'outcome', 'evidence'] : ['id', 'outcome', 'error'], `row.${row.id}`);
    if (row.outcome === 'passed') validatePassedEvidence(row.id, row.evidence, buildDigest, validatedBaseline);
    else if (row.outcome !== 'failed' || typeof row.error !== 'string' || row.error.length > 300) invalid(`row.${row.id} has an invalid failure`);
  }
  if (!Array.isArray(finalization) || finalization.length !== FINALIZATION_PHASES.length || finalization.some((entry, index) => entry.phase !== FINALIZATION_PHASES[index])) throw new TypeError('Acceptance report requires every finalization phase in canonical order.');
  const finalizationResults = finalization.map(({ phase, error, ...unsupported }) => {
    if (Object.keys(unsupported).length > 0) invalid(`finalization.${phase} contains unsupported fields`);
    return Object.freeze({ phase, outcome: error ? 'failed' : 'passed', ...(error ? { error: boundedError(error) } : {}) });
  });
  const passed = rows.every((row) => row.outcome === 'passed') && finalizationResults.every((result) => result.outcome === 'passed');
  return validateStoredAcceptanceReport({ schemaVersion: ACCEPTANCE_REPORT_VERSION, buildDigest, outcome: passed ? 'passed' : 'failed', performanceBaseline: structuredClone(validatedBaseline), rows: structuredClone(rows), finalization: structuredClone(finalizationResults) });
}

export function assertAcceptanceReportPassed(report) {
  const validated = validateStoredAcceptanceReport(report);
  if (validated.outcome !== 'passed') {
    const failures = [...validated.rows.filter((row) => row.outcome !== 'passed').map((row) => row.id), ...validated.finalization.filter((row) => row.outcome !== 'passed').map((row) => row.phase)];
    throw new Error(`Release acceptance failed in: ${failures.join(', ')}`);
  }
  return true;
}
