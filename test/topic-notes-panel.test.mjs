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

test('a retained Topic reader receives refreshed panel capabilities without losing its bound identity or lifetime', { timeout: 30_000 }, async () => {
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><main id="mount" style="display:flex;width:900px;height:700px"></main>'); return; }
    const vendor = { '/vendor/markdown-it.mjs': ['markdown-it', 'dist/browser/markdown-it.esm.min.mjs'], '/vendor/purify.es.mjs': ['dompurify', 'dist/purify.es.mjs'] }[request.url];
    const source = vendor ? new URL(`../node_modules/${vendor[0]}/${vendor[1]}`, import.meta.url)
      : /^\/[a-z-]+\.mjs$/u.test(request.url ?? '') ? new URL(`../src/native-ui${request.url}`, import.meta.url) : null;
    try { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(source)); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(5_000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const { mountTopicNotesPanel } = await import('/topic-notes-panel.mjs');
      const lifetime = new AbortController();
      const stats = { current: 0, stale: 0, mounts: 0, disposes: 0, requests: [] }; window.stats = stats;
      // Native revokes the old presentation capability before issuing a fresh
      // context, even when session, agent and presented identity are unchanged.
      let generation = 0;
      const capability = () => { const issued = generation; return { showInMain() {
        if (issued !== generation) { stats.stale++; throw new Error('This plugin UI view has ended.'); }
        stats.current++;
      } }; };
      const host = {
        signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: false },
        redact: value => value, subscribe: () => () => {}, sessions: { normalizeKey: value => value }, navigation: { openPage() {} },
        components: { mountFileExplorer(container, initial) {
          stats.mounts++;
          const explorer = document.createElement('div'); explorer.className = 'control-ui-file-explorer';
          let props = initial;
          const search = document.createElement('input'); search.type = 'search'; search.setAttribute('aria-label', 'Filter files by name or path');
          search.addEventListener('input', () => props.onQueryChange(search.value));
          const rows = document.createElement('div'); explorer.append(search, rows);
          const render = () => { search.value = props.query; window.lastSelect = props.onSelect;
            rows.replaceChildren(...props.entries.filter(entry => entry.kind === 'file').map(entry => {
              const button = document.createElement('button'); button.textContent = entry.name;
              button.addEventListener('click', () => props.onSelect(entry.path)); return button;
            }));
          };
          container.replaceChildren(explorer); render();
          return { update(next) { props = next; render(); }, dispose() { stats.disposes++; explorer.remove(); } };
        } },
        request: async (method, params) => {
          stats.requests.push({ method, params });
          if (method.endsWith('sessions.topic-context')) { const topic = params.sessionKey.endsWith('two') ? 'topic-two' : 'topic-one'; return { status: 'bound', sessionKey: params.sessionKey, sessionId: `${topic}-session`, topicId: topic, referenceId: `${topic}-reference` }; }
          if (method.endsWith('topics.get')) return { topic: { topicId: params.topicId, name: params.topicId, noteFolderReferenceId: `folder-${params.topicId}`, usable: true, lifecycle: 'active' } };
          if (method.endsWith('notes.browse')) return { notes: ['Overview.md', 'Second.md'].map(name => ({ path: name, revision: 'r1', sourceReference: { topicId: params.topicId, referenceId: name } })), offset: 0, total: 2, hasMore: false, cursor: 'fixture-catalog' };
          if (method.endsWith('notes.read')) {
            if (!['topic-one', 'topic-two'].includes(params.topicId)) throw new Error('The child lost its verified Topic identity.');
            const text = `# ${params.path}\n\nFictional authoritative Note.`; const bytes = new TextEncoder().encode(text);
            return { path: params.path, revision: 'r1', sourceReference: { topicId: params.topicId, referenceId: params.path }, contentEncoding: 'identity', contentBase64: btoa(String.fromCharCode(...bytes)), byteOffset: 0, nextOffset: bytes.length, totalBytes: bytes.length, complete: true };
          }
          if (method.endsWith('sessions.browse')) return { topicId: params.topicId, conversations: [] };
          if (method.endsWith('histories.list')) return { histories: [] };
          throw new Error(`Unexpected request: ${method}`);
        }
      };
      let context = { host, signal: lifetime.signal, presented: true, props: { sessionKey: 'agent:main:one' }, panel: capability() };
      window.panel = mountTopicNotesPanel(document.querySelector('#mount'), context);
      window.refreshCapability = () => { generation++; context = { ...context, panel: capability() }; window.panel.update(context); };
      window.changeIdentity = () => { generation++; context = { ...context, props: { sessionKey: 'agent:main:two' }, panel: capability() }; window.panel.update(context); };
      window.hidePanel = () => { generation++; context = { ...context, presented: false, panel: capability() }; window.panel.update(context); };
      window.disposePanel = () => { lifetime.abort(); window.panel.dispose(); };
    });
    const overview = page.getByRole('button', { name: 'Overview.md', exact: true }); await overview.waitFor();
    const originalExplorer = await page.locator('.control-ui-file-explorer').elementHandle();
    const originalCatalogReads = await page.evaluate(() => window.stats.requests.filter(entry => entry.method.endsWith('notes.browse')).length);
    await page.evaluate(() => window.refreshCapability());
    await overview.click();
    await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { name: 'Overview.md', exact: true }).waitFor();
    await page.waitForFunction(() => window.stats.current + window.stats.stale === 1);
    assert.deepEqual(await page.evaluate(() => ({ current: window.stats.current, stale: window.stats.stale, mounts: window.stats.mounts, disposes: window.stats.disposes })), { current: 1, stale: 0, mounts: 1, disposes: 0 });
    assert.equal(await page.evaluate(() => window.stats.requests.filter(entry => entry.method.endsWith('notes.browse')).length), originalCatalogReads);
    assert.equal(await page.locator('.control-ui-file-explorer').evaluate((element, original) => element === original, originalExplorer), true);
    await page.evaluate(() => window.refreshCapability());
    await page.getByRole('button', { name: 'Second.md', exact: true }).click();
    await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { name: 'Second.md', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => ({ current: window.stats.current, stale: window.stats.stale, mounts: window.stats.mounts, disposes: window.stats.disposes })), { current: 1, stale: 0, mounts: 1, disposes: 0 }, 'A later selection must retain the operator pane order and the existing reader');
    await page.evaluate(() => { window.oldSelect = window.lastSelect; window.changeIdentity(); });
    await page.getByRole('heading', { name: 'topic-two', exact: true }).waitFor(); await overview.click();
    await page.waitForFunction(() => window.stats.current === 2);
    let requests = await page.evaluate(() => window.stats.requests.length);
    await page.evaluate(() => window.oldSelect('Overview.md')); await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => window.stats.requests.length), requests, 'The old child retains its aborted lifetime after identity replacement');
    assert.deepEqual(await page.evaluate(() => ({ stale: window.stats.stale, mounts: window.stats.mounts, disposes: window.stats.disposes })), { stale: 0, mounts: 2, disposes: 1 });
    await page.evaluate(() => { window.hiddenSelect = window.lastSelect; window.hidePanel(); });
    requests = await page.evaluate(() => window.stats.requests.length);
    await page.evaluate(() => window.hiddenSelect('Overview.md')); await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => window.stats.requests.length), requests);
    assert.equal(await page.locator('.control-ui-file-explorer').count(), 0);
    await page.evaluate(() => { window.disposePanel(); window.hiddenSelect('Overview.md'); }); await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => window.stats.requests.length), requests, 'Unpresented/disposed child callbacks cannot admit a new read');
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
});
