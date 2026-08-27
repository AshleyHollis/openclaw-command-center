import assert from 'node:assert/strict';
import assertModule from 'node:assert/strict';
import test from 'node:test';
import { createNotificationCandidate, validateNotificationCandidate } from '../src/notifications/candidate.mjs';
import { notificationPreview } from '../src/notifications/preview.mjs';

test('notification candidates are bounded, opaque, fixed-vocabulary, and replay-stable', () => {
  const nowMs = Date.parse('2026-08-27T12:00:00.000Z');
  const candidate = createNotificationCandidate({ episodeId: 'fictional-private-episode', epochId: 'fictional-epoch', severity: 'High', nowMs });
  assert.equal(validateNotificationCandidate(candidate, { nowMs }), true);
  assert.equal(candidate.expiresAtMs, nowMs + 86_400_000);
  assert.match(candidate.deepLink.kind, /^plugin-detail$/u);
  assert.doesNotMatch(JSON.stringify(candidate), /fictional-private-episode|fictional-epoch|\/|token|secret|session/iu);
  assert.deepEqual(candidate, createNotificationCandidate({ episodeId: 'fictional-private-episode', epochId: 'fictional-epoch', severity: 'High', nowMs }));
  assert.equal(validateNotificationCandidate({ ...candidate, extra: true }, { nowMs }), false);
  assert.equal(notificationPreview({ severity: 'Critical', genericPreview: true }).body, 'Open Command Center to review an item.');
  assert.equal(validateNotificationCandidate({ ...candidate, expiresAtMs: nowMs + 86_400_001 }, { nowMs }), false);
  assertModule.equal(Buffer.byteLength(JSON.stringify(candidate)) < 2048, true);
});
