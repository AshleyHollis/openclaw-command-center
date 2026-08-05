import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedCatalogIsolationFetch, isHostedPluginCatalogRequest } from '../src/host-catalog-isolation.mjs';

test('suppresses the pinned host optional plugin catalog before network dispatch without whitelisting it', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(String(input));
    return new Response('ok');
  };
  const fetch = createHostedCatalogIsolationFetch(fetchImpl);

  assert.equal(isHostedPluginCatalogRequest('https://clawhub.ai/v1/feeds/plugins'), true);
  assert.equal(isHostedPluginCatalogRequest('https://clawhub.ai/v1/feeds/other'), false);
  assert.equal(isHostedPluginCatalogRequest('https://example.invalid/v1/feeds/plugins'), false);
  await assert.rejects(fetch('https://clawhub.ai/v1/feeds/plugins'), /disables the optional hosted plugin catalog/);
  assert.deepEqual(calls, []);

  await fetch('http://127.0.0.1:18789/ready');
  assert.deepEqual(calls, ['http://127.0.0.1:18789/ready']);
  assert.equal(typeof fetch.mock, 'object');
});
