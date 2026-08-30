import assert from 'node:assert/strict';
import test from 'node:test';
import { launchPinnedChromium, PLAYWRIGHT_VERSION } from '../src/browser-setup.mjs';

test('browser setup returns the single evaluator-provided headless browser without a full-executable proxy', async () => {
  const environment = { PLAYWRIGHT_BROWSERS_PATH: '/read-only/evaluator-cache' };
  const calls = [];
  const browser = { async close() {} };
  const result = await launchPinnedChromium({
    version: PLAYWRIGHT_VERSION,
    environment,
    browserType: { async launch(options) { calls.push(options); return browser; } }
  });
  assert.equal(result, browser);
  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, '/read-only/evaluator-cache');
  assert.deepEqual(calls, [{ headless: true }]);
});

test('browser setup fails closed when the evaluator-provided headless launch fails', async () => {
  const environment = { PLAYWRIGHT_BROWSERS_PATH: '/read-only/ms-playwright' };
  await assert.rejects(() => launchPinnedChromium({ version: PLAYWRIGHT_VERSION, environment, browserType: { async launch() { throw new Error('fictional launch failure'); } } }), /fictional launch failure/u);
  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, '/read-only/ms-playwright');
});

test('browser setup fails closed on version drift or a missing evaluator cache', async () => {
  const base = { environment: { PLAYWRIGHT_BROWSERS_PATH: '/fictional/prepared-cache' }, browserType: { async launch() { return {}; } } };
  await assert.rejects(() => launchPinnedChromium({ ...base, version: '1.62.0' }), /requires Playwright 1\.62\.1/u);
  await assert.rejects(() => launchPinnedChromium({ ...base, version: PLAYWRIGHT_VERSION, environment: {} }), /requires the evaluator-provided PLAYWRIGHT_BROWSERS_PATH/u);
});
