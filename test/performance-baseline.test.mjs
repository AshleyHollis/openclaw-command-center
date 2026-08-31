import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { captureFirstReleasePerformanceBaseline, deriveReleaseThresholds, RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, validateReleasePerformanceBaseline, validateReleasePerformanceBaselineSeed } from '../src/performance-baseline.mjs';

async function readReleasePerformanceBaseline() {
  return validateReleasePerformanceBaselineSeed(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v1.json', import.meta.url), 'utf8')));
}

test('release performance seed pins the exact corpus without claiming an unobserved successful baseline', async () => {
  const seed = await readReleasePerformanceBaseline();
  assert.deepEqual(seed.viewport, { width: 1440, height: 900 });
  assert.deepEqual(seed.fixtureCounts, { chunkBoundaryNoteBytes: 524289, largeNoteBytes: 8388609, conversations: 100, activityRecords: 101, actionCards: 2, indexedNotes: 5000, indexedConversationMessages: 5000 });
  assert.equal(seed.fixtureIdentity, RELEASE_FIXTURE_IDENTITY);
  assert.deepEqual(seed.capture, { policy: 'first-successful-pinned-harness-observation', successfulRunOrdinal: null });
  assert.equal(seed.hostReceipt.commit, '30f2924e437857935f034ac349bae8cc22ef9fb0');
  assert.throws(() => validateReleasePerformanceBaseline(seed), /unsupported field|observations/u);
});

test('release performance baseline rejects receipt drift, widened ceilings, zero observations, and silent regeneration', async () => {
  const seed = await readReleasePerformanceBaseline();
  const firstObservations = Object.fromEntries(RELEASE_MEASUREMENTS.map((name, index) => [name, index + 0.25]));
  const baseline = captureFirstReleasePerformanceBaseline(seed, firstObservations);
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(firstObservations));
  assert.equal(baseline.capture.successfulRunOrdinal, 1);
  assert.throws(() => validateReleasePerformanceBaselineSeed({ ...seed, capture: { ...seed.capture, successfulRunOrdinal: 1 } }), /pending/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostVersion: 'fictional-other-host' }), /pinned/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostReceipt: { ...baseline.hostReceipt, contractDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }), /pinned host identity/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, thresholds: { ...baseline.thresholds, dashboardRefreshMs: 999999 } }), /first observation/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, conversations: 99 } }), /conversations must be 100/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, searchQueryMs: 0 } }), /first positive/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, searchQueryMs: undefined } }), /first positive/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, successfulRunOrdinal: 2 } }), /first successful/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, observationsDigest: 'sha256:' + 'a'.repeat(64) } }), /capture evidence/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /release fixture/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, generatedAt: '2026-08-30T00:00:00.000Z' }), /unsupported field/);
});

test('release fixture includes the large and multibyte boundary Notes', () => {
  const chunkBoundaryNote = `${'x'.repeat(524_287)}é`;
  const chunkBoundaryBytes = Buffer.from(chunkBoundaryNote, 'utf8');
  assert.equal(chunkBoundaryBytes.length, RELEASE_FIXTURE_COUNTS.chunkBoundaryNoteBytes);
  assert.equal(chunkBoundaryBytes.subarray(0, 524_288).at(-1), 0xc3);
  assert.equal(chunkBoundaryBytes.subarray(524_288).at(0), 0xa9);
  const largeNote = `${'x'.repeat(8_388_608)}\n`;
  assert.equal(Buffer.byteLength(largeNote), RELEASE_FIXTURE_COUNTS.largeNoteBytes);
});
