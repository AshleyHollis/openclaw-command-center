import assert from 'node:assert/strict';
import test from 'node:test';
import { runIndependentCheckPhases } from '../scripts/check-phases.mjs';

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
