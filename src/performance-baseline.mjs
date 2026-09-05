import { createHash } from 'node:crypto';

export const RELEASE_PERFORMANCE_BASELINE_VERSION = 1;

export const RELEASE_FIXTURE_COUNTS = Object.freeze({
  largeNoteBytes: 8_388_609,
  conversations: 101,
  activityRecords: 101,
  actionCards: 2,
  indexedNotes: 5_000,
  indexedConversationMessages: 5_000
});

export const RELEASE_PERFORMANCE_VIEWPORT = Object.freeze({ width: 1_440, height: 900 });

export const RELEASE_MEASUREMENTS = Object.freeze([
  'startupReadinessMs',
  'dashboardLoadMs',
  'topicOpenCreateMs',
  'chatSendMs',
  'conversationLifecycleMs',
  'largeNoteLifecycleMs',
  'indexedSearchMs',
  'activityNextPageMs',
  'topicReviewApplyMs',
  'mobileReflowMs'
]);

const REQUIRED_HOST_RECEIPT_FIELDS = Object.freeze(['schemaVersion', 'sourceDigest', 'commit', 'executableDigest', 'contractDigest']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HOST_COMMIT = 'd2ef96f4466d253f32fc48a666a4573b2ee98444';
const HOST_VERSION = '2026.9.1';
const PLAYWRIGHT_VERSION = '1.62.1';
export const RELEASE_FIXTURE_IDENTITY = canonicalDigest({
  schemaVersion: RELEASE_PERFORMANCE_BASELINE_VERSION,
  viewport: RELEASE_PERFORMANCE_VIEWPORT,
  fixtureCounts: RELEASE_FIXTURE_COUNTS
});
const HOST_RECEIPT = Object.freeze({
  schemaVersion: 1,
  sourceDigest: 'sha256:c0e913313d99c92368d608d48b21a2d38924a2811c07d7081b847e0492cfa846',
  commit: HOST_COMMIT,
  executableDigest: 'sha256:4f4d29770da4f86dbd0e07cbd4d46deab785905dd89ac719033fcfd866fb5d17',
  contractDigest: 'sha256:ec170da6eb2bb116bcf6b60cfea795af5dfa41ed83762194526eff977fc52fb6'
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
  return { schemaVersion: 1, hostVersion: HOST_VERSION, hostReceipt, pluginBuildDigest: value.pluginBuildDigest, browser, viewport, fixtureIdentity, fixtureCounts };
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
    if (typeof observation !== 'number' || !Number.isFinite(observation) || observation <= 0) invalid(`observations.${name} must be the first positive finite observation`);
    result[name] = observation;
  }
  return Object.freeze(result);
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
  const expectedIdentityDigest = canonicalDigest({ schemaVersion: 1, hostVersion: HOST_VERSION, hostReceipt, pluginBuildDigest: value.pluginBuildDigest, browser, viewport, fixtureIdentity, fixtureCounts });
  const expectedObservationsDigest = canonicalDigest(observations);
  if (value.capture.identityDigest !== expectedIdentityDigest || value.capture.observationsDigest !== expectedObservationsDigest) invalid('capture evidence does not match the pinned identities and observations');
  const capture = Object.freeze({ ...value.capture });
  return Object.freeze({ schemaVersion: 1, hostVersion: HOST_VERSION, hostReceipt, pluginBuildDigest: value.pluginBuildDigest, browser, viewport, fixtureIdentity, fixtureCounts, observations, thresholds, capture });
}

export function assertPerformanceObservationWithinBaseline(name, observation, baseline) {
  if (!RELEASE_MEASUREMENTS.includes(name)) invalid(`unknown observation ${name}`);
  positiveInteger(observation, `observation.${name}`);
  const validated = validateReleasePerformanceBaseline(baseline);
  if (observation > validated.thresholds[name]) throw new Error(`Release performance baseline: ${name} exceeded ${validated.thresholds[name]} ms`);
  return true;
}

export function assertPerformanceBaselineBuildIdentity(baseline, expectedBuildDigest) {
  const validated = validateReleasePerformanceBaseline(baseline);
  digest(expectedBuildDigest, 'expectedBuildDigest');
  if (validated.pluginBuildDigest !== expectedBuildDigest) invalid('pluginBuildDigest does not match the final build');
  return true;
}

export const releasePerformanceIdentity = Object.freeze({ hostVersion: HOST_VERSION, hostReceipt: HOST_RECEIPT, playwrightVersion: PLAYWRIGHT_VERSION, viewport: RELEASE_PERFORMANCE_VIEWPORT });
