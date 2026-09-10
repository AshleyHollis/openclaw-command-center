import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';

test('relay step IDs are distinct from native preparation and stable across unchanged retries', async () => {
  const browser = await launchPinnedChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8'));
    await page.addScriptTag({ content: await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8') });
    const requests = await page.evaluate(async () => {
      const calls = [];
      bridgeRequest = async (method, params, operationId) => { calls.push({ method, params, operationId }); return { status: 200, body: '{}' }; };
      const logicalOperationId = '11111111-1111-4111-8111-111111111111';
      for (const action of ['create', 'create', 'provisioning.retry', 'provisioning.rollback']) {
        await relayHttp('/plugins/command-center/api/topics/actions', { method: 'POST', body: JSON.stringify({ schemaVersion: 1, action, logicalOperationId }) });
      }
      await relayHttp('/plugins/command-center/api/search/rebuild', { method: 'POST', body: JSON.stringify({ schemaVersion: 1, logicalOperationId }) });
      return calls;
    });
    assert.equal(requests[0].operationId, requests[1].operationId);
    assert.equal(new Set(requests.map((request) => request.operationId)).size, 4);
    for (const request of requests) {
      const logicalId = JSON.parse(request.params.body).logicalOperationId;
      assert.notEqual(request.operationId, logicalId, 'native preparation owns the logical ID as its transport ID');
      assert.ok(request.operationId.length <= 128);
      assert.equal(request.method, 'ui.http.post');
    }
  } finally { await browser.close(); }
});
