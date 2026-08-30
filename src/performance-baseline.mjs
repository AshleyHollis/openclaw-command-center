export const RELEASE_PERFORMANCE_BASELINE_VERSION = 1;

export const RELEASE_FIXTURE_COUNTS = Object.freeze({
  largeNoteBytes: 8_388_609,
  conversations: 101,
  activityRecords: 51,
  actionCards: 2,
  indexedNotes: 5_000,
  indexedConversations: 5_000
});

export const RELEASE_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1_440, height: 900 }),
  mobile: Object.freeze({ width: 320, height: 900 })
});

export const RELEASE_MEASUREMENTS = Object.freeze([
  'dashboardReadyMs',
  'activityAppendMs',
  'indexedSearchMs',
  'largeNoteOpenMs',
  'actionCardCompletionMs'
]);

const REQUIRED_HOST_RECEIPT_FIELDS = Object.freeze(['schemaVersion', 'sourceDigest', 'commit', 'executableDigest', 'contractDigest']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HOST_COMMIT = '30f2924e437857935f034ac349bae8cc22ef9fb0';
const HOST_VERSION = '2026.8.1-beta.3';
const PLAYWRIGHT_VERSION = '1.62.1';

function invalid(message) {
  throw new TypeError(`Release performance baseline: ${message}`);
}

function closed(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${label} contains unsupported field ${key}`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative integer`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) invalid(`${label} must be a sha256 digest`);
  return value;
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
  if (value.schemaVersion !== 1 || value.commit !== HOST_COMMIT) invalid('hostReceipt is not the pinned host identity');
  for (const key of ['sourceDigest', 'executableDigest', 'contractDigest']) digest(value[key], `hostReceipt.${key}`);
  return Object.freeze({ ...value });
}

function assertBrowser(value) {
  closed(value, ['engine', 'playwrightVersion', 'version'], 'browser');
  if (value.engine !== 'chromium' || value.playwrightVersion !== PLAYWRIGHT_VERSION || typeof value.version !== 'string' || value.version.trim() === '') invalid('browser identity is incomplete');
  return Object.freeze({ ...value });
}

function assertViewport(value, label, expected) {
  closed(value, ['width', 'height'], label);
  if (value.width !== expected.width || value.height !== expected.height) invalid(`${label} must be ${expected.width}x${expected.height}`);
  return Object.freeze({ ...value });
}

function assertMeasurements(value) {
  closed(value, RELEASE_MEASUREMENTS, 'rawMeasurements');
  const result = {};
  for (const name of RELEASE_MEASUREMENTS) {
    const observation = closed(value[name], ['desktop', 'mobile'], `rawMeasurements.${name}`);
    result[name] = Object.freeze({ desktop: positiveInteger(observation.desktop, `rawMeasurements.${name}.desktop`), mobile: positiveInteger(observation.mobile, `rawMeasurements.${name}.mobile`) });
  }
  return Object.freeze(result);
}

function assertThresholds(value, measurements) {
  closed(value, RELEASE_MEASUREMENTS, 'thresholds');
  const result = {};
  for (const name of RELEASE_MEASUREMENTS) {
    const expected = Math.ceil(Math.max(measurements[name].desktop, measurements[name].mobile));
    if (value[name] !== expected) invalid(`thresholds.${name} must equal the slower first observation (${expected} ms)`);
    result[name] = expected;
  }
  return Object.freeze(result);
}

export function deriveReleaseThresholds(rawMeasurements) {
  const measurements = assertMeasurements(rawMeasurements);
  return Object.freeze(Object.fromEntries(RELEASE_MEASUREMENTS.map((name) => [name, Math.ceil(Math.max(measurements[name].desktop, measurements[name].mobile))])));
}

export function validateReleasePerformanceBaseline(value) {
  closed(value, ['schemaVersion', 'hostVersion', 'hostReceipt', 'pluginBuildDigest', 'browser', 'viewports', 'fixtureCounts', 'rawMeasurements', 'thresholds'], 'baseline');
  if (value.schemaVersion !== RELEASE_PERFORMANCE_BASELINE_VERSION || value.hostVersion !== HOST_VERSION) invalid('version or host identity is not pinned');
  const hostReceipt = assertHostReceipt(value.hostReceipt);
  digest(value.pluginBuildDigest, 'pluginBuildDigest');
  const browser = assertBrowser(value.browser);
  const viewports = closed(value.viewports, ['desktop', 'mobile'], 'viewports');
  const normalizedViewports = Object.freeze({ desktop: assertViewport(viewports.desktop, 'viewports.desktop', RELEASE_VIEWPORTS.desktop), mobile: assertViewport(viewports.mobile, 'viewports.mobile', RELEASE_VIEWPORTS.mobile) });
  const fixtureCounts = assertFixtureCounts(value.fixtureCounts);
  const rawMeasurements = assertMeasurements(value.rawMeasurements);
  const thresholds = assertThresholds(value.thresholds, rawMeasurements);
  return Object.freeze({ schemaVersion: 1, hostVersion: HOST_VERSION, hostReceipt, pluginBuildDigest: value.pluginBuildDigest, browser, viewports: normalizedViewports, fixtureCounts, rawMeasurements, thresholds });
}

export function assertPerformanceObservationWithinBaseline(name, observation, baseline) {
  if (!RELEASE_MEASUREMENTS.includes(name)) invalid(`unknown observation ${name}`);
  positiveInteger(observation, `observation.${name}`);
  const validated = validateReleasePerformanceBaseline(baseline);
  if (observation > validated.thresholds[name]) throw new Error(`Release performance baseline: ${name} exceeded ${validated.thresholds[name]} ms`);
  return true;
}

export const releasePerformanceIdentity = Object.freeze({ hostVersion: HOST_VERSION, hostCommit: HOST_COMMIT, playwrightVersion: PLAYWRIGHT_VERSION });
