import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('a bound Topic exposes native Session Files and safely returns to the verified Topic view', { timeout: 30_000 }, async () => {
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><style>#mount{display:flex;width:900px;height:700px}</style><main id="mount"></main>'); return; }
    const nativeModule = /^\/[a-z-]+\.mjs$/u.test(request.url ?? '') ? new URL(`../src/native-ui${request.url}`, import.meta.url) : null;
    try {
      response.setHeader('content-type', 'text/javascript');
      response.end(await readFile(nativeModule));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const { mountTopicNotesPanel } = await import('/topic-notes-panel.mjs');
      const lifetime = new AbortController(); window.defaultMounts = 0;
      const host = {
        signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: false }, redact: value => value,
        subscribe: () => () => {}, sessions: { normalizeKey: value => value }, navigation: { openPage() {} },
        request: async (method, params) => {
          if (method.endsWith('sessions.topic-context')) return { result: { status: 'bound', sessionKey: params.sessionKey, sessionId: 'session-one', topicId: 'topic-one', referenceId: 'session-ref' } };
          if (method.endsWith('topics.get')) return { result: { topic: { topicId: 'topic-one', name: 'Fictional Topic', noteFolderReferenceId: 'folder-one', usable: true, lifecycle: 'active' } } };
          if (method.endsWith('notes.browse')) return { result: { notes: [], offset: 0, total: 0, hasMore: false } };
          if (method.endsWith('sessions.browse')) return { result: { topicId: 'topic-one', conversations: [{ referenceId: 'session-ref', sessionId: 'session-one', status: 'open', isPrimary: true }] } };
          if (method.endsWith('histories.list')) return { result: { histories: [] } };
          throw new Error(`Unexpected request: ${method}`);
        }
      };
      window.panel = mountTopicNotesPanel(document.querySelector('#mount'), {
        host, signal: lifetime.signal, presented: true, props: { sessionKey: 'agent:main:topic-one' },
        mountDefault(container) { window.defaultMounts += 1; container.textContent = 'Native Session Files fixture'; return () => container.replaceChildren(); }
      });
    });
    await page.getByRole('combobox', { name: 'Files location', exact: true }).selectOption('session');
    await page.getByText('Native Session Files fixture', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.defaultMounts), 1);
    await page.getByRole('combobox', { name: 'Files location', exact: true }).selectOption('topic');
    await page.getByRole('heading', { name: 'Fictional Topic', exact: true }).waitFor();
    assert.equal(await page.locator('#mount').evaluate(el => el.firstElementChild.getBoundingClientRect().width === el.getBoundingClientRect().width), true, 'the workspace fills the native flex pane rather than shrink-wrapping its content');
    assert.equal(await page.getByRole('combobox', { name: 'Files location', exact: true }).inputValue(), 'topic');
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
});
