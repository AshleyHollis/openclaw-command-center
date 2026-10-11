import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { nativeMutation } from '../src/native-ui/mutations.mjs';
import { assertDeclarativeMirror, compatibilityTuple, validateCompatibility } from '../src/compatibility.mjs';
import { assertNativeHttpRouteBoundary } from '../scripts/repository-checks.mjs';

test('repository boundary accepts only the exact packaged native path declarations', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assertNativeHttpRouteBoundary(manifest.controlUi);
  for (const routes of [
    undefined, [], manifest.controlUi.httpRoutes.slice(0, 1),
    [...manifest.controlUi.httpRoutes, '/plugins/command-center/api/fictional-write'],
    manifest.controlUi.httpRoutes.map((path) => ({ path, method: 'POST' }))
  ]) assert.throws(() => assertNativeHttpRouteBoundary({ httpRoutes: routes }), /HTTP route boundary drift/u);
});

test('Next-2 host binding agrees across canonical tuple and committed package metadata', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(compatibilityTuple.host.commit, '7aaa0289cc95f683decddfca1cc506e550d24b48');
  assertDeclarativeMirror(packageJson.commandCenter.compatibilityTuple);
  assertDeclarativeMirror(lock.packages[''].commandCenter.compatibilityTuple);
  const previous = structuredClone(compatibilityTuple);
  previous.host.commit = '6cdebd0aba6e610455f775dced1c9df42d161fab';
  assert.equal(validateCompatibility(previous).ok, false);
});

test('native mutation callers use the manifest-declared exact POST relay paths', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  const paths = ['/plugins/command-center/api/topics/actions', '/plugins/command-center/api/topic/actions'];
  assert.deepEqual(manifest.controlUi.httpRoutes, paths);
  const signal = new AbortController().signal;
  for (const path of paths) {
    const input = { logicalOperationId: 'fictional-operation' };
    let calls = 0;
    const host = { connection: { connected: true, canRead: true }, async httpRequest(request, options) {
      calls++;
      assert.equal(request.method, 'POST');
      assert.equal(request.path, path);
      assert.ok(manifest.controlUi.httpRoutes.includes(request.path));
      assert.equal(options.signal, signal);
      assert.equal(request.body, JSON.stringify(input));
      return { status: 200, body: JSON.stringify({ schemaVersion: 1, status: 'applied', logicalOperationId: input.logicalOperationId, result: { id: 'fictional-result' } }) };
    } };
    assert.deepEqual(await nativeMutation(host, path, input, signal), { id: 'fictional-result' });
    assert.equal(calls, 1);
  }
});
