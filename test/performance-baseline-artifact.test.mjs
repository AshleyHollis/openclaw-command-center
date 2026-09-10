import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from '../src/build.mjs';
import { assertPerformanceBaselineBuildIdentity, assertPerformanceObservationWithinBaseline, deriveReleaseThresholds, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, validateReleasePerformanceBaseline, validateReleasePerformanceBaselineSeed } from '../src/performance-baseline.mjs';

async function readReleasePerformanceBaseline() {
  return validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v3.json', import.meta.url), 'utf8')));
}

test('release performance baseline pins the measured corpus and immutable first successful capture', async () => {
  const buildReceipt = await build();
  const baseline = await readReleasePerformanceBaseline();
  assert.equal(assertPerformanceBaselineBuildIdentity(baseline, `sha256:${buildReceipt.digest}`), true);
  assert.deepEqual(baseline.viewport, { width: 1440, height: 900 });
  assert.deepEqual(baseline.fixtureCounts, { largeNoteBytes: 8388609, conversations: 101, noteFiles: 5000, conversationMessages: 5000 });
  assert.deepEqual(RELEASE_MEASUREMENTS, ['startupReadinessMs', 'topicsLoadMs', 'topicOpenMs', 'chatSendMs', 'conversationCreateMs', 'largeNoteReadMs', 'conversationNextPageMs', 'noteNextPageMs']);
  assert.equal(baseline.fixtureIdentity, RELEASE_FIXTURE_IDENTITY);
  assert.equal(baseline.capture.successfulRunOrdinal, 1);
  assert.equal(baseline.browser.version, '151.0.7922.34');
  assert.equal(baseline.hostReceipt.commit, 'e686a7e7963abedd5e5fa14561a2d3c71692c790');
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(baseline.observations));
  assert.throws(() => validateReleasePerformanceBaselineSeed(baseline), /unsupported field|seed/u);
  for (const name of RELEASE_MEASUREMENTS) {
    assert.equal(assertPerformanceObservationWithinBaseline(name, baseline.thresholds[name], baseline), true);
    assert.throws(() => assertPerformanceObservationWithinBaseline(name, baseline.thresholds[name] + 1, baseline), /exceeded/u);
  }
});
