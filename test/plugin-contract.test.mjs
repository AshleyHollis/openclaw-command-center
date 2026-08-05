import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('plugin uses the pinned public external-tab and gateway-route seams', async () => {
  const source = await readFile(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  assert.match(source, /from 'openclaw\/plugin-sdk\/plugin-entry'/);
  assert.match(source, /definePluginEntry\(/);
  assert.doesNotMatch(source, /openclaw\/plugin-sdk';/);
  assert.match(source, /api\.session\.controls\.registerControlUiDescriptor\(/);
  assert.match(source, /surface:\s*'tab'/);
  assert.match(source, /path:\s*pluginPath/);
  assert.match(source, /api\.registerHttpRoute\(/);
  assert.match(source, /auth:\s*'gateway'/);
  assert.match(source, /serveShellAsset\(req, res, \{ assets \}\)/);
  assert.doesNotMatch(source, /registerControlUiExternalTab/);
});

test('manifest activates the route-registering plugin at Gateway startup', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation?.onStartup, true);
});
