import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertAcceptanceReportPassed, createAcceptanceReport, FINALIZATION_PHASES, RELEASE_ROW_IDS, runAcceptanceRows } from '../src/acceptance-report.mjs';
import { RELEASE_FIXTURE_COUNTS, RELEASE_MEASUREMENTS, releasePerformanceIdentity } from '../src/performance-baseline.mjs';

const BUILD = 'a'.repeat(64);
const observations = Object.freeze(Object.fromEntries(RELEASE_MEASUREMENTS.map((name, index) => [name, index + 0.25])));
const thresholds = Object.freeze(Object.fromEntries(RELEASE_MEASUREMENTS.map((name) => [name, Math.ceil(observations[name])])));
const finalization = () => FINALIZATION_PHASES.map((phase) => ({ phase }));

function validEvidence(id) {
  const values = {
    'pinned-host-startup': { schemaVersion: 1, hostReceipt: { ...releasePerformanceIdentity.hostReceipt }, buildDigest: BUILD, startupMigrationVerified: true, routeGrantObserved: true, scriptsOnlyFrame: true, secureOrigin: { protocol: 'https:', hostname: 'command-center.fictional.ts.net', loopbackOnly: true }, notificationLifecycle: { closedTabDelivered: true, cleared: true, bindingRevoked: true, bindingReconciled: true } },
    'desktop-primary-journey': { schemaVersion: 1, topicId: 'fictional-topic', authoritativeReadback: { primarySession: true, conversation: true, closedConversation: true, note: true, attention: true, activity: true, topicReview: true }, actions: Array.from({ length: 12 }, (_, index) => `action-${index}`) },
    'mobile-accessibility-journey': { schemaVersion: 1, viewport: { width: 320, height: 900 }, keyboardOnly: true, zoom200: true, reflow400: true, forcedColors: true, reducedMotion: true, focusRestored: true, announcements: true, colorIndependent: true, minimumTargetCssPx: 44, noPageOverflow: true, states: ['navigation', 'topic', 'conversation', 'note-dialog', 'note-preview', 'search', 'attention', 'review'] },
    'scale-performance': { schemaVersion: 1, fixtureIdentity: 'sha256:' + 'b'.repeat(64), fixtureCounts: { ...RELEASE_FIXTURE_COUNTS }, observations: { ...observations }, thresholds: { ...thresholds }, activityPage: { firstPageCount: 50, secondPageCount: 50, thirdPageCount: 1, unique: true, orderPreserved: true }, search: { missingProjectionRebuilt: true, staleProjectionRebuilt: true, indexedQuery: true } },
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
  assert.doesNotMatch(source, /requireScenario\(/u);
  assert.match(source, /testContext\.diagnostic\(/u);
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

test('release report binds closed evidence and finalization to one build digest', async () => {
  const rows = await validRows();
  const report = createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization() });
  assert.equal(report.outcome, 'passed');
  assert.equal(assertAcceptanceReportPassed(report), true);
  assert.equal(report.rows.length, 9);
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows: rows.slice(1), finalization: finalization() }), /all release rows/u);
  assert.throws(() => createAcceptanceReport({ buildDigest: BUILD, rows, finalization: finalization().slice(1) }), /every finalization phase/u);
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
