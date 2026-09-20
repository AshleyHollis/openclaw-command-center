import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build, distRoot } from '../src/build.mjs';

test('the built first-live plugin can register without optional services or missing release-policy modules', async () => {
  const receipt = await build();
  const { default: plugin } = await import(pathToFileURL(path.join(distRoot, 'plugin.mjs')).href);
  let services = 0;
  const tools = [];
  plugin.register({ pluginConfig: {},
    get notifications() { assert.fail('The built plugin must not acquire optional notification authority.'); },
    registerGatewayMethod() {}, registerHttpRoute() {},
    registerTool(tool, options) {
      tools.push(options?.name);
      assert.equal(typeof tool, 'function');
    },
    registerService() { services += 1; }
  });
  assert.equal(services, 1);
  assert.deepEqual(tools, ['command_center_capture_commitment', 'command_center_open_capacity_review', 'command_center_capture_source_commitment', 'command_center_record_intake_receipt']);
  assert.ok(receipt.files.some(file => file.path === 'native-ui/entry.mjs'));
  for (const path of ['native-ui/note-render.mjs', 'native-ui/vendor/markdown-it.mjs', 'native-ui/vendor/purify.es.mjs', 'native-ui/vendor/markdown-it-LICENSE.txt', 'native-ui/vendor/dompurify-LICENSE.txt']) {
    assert.ok(receipt.files.some(file => file.path === path), `sealed native asset is missing: ${path}`);
  }
  assert.ok(receipt.files.some(file => file.path === 'documents/filing.mjs'), 'sealed document filing owner is missing');
});
