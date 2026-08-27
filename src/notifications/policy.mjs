import { sourceError } from '../sources/errors.mjs';
import { DEFAULT_NOTIFICATION_SETTINGS, normalizeNotificationSettings } from './settings.mjs';

export const ACTIVE_HOUR_MS = 60 * 60 * 1000;
export const CRITICAL_REPEAT_OFFSETS_MS = Object.freeze([0, 15 * 60 * 1000, 2 * 60 * 60 * 1000 + 15 * 60 * 1000, 4 * 60 * 60 * 1000 + 15 * 60 * 1000]);
export const HIGH_REPEAT_OFFSET_MS = 4 * ACTIVE_HOUR_MS;

function partsAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US-u-hc-h23', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

export function isQuietHours(nowMs, settings = DEFAULT_NOTIFICATION_SETTINGS) {
  const value = normalizeNotificationSettings(settings);
  if (!value.quietHoursEnabled) return false;
  const { hour, minute } = partsAt(nowMs, value.timeZone);
  const current = hour * 60 + minute;
  const start = Number(value.quietHoursStart.slice(0, 2)) * 60 + Number(value.quietHoursStart.slice(3));
  const end = Number(value.quietHoursEnd.slice(0, 2)) * 60 + Number(value.quietHoursEnd.slice(3));
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function quietHoursEnd(nowMs, settings = DEFAULT_NOTIFICATION_SETTINGS) {
  const value = normalizeNotificationSettings(settings);
  if (!value.quietHoursEnabled || !isQuietHours(nowMs, value)) return nowMs;
  const current = new Date(nowMs);
  for (let minute = 1; minute <= 36 * 60; minute += 1) if (!isQuietHours(nowMs + minute * 60_000, value)) return nowMs + minute * 60_000;
  throw sourceError('invalid-request', 'quiet-hours end could not be resolved.');
}

export function policySlots({ severity, activationAtMs, explicitTimed = false, kind = 'attention', settings = DEFAULT_NOTIFICATION_SETTINGS } = {}) {
  const value = normalizeNotificationSettings(settings);
  if (!Number.isSafeInteger(activationAtMs)) throw new TypeError('activationAtMs must be a safe integer');
  if (!['Reminder', 'High', 'Critical'].includes(severity)) return [];
  if (kind === 'reminder' && !value.dueReminders) return [];
  if (kind !== 'reminder' && !value.importantItems) return [];
  if (kind === 'reminder' || severity === 'Reminder') return [{ slotKind: explicitTimed ? 'reminder-explicit' : 'reminder-due', dueAtMs: activationAtMs, bypassQuietHours: explicitTimed }];
  if (severity === 'Critical') return CRITICAL_REPEAT_OFFSETS_MS.map((offset, index) => ({ slotKind: index === 0 ? 'critical-immediate' : `critical-repeat-${index}`, dueAtMs: activationAtMs + offset, bypassQuietHours: true })).filter((slot) => slot.slotKind === 'critical-immediate' || value.criticalRealerts);
  return [{ slotKind: 'high-activation', dueAtMs: activationAtMs, bypassQuietHours: false }, { slotKind: 'high-repeat', dueAtMs: activationAtMs + HIGH_REPEAT_OFFSET_MS, bypassQuietHours: false }];
}

export function slotEligible({ slot, nowMs, settings = DEFAULT_NOTIFICATION_SETTINGS, severity, state = 'Active', explicitTimed = false, queued = false } = {}) {
  if (!slot || !Number.isSafeInteger(nowMs) || slot.dueAtMs > nowMs || ['Resolved', 'Withdrawn', 'Snoozed', 'Action running'].includes(state)) return false;
  const value = normalizeNotificationSettings(settings);
  if (severity === 'Critical' && (slot.slotKind === 'critical-immediate' ? !value.importantItems : !value.criticalRealerts)) return false;
  if (severity !== 'Critical' && severity !== 'Reminder' && !value.importantItems) return false;
  if (severity === 'Reminder' && !value.dueReminders) return false;
  return slot.bypassQuietHours || explicitTimed || !isQuietHours(nowMs, value) || queued;
}

export function activeHoursElapsed({ fromMs, toMs, pausedIntervals = [] } = {}) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return 0;
  const paused = pausedIntervals.reduce((total, interval) => total + Math.max(0, Math.min(toMs, interval.endMs ?? toMs) - Math.max(fromMs, interval.startMs)), 0);
  return Math.max(0, toMs - fromMs - paused);
}
