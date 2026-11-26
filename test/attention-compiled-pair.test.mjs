import test from 'node:test';
import assert from 'node:assert/strict';

test('installed following Attention successor uses native Workboard and accepted fictional email', {
  skip: process.env.COMMAND_CENTER_ATTENTION_QUALIFICATION !== '1' && 'Explicit isolated installed-pair qualification only.',
  timeout: 900_000
}, async context => {
  const { exerciseAttentionCompiledJourney } = await import('./support/attention-compiled-journey.mjs');
  const result = await exerciseAttentionCompiledJourney({ signal: context.signal });
  assert.equal(result.assertionsCompleted, true);
  context.diagnostic(`attention-compiled-pair=${JSON.stringify(result)}`);
});
