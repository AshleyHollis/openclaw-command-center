import { sourceError } from '../sources/errors.mjs';

export const NOTIFICATION_SETTINGS_ID = 'global';
export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  settingsId: NOTIFICATION_SETTINGS_ID,
  dueReminders: true,
  importantItems: true,
  criticalRealerts: true,
  quietHoursEnabled: true,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  timeZone: 'UTC',
  genericPreview: false,
  revision: 1
});

const settingKeys = Object.freeze([
  'dueReminders', 'importantItems', 'criticalRealerts', 'quietHoursEnabled',
  'quietHoursStart', 'quietHoursEnd', 'timeZone', 'genericPreview'
]);
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/u;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('invalid-request', `${label} must be an object.`);
  return value;
}

function assertTime(value, field) {
  if (typeof value !== 'string' || !timePattern.test(value)) throw sourceError('invalid-request', `${field} must be a valid local HH:MM time.`);
  return value;
}

function assertTimeZone(value) {
  if (typeof value !== 'string' || value.trim() === '') throw sourceError('invalid-request', 'timeZone must be a valid IANA timezone.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); }
  catch { throw sourceError('invalid-request', 'timeZone must be a valid IANA timezone.'); }
  return value;
}

export function normalizeNotificationSettings(input = {}, { defaults = DEFAULT_NOTIFICATION_SETTINGS } = {}) {
  const value = object(input, 'notification settings');
  for (const field of Object.keys(value)) if (!['settingsId', ...settingKeys, 'revision', 'updatedAt'].includes(field)) throw sourceError('invalid-request', `notification settings contains unsupported field ${field}.`);
  const base = { ...DEFAULT_NOTIFICATION_SETTINGS, ...defaults };
  const result = { settingsId: NOTIFICATION_SETTINGS_ID };
  for (const field of settingKeys) {
    const candidate = value[field] === undefined ? base[field] : value[field];
    if (['dueReminders', 'importantItems', 'criticalRealerts', 'quietHoursEnabled', 'genericPreview'].includes(field)) {
      if (typeof candidate !== 'boolean') throw sourceError('invalid-request', `${field} must be a boolean.`);
    } else if (field === 'timeZone') assertTimeZone(candidate);
    else assertTime(candidate, field);
    result[field] = candidate;
  }
  if (result.quietHoursEnabled && result.quietHoursStart === result.quietHoursEnd) throw sourceError('invalid-request', 'quiet-hours start and end must differ.');
  if (value.revision !== undefined && (!Number.isInteger(value.revision) || value.revision < 1)) throw sourceError('invalid-request', 'revision must be a positive integer.');
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)))) throw sourceError('invalid-request', 'updatedAt must be an RFC 3339 instant.');
  return Object.freeze({ ...result, revision: value.revision ?? base.revision ?? 1, ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }) });
}

export function validateNotificationSettings(input, options) {
  try { normalizeNotificationSettings(input, options); return true; }
  catch { return false; }
}

export function settingsPatch(input = {}) {
  const value = object(input, 'notification settings patch');
  for (const field of Object.keys(value)) if (!settingKeys.includes(field)) throw sourceError('invalid-request', `notification settings patch contains unsupported field ${field}.`);
  return normalizeNotificationSettings(value);
}

export { settingKeys, timePattern };
