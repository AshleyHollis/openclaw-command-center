import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runtimeCapability } from '../src/runtime-capability.mjs';

test('declares the controller-pinned Control UI capability source graph', async () => {
  const mirror = JSON.parse(await readFile(new URL('../src/runtime-capability.json', import.meta.url), 'utf8'));
  const graph = JSON.parse(await readFile(new URL('../runtime-capability.source-graph.json', import.meta.url), 'utf8'));
  assert.deepEqual(mirror, runtimeCapability);
  assert.equal(graph.contract, './src/runtime-capability.json');
  assert.deepEqual(graph.sources, [
    './src/runtime-capability.mjs',
    './src/fixtures.mjs',
    './src/host-harness.mjs',
    './src/child-traffic.mjs',
    './src/isolated-child-guard.mjs',
    './src/isolation.mjs',
    './src/browser-evidence.mjs',
    './src/plugin.mjs',
    './test/real-host.acceptance.test.mjs'
  ]);
  assert.equal(runtimeCapability.bootstrap.grantsField, 'pluginFrameGrants');
  assert.equal(runtimeCapability.authentication.mode, 'token');
  assert.deepEqual(runtimeCapability.diagnostics.requiredEvidenceFields, ['readinessAttempts', 'url', 'status', 'error', 'bodyKeys']);
});
