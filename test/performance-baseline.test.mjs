import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from '../src/build.mjs';
import { assertPerformanceBaselineBuildIdentity, assertPerformanceObservationWithinBaseline, captureFirstReleasePerformanceBaseline, deriveReleaseThresholds, RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, releasePerformanceIdentity, validateReleasePerformanceBaseline, validateReleasePerformanceBaselineSeed } from '../src/performance-baseline.mjs';

async function readReleasePerformanceBaseline() {
  return validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v1.json', import.meta.url), 'utf8')));
}

test('release performance baseline pins the measured corpus and immutable first successful capture', async () => {
  const buildReceipt = await build();
  const baseline = await readReleasePerformanceBaseline();
  assert.equal(assertPerformanceBaselineBuildIdentity(baseline, `sha256:${buildReceipt.digest}`), true);
  assert.deepEqual(baseline.viewport, { width: 1440, height: 900 });
  assert.deepEqual(baseline.fixtureCounts, { largeNoteBytes: 8388609, conversations: 101, activityRecords: 101, actionCards: 2, indexedNotes: 5000, indexedConversationMessages: 5000 });
  assert.deepEqual(RELEASE_MEASUREMENTS, ['startupReadinessMs', 'dashboardLoadMs', 'topicOpenCreateMs', 'chatSendMs', 'conversationLifecycleMs', 'largeNoteLifecycleMs', 'indexedSearchMs', 'activityNextPageMs', 'topicReviewApplyMs', 'mobileReflowMs']);
  assert.equal(baseline.fixtureIdentity, RELEASE_FIXTURE_IDENTITY);
  assert.equal(baseline.capture.successfulRunOrdinal, 1);
  assert.equal(baseline.browser.version, '151.0.7922.34');
  assert.equal(baseline.hostReceipt.commit, '01072cc079ff2ba088daab493501c0b95b41428a');
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(baseline.observations));
  assert.throws(() => validateReleasePerformanceBaselineSeed(baseline), /unsupported field|seed/u);
  for (const name of RELEASE_MEASUREMENTS) {
    assert.equal(assertPerformanceObservationWithinBaseline(name, baseline.thresholds[name], baseline), true);
    assert.throws(() => assertPerformanceObservationWithinBaseline(name, baseline.thresholds[name] + 1, baseline), /exceeded/u);
  }
});

function coherentGeneratedBaseline() {
  const seed = {
    schemaVersion: 1,
    hostVersion: releasePerformanceIdentity.hostVersion,
    hostReceipt: releasePerformanceIdentity.hostReceipt,
    pluginBuildDigest: `sha256:${'b'.repeat(64)}`,
    browser: { engine: 'chromium', playwrightVersion: releasePerformanceIdentity.playwrightVersion, version: '151.0.7922.34' },
    viewport: releasePerformanceIdentity.viewport,
    fixtureIdentity: RELEASE_FIXTURE_IDENTITY,
    fixtureCounts: RELEASE_FIXTURE_COUNTS,
    capture: { policy: 'first-successful-pinned-harness-observation', successfulRunOrdinal: null }
  };
  const firstObservations = Object.fromEntries(RELEASE_MEASUREMENTS.map((name, index) => [name, index + 0.25]));
  return { seed, firstObservations, baseline: captureFirstReleasePerformanceBaseline(seed, firstObservations) };
}

test('release performance baseline generates one coherent pending capture', () => {
  const { seed, firstObservations, baseline } = coherentGeneratedBaseline();
  assert.deepEqual(validateReleasePerformanceBaselineSeed(seed).capture, seed.capture);
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(firstObservations));
  assert.equal(baseline.capture.successfulRunOrdinal, 1);
  assert.throws(() => validateReleasePerformanceBaselineSeed({ ...seed, capture: { ...seed.capture, successfulRunOrdinal: 1 } }), /pending/u);
});

test('release performance baseline rejects host version drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostVersion: 'fictional-other-host' }), /pinned/u);
});

test('release performance baseline rejects host receipt drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostReceipt: { ...baseline.hostReceipt, contractDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }), /pinned host identity/u);
});

test('release performance baseline rejects incomplete browser identity', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, browser: { ...baseline.browser, version: '' } }), /browser identity/u);
});

test('release performance baseline rejects final build identity drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => assertPerformanceBaselineBuildIdentity(baseline, `sha256:${'c'.repeat(64)}`), /final build/u);
});

for (const name of RELEASE_MEASUREMENTS) test(`release performance baseline rejects a widened ${name} ceiling`, () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, thresholds: { ...baseline.thresholds, [name]: baseline.thresholds[name] + 1 } }), /first observation/);
});

test('release performance baseline rejects conversation corpus drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, conversations: 100 } }), /conversations must be 101/);
});

test('release performance baseline rejects Activity corpus drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, activityRecords: 102 } }), /activityRecords must be 101/);
});

test('release performance baseline rejects a zero observation', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, indexedSearchMs: 0 } }), /first positive/);
});

test('release performance baseline rejects a missing observation', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, indexedSearchMs: undefined } }), /first positive/);
});

test('release performance baseline rejects a later capture ordinal', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, successfulRunOrdinal: 2 } }), /first successful/u);
});

test('release performance baseline rejects an observation digest mismatch', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, observationsDigest: 'sha256:' + 'a'.repeat(64) } }), /capture evidence/u);
});

test('release performance baseline rejects an identity digest mismatch', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, identityDigest: 'sha256:' + 'a'.repeat(64) } }), /capture evidence/u);
});

test('release performance baseline rejects fixture identity drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /release fixture/);
});

test('release performance baseline rejects unsupported top-level fields', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, generatedAt: '2026-08-30T00:00:00.000Z' }), /unsupported field/);
});

test('release fixture includes one exact eight-MiB Note plus trailing newline', () => {
  const largeNote = `${'x'.repeat(8_388_608)}\n`;
  const bytes = Buffer.from(largeNote, 'utf8');
  assert.equal(bytes.length, RELEASE_FIXTURE_COUNTS.largeNoteBytes);
  assert.equal(bytes.subarray(0, 8_388_608).every((value) => value === 0x78), true);
  assert.equal(bytes.at(-1), 0x0a);
});
