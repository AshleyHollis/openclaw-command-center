import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAcceptanceReport, assertAcceptanceReportPassed, assertNonPerformanceAcceptanceEvidence, FINALIZATION_PHASES, RELEASE_ROW_IDS } from '../src/acceptance-report.mjs';
import { deriveReleasePerformanceBudget, RELEASE_FIXTURE_IDENTITY, releasePerformanceIdentity, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';
import { scanPublicEvidence } from '../src/safety.mjs';

const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const BUILD_DIGEST = /^[a-f0-9]{64}$/u;
const PARTICIPANTS = Object.freeze([
  'primary', 'keyboard', 'secure', 'bridgeDenied', 'sourceUnavailable', 'combinedDegraded', 'restoration',
  'hostMismatch', 'buildMismatch', 'pluginApiMismatch', 'bridgeProtocolMismatch', 'bindingMismatch',
  'foreignRestoration', 'schemaMismatch'
]);

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields differ`);
  return value;
}

function validateSlice(receipt, scenario, sourceCommit, workflowRun, hostImage) {
  const keys = ['schemaVersion', 'kind', 'scenario', 'sourceCommit', 'workflowRun', 'hostImage', 'buildDigest', 'evidence',
    ...(scenario === 'scale-performance' ? ['finalization'] : [])];
  exactKeys(receipt, keys, `${scenario} receipt`);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'command-center-release-qualification-slice');
  assert.equal(receipt.scenario, scenario);
  assert.equal(receipt.sourceCommit, sourceCommit);
  assert.equal(receipt.workflowRun, workflowRun);
  assert.equal(receipt.hostImage, hostImage);
  assert.match(receipt.buildDigest, BUILD_DIGEST);
  return receipt;
}

function validateTerminals(entries, label, { paired = false } = {}) {
  const expected = paired ? FINALIZATION_PHASES.flatMap(phase => [
    { schemaVersion: 1, scenario: 'scale-performance', phase, status: 'started' },
    { schemaVersion: 1, scenario: 'scale-performance', phase, status: 'passed' }
  ]) : FINALIZATION_PHASES.map(phase => ({ phase, status: 'passed' }));
  assert.deepEqual(entries, expected, `${label} finalization differs`);
}

const sliceDirectory = process.env.QUALIFICATION_SLICE_DIRECTORY;
const outputDirectory = process.env.QUALIFICATION_OUTPUT_DIRECTORY;
const sourceCommit = process.env.GITHUB_SHA;
const workflowRun = process.env.GITHUB_RUN_ID;
const hostImage = process.env.IMAGE;
assert.ok(sliceDirectory && outputDirectory, 'Qualification slice and output directories are required');
assert.match(sourceCommit ?? '', SOURCE_COMMIT);
assert.match(workflowRun ?? '', /^[0-9]+$/u);
assert.match(hostImage ?? '', /^ghcr\.io\/ashleyhollis\/openclaw@sha256:[a-f0-9]{64}$/u);

const prerequisites = validateSlice(JSON.parse(await readFile(path.join(sliceDirectory, 'native-release-prerequisites.json'), 'utf8')),
  'native-release-prerequisites', sourceCommit, workflowRun, hostImage);
const scale = validateSlice(JSON.parse(await readFile(path.join(sliceDirectory, 'scale-performance.json'), 'utf8')),
  'scale-performance', sourceCommit, workflowRun, hostImage);
assert.equal(prerequisites.buildDigest, scale.buildDigest, 'Qualification slices use different builds');

const prerequisiteEvidence = exactKeys(prerequisites.evidence,
  ['schemaVersion', 'kind', 'performanceQualified', 'buildDigest', 'hostIntegrity', 'rows', 'participants', 'finalization', 'privacy'],
  'prerequisite evidence');
assert.equal(prerequisiteEvidence.schemaVersion, 1);
assert.equal(prerequisiteEvidence.kind, 'native-release-prerequisites');
assert.equal(prerequisiteEvidence.performanceQualified, false);
assert.equal(prerequisiteEvidence.buildDigest, prerequisites.buildDigest);
const { schemaVersion: _hostReceiptVersion, commit: _hostReceiptCommit, ...expectedHostIntegrity } =
  releasePerformanceIdentity.hostReceipt;
assert.deepEqual(prerequisiteEvidence.hostIntegrity, expectedHostIntegrity);
const prerequisiteRows = assertNonPerformanceAcceptanceEvidence({
  buildDigest: prerequisites.buildDigest,
  rows: prerequisiteEvidence.rows
});
exactKeys(prerequisiteEvidence.participants, PARTICIPANTS, 'prerequisite participants');
for (const id of PARTICIPANTS) assert.equal(prerequisiteEvidence.participants[id], 'passed', `${id} did not pass`);
exactKeys(prerequisiteEvidence.finalization, PARTICIPANTS, 'prerequisite finalization');
for (const id of PARTICIPANTS) validateTerminals(prerequisiteEvidence.finalization[id], id);
assert.deepEqual(prerequisiteEvidence.privacy, { repository: true, generated: true, capturedOutput: true });

const scaleResult = exactKeys(scale.evidence,
  ['schemaVersion', 'outcome', 'scenario', 'scenarioIds', 'buildDigest', 'performanceQualified', 'evidence'], 'scale result');
assert.equal(scaleResult.schemaVersion, 1);
assert.equal(scaleResult.outcome, 'passed');
assert.equal(scaleResult.scenario, 'scale-performance');
assert.deepEqual(scaleResult.scenarioIds, ['scale-performance']);
assert.equal(scaleResult.buildDigest, scale.buildDigest);
assert.equal(scaleResult.performanceQualified, false);
validateTerminals(scale.finalization, 'scale', { paired: true });

const baseline = validateReleasePerformanceBaseline(JSON.parse(await readFile(
  new URL('../test/fixtures/release-performance-baseline.native-workspace.v3.json', import.meta.url), 'utf8')));
assert.deepEqual(scaleResult.evidence.browser, baseline.browser, 'Scale browser differs from the frozen baseline');
assert.deepEqual(scaleResult.evidence.viewport, baseline.viewport, 'Scale viewport differs from the frozen baseline');
const scaleRow = {
  schemaVersion: 2,
  fixtureIdentity: RELEASE_FIXTURE_IDENTITY,
  fixtureCounts: scaleResult.evidence.fixtureCounts,
  observations: scaleResult.evidence.observations,
  thresholds: deriveReleasePerformanceBudget(baseline).thresholds,
  conversationPage: scaleResult.evidence.conversationPage,
  notes: scaleResult.evidence.notes
};
const rowEvidence = [
  ...prerequisiteRows.slice(0, 3).map(row => row.evidence),
  scaleRow,
  ...prerequisiteRows.slice(3).map(row => row.evidence),
  { schemaVersion: 2, repository: true, generated: true, capturedOutput: true,
    browserDiagnostics: true, hostDiagnostics: true, trafficFinalized: true }
];
const report = createAcceptanceReport({
  buildDigest: prerequisites.buildDigest,
  rows: RELEASE_ROW_IDS.map((id, index) => ({ id, outcome: 'passed', evidence: rowEvidence[index] })),
  finalization: FINALIZATION_PHASES.map(phase => ({ phase })),
  performanceBaseline: baseline
});
assertAcceptanceReportPassed(report);
const acceptance = {
  schemaVersion: 1,
  outcome: 'passed',
  releaseRows: RELEASE_ROW_IDS,
  command: ['node', '--test', '--test-isolation=none', '--test-reporter=/opt/openclaw-control/src/ticket-test-reporter.js', 'test/real-host.acceptance.test.mjs'],
  expectedTest: 'mounts the built plugin through the isolated authenticated external tab',
  buildDigest: prerequisites.buildDigest,
  performanceBaseline: report.performanceBaseline
};
const receipt = { schemaVersion: 1, sourceCommit, workflowRun, hostImage, acceptance };
scanPublicEvidence([JSON.stringify(prerequisites), JSON.stringify(scale), JSON.stringify(report), JSON.stringify(receipt)],
  { label: 'qualification-receipt' });
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: 'qualification-sealed', sourceCommit, buildDigest: prerequisites.buildDigest,
  performance: scaleResult.evidence.observations }));
