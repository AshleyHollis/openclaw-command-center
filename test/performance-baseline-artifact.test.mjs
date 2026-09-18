import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';

test('historical performance capture cannot qualify the upgraded host', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v3.json', import.meta.url), 'utf8'));
  assert.throws(() => validateReleasePerformanceBaseline(baseline), /pinned/u);
});

test('the upgraded release reserves a new baseline for its first exact capture', async () => {
  await assert.rejects(readFile(new URL('./fixtures/release-performance-baseline.native-workspace.v3.json', import.meta.url), 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(RELEASE_FIXTURE_IDENTITY.length, 71);
  assert.deepEqual(RELEASE_MEASUREMENTS, ['startupReadinessMs', 'topicsLoadMs', 'topicOpenMs', 'chatSendMs', 'conversationCreateMs', 'largeNoteReadMs', 'conversationNextPageMs', 'noteNextPageMs']);
});
