import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deriveReleaseThresholds, RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';

async function readReleasePerformanceBaseline() {
  return validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v1.json', import.meta.url), 'utf8')));
}

test('release performance baseline is pinned to the exact host receipt, release fixtures, and three first observations', async () => {
  const baseline = await readReleasePerformanceBaseline();
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(baseline.observations));
  assert.deepEqual(baseline.viewport, { width: 1440, height: 900 });
  assert.deepEqual(baseline.fixtureCounts, { chunkBoundaryNoteBytes: 524289, largeNoteBytes: 8388609, conversations: 100, activityRecords: 51, actionCards: 3, indexedNotes: 5000, indexedConversations: 5000 });
  assert.equal(baseline.fixtureIdentity, RELEASE_FIXTURE_IDENTITY);
  assert.deepEqual(Object.keys(baseline.observations), [...RELEASE_MEASUREMENTS]);
  for (const samples of Object.values(baseline.observations)) assert.equal(samples.length, 3);
  assert.equal(baseline.hostReceipt.commit, '30f2924e437857935f034ac349bae8cc22ef9fb0');
  assert.equal(baseline.hostReceipt.sourceDigest, 'sha256:6e4ac1c2c914e3794f04427b41d8661220c45a224513fe55062186dd3f6f4d06');
  assert.equal(baseline.hostReceipt.contractDigest, 'sha256:ec170da6eb2bb116bcf6b60cfea795af5dfa41ed83762194526eff977fc52fb6');
});

test('release performance baseline rejects receipt drift, inflated maxima, and silent regeneration', async () => {
  const baseline = await readReleasePerformanceBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostVersion: 'fictional-other-host' }), /pinned/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostReceipt: { ...baseline.hostReceipt, contractDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }), /pinned host identity/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, thresholds: { ...baseline.thresholds, dashboardReadyMs: 999999 } }), /first three observations/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, conversations: 101 } }), /conversations must be 100/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, indexedSearchMs: [1, 2] } }), /exactly three/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /release fixture/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, generatedAt: '2026-08-30T00:00:00.000Z' }), /unsupported field/);
});

test('release fixture boundaries include a split UTF-8 chunk and an 8 MiB Note with its trailing newline', () => {
  const chunkBoundaryNote = `${'x'.repeat(524_287)}é`;
  const chunkBoundaryBytes = Buffer.from(chunkBoundaryNote, 'utf8');
  assert.equal(chunkBoundaryBytes.length, RELEASE_FIXTURE_COUNTS.chunkBoundaryNoteBytes);
  assert.equal(chunkBoundaryBytes.subarray(0, 524_288).at(-1), 0xc3);
  assert.equal(chunkBoundaryBytes.subarray(524_288).at(0), 0xa9);
  const largeNote = `${'x'.repeat(8 * 1024 * 1024)}\n`;
  assert.equal(Buffer.byteLength(largeNote), RELEASE_FIXTURE_COUNTS.largeNoteBytes);
});
