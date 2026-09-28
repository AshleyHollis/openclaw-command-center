import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

for (const scenario of ['ready', 'stale-on-open', 'expired-on-load', 'expired-on-open', 'missing-on-load', 'request-missing-on-load', 'missing-on-open', 'wrong-agent-on-open', 'reset-on-open']) test(`native DEV handoff ${scenario}`, { timeout: 30_000 }, async () => {
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
      const stale = { schemaVersion: 1, status: 'stale', workId: 'feature-1', requestId: 'review-a', reason: 'session-replaced' };
      const missing = { ...exact, sessionId: undefined };
      const responses = {
        ready: [exact, exact], 'stale-on-open': [exact, stale],
        'expired-on-load': [{ ...stale, reason: 'request-expired' }], 'expired-on-open': [exact, { ...stale, reason: 'request-expired' }],
        'missing-on-load': [missing],
        'request-missing-on-load': [{ ...stale, reason: 'request-missing' }],
        'missing-on-open': [exact, missing],
        'wrong-agent-on-open': [exact, { ...exact, agentId: 'different-agent' }],
        'reset-on-open': [exact, { ...exact, sessionId: 'session-2', lifecycleRevision: 'lifecycle-2' }]
      }[chosen];
      window.opened = []; window.navigated = []; window.requests = [];
      const host = { signal: controller.signal, connection: { connected: true, canRead: true }, redact: value => value,
        subscribe: () => () => {},
        request: async (method, params) => { window.requests.push({ method, params }); return { result: responses.shift() }; },
        sessions: { openChat: value => window.opened.push(value) },
        navigation: { openPage: value => window.navigated.push(value) }
      };
      window.view = mountDeveloperWorkPage(document.getElementById('mount'), { host, signal: controller.signal, presented: true, props: { workId: 'feature-1', requestId: 'review-a' } });
    }, scenario);
    if (!['missing-on-load', 'request-missing-on-load', 'expired-on-load'].includes(scenario)) {
      await page.getByRole('button', { name: 'Open exact DEV session' }).click();
      if (scenario === 'ready') await page.getByRole('status').getByText('Opened the exact DEV session. The request remains open.').waitFor();
      else await page.getByRole('heading', { name: 'This handoff is stale' }).waitFor();
    } else await page.getByRole('heading', { name: 'This handoff is stale' }).waitFor();
    if (scenario === 'stale-on-open') await page.getByRole('button', { name: 'Open current DEV work' }).click();
    const state = await page.evaluate(() => ({ opened: window.opened, navigated: window.navigated, requests: window.requests, status: document.querySelector('[role="status"]').textContent }));
    assert.equal(state.requests.length, scenario.endsWith('-on-load') ? 1 : 2);
    assert.deepEqual(state.requests.map(row => row.params), Array.from({ length: state.requests.length }, () =>
      ({ schemaVersion: 1, workId: 'feature-1', requestId: 'review-a' })));
    assert.ok(state.requests.every(row => row.method === 'command-center.v1.developer-work.resolve'));
    if (scenario === 'ready') {
      assert.deepEqual(state.opened, [{ sessionKey: 'agent:sample-agent:main', agentId: 'sample-agent' }]);
      assert.deepEqual(state.navigated, []);
    } else {
      assert.deepEqual(state.opened, []);
      assert.deepEqual(state.navigated, scenario === 'stale-on-open' ? [{ id: 'developer-work', params: { workId: 'feature-1' } }] : []);
      assert.match(state.status, /exact DEV context changed|exact DEV session binding|waiting request is no longer available|waiting request expired/iu);
      if (scenario.startsWith('expired-')) assert.match(state.status, /waiting request expired/iu);
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
