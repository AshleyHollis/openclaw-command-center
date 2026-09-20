import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RELEASE_MEASUREMENTS,
  assertPerformanceObservationWithinBudget,
  validateReleasePerformanceBaseline
} from '../src/performance-baseline.mjs';

const [logPath] = process.argv.slice(2);
assert.ok(logPath, 'usage: validate-scale-qualification-log.mjs <log>');
const log = await readFile(logPath, 'utf8');
const marker = 'acceptance-scenario-result=';
const lines = log.split(/\r?\n/u).filter(line => line.includes(marker));
assert.equal(lines.length, 1, 'scale attempt must emit one canonical completion receipt');
const result = JSON.parse(lines[0].slice(lines[0].indexOf(marker) + marker.length));
assert.equal(result.outcome, 'passed');
assert.equal(result.scenario, 'scale-performance');
assert.deepEqual(result.scenarioIds, ['scale-performance']);
const baseline = validateReleasePerformanceBaseline(JSON.parse(await readFile(
  new URL('../test/fixtures/release-performance-baseline.native-workspace.v3.json', import.meta.url), 'utf8')));
for (const name of RELEASE_MEASUREMENTS) {
  assertPerformanceObservationWithinBudget(name, result.evidence.observations[name], baseline);
}
console.log(JSON.stringify({ status: 'scale-performance-within-budget', observations: result.evidence.observations }));
