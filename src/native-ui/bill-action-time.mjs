// Notification eligibility only. These helpers never schedule delivery or read a clock.
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(code, message) {
  const error = new RangeError(message);
  error.code = code;
  throw error;
}

function localParts(value) {
  const match = typeof value === 'string' && LOCAL.exec(value);
  if (!match) fail('invalid_local_time', 'Enter a valid local date and time.');
  const [, year, month, day, hour, minute, second = '00', fraction = ''] = match;
  const millisecond = Number(fraction.padEnd(3, '0'));
  const parts = [year, month, day, hour, minute, second].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], millisecond);
  if (parts[0] < 1 || date.getUTCFullYear() !== parts[0]
    || date.getUTCMonth() + 1 !== parts[1] || date.getUTCDate() !== parts[2]
    || date.getUTCHours() !== parts[3] || date.getUTCMinutes() !== parts[4]
    || date.getUTCSeconds() !== parts[5]) {
    fail('invalid_local_time', 'Enter a valid local date and time.');
  }
  return { epoch: date.getTime(), text: `${year}-${month}-${day}T${hour}:${minute}:${second}${millisecond ? `.${String(millisecond).padStart(3, '0')}` : ''}` };
}

function instant(value, code = 'invalid_server_time') {
  if (typeof value !== 'string' || !INSTANT.test(value)) {
    fail(code, 'An authoritative RFC 3339 time is required. Refresh and try again.');
  }
  // Date.parse normalizes impossible dates; reject them before parsing the offset.
  try { localParts(value.slice(0, 19)); } catch { fail(code, 'Enter a valid RFC 3339 time.'); }
  const suffix = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (suffix && (Number(suffix[2]) > 23 || Number(suffix[3]) > 59)) {
    fail(code, 'Enter a valid RFC 3339 time.');
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) fail(code, 'Enter a valid RFC 3339 time.');
  return epoch;
}

function zoneFormatter(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    fail('zone_required', 'Choose your timezone before selecting a review time.');
  }
  // Reject offset-only zones and implicit browser defaults. UTC is an explicit choice.
  if (timeZone !== 'UTC' && !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timeZone)) {
    fail('invalid_zone', 'Choose a valid IANA timezone.');
  }
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    fail('invalid_zone', 'Choose a valid IANA timezone.');
  }
}

function localAt(epoch, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(epoch)
    .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  const millisecond = new Date(epoch).getUTCMilliseconds();
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${millisecond ? `.${String(millisecond).padStart(3, '0')}` : ''}`;
}

function canonical(epoch) {
  return new Date(epoch).toISOString().replace('.000Z', 'Z');
}

function offsetText(seconds) {
  const absolute = Math.abs(seconds);
  const hours = String(Math.floor(absolute / 3600)).padStart(2, '0');
  const minutes = String(Math.floor(absolute / 60) % 60).padStart(2, '0');
  const remainder = absolute % 60;
  return `${seconds < 0 ? '-' : '+'}${hours}:${minutes}${remainder ? `:${String(remainder).padStart(2, '0')}` : ''}`;
}

export function formatBillActionTime({ localDateTime, timeZone, offset, reviewAt, offsetMinutes }) {
  // A saved eligibility row retains its disclosed offset. Do not reinterpret it
  // using the browser zone or today's timezone rules and thereby rewrite intent.
  if (localDateTime === undefined) {
    if (!Number.isFinite(offsetMinutes) || Math.abs(offsetMinutes) >= 24 * 60
      || !Number.isInteger(offsetMinutes * 60)) {
      fail('invalid_offset', 'The saved review time requires its disclosed UTC offset.');
    }
    localDateTime = canonical(instant(reviewAt, 'invalid_review_time') + offsetMinutes * 60 * SECOND).replace(/Z$/, '');
    offset = offsetText(offsetMinutes * 60);
  }
  const local = localParts(localDateTime).text;
  zoneFormatter(timeZone);
  if (typeof offset !== 'string' || !/^[+-]\d{2}:\d{2}(?::\d{2})?$/.test(offset)) {
    fail('invalid_offset', 'Choose a displayed UTC offset.');
  }
  const date = new Date(`${local}Z`);
  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', calendar: 'gregory', day: 'numeric', month: 'long', year: 'numeric',
  }).format(date);
  const clock = local.slice(11, 16) + (local.endsWith(':00') ? '' : local.slice(16));
  return `${dateLabel}, ${clock} ${timeZone} (UTC${offset})`;
}

export function resolveBillActionLocalTime({ localDateTime, timeZone }) {
  const local = localParts(localDateTime);
  const formatter = zoneFormatter(timeZone);
  const offsets = new Set();
  // Observe offsets on both sides of a transition; then round-trip every candidate.
  // The window includes date-line changes as well as ordinary daylight-saving folds.
  for (let delta = -48; delta <= 48; delta += 6) {
    const sample = local.epoch + delta * HOUR;
    offsets.add((localParts(localAt(sample, formatter)).epoch - sample) / SECOND);
  }
  const candidates = [...offsets].map((offsetSeconds) => ({
    epoch: local.epoch - offsetSeconds * SECOND, offsetSeconds,
  })).filter(({ epoch }) => localAt(epoch, formatter) === local.text)
    .sort((a, b) => a.epoch - b.epoch);
  return Object.freeze(candidates.map(({ epoch, offsetSeconds }, index) => {
    const result = {
      reviewAt: canonical(epoch), localDateTime: local.text, timeZone,
      offset: offsetText(offsetSeconds), offsetMinutes: offsetSeconds / 60, occurrence: index + 1,
    };
    result.display = formatBillActionTime(result);
    return Object.freeze(result);
  }));
}

export function createBillActionTimeIntent({ localDateTime, timeZone, offset, serverTime }) {
  const now = instant(serverTime);
  const candidates = resolveBillActionLocalTime({ localDateTime, timeZone });
  if (!candidates.length) fail('nonexistent_local_time', 'This local time does not exist. Choose another time.');
  if (candidates.length > 1 && !offset) {
    fail('ambiguous_local_time', 'This local time occurs twice. Choose a displayed UTC offset.');
  }
  const chosen = offset ? candidates.find((candidate) => candidate.offset === offset) : candidates[0];
  if (!chosen) fail('invalid_offset', 'Choose one of the displayed UTC offsets for this local time.');
  if (instant(chosen.reviewAt) <= now) fail('not_future', 'Choose a review time after the authoritative current time.');
  return Object.freeze({
    ...chosen,
    confirmation: `Eligible when you next open or refresh Attention after ${chosen.display}.`,
  });
}

export function billActionTimePresets({ serverTime, timeZone }) {
  const now = instant(serverTime);
  const formatter = zoneFormatter(timeZone);
  const currentLocal = localAt(now, formatter);
  const laterLocal = localAt(now + 3 * HOUR, formatter);
  let laterToday = null;
  if (currentLocal.slice(0, 10) === laterLocal.slice(0, 10)) {
    const candidates = resolveBillActionLocalTime({ localDateTime: laterLocal, timeZone });
    // The preset supplies an exact +3h instant, disclosing its offset even during a fold.
    const chosen = candidates.find(({ reviewAt }) => instant(reviewAt) === now + 3 * HOUR);
    if (chosen) laterToday = createBillActionTimeIntent({ ...chosen, serverTime });
  }
  const nextDate = new Date(localParts(`${currentLocal.slice(0, 10)}T00:00:00`).epoch);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const tomorrowLocal = `${nextDate.toISOString().slice(0, 10)}T09:00:00`;
  const tomorrowCandidates = resolveBillActionLocalTime({ localDateTime: tomorrowLocal, timeZone });
  // No automatic gap normalization or silent fold choice for tomorrow's clock time.
  const tomorrowMorning = tomorrowCandidates.length === 1
    ? createBillActionTimeIntent({ ...tomorrowCandidates[0], serverTime }) : null;
  return Object.freeze({ laterToday, tomorrowMorning });
}

export function isBillActionReviewEligible(reviewAt, serverTime) {
  return instant(reviewAt, 'invalid_review_time') <= instant(serverTime);
}
