import { createHash } from 'node:crypto';

export const RELEASE_PERFORMANCE_BASELINE_VERSION = 1;

export const RELEASE_FIXTURE_COUNTS = Object.freeze({
  chunkBoundaryNoteBytes: 524_289,
  largeNoteBytes: 524_289,
  conversations: 51,
  activityRecords: 51,
  actionCards: 2,
  indexedNotes: 2,
  indexedConversations: 51
});

export const RELEASE_PERFORMANCE_VIEWPORT = Object.freeze({ width: 1_440, height: 900 });

export const RELEASE_MEASUREMENTS = Object.freeze([
  'dashboardInteractiveMs',
  'topicInteractiveMs',
  'activityNextPageMs',
  'searchRebuildMs',
  'searchQueryMs',
  'slowestJourneyActionMs'
]);

const REQUIRED_HOST_RECEIPT_FIELDS = Object.freeze(['schemaVersion', 'sourceDigest', 'commit', 'executableDigest', 'contractDigest']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HOST_COMMIT = '30f2924e437857935f034ac349bae8cc22ef9fb0';
const HOST_VERSION = '2026.8.1-beta.3';
const PLAYWRIGHT_VERSION = '1.62.1';
export const RELEASE_FIXTURE_IDENTITY = 'sha256:c244084038c483c04a359bc6e4a845c93c7299685f7a401e2de0f03f312597cc';
const HOST_RECEIPT = Object.freeze({
  schemaVersion: 1,
  sourceDigest: 'sha256:6e4ac1c2c914e3794f04427b41d8661220c45a224513fe55062186dd3f6f4d06',
  commit: HOST_COMMIT,
  executableDigest: 'sha256:e5ec47e5fcad9a75be0d7164f71b8e069d78aa6422b0c9ed750bf5521735e083',
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

export function validateReleasePerformanceBaseline(value) {
  closed(value, ['schemaVersion', 'hostVersion', 'hostReceipt', 'pluginBuildDigest', 'browser', 'viewport', 'fixtureIdentity', 'fixtureCounts', 'observations', 'thresholds', 'capture'], 'baseline');
  if (value.schemaVersion !== RELEASE_PERFORMANCE_BASELINE_VERSION || value.hostVersion !== HOST_VERSION) invalid('version or host identity is not pinned');
  const hostReceipt = assertHostReceipt(value.hostReceipt);
  digest(value.pluginBuildDigest, 'pluginBuildDigest');
  const browser = assertBrowser(value.browser);
  const viewport = assertViewport(value.viewport);
  const fixtureIdentity = digest(value.fixtureIdentity, 'fixtureIdentity');
  if (fixtureIdentity !== RELEASE_FIXTURE_IDENTITY) invalid('fixtureIdentity is not the measured release fixture');
  const fixtureCounts = assertFixtureCounts(value.fixtureCounts);
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

export const releasePerformanceIdentity = Object.freeze({ hostVersion: HOST_VERSION, hostReceipt: HOST_RECEIPT, playwrightVersion: PLAYWRIGHT_VERSION, viewport: RELEASE_PERFORMANCE_VIEWPORT });
