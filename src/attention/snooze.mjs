const presetDurations = Object.freeze({ PT72H: 72 * 60 * 60 * 1000, PT168H: 168 * 60 * 60 * 1000 });

export const SNOOZE_PRESETS = Object.freeze(['NEXT_0700', 'PT72H', 'PT168H']);

function zonedParts(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US-u-hc-h23', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  return Object.fromEntries(formatter.formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function nextLocalSeven(now, timeZone) {
  let local;
  try { local = zonedParts(new Date(now), timeZone); } catch { throw new TypeError('snooze timezone must be a valid IANA timezone'); }
  // "Tomorrow morning" is always the next local calendar day. It is not the
  // next occurrence of 07:00, which would incorrectly select today before 07:00.
  const calendar = new Date(Date.UTC(local.year, local.month - 1, local.day + 1, 7));
  const desired = { year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(), hour: 7 };
  const desiredUtcShape = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour);
  let candidate = desiredUtcShape;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const observed = zonedParts(new Date(candidate), timeZone);
    const observedUtcShape = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const correction = desiredUtcShape - observedUtcShape;
    if (correction === 0) return new Date(candidate).toISOString();
    candidate += correction;
  }
  throw new TypeError('next 07:00 snooze could not be resolved in the configured timezone');
}

export function eligibleSnoozeChoices(episode) {
  if (!episode || episode.state !== 'Active' || episode.severity === 'Critical' || episode.monitoring !== true) return [];
  return [...SNOOZE_PRESETS, 'custom'];
}

export function resolveSnoozeUntil(input, now, timeZone = 'UTC') {
  const clock = Date.parse(now);
  if (!Number.isFinite(clock)) throw new TypeError('server clock must be an RFC 3339 instant');
  if (input === 'NEXT_0700') return nextLocalSeven(now, timeZone);
  if (Object.hasOwn(presetDurations, input)) return new Date(clock + presetDurations[input]).toISOString();
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'until') || typeof input.until !== 'string') throw new TypeError('custom snooze requires only a future RFC 3339 until instant');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(input.until)) throw new TypeError('custom snooze requires an RFC 3339 instant');
  const until = Date.parse(input.until);
  if (!Number.isFinite(until) || until <= clock) throw new TypeError('custom snooze must be strictly after the server clock');
  return new Date(until).toISOString();
}

export function snoozeExpired(episode, now) {
  return episode.state === 'Snoozed' && typeof episode.snoozedUntil === 'string' && Date.parse(episode.snoozedUntil) <= Date.parse(now);
}
