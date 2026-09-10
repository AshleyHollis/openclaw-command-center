import { createHash } from 'node:crypto';

// ADR 0004 changes measured actions, not just their labels. Historical mixed
// write/Search/Review observations cannot qualify these native read journeys.
export const RELEASE_PERFORMANCE_BASELINE_VERSION = 3;

export const RELEASE_FIXTURE_COUNTS = Object.freeze({
  largeNoteBytes: 8_388_609,
  conversations: 101,
  noteFiles: 5_000,
  conversationMessages: 5_000
});

export const RELEASE_PERFORMANCE_VIEWPORT = Object.freeze({ width: 1_440, height: 900 });

export const RELEASE_MEASUREMENTS = Object.freeze([
  'startupReadinessMs',
  'topicsLoadMs',
  'topicOpenMs',
  'chatSendMs',
  'conversationCreateMs',
  'largeNoteReadMs',
  'conversationNextPageMs',
  'noteNextPageMs'
]);

const REQUIRED_HOST_RECEIPT_FIELDS = Object.freeze(['schemaVersion', 'sourceDigest', 'commit', 'executableDigest', 'contractDigest', 'packageDigest', 'runtimeDigest']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HOST_COMMIT = '3040eff630e5a6d9a9f9f5ce52af3c0971776f15';
const HOST_VERSION = '2026.9.2';
const PLAYWRIGHT_VERSION = '1.62.1';
export const RELEASE_FIXTURE_IDENTITY = canonicalDigest({
  schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION,
  viewport: RELEASE_PERFORMANCE_VIEWPORT,
  fixtureCounts: RELEASE_FIXTURE_COUNTS
});
const HOST_RECEIPT = Object.freeze({
  schemaVersion: 2,
  sourceDigest: 'sha256:1222f1e0f26bd72ac1a52981c184d8f7c85cf7aef3cb04a3e0c3cbdc20ec4b91',
  commit: HOST_COMMIT,
  executableDigest: 'sha256:4f4d29770da4f86dbd0e07cbd4d46deab785905dd89ac719033fcfd866fb5d17',
  contractDigest: 'sha256:ec170da6eb2bb116bcf6b60cfea795af5dfa41ed83762194526eff977fc52fb6',
  packageDigest: 'sha256:6b4c749f4635b9519bf3c88f75adb2bccbf28db8d80c7f1d236b9c4cf9aea177',
  runtimeDigest: 'sha256:5cdf869dc8d1dc27f5147769ad214c9d54e14bd93db1378975b132196b50be8b'
});

function invalid(message) {
  throw new TypeError(`Release performance baseline: ${message}`);
}

function closed(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${label} contains unsupported field ${key}`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive integer`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) invalid(`${label} must be a sha256 digest`);
  return value;
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeIdentity(value, { allowPendingCapture = false } = {}) {
  const keys = ['schemaVersion', 'hostVersion', 'hostReceipt', 'pluginBuildDigest', 'browser', 'viewport', 'fixtureIdentity', 'fixtureCounts', ...(allowPendingCapture ? ['capture'] : [])];
  closed(value, keys, allowPendingCapture ? 'baseline seed' : 'baseline identity');
  if (value.schemaVersion !== RELEASE_PERFORMANCE_BASELINE_VERSION || value.hostVersion !== HOST_VERSION) invalid('version or host identity is not pinned');
  const hostReceipt = assertHostReceipt(value.hostReceipt);
  digest(value.pluginBuildDigest, 'pluginBuildDigest');
  const browser = assertBrowser(value.browser);
  const viewport = assertViewport(value.viewport);
  const fixtureIdentity = digest(value.fixtureIdentity, 'fixtureIdentity');
  if (fixtureIdentity !== RELEASE_FIXTURE_IDENTITY) invalid('fixtureIdentity is not the measured release fixture');
  const fixtureCounts = assertFixtureCounts(value.fixtureCounts);
  return { schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION, hostVersion: HOST_VERSION, hostReceipt, pluginBuildDigest: value.pluginBuildDigest, browser, viewport, fixtureIdentity, fixtureCounts };
}

function assertFixtureCounts(value) {
  closed(value, Object.keys(RELEASE_FIXTURE_COUNTS), 'fixtureCounts');
  for (const [key, expected] of Object.entries(RELEASE_FIXTURE_COUNTS)) {
    if (value[key] !== expected) invalid(`fixtureCounts.${key} must be ${expected}`);
  }
  return Object.freeze({ ...value });
}

function assertHostReceipt(value) {
  closed(value, REQUIRED_HOST_RECEIPT_FIELDS, 'hostReceipt');
  for (const key of REQUIRED_HOST_RECEIPT_FIELDS) {
    if (value[key] !== HOST_RECEIPT[key]) invalid('hostReceipt is not the pinned host identity');
  }
  return HOST_RECEIPT;
}

export function assertPerformanceHostIdentity(descriptor) {
  return assertHostReceipt({ schemaVersion: descriptor.schemaVersion ?? 1, commit: descriptor.commit, ...descriptor.integrity });
}

function assertBrowser(value) {
  closed(value, ['engine', 'playwrightVersion', 'version'], 'browser');
  if (value.engine !== 'chromium' || value.playwrightVersion !== PLAYWRIGHT_VERSION || typeof value.version !== 'string' || value.version.trim() === '') invalid('browser identity is incomplete');
  return Object.freeze({ ...value });
}

function assertViewport(value) {
  closed(value, ['width', 'height'], 'viewport');
  if (value.width !== RELEASE_PERFORMANCE_VIEWPORT.width || value.height !== RELEASE_PERFORMANCE_VIEWPORT.height) invalid(`viewport must be ${RELEASE_PERFORMANCE_VIEWPORT.width}x${RELEASE_PERFORMANCE_VIEWPORT.height}`);
  return RELEASE_PERFORMANCE_VIEWPORT;
}

function assertObservations(value) {
  closed(value, RELEASE_MEASUREMENTS, 'observations');
  const result = {};
  for (const name of RELEASE_MEASUREMENTS) {
    const observation = value[name];
    assertPositiveObservation(observation, `observations.${name}`);
    result[name] = observation;
  }
  return Object.freeze(result);
}

function assertPositiveObservation(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) invalid(`${label} must be the first positive finite observation`);
}

function assertThresholds(value, observations) {
  closed(value, RELEASE_MEASUREMENTS, 'thresholds');
  const result = {};
  for (const name of RELEASE_MEASUREMENTS) {
    const expected = Math.max(1, Math.ceil(observations[name]));
    if (value[name] !== expected) invalid(`thresholds.${name} must equal max(1, ceil(first observation)) (${expected} ms)`);
    result[name] = expected;
  }
  return Object.freeze(result);
}

export function deriveReleaseThresholds(observations) {
  const normalized = assertObservations(observations);
  return Object.freeze(Object.fromEntries(RELEASE_MEASUREMENTS.map((name) => [name, Math.max(1, Math.ceil(normalized[name]))])));
}

export function validateReleasePerformanceBaselineSeed(value) {
  const identity = normalizeIdentity(value, { allowPendingCapture: true });
  closed(value.capture, ['policy', 'successfulRunOrdinal'], 'capture');
  if (value.capture.policy !== 'first-successful-pinned-harness-observation' || value.capture.successfulRunOrdinal !== null) invalid('baseline seed must remain pending until the first successful pinned harness run');
  return Object.freeze({ ...identity, capture: Object.freeze({ ...value.capture }) });
}

export function captureFirstReleasePerformanceBaseline(seed, observations) {
  const identity = validateReleasePerformanceBaselineSeed(seed);
  const normalizedObservations = assertObservations(observations);
  const thresholds = deriveReleaseThresholds(normalizedObservations);
  const identityFields = { schemaVersion: identity.schemaVersion, hostVersion: identity.hostVersion, hostReceipt: identity.hostReceipt, pluginBuildDigest: identity.pluginBuildDigest, browser: identity.browser, viewport: identity.viewport, fixtureIdentity: identity.fixtureIdentity, fixtureCounts: identity.fixtureCounts };
  return validateReleasePerformanceBaseline({
    ...identityFields,
    observations: normalizedObservations,
    thresholds,
    capture: {
      policy: 'first-successful-pinned-harness-observation',
      successfulRunOrdinal: 1,
      identityDigest: canonicalDigest(identityFields),
      observationsDigest: canonicalDigest(normalizedObservations)
    }
  });
}

export function validateReleasePerformanceBaseline(value) {
  closed(value, ['schemaVersion', 'hostVersion', 'hostReceipt', 'pluginBuildDigest', 'browser', 'viewport', 'fixtureIdentity', 'fixtureCounts', 'observations', 'thresholds', 'capture'], 'baseline');
  const { hostReceipt, browser, viewport, fixtureIdentity, fixtureCounts } = normalizeIdentity(Object.fromEntries(Object.entries(value).filter(([key]) => !['observations', 'thresholds', 'capture'].includes(key))));
  const observations = assertObservations(value.observations);
  const thresholds = assertThresholds(value.thresholds, observations);
  closed(value.capture, ['policy', 'successfulRunOrdinal', 'identityDigest', 'observationsDigest'], 'capture');
  if (value.capture.policy !== 'first-successful-pinned-harness-observation' || value.capture.successfulRunOrdinal !== 1) invalid('capture must identify the first successful pinned harness observation');
  const expectedIdentityDigest = canonicalDigest({ schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION, hostVersion: HOST_VERSION, hostReceipt, pluginBuildDigest: value.pluginBuildDigest, browser, viewport, fixtureIdentity, fixtureCounts });
  const expectedObservationsDigest = canonicalDigest(observations);
  if (value.capture.identityDigest !== expectedIdentityDigest || value.capture.observationsDigest !== expectedObservationsDigest) invalid('capture evidence does not match the pinned identities and observations');
  const capture = Object.freeze({ ...value.capture });
  return Object.freeze({ schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION, hostVersion: HOST_VERSION, hostReceipt, pluginBuildDigest: value.pluginBuildDigest, browser, viewport, fixtureIdentity, fixtureCounts, observations, thresholds, capture });
}

export function assertPerformanceObservationWithinBaseline(name, observation, baseline) {
  if (!RELEASE_MEASUREMENTS.includes(name)) invalid(`unknown observation ${name}`);
  assertPositiveObservation(observation, `observation.${name}`);
  const validated = validateReleasePerformanceBaseline(baseline);
  if (observation > validated.thresholds[name]) throw new Error(`Release performance baseline: ${name} exceeded ${validated.thresholds[name]} ms`);
  return true;
}

// The first-capture artifact and its historical ceilings stay immutable. The
// separately versioned qualification policy was approved before new samples;
// it is an engineering allowance, not a statistical confidence interval.
const QUALIFICATION_ALLOWANCE = Object.freeze({ policy: 'bounded-relative-allowance-v1',
  relativeAllowance: 0.20, minimumAllowanceMs: 50, maximumAllowanceMs: 2000 });

export function deriveReleasePerformanceBudget(baseline) {
  const validated = validateReleasePerformanceBaseline(baseline);
  const thresholds = Object.freeze(Object.fromEntries(RELEASE_MEASUREMENTS.map(name => {
    const first = validated.observations[name];
    const limit = Math.ceil(first + Math.min(QUALIFICATION_ALLOWANCE.maximumAllowanceMs,
      Math.max(QUALIFICATION_ALLOWANCE.minimumAllowanceMs, first * QUALIFICATION_ALLOWANCE.relativeAllowance)));
    return [name, positiveInteger(limit, `budget.thresholds.${name}`)];
  })));
  return Object.freeze({ schemaVersion: 1, ...QUALIFICATION_ALLOWANCE, policyDigest: canonicalDigest(QUALIFICATION_ALLOWANCE),
    baselineIdentityDigest: validated.capture.identityDigest,
    baselineObservationsDigest: validated.capture.observationsDigest, thresholds });
}

export function validateReleasePerformanceBudget(value, baseline) {
  const expected = deriveReleasePerformanceBudget(baseline);
  closed(value, Object.keys(expected), 'budget');
  for (const key of Object.keys(expected).filter(key => key !== 'thresholds')) {
    if (value[key] !== expected[key]) invalid(`budget.${key} does not match the frozen budget`);
  }
  closed(value.thresholds, RELEASE_MEASUREMENTS, 'budget.thresholds');
  for (const name of RELEASE_MEASUREMENTS) {
    if (value.thresholds[name] !== expected.thresholds[name]) invalid(`budget.thresholds.${name} does not match the frozen budget`);
  }
  return expected;
}

export function assertPerformanceObservationWithinBudget(name, observation, baseline) {
  if (!RELEASE_MEASUREMENTS.includes(name)) invalid(`unknown observation ${name}`);
  assertPositiveObservation(observation, `observation.${name}`);
  const budget = deriveReleasePerformanceBudget(baseline);
  const limit = budget.thresholds[name];
  if (observation > limit) throw new Error(`Release performance budget: ${name} observed ${observation} ms exceeded ${limit} ms`);
  return true;
}

export function assertPerformanceBaselineBuildIdentity(baseline, expectedBuildDigest) {
  const validated = validateReleasePerformanceBaseline(baseline);
  digest(expectedBuildDigest, 'expectedBuildDigest');
  if (validated.pluginBuildDigest !== expectedBuildDigest) invalid('pluginBuildDigest does not match the final build');
  return true;
}

export const releasePerformanceIdentity = Object.freeze({ hostVersion: HOST_VERSION, hostReceipt: HOST_RECEIPT, playwrightVersion: PLAYWRIGHT_VERSION, viewport: RELEASE_PERFORMANCE_VIEWPORT });
