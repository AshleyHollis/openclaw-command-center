import assert from 'node:assert/strict';
import test from 'node:test';
import { runIndependentCheckPhases } from '../scripts/check-phases.mjs';
import * as checks from '../scripts/check-phases.mjs';

test('capture prerequisites defer only the baseline artifact, never generated safety', async () => {
  const observed = [];
  const owners = {
    verifyBaseline: async () => { observed.push('baseline'); throw new Error('No measured artifact yet'); },
    scanGenerated: async () => { observed.push('safety'); }
  };
  await runIndependentCheckPhases(checks.repositoryArtifactCheckPhases('capture-prerequisites', owners));
  assert.deepEqual(observed, ['safety']);
  observed.length = 0;
  await assert.rejects(runIndependentCheckPhases(checks.repositoryArtifactCheckPhases('qualification', owners)), AggregateError);
  assert.deepEqual(observed.sort(), ['baseline', 'safety']);
  assert.throws(() => checks.repositoryArtifactCheckPhases('skip-everything', owners), /check purpose/u);
  await assert.rejects(runIndependentCheckPhases(checks.repositoryArtifactCheckPhases('capture-prerequisites', {
    ...owners, scanGenerated: async () => { throw new Error('Unsafe generated artifact'); }
  })), AggregateError);
});

test('check phases retain every sibling failure and execute generated safety after baseline failure', async () => {
  const observed = [];
  await assert.rejects(
    runIndependentCheckPhases([
      { id: 'performance-baseline', run: async () => { observed.push('baseline'); throw new Error('stale digest'); } },
      { id: 'generated-artifact-safety', run: async () => { observed.push('generated'); throw new Error('unsafe artifact'); } }
    ]),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((failure) => failure.message), [
        'performance-baseline phase failed',
        'generated-artifact-safety phase failed'
      ]);
      return true;
    }
  );
  assert.deepEqual(observed.sort(), ['baseline', 'generated']);
});
