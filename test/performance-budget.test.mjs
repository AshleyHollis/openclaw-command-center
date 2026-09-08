import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as budgetOwner from '../src/performance-baseline.mjs';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/release-performance-baseline.v3.json', import.meta.url), 'utf8'));
const before = JSON.stringify(baseline);

test('qualification uses a separately identified budget without rewriting the first observation', () => {
  const budget = budgetOwner.deriveReleasePerformanceBudget(baseline);
  assert.equal(budget.policy, 'bounded-relative-allowance-v1');
  assert.equal(budget.schemaVersion, 1);
  assert.equal(budget.baselineIdentityDigest, baseline.capture.identityDigest);
  assert.equal(budget.baselineObservationsDigest, baseline.capture.observationsDigest);
  assert.equal(budget.thresholds.startupReadinessMs, 12665);
  assert.equal(budget.thresholds.conversationNextPageMs, 190);
  assert.equal(Object.isFrozen(budget.thresholds), true);
  assert.equal(JSON.stringify(baseline), before);
  assert.equal(baseline.thresholds.startupReadinessMs, 10665);
});

for (const name of budgetOwner.RELEASE_MEASUREMENTS) {
  test(`budget owner enforces the fixed formula and fractional edge for ${name}`, () => {
    const budget = budgetOwner.deriveReleasePerformanceBudget(baseline);
    const observed = baseline.observations[name];
    const limit = Math.ceil(observed + Math.min(2000, Math.max(50, observed * 0.20)));
    assert.equal(budget.thresholds[name], limit);
    assert.equal(budgetOwner.assertPerformanceObservationWithinBudget(name, limit, baseline), true);
    assert.throws(() => budgetOwner.assertPerformanceObservationWithinBudget(name, limit + 0.001, baseline), /exceeded/u);
    for (const value of [0, -1, NaN, Infinity, '1', null, undefined]) {
      assert.throws(() => budgetOwner.assertPerformanceObservationWithinBudget(name, value, baseline), /positive finite/u);
    }
    for (const delta of [-1, 1]) {
      const changed = structuredClone(budget);
      changed.thresholds[name] += delta;
      assert.throws(() => budgetOwner.validateReleasePerformanceBudget(changed, baseline), /frozen budget/u);
    }
  });
}

test('stored budgets reject missing, extra, stale and caller-selected policy fields', () => {
  const budget = budgetOwner.deriveReleasePerformanceBudget(baseline);
  assert.deepEqual(budgetOwner.validateReleasePerformanceBudget(JSON.parse(JSON.stringify(budget)), baseline), budget);
  for (const field of Object.keys(budget)) {
    const missing = structuredClone(budget);
    delete missing[field];
    assert.throws(() => budgetOwner.validateReleasePerformanceBudget(missing, baseline));
  }
  for (const change of [{ policy: 'caller-policy' }, { schemaVersion: 2 }, { baselineIdentityDigest: 'sha256:' + 'a'.repeat(64) },
    { baselineObservationsDigest: 'sha256:' + 'b'.repeat(64) }, { tolerance: 10 }]) {
    assert.throws(() => budgetOwner.validateReleasePerformanceBudget({ ...budget, ...change }, baseline));
  }
  assert.throws(() => budgetOwner.deriveReleasePerformanceBudget({ ...baseline, observations: { ...baseline.observations, startupReadinessMs: 12000 } }));
  assert.throws(() => budgetOwner.assertPerformanceObservationWithinBudget('unknown', 1, baseline), /unknown observation/u);
  assert.equal(JSON.stringify(baseline), before);
});
