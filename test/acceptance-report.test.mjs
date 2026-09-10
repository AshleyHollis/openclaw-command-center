import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertAcceptanceReportPassed, createAcceptanceReport as createAcceptanceReportBase, FINALIZATION_PHASES, RELEASE_ROW_IDS, runAcceptanceRows } from '../src/acceptance-report.mjs';
import { captureFirstReleasePerformanceBaseline, deriveReleasePerformanceBudget, RELEASE_PERFORMANCE_BASELINE_VERSION, RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, releasePerformanceIdentity } from '../src/performance-baseline.mjs';

const BUILD = 'a'.repeat(64);
const observations = Object.freeze(Object.fromEntries(RELEASE_MEASUREMENTS.map((name, index) => [name, index + 0.25])));
const performanceBaseline = captureFirstReleasePerformanceBaseline({ schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION, hostVersion: releasePerformanceIdentity.hostVersion, hostReceipt: releasePerformanceIdentity.hostReceipt, pluginBuildDigest: `sha256:${BUILD}`, browser: { engine: 'chromium', playwrightVersion: releasePerformanceIdentity.playwrightVersion, version: '151.0.7922.34' }, viewport: releasePerformanceIdentity.viewport, fixtureIdentity: RELEASE_FIXTURE_IDENTITY, fixtureCounts: RELEASE_FIXTURE_COUNTS, capture: { policy: 'first-successful-pinned-harness-observation', successfulRunOrdinal: null } }, observations);
const createAcceptanceReport = (input) => createAcceptanceReportBase({ ...input, performanceBaseline: input.performanceBaseline ?? performanceBaseline });
const thresholds = deriveReleasePerformanceBudget(performanceBaseline).thresholds;
const finalization = () => FINALIZATION_PHASES.map((phase) => ({ phase }));

function validEvidence(id) {
  const values = {
    'pinned-host-startup': { schemaVersion: 2, hostReceipt: { ...releasePerformanceIdentity.hostReceipt }, buildDigest: BUILD, startupMigrationVerified: true, routeGrantObserved: true, secureOrigin: { protocol: 'https:', hostname: 'command-center.fictional.ts.net', loopbackOnly: true }, nativeUi: { pluginId: 'command-center', revision: 'fictional-native-revision', activationObserved: true, authenticatedHttpObserved: true } },
    'desktop-primary-journey': { schemaVersion: 2, topicId: 'fictional-topic', authoritativeReadback: { existingTopics: true, primarySession: true, conversation: true, note: true, chatSend: true, conversationAfterRestart: true }, actions: ['existing-topic-open', 'note-read', 'native-chat-open', 'native-chat-send', 'conversation-create', 'conversation-replay', 'conversation-refresh', 'native-return'] },
    'desktop-keyboard-journey': { schemaVersion: 2, viewport: { width: 1440, height: 900 }, keyboardOnly: true, forcedColors: true, reducedMotion: true, focusRestored: true, announcements: true, colorIndependent: true, noPageOverflow: true, states: ['topics-navigation', 'notes-list', 'note-reader', 'native-chat-handoff', 'conversation-create', 'unknown-creation', 'source-unavailable', 'permission-refused'] },
    'scale-performance': { schemaVersion: 2, fixtureIdentity: RELEASE_FIXTURE_IDENTITY, fixtureCounts: { ...RELEASE_FIXTURE_COUNTS }, observations: { ...observations }, thresholds: { ...thresholds }, conversationPage: { firstPageCount: 50, secondPageCount: 50, thirdPageCount: 1, unique: true, orderPreserved: true }, notes: { largeNoteBytes: 8_388_609, readOnly: true, paginationVerified: true } },
    'degraded-bridge-grants': { schemaVersion: 2, mode: 'degraded', safeReadObserved: true, mutationRejected: true, bridge: { protocolVersion: 1, writeGrant: false, observedFromAuthenticatedAction: true, action: 'conversations.create', httpStatus: 422, errorCode: 'capability-unavailable' } },
    'degraded-source-availability': { schemaVersion: 2, mode: 'degraded', safeReadObserved: true, mutationRejected: true, source: { capability: 'sessions', available: false, bindingObserved: true } },
    'recovery-only-compatibility': { schemaVersion: 2, mode: 'recovery-only', safeReadObserved: true, mutationsRejected: true, mismatches: ['host', 'build', 'pluginApi', 'bridgeProtocol', 'binding', 'schema'] },
    'destructive-migration-restoration': { schemaVersion: 2, snapshotId: 'fictional-snapshot', writesBlockedBeforeValidation: true, exactIdentityValidated: true, postValidationMutation: true, boundaries: { beforeCommit: true, afterCommitBeforeManifest: true } },
    'privacy-artifact-output': { schemaVersion: 2, repository: true, generated: true, capturedOutput: true, browserDiagnostics: true, hostDiagnostics: true, trafficFinalized: true }
  };
  return structuredClone(values[id]);
}

async function validRows() {
  return runAcceptanceRows(RELEASE_ROW_IDS.map((id) => ({ id, run: async () => validEvidence(id) })));
}

test('scope-v2 acceptance requires report version 4, a separate budget and native retained evidence version 2', async () => {
  const report = createAcceptanceReport({ buildDigest: BUILD, rows: await validRows(), finalization: finalization() });
  assert.equal(report.schemaVersion, 4);
  assert.deepEqual(report.performanceBudget, deriveReleasePerformanceBudget(performanceBaseline));
  assert.equal(assertAcceptanceReportPassed(report), true);
  assert.equal(report.rows.length, 9);
  assert.equal(report.finalization.length, 6);
  for (const row of report.rows) assert.equal(row.evidence.schemaVersion, 2);
});

test('real-host release dispatches native producers and preserves the controller receipt boundary', async () => {
  // Static wiring checks complement the real coordinator tests; not runtime qualification.
  const source = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("if (['release', 'prerequisites'].includes(acceptancePlan.kind)) {\n    assert.ok(descriptor");
  const end = source.indexOf('const isolatedEvidence = new Map()', start);
  assert.ok(start > 0 && end > start);
  const release = source.slice(start, end);
  assert.ok(source.includes("nativeDiagnostic || ['release', 'prerequisites'].includes(acceptancePlan.kind)"), 'release and prerequisite admission require sealed inputs');
  assert.match(release, /const execute = prerequisitesOnly \? runNativeReleasePrerequisites : runNativeReleaseCapture/u);
  assert.match(release, /const nativeResult = await execute\(/u);
  assert.match(release, /prerequisitesOnly \? \{\} : \{ scale: bind\(exerciseNativeScaleJourney\) \}/u, 'prerequisite runners cannot include scale');
  const prerequisiteReturn = release.indexOf('acceptance-prerequisites=');
  assert.ok(prerequisiteReturn > 0 && prerequisiteReturn < release.indexOf('const { report, capturedBaseline }'));
  for (const producer of ['exerciseNativeControlUiActivation', 'exerciseNativeKeyboardJourney', 'exerciseSecureHostVariant', 'exerciseNativeDegradedBridgeHostVariant', 'exerciseNativeDegradedSourceRow', 'exerciseNativeReleaseMismatchVariant', 'exerciseNativePluginApiMismatchVariant', 'exerciseNativeBindingMismatchHostVariant', 'exerciseNativeForeignDatabaseRestorationVariant', 'exerciseNativeRecoveryOnlyHostVariant', 'exerciseNativeRestorationMatrix', 'exerciseNativeScaleJourney']) assert.ok(release.includes(producer), `${producer} must be wired`);
  assert.match(release, /signal, onFinalization/u);
  const scan = release.indexOf('scanPublicEvidence([JSON.stringify(report), JSON.stringify(result)])');
  const commit = release.indexOf('await writeFile(capturedPerformanceBaselinePath');
  const emit = release.indexOf('testContext.diagnostic(`acceptance-result=');
  assert.ok(scan > 0 && scan < commit && commit < emit);
  assert.match(release, /\{ flag: 'wx' \}/u);
  assert.match(release, /acceptance-report=\$\{JSON\.stringify\(report\)\}/u);
  assert.doesNotMatch(release.slice(release.indexOf('const result ='), scan), /acceptanceReport:/u, 'keep the seven-field controller completion envelope');
  assert.match(release, /return;\s+\}\s*$/u, 'native release must not fall through into historical iframe journeys');
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
  assert.throws(() => { report.rows[3].evidence.thresholds.topicsLoadMs += 1; }, /read only|Cannot assign/iu);
  assert.equal(assertAcceptanceReportPassed(report), true);
  const reloaded = JSON.parse(JSON.stringify(report));
  assert.equal(assertAcceptanceReportPassed(reloaded), true);
  assert.equal(Object.isFrozen(reloaded.rows[3].evidence.thresholds), true);
  const widened = JSON.parse(JSON.stringify(report));
  widened.rows[3].evidence.observations.topicsLoadMs += 10;
  widened.rows[3].evidence.thresholds.topicsLoadMs += 10;
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
  scale.observations.topicsLoadMs = Math.max(0.25, scale.thresholds.topicsLoadMs - 0.5);
  assert.equal(createAcceptanceReport({ rows: fasterRows, buildDigest: BUILD, finalization: finalization() }).outcome, 'passed');

  const slowerRows = await validRows();
  const slowerScale = slowerRows.find((row) => row.id === 'scale-performance').evidence;
  slowerScale.observations.topicsLoadMs = slowerScale.thresholds.topicsLoadMs + 0.01;
  assert.throws(() => createAcceptanceReport({ rows: slowerRows, buildDigest: BUILD, finalization: finalization() }), /frozen performance budget/u);

  const widenedRows = await validRows();
  const widenedScale = widenedRows.find((row) => row.id === 'scale-performance').evidence;
  widenedScale.observations.topicsLoadMs = widenedScale.thresholds.topicsLoadMs + 10;
  widenedScale.thresholds.topicsLoadMs += 10;
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

test('historical report and evidence versions cannot qualify the retained native release', async () => {
  const report = createAcceptanceReport({ buildDigest: BUILD, rows: await validRows(), finalization: finalization() });
  for (const schemaVersion of [1, 2, 3]) assert.throws(() => assertAcceptanceReportPassed({ ...structuredClone(report), schemaVersion }), /schemaVersion is unsupported/u);
  for (const id of RELEASE_ROW_IDS) {
    const rows = await validRows();
    rows.find(row => row.id === id).evidence.schemaVersion = 1;
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /schemaVersion must be 2/u);
    const stored = structuredClone(report);
    stored.rows.find(row => row.id === id).evidence.schemaVersion = 1;
    assert.throws(() => assertAcceptanceReportPassed(stored), /schemaVersion must be 2/u);
  }
});

test('stored report refuses omitted, forged and jointly widened performance budgets', async () => {
  const report = createAcceptanceReport({ buildDigest: BUILD, rows: await validRows(), finalization: finalization() });
  const missing = structuredClone(report);
  delete missing.performanceBudget;
  assert.throws(() => assertAcceptanceReportPassed(missing), /performanceBudget/u);
  const forged = structuredClone(report);
  forged.performanceBudget.policy = 'caller-policy';
  assert.throws(() => assertAcceptanceReportPassed(forged), /frozen budget/u);
  const widened = structuredClone(report);
  widened.performanceBudget.thresholds.topicsLoadMs += 1;
  widened.rows.find(row => row.id === 'scale-performance').evidence.thresholds.topicsLoadMs += 1;
  assert.throws(() => assertAcceptanceReportPassed(widened), /frozen budget/u);
});

test('native activation must identify the plugin revision and observed authenticated HTTP', async () => {
  const cases = [
    evidence => { evidence.nativeUi.pluginId = 'other-plugin'; },
    evidence => { evidence.nativeUi.revision = '   '; },
    evidence => { evidence.nativeUi.revision = 'x'.repeat(257); },
    evidence => { evidence.nativeUi.activationObserved = false; },
    evidence => { evidence.nativeUi.authenticatedHttpObserved = false; },
    evidence => { evidence.scriptsOnlyFrame = true; },
    evidence => { evidence.notificationLifecycle = { closedTabDelivered: true }; },
    evidence => { evidence.secureOrigin.protocol = 'http:'; },
    evidence => { evidence.hostReceipt.commit = 'b'.repeat(40); }
  ];
  for (const change of cases) {
    const rows = await validRows();
    change(rows[0].evidence);
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /pinned-host-startup/u);
  }
});

test('desktop retained journey requires each exact action and authoritative readback', async () => {
  const required = ['existing-topic-open', 'note-read', 'native-chat-open', 'native-chat-send', 'conversation-create', 'conversation-replay', 'conversation-refresh', 'native-return'];
  for (const omitted of required) {
    const rows = await validRows();
    const desktop = rows[1].evidence;
    desktop.actions = desktop.actions.filter(action => action !== omitted);
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /desktop-primary-journey.actions/u);
  }
  for (const replacement of [required[0], 'arbitrary-action', '', 42]) {
    const rows = await validRows();
    rows[1].evidence.actions[1] = replacement;
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /desktop-primary-journey.actions/u);
  }
  for (const key of ['existingTopics', 'primarySession', 'conversation', 'note', 'chatSend', 'conversationAfterRestart']) {
    const rows = await validRows();
    rows[1].evidence.authoritativeReadback[key] = false;
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /authoritativeReadback/u);
  }
  const rows = await validRows();
  rows[1].evidence.authoritativeReadback.attention = true;
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /unsupported field attention/u);
});

test('keyboard evidence requires retained navigation and failure states, not arbitrary counts', async () => {
  for (const state of ['topics-navigation', 'notes-list', 'note-reader', 'native-chat-handoff', 'conversation-create', 'unknown-creation', 'source-unavailable', 'permission-refused']) {
    const rows = await validRows();
    rows[2].evidence.states = rows[2].evidence.states.filter(value => value !== state);
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /desktop-keyboard-journey.states/u);
  }
  const rows = await validRows();
  rows[2].evidence.states = Array(8).fill('note-reader');
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /desktop-keyboard-journey.states/u);
  for (const field of ['keyboardOnly', 'forcedColors', 'reducedMotion', 'focusRestored', 'announcements', 'colorIndependent', 'noPageOverflow']) {
    const rows = await validRows();
    rows[2].evidence[field] = false;
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), new RegExp(field));
  }
});

test('retained performance evidence requires exact Conversation pages and read-only Note scale', async () => {
  const changes = [
    scale => { scale.conversationPage.thirdPageCount = 0; },
    scale => { scale.conversationPage.unique = false; },
    scale => { scale.conversationPage.orderPreserved = false; },
    scale => { scale.notes.largeNoteBytes = 8_388_608; },
    scale => { scale.notes.readOnly = false; },
    scale => { scale.notes.paginationVerified = false; },
    scale => { scale.fixtureCounts.noteFiles = 4_999; },
    scale => { scale.fixtureCounts.conversations = 100; },
    scale => { scale.activityPage = scale.conversationPage; },
    scale => { scale.search = { indexedQuery: true }; },
    scale => { scale.observations.noteReadMs = 1; },
    scale => { delete scale.observations.noteNextPageMs; }
  ];
  for (const change of changes) {
    const rows = await validRows();
    change(rows[3].evidence);
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /scale-performance/u);
  }
});

test('degraded native write evidence cannot infer refusal from bootstrap asset grants', async () => {
  const rows = await validRows();
  rows.find(row => row.id === 'degraded-bridge-grants').evidence.bridge = {
    protocolVersion: 1, writeGrant: false, observedFromBootstrap: true
  };
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /degraded-bridge-grants.bridge/u);
  const valid = createAcceptanceReport({ buildDigest: BUILD, rows: await validRows(), finalization: finalization() });
  for (const change of [
    bridge => { bridge.observedFromAuthenticatedAction = false; },
    bridge => { bridge.action = 'notes.edit'; },
    bridge => { bridge.httpStatus = 200; },
    bridge => { bridge.errorCode = 'feature-unavailable'; }
  ]) {
    const stored = structuredClone(valid);
    change(stored.rows.find(row => row.id === 'degraded-bridge-grants').evidence.bridge);
    assert.throws(() => assertAcceptanceReportPassed(stored), /degraded-bridge-grants.bridge/u);
  }
});

test('degraded source evidence cannot substitute a deferred capability for Sessions', async () => {
  const validReport = createAcceptanceReport({ buildDigest: BUILD, rows: await validRows(), finalization: finalization() });
  for (const capability of ['search', 'analysis', 'notifications', 'cron', 'unknown']) {
    const rows = await validRows();
    rows.find(row => row.id === 'degraded-source-availability').evidence.source.capability = capability;
    assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() }), /degraded-source-availability.source.capability/u);
    const stored = structuredClone(validReport);
    stored.rows.find(row => row.id === 'degraded-source-availability').evidence.source.capability = capability;
    assert.throws(() => assertAcceptanceReportPassed(stored), /degraded-source-availability.source.capability/u);
  }
});

test('each finalization failure prevents a passing release even with complete retained evidence', async () => {
  for (const phase of ['browser-close', 'host-stop', 'browser-traffic', 'host-traffic', 'child-traffic', 'build-digest']) {
    const report = createAcceptanceReport({ buildDigest: BUILD, rows: await validRows(), finalization: finalization().map(entry => entry.phase === phase ? { ...entry, error: new Error('fictional cleanup failure') } : entry) });
    assert.equal(report.outcome, 'failed');
    assert.throws(() => assertAcceptanceReportPassed(report), new RegExp(phase));
  }
});
