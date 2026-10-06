import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

for (const { name, props, sourceCapabilityId, hasHandoff } of [
  { name: 'notificationRecord', props: { notificationRecord: 'record-1' }, sourceCapabilityId: 'developer-work.v1', hasHandoff: true },
  { name: 'attentionRecord', props: { attentionRecord: 'attention-1' }, sourceCapabilityId: 'developer-work.v1', hasHandoff: true },
  { name: 'attentionRecord with a different source capability', props: { attentionRecord: 'attention-1' }, sourceCapabilityId: 'topic-review', hasHandoff: false }
]) test(`fictional Attention ${name} selects the exact item and gates the developer handoff`, { timeout: 30_000 }, async () => {
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
    const result = await page.evaluate(async ({ props, sourceCapabilityId }) => {
      const { mountAttentionPage } = await import('/attention-page.mjs');
      const controller = new AbortController();
      const card = { episodeId: 'episode-1', attentionRecordId: 'attention-1', notificationRecordIds: ['record-1'], context: 'Review sample feature', revision: 1 };
      const otherCard = { episodeId: 'episode-2', attentionRecordId: 'attention-2', notificationRecordIds: ['record-2'], context: 'Unrelated fictional item', revision: 1 };
      const detail = { ...card, sourceCapabilityId, state: 'Active', severity: 'Routine', evidenceFacts: {
        question: 'Is this ready?', devHandoffUrl: 'https://dev.example.test/ui/plugin?plugin=command-center&id=developer-work&p.workId=sample-feature&p.requestId=review-a'
      } };
      window.calls = [];
      const host = { signal: controller.signal, connection: { connected: true, canRead: true, canWrite: true }, redact: value => value,
        subscribe: () => () => {},
        request: async (method, params) => {
          window.calls.push({ method, params });
          if (method === 'command-center.v1.dashboard.get') return { result: { attention: [otherCard, card], inProgress: [] } };
          if (method === 'command-center.v1.attention.get' && params.episodeId === card.episodeId) return { result: { episode: detail } };
          throw new Error(`Unexpected Attention request: ${method} ${params.episodeId ?? ''}`);
        },
        navigation: { openPage: () => { throw new Error('Unexpected LIVE navigation'); } }
      };
      window.view = mountAttentionPage(document.getElementById('mount'), { host, signal: controller.signal, presented: true, props });
      return detail.evidenceFacts.devHandoffUrl;
    }, { props, sourceCapabilityId });
    const link = page.getByRole('link', { name: 'Open DEV Session' });
    await page.getByRole('heading', { name: 'Review sample feature' }).waitFor();
    assert.equal(await link.count(), hasHandoff ? 1 : 0);
    if (hasHandoff) {
      assert.equal(await link.getAttribute('href'), result);
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    }
    assert.equal((await page.locator('body').innerText()).includes('Unrelated fictional item'), false);
    assert.equal((await page.locator('body').innerText()).includes('agent:sample-agent:main'), false);
    assert.equal((await page.locator('body').innerText()).includes('Source Recovery'), false);
    assert.deepEqual(await page.evaluate(() => window.calls), [
      { method: 'command-center.v1.dashboard.get', params: { schemaVersion: 1, activityOffset: 0, activityLimit: 20 } },
      { method: 'command-center.v1.attention.get', params: { schemaVersion: 1, episodeId: 'episode-1' } }
    ]);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
