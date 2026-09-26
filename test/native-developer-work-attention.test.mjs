import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('LIVE Attention opens the DEV handoff without exposing a session key or submitting an action', { timeout: 30_000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional LIVE host</title><main id="mount"></main></html>'); return; }
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
    const result = await page.evaluate(async () => {
      const { mountAttentionPage } = await import('/attention-page.mjs');
      const controller = new AbortController();
      const card = { episodeId: 'episode-1', attentionRecordId: 'attention-1', notificationRecordIds: ['record-1'], context: 'Review sample feature', revision: 1 };
      const detail = { ...card, sourceCapabilityId: 'developer-work.v1', state: 'Active', severity: 'Routine', evidenceFacts: {
        question: 'Is this ready?', devHandoffUrl: 'https://dev.example.test/ui/plugin?plugin=command-center&id=developer-work&p.workId=sample-feature&p.requestId=review-a'
      } };
      window.calls = [];
      const host = { signal: controller.signal, connection: { connected: true, canRead: true, canWrite: true }, redact: value => value,
        subscribe: () => () => {},
        request: async (method, params) => { window.calls.push({ method, params }); return { result: method === 'command-center.v1.dashboard.get' ? { attention: [card], inProgress: [] } : { episode: detail } }; },
        navigation: { openPage: () => { throw new Error('Unexpected LIVE navigation'); } }
      };
      window.view = mountAttentionPage(document.getElementById('mount'), { host, signal: controller.signal, presented: true, props: { notificationRecord: 'record-1' } });
      return detail.evidenceFacts.devHandoffUrl;
    });
    const link = page.getByRole('link', { name: 'Open DEV Session' });
    await link.waitFor();
    assert.equal(await link.getAttribute('href'), result);
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal((await page.locator('body').innerText()).includes('agent:sample-agent:main'), false);
    assert.equal((await page.locator('body').innerText()).includes('Source Recovery'), false);
    assert.deepEqual((await page.evaluate(() => window.calls)).map(row => row.method), ['command-center.v1.dashboard.get', 'command-center.v1.attention.get']);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
