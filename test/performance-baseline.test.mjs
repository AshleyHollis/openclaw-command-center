import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPerformanceObservationWithinBaseline, captureFirstReleasePerformanceBaseline, deriveReleaseThresholds, RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, validateReleasePerformanceBaseline, validateReleasePerformanceBaselineSeed } from '../src/performance-baseline.mjs';

async function readReleasePerformanceBaseline() {
  return validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v1.json', import.meta.url), 'utf8')));
}

test('release performance baseline pins the measured corpus and immutable first successful capture', async () => {
  const baseline = await readReleasePerformanceBaseline();
  assert.deepEqual(baseline.viewport, { width: 1440, height: 900 });
  assert.deepEqual(baseline.fixtureCounts, { largeNoteBytes: 8388609, conversations: 101, activityRecords: 51, actionCards: 2, indexedNotes: 5000, indexedConversationMessages: 5000 });
  assert.deepEqual(RELEASE_MEASUREMENTS, ['startupReadinessMs', 'dashboardLoadMs', 'topicOpenCreateMs', 'chatSendMs', 'conversationLifecycleMs', 'largeNoteLifecycleMs', 'indexedSearchMs', 'activityNextPageMs', 'topicReviewApplyMs', 'mobileReflowMs']);
  assert.equal(baseline.fixtureIdentity, RELEASE_FIXTURE_IDENTITY);
  assert.equal(baseline.capture.successfulRunOrdinal, 1);
  assert.equal(baseline.browser.version, '151.0.7922.34');
  assert.equal(baseline.hostReceipt.commit, '19686a23834910173df0fd1f77bd762ffcda2afd');
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(baseline.observations));
  assert.throws(() => validateReleasePerformanceBaselineSeed(baseline), /unsupported field|seed/u);
  for (const name of RELEASE_MEASUREMENTS) {
    assert.equal(assertPerformanceObservationWithinBaseline(name, baseline.thresholds[name], baseline), true);
    assert.throws(() => assertPerformanceObservationWithinBaseline(name, baseline.thresholds[name] + 1, baseline), /exceeded/u);
  }
});

test('release performance baseline rejects receipt drift, widened ceilings, zero observations, and silent regeneration', async () => {
  const committed = await readReleasePerformanceBaseline();
  const seed = {
    schemaVersion: committed.schemaVersion,
    hostVersion: committed.hostVersion,
    hostReceipt: committed.hostReceipt,
    pluginBuildDigest: committed.pluginBuildDigest,
    browser: committed.browser,
    viewport: committed.viewport,
    fixtureIdentity: committed.fixtureIdentity,
    fixtureCounts: committed.fixtureCounts,
    capture: { policy: committed.capture.policy, successfulRunOrdinal: null }
  };
  assert.deepEqual(validateReleasePerformanceBaselineSeed(seed).capture, seed.capture);
  const firstObservations = Object.fromEntries(RELEASE_MEASUREMENTS.map((name, index) => [name, index + 0.25]));
  const baseline = captureFirstReleasePerformanceBaseline(seed, firstObservations);
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(firstObservations));
  assert.equal(baseline.capture.successfulRunOrdinal, 1);
  assert.throws(() => validateReleasePerformanceBaselineSeed({ ...seed, capture: { ...seed.capture, successfulRunOrdinal: 1 } }), /pending/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostVersion: 'fictional-other-host' }), /pinned/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostReceipt: { ...baseline.hostReceipt, contractDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }), /pinned host identity/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, browser: { ...baseline.browser, version: '' } }), /browser identity/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, thresholds: { ...baseline.thresholds, dashboardLoadMs: 999999 } }), /first observation/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, conversations: 100 } }), /conversations must be 101/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, activityRecords: 52 } }), /activityRecords must be 51/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, indexedSearchMs: 0 } }), /first positive/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, indexedSearchMs: undefined } }), /first positive/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, successfulRunOrdinal: 2 } }), /first successful/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, observationsDigest: 'sha256:' + 'a'.repeat(64) } }), /capture evidence/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /release fixture/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, generatedAt: '2026-08-30T00:00:00.000Z' }), /unsupported field/);
});

test('release fixture includes one exact eight-MiB Note plus trailing newline', () => {
  const largeNote = `${'x'.repeat(8_388_608)}\n`;
  const bytes = Buffer.from(largeNote, 'utf8');
  assert.equal(bytes.length, RELEASE_FIXTURE_COUNTS.largeNoteBytes);
  assert.equal(bytes.subarray(0, 8_388_608).every((value) => value === 0x78), true);
  assert.equal(bytes.at(-1), 0x0a);
});
