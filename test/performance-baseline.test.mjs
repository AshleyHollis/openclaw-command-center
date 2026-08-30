import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deriveReleaseThresholds, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';

async function readReleasePerformanceBaseline() {
  return validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v1.json', import.meta.url), 'utf8')));
}

test('release performance baseline is pinned to the host, browser, fixtures, and first observations', async () => {
  const baseline = await readReleasePerformanceBaseline();
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(baseline.rawMeasurements));
  assert.deepEqual(baseline.viewports, { desktop: { width: 1440, height: 900 }, mobile: { width: 320, height: 900 } });
  assert.deepEqual(baseline.fixtureCounts, { largeNoteBytes: 8388609, conversations: 101, activityRecords: 51, actionCards: 2, indexedNotes: 5000, indexedConversations: 5000 });
  assert.equal(baseline.hostReceipt.commit, '30f2924e437857935f034ac349bae8cc22ef9fb0');
});

test('release performance baseline rejects drift, inflated thresholds, and incomplete observations', async () => {
  const baseline = await readReleasePerformanceBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostVersion: 'fictional-other-host' }), /pinned/u);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, thresholds: { ...baseline.thresholds, dashboardReadyMs: 999999 } }), /slower first observation/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, conversations: 100 } }), /conversations must be 101/);
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, rawMeasurements: { ...baseline.rawMeasurements, indexedSearchMs: { desktop: -1, mobile: 1 } } }), /non-negative integer/);
});
