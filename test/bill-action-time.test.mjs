import assert from 'node:assert/strict';
import test from 'node:test';
import {
  billActionTimePresets, createBillActionTimeIntent, formatBillActionTime,
  isBillActionReviewEligible, resolveBillActionLocalTime,
} from '../src/native-ui/bill-action-time.mjs';

const brisbane = { localDateTime: '2026-10-06T09:00', timeZone: 'Australia/Brisbane' };
const now = '2026-10-05T20:00:00Z';
const code = (expected) => (error) => error instanceof RangeError && error.code === expected;

test('explicit Brisbane local time freezes its UTC instant, zone, offset and confirmation', () => {
  const intent = createBillActionTimeIntent({ ...brisbane, serverTime: now });
  assert.equal(intent.reviewAt, '2026-10-05T23:00:00Z');
  assert.equal(intent.offset, '+10:00');
  assert.equal(intent.display, '6 October 2026, 09:00 Australia/Brisbane (UTC+10:00)');
  assert.equal(intent.confirmation, `Eligible when you next open or refresh Attention after ${intent.display}.`);
  assert.ok(Object.isFrozen(intent));
  assert.throws(() => { intent.reviewAt = now; }, TypeError);
});

test('eligibility uses supplied server time and includes exact equality across UTC midnight', () => {
  const reviewAt = '2026-10-05T23:00:00Z';
  assert.equal(isBillActionReviewEligible(reviewAt, '2026-10-05T22:59:59Z'), false);
  assert.equal(isBillActionReviewEligible(reviewAt, reviewAt), true);
  assert.equal(isBillActionReviewEligible(reviewAt, '2026-10-06T00:00:00Z'), true);
  assert.throws(() => createBillActionTimeIntent({ ...brisbane, serverTime: reviewAt }), code('not_future'));
});

test('New York gap returns no candidate and cannot be normalized into another time', () => {
  const local = { localDateTime: '2026-03-08T02:30', timeZone: 'America/New_York' };
  assert.deepEqual(resolveBillActionLocalTime(local), []);
  assert.throws(() => createBillActionTimeIntent({ ...local, serverTime: '2026-03-01T00:00:00Z' }), code('nonexistent_local_time'));
});

test('New York fold discloses both occurrences and requires explicit offset selection', () => {
  const local = { localDateTime: '2026-11-01T01:30', timeZone: 'America/New_York' };
  const candidates = resolveBillActionLocalTime(local);
  assert.deepEqual(candidates.map(({ reviewAt, offset, occurrence }) => ({ reviewAt, offset, occurrence })), [
    { reviewAt: '2026-11-01T05:30:00Z', offset: '-04:00', occurrence: 1 },
    { reviewAt: '2026-11-01T06:30:00Z', offset: '-05:00', occurrence: 2 },
  ]);
  assert.ok(Object.isFrozen(candidates));
  assert.ok(candidates.every(Object.isFrozen));
  assert.throws(() => createBillActionTimeIntent({ ...local, serverTime: now }), code('ambiguous_local_time'));
  for (const candidate of candidates) {
    const intent = createBillActionTimeIntent({ ...local, offset: candidate.offset, serverTime: now });
    assert.equal(intent.reviewAt, candidate.reviewAt);
    assert.match(intent.confirmation, new RegExp(candidate.offset.replace('+', '\\+')));
  }
  assert.throws(() => createBillActionTimeIntent({ ...local, offset: '+10:00', serverTime: now }), code('invalid_offset'));
});

test('invalid calendar, time, zone, server clock and past time fail closed', () => {
  for (const localDateTime of ['2026-02-30T09:00', '2026-10-06T24:00', '2026-10-06T09:60', '2026-10-06', '2026-10-06T09:00Z']) {
    assert.throws(() => resolveBillActionLocalTime({ ...brisbane, localDateTime }), code('invalid_local_time'));
  }
  for (const timeZone of [undefined, '']) {
    assert.throws(() => resolveBillActionLocalTime({ ...brisbane, timeZone }), code('zone_required'));
  }
  for (const timeZone of ['browser', 'Mars/Olympus', '+10:00']) {
    assert.throws(() => resolveBillActionLocalTime({ ...brisbane, timeZone }), code('invalid_zone'));
  }
  for (const serverTime of [undefined, '2026-10-05T20:00', '2026-02-30T20:00:00Z', '2026-10-05T20:00:00+24:00', 'garbage']) {
    assert.throws(() => createBillActionTimeIntent({ ...brisbane, serverTime }), code('invalid_server_time'));
  }
  assert.throws(() => createBillActionTimeIntent({ ...brisbane, serverTime: '2026-10-06T00:00:00Z' }), code('not_future'));
});

test('later today stays on the local date; tomorrow morning is explicitly 09:00', () => {
  const presets = billActionTimePresets({ serverTime: '2026-10-05T01:00:00Z', timeZone: brisbane.timeZone });
  assert.equal(presets.laterToday.localDateTime, '2026-10-05T14:00:00');
  assert.equal(presets.laterToday.reviewAt, '2026-10-05T04:00:00Z');
  assert.equal(presets.tomorrowMorning.localDateTime, '2026-10-06T09:00:00');
  assert.equal(presets.tomorrowMorning.reviewAt, '2026-10-05T23:00:00Z');
  const nearMidnight = billActionTimePresets({ serverTime: '2026-10-05T13:59:59Z', timeZone: brisbane.timeZone });
  assert.equal(nearMidnight.laterToday, null);
  assert.equal(nearMidnight.tomorrowMorning.reviewAt, '2026-10-05T23:00:00Z');
  assert.ok(Object.isFrozen(presets));
});

test('tomorrow local date accounts for year rollover and daylight-saving offset', () => {
  const presets = billActionTimePresets({ serverTime: '2026-12-31T23:00:00Z', timeZone: 'UTC' });
  assert.equal(presets.laterToday, null);
  assert.equal(presets.tomorrowMorning.reviewAt, '2027-01-01T09:00:00Z');
  const dst = billActionTimePresets({ serverTime: '2026-03-07T22:00:00Z', timeZone: 'America/New_York' });
  assert.equal(dst.tomorrowMorning.reviewAt, '2026-03-08T13:00:00Z');
  assert.equal(dst.tomorrowMorning.offset, '-04:00');
});

test('zone edits change unsent preview; retries preserve the frozen submitted intent', () => {
  const submitted = createBillActionTimeIntent({ ...brisbane, serverTime: now });
  const original = JSON.stringify(submitted);
  const edited = createBillActionTimeIntent({ ...brisbane, timeZone: 'America/New_York', serverTime: now });
  assert.notEqual(edited.reviewAt, submitted.reviewAt);
  assert.equal(formatBillActionTime(submitted), submitted.display);
  // Retry forwards this object, with no call to the preset resolver or current clock.
  const retry = submitted;
  assert.equal(JSON.stringify(retry), original);
  assert.equal(retry.reviewAt, '2026-10-05T23:00:00Z');
  assert.equal(isBillActionReviewEligible(retry.reviewAt, '2026-10-06T01:00:00Z'), true);
});

test('half-hour daylight-saving transitions and quarter-hour zones resolve exactly', () => {
  assert.deepEqual(resolveBillActionLocalTime({ localDateTime: '2026-10-04T02:15', timeZone: 'Australia/Lord_Howe' }), []);
  assert.equal(resolveBillActionLocalTime({ localDateTime: '2026-10-06T09:00', timeZone: 'Asia/Kathmandu' })[0].reviewAt, '2026-10-06T03:15:00Z');
});

test('preset retains authoritative fractional seconds for an exact three-hour intent', () => {
  const presets = billActionTimePresets({ serverTime: '2026-10-05T01:00:00.125Z', timeZone: brisbane.timeZone });
  assert.equal(presets.laterToday.reviewAt, '2026-10-05T04:00:00.125Z');
  assert.equal(presets.laterToday.localDateTime, '2026-10-05T14:00:00.125');
  assert.match(presets.laterToday.display, /14:00:00\.125/);
});

test('saved eligibility display uses the retained instant, explicit zone and disclosed offset', () => {
  assert.equal(formatBillActionTime({ reviewAt: '2026-10-05T23:00:00Z', timeZone: 'Australia/Brisbane', offsetMinutes: 600 }),
    '6 October 2026, 09:00 Australia/Brisbane (UTC+10:00)');
  assert.equal(formatBillActionTime({ reviewAt: '2026-11-01T06:30:00Z', timeZone: 'America/New_York', offsetMinutes: -300 }),
    '1 November 2026, 01:30 America/New_York (UTC-05:00)');
  assert.throws(() => formatBillActionTime({ reviewAt: now, timeZone: 'UTC' }), code('invalid_offset'));
});
