import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FINALIZATION_PHASES } from '../src/acceptance-report.mjs';
import { RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS } from '../src/performance-baseline.mjs';
import { createScaleMeasurementIdentity, selectedScaleMeasurement, validateScaleQualificationLog } from '../scripts/validate-scale-qualification-log.mjs';
import canonical from '../src/compatibility-tuple.json' with { type: 'json' };

const baselineText = await readFile(new URL('./fixtures/release-performance-baseline.native-workspace.v3.json', import.meta.url), 'utf8');
const hash = `sha256:${'a'.repeat(64)}`;
const expected = { schemaVersion: 1, hostVersion: '2026.10.3', hostReceipt: { schemaVersion: 2, commit: 'a'.repeat(40),
  sourceDigest: hash, executableDigest: hash, contractDigest: hash, packageDigest: hash, runtimeDigest: hash },
  buildDigest: 'b'.repeat(64), browser: { engine: 'chromium', playwrightVersion: '1.63.0', version: '153.0.8010.12' },
  viewport: { width: 1440, height: 900 }, fixtureIdentity: RELEASE_FIXTURE_IDENTITY, fixtureCounts: RELEASE_FIXTURE_COUNTS };
const completion = () => ({ schemaVersion: 1, outcome: 'passed', scenario: 'scale-performance', scenarioIds: ['scale-performance'],
  buildDigest: expected.buildDigest, performanceQualified: false, evidence: { measurementIdentity: structuredClone(expected),
    browser: expected.browser, viewport: expected.viewport, fixtureCounts: expected.fixtureCounts,
    observations: Object.fromEntries(RELEASE_MEASUREMENTS.map(name => [name, 1])) } });
const finalizers = FINALIZATION_PHASES.flatMap(phase => ['started', 'passed'].map(status => ({ schemaVersion: 1, scenario: 'scale-performance', phase, status })));
const log = (result = completion(), finalization = finalizers) => [...finalization.map(value => `# acceptance-finalization=${JSON.stringify(value)}`),
  `# acceptance-scenario-result=${JSON.stringify(result)}`].join('\n');

test('direct scale measurement binds current metadata without changing evidence class or budgets', () => {
  const result = validateScaleQualificationLog(log(), baselineText, expected);
  assert.equal(result.measurementBound, true);
  assert.equal(result.performanceQualified, false);
  assert.equal(result.actionsAttested, false);
  assert.equal(Object.hasOwn(result, 'performanceBaseline'), false);
  assert.deepEqual(createScaleMeasurementIdentity(expected), expected);
  assert.equal(validateScaleQualificationLog(log(), baselineText).status, 'scale-performance-within-budget');
});

test('selected candidate measurement binds current host and build while retaining the historical budget', () => {
  const receipt = { ...expected.hostReceipt, commit: canonical.host.commit };
  const selected = selectedScaleMeasurement({ hostVersion: canonical.host.range.slice(1), hostReceipt: receipt,
    buildDigest: expected.buildDigest, baseline: JSON.parse(baselineText) });
  const value = completion();
  value.evidence.measurementIdentity = structuredClone(selected);
  value.evidence.browser = structuredClone(selected.browser);
  const measured = validateScaleQualificationLog(log(value), baselineText, selected);
  assert.equal(measured.measurementBound, true);
  assert.equal(measured.performanceQualified, false);
  for (const changed of [
    { hostVersion: '2026.1.1', hostReceipt: receipt },
    { hostVersion: canonical.host.range.slice(1), hostReceipt: { ...receipt, commit: 'f'.repeat(40) } }
  ]) assert.throws(() => selectedScaleMeasurement({ ...changed, buildDigest: expected.buildDigest, baseline: JSON.parse(baselineText) }));
  value.evidence.measurementIdentity.hostReceipt.runtimeDigest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => validateScaleQualificationLog(log(value), baselineText, selected), /Measured candidate identity differs/u);
});

test('every measured receipt field and candidate identity must match explicit input', () => {
  for (const name of Object.keys(expected)) {
    const missing = structuredClone(expected); delete missing[name];
    assert.throws(() => createScaleMeasurementIdentity(missing));
  }
  for (const name of Object.keys(expected.hostReceipt)) {
    const result = completion(); result.evidence.measurementIdentity.hostReceipt[name] = name === 'schemaVersion' ? 1 : name === 'commit' ? 'c'.repeat(40) : `sha256:${'c'.repeat(64)}`;
    assert.throws(() => validateScaleQualificationLog(log(result), baselineText, expected), undefined, name);
  }
  for (const mutate of [
    value => { value.evidence.measurementIdentity.hostVersion = '2026.10.4'; },
    value => { value.evidence.measurementIdentity.buildDigest = 'c'.repeat(64); },
    value => { value.buildDigest = 'c'.repeat(64); },
    value => { value.evidence.measurementIdentity.browser.version = 'fictional-other-browser'; },
    value => { value.evidence.browser = { ...expected.browser, playwrightVersion: '0.0.0' }; },
    value => { value.evidence.measurementIdentity.viewport.width = 320; },
    value => { value.evidence.viewport = { width: 320, height: 900 }; },
    value => { value.evidence.measurementIdentity.fixtureCounts.conversations = 100; },
    value => { value.evidence.fixtureCounts = { ...expected.fixtureCounts, noteFiles: 1 }; },
    value => { value.evidence.measurementIdentity.fixtureIdentity = `sha256:${'c'.repeat(64)}`; },
    value => { value.evidence.measurementIdentity.extra = true; },
    value => { delete value.evidence.measurementIdentity; },
    value => { value.performanceQualified = true; },
    value => { value.performanceBaseline = {}; },
    value => { value.outcome = 'failed'; },
    value => { value.scenarioIds = ['diagnostic-scale-startup']; }
  ]) {
    const result = completion(); mutate(result);
    assert.throws(() => validateScaleQualificationLog(log(result), baselineText, expected));
  }
});

test('all eight observations retain original budget and positive finite requirements', () => {
  for (const name of RELEASE_MEASUREMENTS) for (const value of [0, -1, Infinity, NaN, 1e9, '1', undefined]) {
    const result = completion(); result.evidence.observations[name] = value;
    assert.throws(() => validateScaleQualificationLog(log(result), baselineText, expected));
  }
  const result = completion(); result.evidence.observations.extra = 1;
  assert.throws(() => validateScaleQualificationLog(log(result), baselineText, expected));
});

test('baseline bytes and canonical completion/finalization cannot be replaced or omitted', () => {
  assert.throws(() => validateScaleQualificationLog(log(), baselineText + '\n', expected), /baseline bytes/u);
  assert.doesNotThrow(() => validateScaleQualificationLog(log(), baselineText.replace(/\n/gu, '\r\n'), expected));
  assert.throws(() => validateScaleQualificationLog('', baselineText, expected));
  assert.throws(() => validateScaleQualificationLog(log() + '\n' + log(), baselineText, expected));
  for (const changed of [[], finalizers.slice(1), [...finalizers, finalizers[0]], [...finalizers].reverse(),
    finalizers.map((entry, index) => index === 1 ? { ...entry, status: 'failed' } : entry)]) {
    assert.throws(() => validateScaleQualificationLog(log(completion(), changed), baselineText, expected));
  }
});
