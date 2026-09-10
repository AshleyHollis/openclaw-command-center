import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPerformanceHostIdentity, assertPerformanceBaselineBuildIdentity, assertPerformanceObservationWithinBaseline, captureFirstReleasePerformanceBaseline, deriveReleaseThresholds, RELEASE_PERFORMANCE_BASELINE_VERSION, RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, releasePerformanceIdentity, validateReleasePerformanceBaseline, validateReleasePerformanceBaselineSeed } from '../src/performance-baseline.mjs';

test('performance capture binds the actual packaged descriptor before measuring', () => {
  const { schemaVersion, commit, ...integrity } = releasePerformanceIdentity.hostReceipt;
  assert.deepEqual(assertPerformanceHostIdentity({ schemaVersion, commit, integrity }), releasePerformanceIdentity.hostReceipt);
  for (const key of Object.keys(integrity)) {
    assert.throws(() => assertPerformanceHostIdentity({ schemaVersion, commit, integrity: { ...integrity, [key]: `sha256:${'a'.repeat(64)}` } }), /pinned host/u);
  }
  assert.throws(() => assertPerformanceHostIdentity({ schemaVersion: 1, commit, integrity }), /pinned host/u);
  assert.throws(() => assertPerformanceHostIdentity({ commit, integrity }), /pinned host/u);
  assert.throws(() => assertPerformanceHostIdentity({ schemaVersion, commit: 'a'.repeat(40), integrity }), /pinned host/u);
});

test('first-live performance names retained native actions without claiming deferred work', () => {
  assert.equal(RELEASE_PERFORMANCE_BASELINE_VERSION, 3);
  assert.deepEqual(RELEASE_FIXTURE_COUNTS, { largeNoteBytes: 8388609, conversations: 101, noteFiles: 5000, conversationMessages: 5000 });
  assert.deepEqual(RELEASE_MEASUREMENTS, ['startupReadinessMs', 'topicsLoadMs', 'topicOpenMs', 'chatSendMs', 'conversationCreateMs', 'largeNoteReadMs', 'conversationNextPageMs', 'noteNextPageMs']);
});


function coherentGeneratedBaseline() {
  const seed = {
    schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION,
    hostVersion: releasePerformanceIdentity.hostVersion,
    hostReceipt: releasePerformanceIdentity.hostReceipt,
    pluginBuildDigest: `sha256:${'b'.repeat(64)}`,
    browser: { engine: 'chromium', playwrightVersion: releasePerformanceIdentity.playwrightVersion, version: '151.0.7922.34' },
    viewport: releasePerformanceIdentity.viewport,
    fixtureIdentity: RELEASE_FIXTURE_IDENTITY,
    fixtureCounts: RELEASE_FIXTURE_COUNTS,
    capture: { policy: 'first-successful-pinned-harness-observation', successfulRunOrdinal: null }
  };
  const firstObservations = Object.fromEntries(RELEASE_MEASUREMENTS.map((name, index) => [name, index + 0.25]));
  return { seed, firstObservations, baseline: captureFirstReleasePerformanceBaseline(seed, firstObservations) };
}

test('release performance baseline generates one coherent pending capture', () => {
  assert.equal(releasePerformanceIdentity.hostReceipt.sourceDigest, 'sha256:3f113080845fcf23618f64d0e4c08df6c45bb3b2910d6505c576ddad2c6d9f6c');
  const { seed, firstObservations, baseline } = coherentGeneratedBaseline();
  assert.deepEqual(validateReleasePerformanceBaselineSeed(seed).capture, seed.capture);
  assert.deepEqual(baseline.thresholds, deriveReleaseThresholds(firstObservations));
  assert.equal(baseline.capture.successfulRunOrdinal, 1);
  assert.throws(() => validateReleasePerformanceBaselineSeed({ ...seed, capture: { ...seed.capture, successfulRunOrdinal: 1 } }), /pending/u);
});

test('release performance baseline rejects host version drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostVersion: 'fictional-other-host' }), /pinned/u);
});

test('measured fractional timings retain exact immutable ceiling checks', () => {
  const { baseline } = coherentGeneratedBaseline();
  const name = 'topicsLoadMs';
  assert.equal(assertPerformanceObservationWithinBaseline(name, 0.25, baseline), true);
  assert.equal(assertPerformanceObservationWithinBaseline(name, baseline.thresholds[name], baseline), true);
  assert.throws(() => assertPerformanceObservationWithinBaseline(name, baseline.thresholds[name] + 0.01, baseline), /exceeded/u);
  for (const value of [0, -1, NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.throws(() => assertPerformanceObservationWithinBaseline(name, value, baseline), /positive finite/u);
  }
});

test('release performance baseline rejects host receipt drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, hostReceipt: { ...baseline.hostReceipt, contractDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }), /pinned host identity/u);
});

test('release performance baseline rejects incomplete browser identity', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, browser: { ...baseline.browser, version: '' } }), /browser identity/u);
});

test('release performance baseline rejects final build identity drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => assertPerformanceBaselineBuildIdentity(baseline, `sha256:${'c'.repeat(64)}`), /final build/u);
});

for (const name of RELEASE_MEASUREMENTS) test(`release performance baseline rejects a widened ${name} ceiling`, () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, thresholds: { ...baseline.thresholds, [name]: baseline.thresholds[name] + 1 } }), /first observation/);
});

test('release performance baseline rejects conversation corpus drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, conversations: 100 } }), /conversations must be 101/);
});

test('release performance baseline rejects Note corpus drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureCounts: { ...baseline.fixtureCounts, noteFiles: 4999 } }), /noteFiles must be 5000/);
});

test('release performance baseline rejects a zero observation', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, largeNoteReadMs: 0 } }), /first positive/);
});

test('release performance baseline rejects a missing observation', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, observations: { ...baseline.observations, largeNoteReadMs: undefined } }), /first positive/);
});

test('release performance baseline rejects a later capture ordinal', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, successfulRunOrdinal: 2 } }), /first successful/u);
});

test('release performance baseline rejects an observation digest mismatch', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, observationsDigest: 'sha256:' + 'a'.repeat(64) } }), /capture evidence/u);
});

test('release performance baseline rejects an identity digest mismatch', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, capture: { ...baseline.capture, identityDigest: 'sha256:' + 'a'.repeat(64) } }), /capture evidence/u);
});

test('release performance baseline rejects fixture identity drift', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, fixtureIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /release fixture/);
});

test('release performance baseline rejects unsupported top-level fields', () => {
  const { baseline } = coherentGeneratedBaseline();
  assert.throws(() => validateReleasePerformanceBaseline({ ...baseline, generatedAt: '2026-08-30T00:00:00.000Z' }), /unsupported field/);
});

test('release fixture includes one exact eight-MiB Note plus trailing newline', () => {
  const largeNote = `${'x'.repeat(8_388_608)}\n`;
  const bytes = Buffer.from(largeNote, 'utf8');
  assert.equal(bytes.length, RELEASE_FIXTURE_COUNTS.largeNoteBytes);
  assert.equal(bytes.subarray(0, 8_388_608).every((value) => value === 0x78), true);
  assert.equal(bytes.at(-1), 0x0a);
});
