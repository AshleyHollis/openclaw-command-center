import assert from 'node:assert/strict';
import test from 'node:test';
import { CRITICAL_REPEAT_OFFSETS_MS, HIGH_REPEAT_OFFSET_MS, isQuietHours, policySlots, quietHoursEnd } from '../src/notifications/policy.mjs';

test('notification policy fixes repeat slots and quiet-hour boundaries', () => {
  const settings = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00', timeZone: 'UTC', dueReminders: true, importantItems: true, criticalRealerts: true, genericPreview: false };
  const start = Date.parse('2026-08-27T12:00:00.000Z');
  assert.deepEqual(policySlots({ severity: 'High', activationAtMs: start, settings }), [
    { slotKind: 'high-activation', dueAtMs: start, bypassQuietHours: false },
    { slotKind: 'high-repeat', dueAtMs: start + HIGH_REPEAT_OFFSET_MS, bypassQuietHours: false }
  ]);
  assert.deepEqual(policySlots({ severity: 'Critical', activationAtMs: start, settings }).map((slot) => slot.dueAtMs), CRITICAL_REPEAT_OFFSETS_MS.map((offset) => start + offset));
  assert.equal(isQuietHours(Date.parse('2026-08-27T22:00:00.000Z'), settings), true);
  assert.equal(isQuietHours(Date.parse('2026-08-28T06:59:00.000Z'), settings), true);
  assert.equal(isQuietHours(Date.parse('2026-08-28T07:00:00.000Z'), settings), false);
  assert.equal(quietHoursEnd(Date.parse('2026-08-27T23:00:00.000Z'), settings), Date.parse('2026-08-28T07:00:00.000Z'));
  assert.equal(policySlots({ severity: 'High', activationAtMs: start, settings: { ...settings, importantItems: false } }).length, 0);
  assert.equal(policySlots({ severity: 'Reminder', activationAtMs: start, kind: 'reminder', explicitTimed: true, settings }).at(0).bypassQuietHours, true);
});
