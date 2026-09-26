import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

for (const scenario of ['ready', 'stale-on-open']) test(`native DEV handoff ${scenario}`, { timeout: 30_000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional DEV host</title><main id="mount"></main></html>'); return; }
    if (!/^\/[a-z-]+\.mjs$/u.test(req.url)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(`../src/native-ui${req.url}`, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async chosen => {
      const { mountDeveloperWorkPage } = await import('/developer-work-page.mjs');
      const controller = new AbortController();
      const exact = { schemaVersion: 1, status: 'ready', workId: 'feature-1', requestId: 'review-a', requestRevision: 1, agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'session-1', lifecycleRevision: 'lifecycle-1', summary: 'Review the sample feature' };
      const responses = chosen === 'ready' ? [exact, exact] : [exact, { schemaVersion: 1, status: 'stale', workId: 'feature-1', requestId: 'review-a', reason: 'session-replaced' }];
      window.opened = []; window.navigated = []; window.requests = [];
      const host = { signal: controller.signal, connection: { connected: true, canRead: true }, redact: value => value,
        subscribe: () => () => {},
        request: async (method, params) => { window.requests.push({ method, params }); return { result: responses.shift() }; },
        sessions: { openChat: value => window.opened.push(value) },
        navigation: { openPage: value => window.navigated.push(value) }
      };
      window.view = mountDeveloperWorkPage(document.getElementById('mount'), { host, signal: controller.signal, presented: true, props: { workId: 'feature-1', requestId: 'review-a' } });
    }, scenario);
    await page.getByRole('button', { name: 'Open exact DEV session' }).waitFor();
    await page.getByRole('button', { name: 'Open exact DEV session' }).click();
    if (scenario === 'ready') await page.getByRole('status').getByText('Opened the exact DEV session. The request remains open.').waitFor();
    else await page.getByRole('button', { name: 'Open current DEV work' }).click();
    const state = await page.evaluate(() => ({ opened: window.opened, navigated: window.navigated, requests: window.requests, status: document.querySelector('[role="status"]').textContent }));
    assert.equal(state.requests.length, 2);
    assert.deepEqual(state.requests.map(row => row.params), [
      { schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' },
      { schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' }
    ]);
    if (scenario === 'ready') {
      assert.deepEqual(state.opened, [{ sessionKey: 'agent:sample-agent:main', agentId: 'sample-agent' }]);
      assert.deepEqual(state.navigated, []);
    } else {
      assert.deepEqual(state.opened, []);
      assert.deepEqual(state.navigated, [{ id: 'developer-work', params: { workId: 'feature-1' } }]);
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
