import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeCliSummary } from './fixtures/native-cli-plugin.mjs';

test('native CLI fixture accepts terminal decoration without mixing output streams or forgiving corrupt JSON', () => {
  const digest = 'a'.repeat(64);
  const result = { phase: 'applied', planDigest: digest };
  const line = `07:30:00 \u001b[32m${JSON.stringify(result)}\u001b[0m\n`;
  assert.deepEqual(parseNativeCliSummary(['unrelated startup output\n', line], digest), result);
  assert.throws(() => parseNativeCliSummary([line, line], digest));
  assert.throws(() => parseNativeCliSummary(['no result'], digest));
  assert.throws(() => parseNativeCliSummary([JSON.stringify(result) + 'unexpected'], digest), SyntaxError);
});
