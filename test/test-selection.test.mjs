import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { ordinaryTestArgv, selectOrdinaryTestFiles } from '../src/test-selection.mjs';

test('ordinary suite excludes only the separately invoked real-host receipt test', () => {
  assert.deepEqual(selectOrdinaryTestFiles([
    'storage-recovery.test.mjs',
    'real-host.acceptance.test.mjs',
    'attention-service.integration.test.mjs',
    'fixtures'
  ]), [
    'test/attention-service.integration.test.mjs',
    'test/storage-recovery.test.mjs'
  ]);
});

test('ordinary suite uses bounded isolated workers on the medium evaluator', () => {
  assert.deepEqual(ordinaryTestArgv([
    'test/attention-service.integration.test.mjs',
    'test/storage-recovery.test.mjs'
  ]), [
    '--test',
    '--test-concurrency=4',
    'test/attention-service.integration.test.mjs',
    'test/storage-recovery.test.mjs'
  ]);
});

test('package test command selects every current ordinary test and preserves the dedicated receipt path', async () => {
  const entries = await readdir(new URL('./', import.meta.url));
  const selected = selectOrdinaryTestFiles(entries);
  const ordinary = entries.filter((entry) => entry.endsWith('.test.mjs') && entry !== 'real-host.acceptance.test.mjs');
  assert.equal(selected.length, ordinary.length);
  assert.equal(selected.includes('test/real-host.acceptance.test.mjs'), false);
  assert.equal(entries.includes('real-host.acceptance.test.mjs'), true);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node scripts/test.mjs');
});
