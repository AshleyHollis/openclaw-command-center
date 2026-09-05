import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertAcceptanceReportPassed, createAcceptanceReport as createAcceptanceReportBase, FINALIZATION_PHASES, RELEASE_ROW_IDS, runAcceptanceRows } from '../src/acceptance-report.mjs';
import { captureFirstReleasePerformanceBaseline, RELEASE_PERFORMANCE_BASELINE_VERSION, RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, releasePerformanceIdentity } from '../src/performance-baseline.mjs';

const BUILD = 'a'.repeat(64);
const observations = Object.freeze(Object.fromEntries(RELEASE_MEASUREMENTS.map((name, index) => [name, index + 0.25])));
const thresholds = Object.freeze(Object.fromEntries(RELEASE_MEASUREMENTS.map((name) => [name, Math.ceil(observations[name])])));
const performanceBaseline = captureFirstReleasePerformanceBaseline({ schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION, hostVersion: releasePerformanceIdentity.hostVersion, hostReceipt: releasePerformanceIdentity.hostReceipt, pluginBuildDigest: `sha256:${BUILD}`, browser: { engine: 'chromium', playwrightVersion: releasePerformanceIdentity.playwrightVersion, version: '151.0.7922.34' }, viewport: releasePerformanceIdentity.viewport, fixtureIdentity: RELEASE_FIXTURE_IDENTITY, fixtureCounts: RELEASE_FIXTURE_COUNTS, capture: { policy: 'first-successful-pinned-harness-observation', successfulRunOrdinal: null } }, observations);
const createAcceptanceReport = (input) => createAcceptanceReportBase({ ...input, performanceBaseline: input.performanceBaseline ?? performanceBaseline });
const finalization = () => FINALIZATION_PHASES.map((phase) => ({ phase }));

function validEvidence(id) {
  const values = {
    'pinned-host-startup': { schemaVersion: 1, hostReceipt: { ...releasePerformanceIdentity.hostReceipt }, buildDigest: BUILD, startupMigrationVerified: true, routeGrantObserved: true, scriptsOnlyFrame: true, secureOrigin: { protocol: 'https:', hostname: 'command-center.fictional.ts.net', loopbackOnly: true }, notificationLifecycle: { closedTabDelivered: true, cleared: true, bindingRevoked: true, bindingReconciled: true } },
    'desktop-primary-journey': { schemaVersion: 1, topicId: 'fictional-topic', authoritativeReadback: { primarySession: true, conversation: true, closedConversation: true, note: true, attention: true, activity: true, topicReview: true }, actions: Array.from({ length: 12 }, (_, index) => `action-${index}`) },
    'desktop-keyboard-journey': { schemaVersion: 1, viewport: { width: 1440, height: 900 }, keyboardOnly: true, forcedColors: true, reducedMotion: true, focusRestored: true, announcements: true, colorIndependent: true, noPageOverflow: true, states: ['navigation', 'topic', 'conversation', 'note-dialog', 'note-preview', 'search', 'attention', 'review'] },
    'scale-performance': { schemaVersion: 1, fixtureIdentity: RELEASE_FIXTURE_IDENTITY, fixtureCounts: { ...RELEASE_FIXTURE_COUNTS }, observations: { ...observations }, thresholds: { ...thresholds }, activityPage: { firstPageCount: 50, secondPageCount: 50, thirdPageCount: 1, unique: true, orderPreserved: true }, search: { missingProjectionRebuilt: true, staleProjectionRebuilt: true, indexedQuery: true } },
    'degraded-bridge-grants': { schemaVersion: 1, mode: 'degraded', safeReadObserved: true, mutationRejected: true, bridge: { protocolVersion: 1, writeGrant: false, observedFromBootstrap: true } },
    'degraded-source-availability': { schemaVersion: 1, mode: 'degraded', safeReadObserved: true, mutationRejected: true, source: { capability: 'sessions', available: false, bindingObserved: true } },
    'recovery-only-compatibility': { schemaVersion: 1, mode: 'recovery-only', safeReadObserved: true, mutationsRejected: true, mismatches: ['host', 'build', 'pluginApi', 'bridgeProtocol', 'binding', 'schema'] },
    'destructive-migration-restoration': { schemaVersion: 1, snapshotId: 'fictional-snapshot', writesBlockedBeforeValidation: true, exactIdentityValidated: true, postValidationMutation: true, boundaries: { beforeCommit: true, afterCommitBeforeManifest: true } },
    'privacy-artifact-output': { schemaVersion: 1, repository: true, generated: true, capturedOutput: true, browserDiagnostics: true, hostDiagnostics: true, trafficFinalized: true }
  };
  return structuredClone(values[id]);
}

async function validRows() {
  return runAcceptanceRows(RELEASE_ROW_IDS.map((id) => ({ id, run: async () => validEvidence(id) })));
}

test('real-host aggregate reports scenario children and Session interleaving coverage', async () => {
  const source = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  const sessionSource = await readFile(new URL('./session-adapter.test.mjs', import.meta.url), 'utf8');
  const bridgeSource = await readFile(new URL('./bridge-contract.test.mjs', import.meta.url), 'utf8');
  assert.match(source, /await testContext\.test\(`release scenario:/u);
  for (const boundary of ['startup-migration-channel-count', 'startup-migration-occurrence-count', 'startup-authenticated-history', 'startup-imported-history-text', 'startup-imported-history-provenance', 'migrated-scale-conversation-seeding', 'startup-projection-recovery', 'invalidated-projection-recovery', 'missing-projection-recovery', 'stale-projection-recovery', 'malformed-topic-route-rejection']) assert.match(source, new RegExp(`collectScenario\\('${boundary}'`, 'u'));
  assert.match(source, /migrationFixtureEvidence = retainPreparedMigrationFixtureEvidence\(migrationExport\)/u);
  assert.match(source, /prepared migration fixture evidence must remain available after fixture preparation/u);
  assert.doesNotMatch(source, /fictional-topic-(?:alpha|scale)/u);
  assert.match(source, /RELEASE_ALPHA_TOPIC_ID/u);
  assert.match(source, /RELEASE_SCALE_TOPIC_ID/u);
  assert.match(source, /startIsolatedSlice/u);
  assert.match(source, /isolatedResult\('degraded-source-availability'\)/u);
  assert.doesNotMatch(source, /requireScenario\(/u);
  assert.match(source, /testContext\.diagnostic\(/u);
  assert.match(source, /if \(acceptancePlan\.kind !== 'release'\) return;\s+assert\.ok\(emittedBaseline,[^;]+;\s+testContext\.diagnostic\(`acceptance-result=/u, 'focused diagnostics must not claim complete release acceptance');
  assert.match(source, /timeout: 2_400_000/u);
  const isolatedCompletion = source.indexOf("await Promise.all([...isolatedSlices.keys()]");
  const finalization = source.indexOf('const finalizationErrors = await finalizeAcceptanceJourney', isolatedCompletion);
  const privacyPreflight = source.indexOf('await scanRepositorySafety', finalization);
  const baselineComparison = source.indexOf('for (const name of RELEASE_MEASUREMENTS) assertPerformanceObservationWithinBaseline', privacyPreflight);
  const reportRows = source.indexOf('const rows = await runAcceptanceRows', finalization);
  const reportValidation = source.indexOf('assertAcceptanceReportPassed(report)', reportRows);
  const capturedOutputScan = source.indexOf('scanPublicEvidence([JSON.stringify(report)', reportValidation);
  const baselineCommit = source.indexOf('releaseState.baseline = qualifiedBaseline', capturedOutputScan);
  assert.ok(isolatedCompletion > 0 && isolatedCompletion < finalization && finalization < privacyPreflight && privacyPreflight < baselineComparison && baselineComparison < reportRows && reportRows < reportValidation && reportValidation < capturedOutputScan && capturedOutputScan < baselineCommit, 'all isolated slices, finalization, privacy, immutable baseline comparison, report validation, and captured-output scanning must precede baseline commitment');
  assert.match(source, /capturePerformanceBaseline = process\.env\.COMMAND_CENTER_CAPTURE_PERFORMANCE_BASELINE === '1'/u);
  assert.match(source, /captureFirstReleasePerformanceBaseline\(baselineSeed, scaleJourney\.measurement\)/u);
  assert.match(source, /writeFile\(capturedPerformanceBaselinePath,[\s\S]*\{ flag: 'wx' \}\)/u);
  assert.doesNotMatch(source, /const passed = await (?:testContext\.test|isolatedRunPromises)/u);
  assert.doesNotMatch(source, /withDeadline\(`isolated release slice/u);
  assert.match(source, /runBoundedAcceptanceSlice/u);
  assert.match(source, /timeoutMs: 240_000, cleanupTimeoutMs: 15_000/u);
  assert.match(source, /release preparation: candidate build and authenticated descriptor/u);
  assert.match(source, /release preparation: deterministic source fixtures/u);
  assert.match(source, /release preparation: pinned host launch/u);
  assert.match(source, /fetchWithRuntimeDispatcher as fetch/u);
  for (const category of ['bootstrap-http-', 'bootstrap-invalid-response', 'metadata-not-ready']) assert.match(source, new RegExp(category, 'u'));
  assert.match(source, /api\/topics\/actions`.*, \{ method: 'POST'/u);
  assert.equal(source.match(/await seedAuthoritativeSessionCatalog\(/gu)?.length, 2, 'both real-host 100-Conversation fixtures must use the bounded authoritative seeding path');
  assert.match(source, /const batch = await Promise\.all\(indexes\.map/u);
  assert.match(source, /metadata\.setSessionState\(/u);
  assert.doesNotMatch(source, /runSettledAcceptanceBatch/u);
  assert.match(source, /session-create-catalog-readback/u);
  assert.match(source, /session-create-idempotent-replay/u);
  assert.match(source, /migrated-scale-conversation-seeding/u);
  assert.match(source, /const key = `agent:main:command-center:acceptance-scale:\$\{topicId\}:\$\{index\}`/u);
  assert.match(source, /params: \{ agentId: 'main', key, label \}/u);
  assert.doesNotMatch(source, /ensureVerifiedActivityFixture|createAttentionService/u);
  assert.match(source, /data-activity-receipt/u);
  assert.match(source, /method: 'command-center\.v1\.activity\.get'.*activityId: actionReceipt\.activityId/u);
  assert.ok(source.indexOf("collectScenario('scale-performance'") < source.indexOf("collectScenario('verified-activity-readback'"), 'verified Activity readback must follow the keyboard source action that produced its receipt');
  assert.match(source, /performanceBaseline: emittedBaseline/u);
  assert.match(source, /browser\.version\(\), baseline\.browser\.version/u);
  assert.match(sessionSource, /overlapping Session creates preserve every distinct plugin-owned key/u);
  assert.match(bridgeSource, /registered Session create bridge preserves independent durable identities under reversed completion/u);
});

test('release rows all execute and collect failures in canonical order', async () => {
  const visited = [];
  const rows = await runAcceptanceRows(RELEASE_ROW_IDS.map((id, index) => ({ id, async run() { visited.push(id); if (index === 1) throw new Error('fictional row failure'); return validEvidence(id); } })));
  assert.deepEqual(visited, RELEASE_ROW_IDS);
  assert.equal(rows[1].outcome, 'failed');
  assert.equal(rows.at(-1).outcome, 'passed');
});

test('release rows bound a stalled sibling and retain independent completion evidence', async () => {
  const progress = [];
  const completed = [];
  let active = 0;
  let peak = 0;
  const rows = await runAcceptanceRows(RELEASE_ROW_IDS.map((id, index) => ({
    id,
    run: async (signal) => {
      if (index === 1) return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
      active += 1;
      peak = Math.max(peak, active);
      try { completed.push(id); return validEvidence(id); }
      finally { active -= 1; }
    }
  })), { timeoutMs: 25, onProgress: (entry) => progress.push(entry) });
  assert.equal(rows[1].outcome, 'failed');
  assert.match(rows[1].error, /deadline/iu);
  assert.deepEqual(completed, RELEASE_ROW_IDS.filter((_, index) => index !== 1));
  assert.equal(progress.filter((entry) => entry.phase === 'started').length, RELEASE_ROW_IDS.length);
  assert.equal(progress.some((entry) => entry.id === RELEASE_ROW_IDS.at(-1) && entry.phase === 'passed'), true);
  assert.ok(peak <= 2, 'release rows must stay within the medium-resource concurrency lane');
});

test('release row cancellation settles cleanup before returning the failed row', async () => {
  let cleanupFinished = false;
  const rows = await runAcceptanceRows(RELEASE_ROW_IDS.map((id, index) => ({
    id,
    run: async (signal) => {
      if (index !== 0) return validEvidence(id);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleanupFinished = true;
      return validEvidence(id);
    }
  })), { timeoutMs: 10 });
  assert.equal(rows[0].outcome, 'failed');
  assert.equal(cleanupFinished, true);
});

test('an uncooperative timed-out row aborts report construction within a secondary bound', async () => {
  const startedAt = Date.now();
  let siblingCancelled = false;
  await assert.rejects(() => runAcceptanceRows(RELEASE_ROW_IDS.map((id, index) => ({
    id,
    run: async (signal) => {
      if (index === 0) return new Promise(() => {});
      if (index === 1) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        siblingCancelled = true;
      }
      return validEvidence(id);
    }
  })), { timeoutMs: 5, cleanupTimeoutMs: 10 }), /did not settle/iu);
  assert.equal(siblingCancelled, true, 'fatal row cancellation must abort and await active sibling cleanup');
  assert.ok(Date.now() - startedAt < 200, 'uncooperative row cancellation exceeded its cleanup bound');
});

test('release report binds closed evidence and finalization to one build digest', async () => {
  const rows = await validRows();
  const report = createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() });
  assert.equal(report.outcome, 'passed');
  assert.equal(assertAcceptanceReportPassed(report), true);
  assert.equal(report.rows.length, 9);
  assert.equal(report.performanceBaseline.capture.identityDigest, performanceBaseline.capture.identityDigest);
  assert.equal(Object.isFrozen(report.rows[3].evidence.thresholds), true);
  assert.throws(() => { report.rows[3].evidence.thresholds.dashboardLoadMs += 1; }, /read only|Cannot assign/iu);
  assert.equal(assertAcceptanceReportPassed(report), true);
  const reloaded = JSON.parse(JSON.stringify(report));
  assert.equal(assertAcceptanceReportPassed(reloaded), true);
  assert.equal(Object.isFrozen(reloaded.rows[3].evidence.thresholds), true);
  const widened = JSON.parse(JSON.stringify(report));
  widened.rows[3].evidence.observations.dashboardLoadMs += 10;
  widened.rows[3].evidence.thresholds.dashboardLoadMs += 10;
  assert.throws(() => assertAcceptanceReportPassed(widened), /frozen identity/u);
  const staleBuild = JSON.parse(JSON.stringify(report));
  staleBuild.buildDigest = 'b'.repeat(64);
  assert.throws(() => assertAcceptanceReportPassed(staleBuild), /exact build digest/u);
  const forgedOutcome = JSON.parse(JSON.stringify(report));
  forgedOutcome.rows[0] = { id: RELEASE_ROW_IDS[0], outcome: 'failed', error: 'fictional failure' };
  assert.throws(() => assertAcceptanceReportPassed(forgedOutcome), /does not match its evidence/u);
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows: rows.slice(1), finalization: finalization() }), /all release rows/u);
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization().slice(1) }), /every finalization phase/u);
});

test('release report rejects a different scale fixture identity', async () => {
  const rows = await validRows();
  rows.find((row) => row.id === 'scale-performance').evidence.fixtureIdentity = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => createAcceptanceReport({ rows, buildDigest: BUILD, finalization: finalization() }), /fixtureIdentity/u);
});

test('release report accepts faster subsequent observations and rejects immutable-threshold regressions', async () => {
  const fasterRows = await validRows();
  const scale = fasterRows.find((row) => row.id === 'scale-performance').evidence;
  scale.observations.dashboardLoadMs = Math.max(0.25, scale.thresholds.dashboardLoadMs - 0.5);
  assert.equal(createAcceptanceReport({ rows: fasterRows, buildDigest: BUILD, finalization: finalization() }).outcome, 'passed');

  const slowerRows = await validRows();
  const slowerScale = slowerRows.find((row) => row.id === 'scale-performance').evidence;
  slowerScale.observations.dashboardLoadMs = slowerScale.thresholds.dashboardLoadMs + 0.01;
  assert.throws(() => createAcceptanceReport({ rows: slowerRows, buildDigest: BUILD, finalization: finalization() }), /immutable first-observation ceiling/u);

  const widenedRows = await validRows();
  const widenedScale = widenedRows.find((row) => row.id === 'scale-performance').evidence;
  widenedScale.observations.dashboardLoadMs = widenedScale.thresholds.dashboardLoadMs + 10;
  widenedScale.thresholds.dashboardLoadMs += 10;
  assert.throws(() => createAcceptanceReport({ rows: widenedRows, buildDigest: BUILD, finalization: finalization() }), /frozen identity/u);
});

test('every passing release row rejects missing, open, stale, or unbounded evidence', async () => {
  const rows = await validRows();
  for (const [index, id] of RELEASE_ROW_IDS.entries()) {
    const missing = rows.map((row, rowIndex) => rowIndex === index ? { ...row, evidence: null } : row);
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows: missing, finalization: finalization() }), new RegExp(id));
    const open = rows.map((row, rowIndex) => rowIndex === index ? { ...row, evidence: { ...row.evidence, unsupported: true } } : row);
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows: open, finalization: finalization() }), /unsupported field/u);
  }
  const stale = rows.map((row) => row.id === 'pinned-host-startup' ? { ...row, evidence: { ...row.evidence, buildDigest: 'b'.repeat(64) } } : row);
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows: stale, finalization: finalization() }), /stale/u);
  const unbounded = rows.map((row) => row.id === 'desktop-primary-journey' ? { ...row, evidence: { ...row.evidence, topicId: 'x'.repeat(40_000) } } : row);
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows: unbounded, finalization: finalization() }), /unbounded/u);
});

test('release report fails closed after every row ran and redacts bounded diagnostics', async () => {
  const sensitiveDiagnostic = ['to', 'ken=fictional-sensitive-value'].join('');
  const rows = await runAcceptanceRows(RELEASE_ROW_IDS.map((id) => ({ id, run: async () => id === 'scale-performance' ? Promise.reject(new Error(sensitiveDiagnostic)) : validEvidence(id) })));
  const report = createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() });
  assert.equal(report.outcome, 'failed');
  assert.equal(report.rows.find((row) => row.id === 'scale-performance').error, ['to', 'ken=[redacted]'].join(''));
  assert.throws(() => assertAcceptanceReportPassed(report), /scale-performance/u);
});
