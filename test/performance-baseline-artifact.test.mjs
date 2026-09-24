import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, releasePerformanceIdentity, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';

test('historical performance capture cannot qualify the upgraded host', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v3.json', import.meta.url), 'utf8'));
  assert.throws(() => validateReleasePerformanceBaseline(baseline), /pinned/u);
});

test('the upgraded release retains its first exact native-workspace capture', async () => {
  const baseline = validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.native-workspace.v3.json', import.meta.url), 'utf8')));
  assert.equal(baseline.hostVersion, '2026.9.5');
  assert.equal(releasePerformanceIdentity.hostVersion, '2026.9.6');
  assert.notDeepEqual(baseline.hostReceipt, releasePerformanceIdentity.hostReceipt);
  assert.equal(baseline.capture.successfulRunOrdinal, 1);
  assert.equal(baseline.fixtureIdentity, RELEASE_FIXTURE_IDENTITY);
  assert.deepEqual(Object.keys(baseline.observations), RELEASE_MEASUREMENTS);
  assert.deepEqual(RELEASE_FIXTURE_IDENTITY.length, 71);
  assert.deepEqual(RELEASE_MEASUREMENTS, ['startupReadinessMs', 'topicsLoadMs', 'topicOpenMs', 'chatSendMs', 'conversationCreateMs', 'largeNoteReadMs', 'conversationNextPageMs', 'noteNextPageMs']);
});
