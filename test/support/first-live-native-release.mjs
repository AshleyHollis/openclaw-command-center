import assert from 'node:assert/strict';
import { createAcceptanceReport, assertAcceptanceReportPassed, assertNonPerformanceAcceptanceEvidence, NON_PERFORMANCE_ROW_IDS, FINALIZATION_PHASES, RELEASE_ROW_IDS } from '../../src/acceptance-report.mjs';
import { runBoundedAcceptanceSlice, runIsolatedAcceptanceSlices } from '../../src/acceptance-scenario-coordinator.mjs';
import { captureFirstReleasePerformanceBaseline, validateReleasePerformanceBaseline, RELEASE_PERFORMANCE_BASELINE_VERSION, RELEASE_FIXTURE_IDENTITY, releasePerformanceIdentity } from '../../src/performance-baseline.mjs';

// Two fixed subsystem lanes, not an extensible workflow registry. Each pair
// settles before the next is admitted; scale never shares their resources.
const NATIVE_LANE = Object.freeze(['primary', 'keyboard', 'secure', 'bridgeDenied', 'sourceUnavailable', 'combinedDegraded', 'restoration']);
const COMPATIBILITY_LANE = Object.freeze(['hostMismatch', 'buildMismatch', 'pluginApiMismatch', 'bridgeProtocolMismatch', 'bindingMismatch', 'foreignRestoration', 'schemaMismatch']);
const PARTICIPANTS = Object.freeze([...NATIVE_LANE, ...COMPATIBILITY_LANE, 'scale']);
const PREREQUISITE_PARTICIPANTS = Object.freeze([...NATIVE_LANE, ...COMPATIBILITY_LANE]);

function requireFacts(value, keys, label) {
  for (const key of keys) assert.equal(value?.[key], true, `${label}.${key} must be observed`);
}

function requireNativeRecovery(value, mode, label) {
  assert.equal(value?.mode, mode, `${label}.mode`);
  requireFacts(value, ['safeReadObserved', 'mountedUiObserved', 'unsupportedControlsAbsent', 'nativeActivationObserved'], label);
  assert.ok(typeof value.revision === 'string' && value.revision.trim(), `${label}.revision`);
}

function validateSupplementalEvidence(results) {
  for (const [id, kind] of [['hostMismatch', 'host'], ['buildMismatch', 'build'], ['bridgeProtocolMismatch', 'bridge-protocol']]) {
    const value = results.get(id);
    assert.equal(value.kind, kind, `${id}.kind`);
    requireNativeRecovery(value, 'recovery-only', id);
    requireFacts(value, ['mutationRejected', 'restoredStatePreserved', 'recoveryArtifactsPreserved', 'compatibilityRefusalObserved'], id);
  }
  const api = results.get('pluginApiMismatch');
  assert.equal(api.kind, 'plugin-api');
  requireFacts(api, ['activationRejected', 'mutationRejected', 'restoredStatePreserved', 'recoveryArtifactsPreserved'], 'pluginApiMismatch');
  assert.equal(api.mountedUiObserved, false);
  if (api.startupRejected === true) requireFacts(api, ['hostStoppedObserved'], 'pluginApiMismatch');
  else {
    assert.equal(api.startupRejected, false);
    requireFacts(api, ['nativeUnavailableObserved', 'unsupportedControlsAbsent'], 'pluginApiMismatch');
  }
  const binding = results.get('bindingMismatch');
  assert.equal(binding.kind, 'binding');
  requireNativeRecovery(binding, 'degraded', 'bindingMismatch');
  requireFacts(binding, ['mutationRejected', 'bindingObserved', 'bindingPreserved', 'recoveryArtifactsPreserved'], 'bindingMismatch');
  const foreign = results.get('foreignRestoration');
  assert.equal(foreign.kind, 'database-identity');
  requireNativeRecovery(foreign, 'recovery-only', 'foreignRestoration');
  requireFacts(foreign, ['mutationRejected', 'restoredStateValidated', 'foreignOwnershipRefused', 'databaseBytesPreserved', 'recoveryArtifactsPreserved'], 'foreignRestoration');
  const schema = results.get('schemaMismatch');
  requireNativeRecovery(schema, 'recovery-only', 'schemaMismatch');
  requireFacts(schema, ['mutationsRejected', 'futureSchemaBytesPreserved', 'recoveryArtifactsPreserved'], 'schemaMismatch');
  assert.deepEqual(schema.mismatches, ['schema']);
  const combined = results.get('combinedDegraded');
  assert.equal(combined.schemaVersion, 2);
  assert.equal(combined.mode, 'degraded');
  requireFacts(combined, ['safeReadObserved', 'mutationRejected', 'combinedGrantDenied'], 'combinedDegraded');
  assert.deepEqual(combined.bridge, results.get('bridgeDenied').bridge);
  assert.deepEqual(combined.source, results.get('sourceUnavailable').source);
  requireFacts(results.get('restoration'), ['realStartupValidated', 'existingTopicVerified', 'authoritativeNoteRead', 'readOnlyNotesObserved', 'retainedConversationCreation', 'exactNativeChatHandoff', 'nativeActivationObserved'], 'restoration');
}

function captureFailure(failures, outcomes) {
  const error = new AggregateError(failures.map(entry => entry.error), `Native release capture failed: ${failures.map(entry => entry.id).join(', ')}`);
  error.outcomes = Object.freeze([...outcomes].map(([id, status]) => Object.freeze({ id, status })));
  if (failures.some(entry => entry.error?.fatalAcceptanceCleanup === true)) error.fatalAcceptanceCleanup = true;
  return error;
}

/**
 * The supplied runners are the real, isolated native producers. A successful
 * return includes their local browser/host diagnostic privacy scans; all six
 * lifecycle terminal callbacks are separately mandatory. Test doubles prove
 * only this orchestration seam, never native acceptance or performance.
 *
 * scanArtifacts must perform the final repository, generated-artifact and
 * captured-output privacy scan, returning those three observed boolean facts.
 * This helper does not write a baseline; its caller persists one only after
 * the complete capture succeeds.
 */
export async function runNativeReleaseCapture(options = {}) {
  return runNativeRelease(options, false);
}

export async function runNativeReleasePrerequisites(options = {}) {
  assert.ok(!Object.hasOwn(options, 'capturePerformanceBaseline') && !Object.hasOwn(options, 'baseline'), 'Prerequisites cannot capture or qualify a performance baseline');
  return runNativeRelease(options, true);
}

async function runNativeRelease({ buildReceipt, descriptor, runners, capturePerformanceBaseline = false, baseline,
  scanArtifacts, onProgress = () => {}, timeoutMs = 240_000, cleanupTimeoutMs = 15_000 } = {}, prerequisitesOnly) {
  assert.match(buildReceipt?.digest ?? '', /^[a-f0-9]{64}$/u, 'An exact sealed build receipt is required');
  assert.equal(typeof descriptor?.integrity, 'object', 'The verified host descriptor integrity is required');
  const participants = prerequisitesOnly ? PREREQUISITE_PARTICIPANTS : PARTICIPANTS;
  assert.deepEqual(Object.keys(runners ?? {}).sort(), [...participants].sort(), prerequisitesOnly ? 'Exactly fourteen non-performance participants are required' : 'All fifteen closed native participants are required');
  for (const id of participants) assert.equal(typeof runners[id], 'function', `${id} runner is required`);
  assert.equal(typeof scanArtifacts, 'function', 'The final artifact scanner is required');
  assert.equal(typeof onProgress, 'function');
  assert.equal(typeof capturePerformanceBaseline, 'boolean');
  assert.ok(!capturePerformanceBaseline || baseline === undefined, 'A first capture must not replace an existing baseline');
  const sealedDigest = buildReceipt.digest;
  const sealedIntegrity = structuredClone(descriptor.integrity);
  const existingBaseline = prerequisitesOnly || capturePerformanceBaseline ? undefined : validateReleasePerformanceBaseline(structuredClone(baseline));
  if (existingBaseline) assert.equal(existingBaseline.pluginBuildDigest, `sha256:${sealedDigest}`);
  const bounds = { timeoutMs, cleanupTimeoutMs };
  const results = new Map();
  const outcomes = new Map();
  const terminalEvidence = new Map();
  const failures = [];
  let observerFailure;
  const progress = ({ id, status, lane }) => {
    if (status !== 'started') outcomes.set(id, status);
    // An output sink is not a lifecycle owner. Retain its failure, but never
    // let it reject the coordinator before the active peer has settled.
    try { onProgress(Object.freeze({ id, status, lane })); }
    catch (error) { observerFailure ??= error; }
  };
  const execute = id => async signal => {
    const terminals = [];
    const invalidEvents = [];
    let open = true;
    let result;
    let failure;
    try {
      result = await runners[id]({ signal, onFinalization: event => {
        if (!open) return;
        if (!FINALIZATION_PHASES.includes(event?.phase) || !['started', 'passed', 'failed'].includes(event?.status)) {
          invalidEvents.push('invalid phase or status');
        } else if (event.status !== 'started') terminals.push({ phase: event.phase, status: event.status });
      } });
    } catch (error) { failure = error; }
    finally { open = false; }
    const complete = invalidEvents.length === 0 && terminals.length === FINALIZATION_PHASES.length &&
      terminals.every((entry, index) => entry.phase === FINALIZATION_PHASES[index]);
    const stopped = complete && terminals.slice(0, 2).every(entry => entry.status === 'passed');
    if (!stopped) {
      const error = new Error(`${id} has missing, duplicate, invalid or failed shutdown finalization evidence`, { cause: failure });
      error.fatalAcceptanceCleanup = true;
      throw error;
    }
    terminalEvidence.set(id, terminals);
    if (failure) throw failure;
    assert.equal(terminals.every(entry => entry.status === 'passed'), true, `${id} finalization failed`);
    assert.ok(result && typeof result === 'object' && !Array.isArray(result), `${id} produced no completion evidence`);
    return structuredClone(result);
  };
  for (let index = 0; index < NATIVE_LANE.length; index += 1) {
    const pair = [NATIVE_LANE[index], COMPATIBILITY_LANE[index]];
    const batch = await runIsolatedAcceptanceSlices(pair.map(id => ({ id, run: execute(id) })), { ...bounds, maxConcurrency: 2, onProgress: progress });
    for (const [id, result] of batch.results) results.set(id, result);
    failures.push(...batch.failures);
    if (batch.failures.some(entry => entry.error?.fatalAcceptanceCleanup === true)) throw captureFailure(failures, outcomes);
    if (observerFailure) throw captureFailure([...failures, { id: 'progress-observer', error: observerFailure }], outcomes);
  }
  if (failures.length) throw captureFailure(failures, outcomes);
  validateSupplementalEvidence(results);
  const primary = results.get('primary');
  assert.deepEqual(primary.startup.hostReceipt, releasePerformanceIdentity.hostReceipt, 'Startup must observe the pinned host receipt');
  const { schemaVersion: _schema, commit: _commit, ...observedIntegrity } = primary.startup.hostReceipt;
  assert.deepEqual(observedIntegrity, sealedIntegrity, 'Startup must observe the supplied sealed host');
  const secure = results.get('secure');
  const origin = new URL(secure.secureOrigin);
  assert.equal(origin.protocol, 'https:');
  assert.equal(origin.hostname, secure.fictionalTailnetHost);
  assert.equal(secure.loopbackResolution, '127.0.0.1');
  requireFacts(secure, ['actualTlsLoad', 'nativeActivationObserved'], 'secure');
  assert.equal(secure.revision, primary.startup.nativeUi.revision, 'HTTPS must activate the same sealed native revision');
  for (const id of [...COMPATIBILITY_LANE.filter(id => id !== 'pluginApiMismatch'), 'restoration']) {
    assert.equal(results.get(id).revision, primary.startup.nativeUi.revision, `${id} must activate the same sealed native revision`);
  }

  const schema = results.get('schemaMismatch');
  const restoration = results.get('restoration');
  const prerequisiteEvidence = [
    { schemaVersion: 2, hostReceipt: primary.startup.hostReceipt, buildDigest: sealedDigest,
      startupMigrationVerified: primary.startup.startupMigrationVerified, routeGrantObserved: primary.startup.routeGrantObserved,
      secureOrigin: { protocol: origin.protocol, hostname: origin.hostname, loopbackOnly: secure.loopbackResolution === '127.0.0.1' }, nativeUi: primary.startup.nativeUi },
    primary.primary,
    results.get('keyboard'),
    results.get('bridgeDenied'),
    results.get('sourceUnavailable'),
    { schemaVersion: 2, mode: schema.mode, safeReadObserved: schema.safeReadObserved, mutationsRejected: schema.mutationsRejected,
      mismatches: ['host', 'build', 'pluginApi', 'bridgeProtocol', 'binding', 'schema'] },
    { schemaVersion: 2, snapshotId: restoration.snapshotId, writesBlockedBeforeValidation: restoration.writesBlocked,
      exactIdentityValidated: restoration.exactIdentityValidated, postValidationMutation: restoration.postValidationMutation,
      boundaries: { beforeCommit: restoration.beforeCommitBytesPreserved, afterCommitBeforeManifest: restoration.afterCommitBytesPreserved } }
  ];
  const prerequisiteRows = assertNonPerformanceAcceptanceEvidence({ buildDigest: sealedDigest,
    rows: NON_PERFORMANCE_ROW_IDS.map((id, index) => ({ id, evidence: prerequisiteEvidence[index] })) });
  assert.equal(buildReceipt.digest, sealedDigest, 'The sealed build receipt changed during prerequisites');
  assert.deepEqual(descriptor.integrity, sealedIntegrity, 'The host identity changed during prerequisites');

  if (prerequisitesOnly) {
    const privacy = await runBoundedAcceptanceSlice('prerequisite-artifact-privacy', signal => scanArtifacts({ signal,
      buildDigest: sealedDigest, participantEvidence: structuredClone(Object.fromEntries(results)),
      rowEvidence: prerequisiteRows.map(row => structuredClone(row.evidence)) }), bounds);
    requireFacts(privacy, ['repository', 'generated', 'capturedOutput'], 'scanArtifacts');
    assert.equal(buildReceipt.digest, sealedDigest, 'The sealed build receipt changed during prerequisite scanning');
    assert.deepEqual(descriptor.integrity, sealedIntegrity, 'The host identity changed during prerequisite scanning');
    assert.equal(terminalEvidence.size, PREREQUISITE_PARTICIPANTS.length);
    return Object.freeze({ schemaVersion: 1, kind: 'native-release-prerequisites', performanceQualified: false,
      buildDigest: sealedDigest, hostIntegrity: sealedIntegrity, rows: prerequisiteRows,
      participants: Object.fromEntries(outcomes), finalization: Object.fromEntries(terminalEvidence),
      privacy: { repository: true, generated: true, capturedOutput: true } });
  }

  progress({ id: 'scale', status: 'started', lane: 'exclusive-performance' });
  if (observerFailure) throw captureFailure([{ id: 'progress-observer', error: observerFailure }], outcomes);
  try {
    results.set('scale', await runBoundedAcceptanceSlice('scale', execute('scale'), bounds));
    progress({ id: 'scale', status: 'passed', lane: 'exclusive-performance' });
  } catch (error) {
    progress({ id: 'scale', status: 'failed', lane: 'exclusive-performance' });
    throw captureFailure([{ id: 'scale', error }], outcomes);
  }
  if (observerFailure) throw captureFailure([{ id: 'progress-observer', error: observerFailure }], outcomes);
  const scale = results.get('scale');
  const seed = {
    schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION,
    hostVersion: releasePerformanceIdentity.hostVersion, hostReceipt: primary.startup.hostReceipt,
    pluginBuildDigest: `sha256:${sealedDigest}`, browser: scale.browser, viewport: scale.viewport,
    fixtureIdentity: RELEASE_FIXTURE_IDENTITY, fixtureCounts: scale.fixtureCounts,
    capture: { policy: 'first-successful-pinned-harness-observation', successfulRunOrdinal: null }
  };
  const qualifiedBaseline = capturePerformanceBaseline ? captureFirstReleasePerformanceBaseline(seed, scale.observations) : existingBaseline;
  if (existingBaseline) {
    for (const key of ['hostReceipt', 'browser', 'viewport', 'fixtureIdentity', 'fixtureCounts']) assert.deepEqual(seed[key], existingBaseline[key], `Scale ${key} must match the immutable baseline`);
  }
  assert.equal(buildReceipt.digest, sealedDigest, 'The sealed build receipt changed during capture');
  assert.deepEqual(descriptor.integrity, sealedIntegrity, 'The host identity changed during capture');
  assert.equal(terminalEvidence.size, PARTICIPANTS.length);
  const rowEvidence = [
    ...prerequisiteRows.slice(0, 3).map(row => row.evidence),
    { schemaVersion: 2, fixtureIdentity: seed.fixtureIdentity, fixtureCounts: scale.fixtureCounts, observations: scale.observations, thresholds: qualifiedBaseline.thresholds, conversationPage: scale.conversationPage, notes: scale.notes },
    ...prerequisiteRows.slice(3).map(row => row.evidence)
  ];
  const scanned = await runBoundedAcceptanceSlice('final-artifact-privacy', signal => scanArtifacts({ signal,
    buildDigest: sealedDigest, participantEvidence: structuredClone(Object.fromEntries(results)),
    rowEvidence: structuredClone(rowEvidence), performanceBaseline: structuredClone(qualifiedBaseline) }), bounds);
  requireFacts(scanned, ['repository', 'generated', 'capturedOutput'], 'scanArtifacts');
  rowEvidence.push({ schemaVersion: 2, repository: scanned.repository, generated: scanned.generated, capturedOutput: scanned.capturedOutput,
    browserDiagnostics: true, hostDiagnostics: true, trafficFinalized: true });
  const report = createAcceptanceReport({ buildDigest: sealedDigest,
    rows: RELEASE_ROW_IDS.map((id, index) => ({ id, outcome: 'passed', evidence: rowEvidence[index] })),
    finalization: FINALIZATION_PHASES.map(phase => ({ phase })), performanceBaseline: qualifiedBaseline });
  assertAcceptanceReportPassed(report);
  return Object.freeze({ report, capturedBaseline: capturePerformanceBaseline ? report.performanceBaseline : undefined });
}
