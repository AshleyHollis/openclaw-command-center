import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

// Same actual-module loopback fixture seam as native-reader-workspace.test.mjs.
// This is not a Gateway or an alternative app; mountTopics/mountTopicPage are
// loaded verbatim from the exact candidate's native-ui directory.
async function withNativeFixture(run) {
  const packagedRoot = process.env.COMMAND_CENTER_NATIVE_UI_ROOT;
  const root = packagedRoot ? path.resolve(packagedRoot) : fileURLToPath(new URL('../src/native-ui/', import.meta.url));
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional boundary fixture</title><style>body{margin:0;font:16px system-ui}#mount{height:700px;width:900px}</style><main id="mount"></main></html>'); return; }
    const vendor = { '/vendor/markdown-it.mjs': ['markdown-it', 'dist/browser/markdown-it.esm.min.mjs'], '/vendor/purify.es.mjs': ['dompurify', 'dist/purify.es.mjs'] }[req.url];
    if (!vendor && !/^\/[a-z-]+\.mjs$/u.test(req.url)) { res.writeHead(404); res.end(); return; }
    const asset = vendor ? packagedRoot ? path.join(root, 'vendor', path.basename(req.url)) : new URL(`../node_modules/${vendor[0]}/${vendor[1]}`, import.meta.url) : path.join(root, req.url.slice(1));
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(asset)); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1530, height: 780 } });
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await run(page);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
async function retain(name, observation, page) {
  const serialized = JSON.stringify(observation);
  assert.ok(Buffer.byteLength(serialized) <= 32768, 'Closed fictional evidence remains bounded.');
  console.log(`${name}=${serialized}`);
  const directory = process.env.COMMAND_CENTER_NATIVE_CHAT_EVIDENCE_DIR;
  if (directory) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, `${name}.json`), serialized); await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: false }); }
}

async function mountDelayedTopics(page, { shadow = false } = {}) {
  await page.evaluate(async ({ shadow }) => {
    const { mountTopics } = await import('/entry.mjs');
    const signal = new AbortController().signal;
    const outside = document.createElement('button'); outside.textContent = 'Unrelated control'; document.body.append(outside);
    let mount = document.querySelector('#mount');
    if (shadow) { window.fixtureShadow = mount.attachShadow({ mode: 'open' }); mount = document.createElement('section'); window.fixtureShadow.append(mount); }
    window.fixtureMount = mount;
    let lists = 0; window.openedPages = []; window.inputEvents = [];
    document.addEventListener('keydown', event => window.inputEvents.push({ type: event.type, key: event.key, targetIsNotes: event.composedPath()[0].textContent === 'View Notes for Fictional boundary Topic', targetIsBody: event.target === document.body }), true);
    document.addEventListener('click', event => window.inputEvents.push({ type: event.type, targetIsNotes: event.composedPath()[0].textContent === 'View Notes for Fictional boundary Topic', targetIsBody: event.target === document.body }), true);
    const host = { signal, connection: { connected: true, canRead: true, canWrite: false }, subscribe: () => () => {}, redact: value => value,
      sessions: { open: async () => {} }, navigation: { openPage: target => window.openedPages.push({ id: target.id, topicMatches: target.params.topicId === 'fictional-topic' }) },
      request: async method => {
        if (method.endsWith('sources.status')) return { mode: 'degraded' };
        if (method.endsWith('topics.list')) { if (++lists > 1) await new Promise(resolve => { window.finishRefresh = resolve; }); return { activeGroups: { project: window.nextTopics ?? [{ topicId: 'fictional-topic', name: 'Fictional boundary Topic', usable: true }], area: [], resource: [] }, recovery: [] }; }
        throw new Error(`Unexpected read-only fixture method: ${method}`);
      }
    };
    window.view = mountTopics(mount, { host, signal, presented: true });
  }, { shadow });
}

test('Refresh preserves exact valid Notes focus and Enter, including the delayed publication boundary', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedTopics(page);
  const notes = page.getByRole('button', { name: 'View Notes for Fictional boundary Topic', exact: true });
  await notes.waitFor();
  const original = await notes.elementHandle();
  await page.getByRole('button', { name: 'Refresh Topics', exact: true }).press('Enter');
  await page.waitForFunction(() => typeof window.finishRefresh === 'function');
  await notes.focus();
  await page.evaluate(() => window.finishRefresh());
  await page.waitForFunction(node => !node.isConnected, original);
  const refreshed = await notes.evaluate((node, original) => ({ originalDetached: !original.isConnected, exactReplacementFocused: document.activeElement === node }), original);
  assert.equal(refreshed.originalDetached, true);
  assert.equal(refreshed.exactReplacementFocused, true, 'Exact surviving Topic action retains user focus across publication.');
  await page.keyboard.press('Enter');
  const activated = await page.evaluate(() => ({ opened: [...window.openedPages], events: window.inputEvents.slice(-8) }));
  assert.deepEqual(activated.opened, [{ id: 'topic', topicMatches: true }]);
  assert.ok(activated.events.some(event => event.type === 'keydown' && event.targetIsNotes));
  assert.ok(activated.events.some(event => event.type === 'click' && event.targetIsNotes));
  await retain('positive-topics-refresh-focus', { refreshed, activated }, page);
}));

async function mountDelayedReader(page, { native = false, large = false } = {}) {
  await page.evaluate(async ({ native, large }) => {
    const { mountTopicPage } = await import('/topic-page.mjs');
    const { createNativeState } = await import('/mutations.mjs');
    const signal = new AbortController().signal;
    window.readerPaths = ['Overview.md', ...Array.from({ length: 143 }, (_, index) => `Z Projects/Alpha/Planning/Fictional-${String(index + 1).padStart(3, '0')}.md`)];
    if (large) {
      const files = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(3, '0')}.md`);
      window.readerPaths = [
        'Overview.md', ...files(55, 'Root-'), ...files(111, 'Archive/Alpha/Contract-'),
        ...files(85, 'Archive/Beta/Quote-'), ...files(445, 'Reference/Source-'),
        'Z Last/Deep/Later.md'
      ].sort((left, right) => left.localeCompare(right));
    }
    window.catalogRequests = []; window.completedTopics = []; window.promotions = 0;
    const host = { signal, connection: { connected: true, canRead: true, canWrite: false }, subscribe: () => () => {}, redact: value => value, sessions: {},
      request: async (method, params) => {
        if (method.endsWith('topics.get')) return { topic: { topicId: params.topicId, name: params.topicId === 'fictional-topic' ? 'Fictional boundary Topic' : 'Replacement Topic', noteFolderReferenceId: 'fictional-folder', usable: true, lifecycle: 'active' } };
        if (method.endsWith('notes.browse')) {
          const offset = params.offset ?? 0; const limit = params.limit ?? 50;
          window.catalogRequests.push({ offset, limit, topicId: params.topicId, cursorMatches: offset === 0 || params.cursor === 'fictional-cursor' });
          if (offset === 50) { await new Promise(resolve => { window.finishCatalog = resolve; }); window.completedTopics.push(params.topicId); }
          const paths = window.readerPaths.slice(offset, offset + limit); const next = offset + paths.length;
          const total = window.readerPaths.length;
          return { notes: paths.map(path => ({ path, revision: 'fictional-r1', sourceReference: { topicId: params.topicId, referenceId: `fictional:${path}` } })), total, offset, hasMore: next < total, ...(next < total ? { nextOffset: next } : {}), cursor: 'fictional-cursor' };
        }
        if (method.endsWith('notes.read')) { const text = `# ${params.path}\nFictional exact read.\n`; return { path: params.path, revision: 'fictional-r1', sourceReference: { topicId: params.topicId, referenceId: `fictional:${params.path}` }, contentEncoding: 'identity', contentBase64: btoa(text), byteOffset: 0, nextOffset: text.length, totalBytes: text.length, complete: true }; }
        throw new Error(`Unexpected read-only fixture method: ${method}`);
      }
    };
    if (native) {
      window.nativeCounts = []; window.nativeMounts = 0;
      host.components = { mountFileExplorer(container, props) {
        window.nativeMounts++;
        const owner = document.createElement('div'); const shadow = owner.attachShadow({ mode: 'open' });
        const input = document.createElement('input'); input.type = 'search'; input.setAttribute('aria-label', 'Native fictional filter');
        shadow.append(input); container.append(owner); window.nativeSearch = input;
        const record = props => window.nativeCounts.push(props.entries.length); record(props);
        return { update: record, dispose: () => owner.remove() };
      } };
    }
    window.readerContext = { host, signal, props: { topicId: 'fictional-topic' }, presented: true, panel: { showInMain: () => window.promotions++ } };
    window.view = mountTopicPage(document.querySelector('#mount'), window.readerContext, createNativeState(signal), { panel: true });
  }, { native, large });
}

test('catalog finalization preserves first-page focused row identity and real Enter/Tab', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedReader(page);
  await page.getByText('Loading remaining Topic files\u2026', { exact: true }).waitFor();
  const overview = page.getByRole('button', { name: 'Read Overview.md', exact: true });
  await overview.waitFor();
  const original = await overview.elementHandle();
  await overview.focus();
  await page.evaluate(() => window.finishCatalog());
  await page.getByText('Loading remaining Topic files\u2026', { exact: true }).waitFor({ state: 'hidden' });
  const interrupted = await page.evaluate(node => ({ originalDetached: !node.isConnected, focusIsBody: document.activeElement === document.body, loading: [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('Loading remaining')), rows: document.querySelectorAll('.note-tree-item').length }), original);
  assert.equal(interrupted.originalDetached, false);
  assert.equal(interrupted.focusIsBody, false);
  assert.equal(interrupted.loading, false);
  assert.equal(await overview.evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { name: 'Overview.md', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Filter filenames', exact: true }).focus();
  const before = await overview.elementHandle();
  for (let step = 0; step < 5 && !(await overview.evaluate(node => document.activeElement === node)); step++) await page.keyboard.press('Tab');
  const settled = await overview.evaluate((node, old) => ({ exactOriginalNode: node === old, connected: node.isConnected, targetFocused: document.activeElement === node }), before);
  assert.equal(settled.targetFocused, true, 'After complete catalog publication, sequential keyboard navigation must reach Overview.');
  assert.equal(settled.exactOriginalNode, true);
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { name: 'Overview.md', exact: true }).waitFor();
  await retain('positive-catalog-focus-preservation', { interrupted, settled }, page);
}));

test('fallback pages files inside the exact folder and keeps its root sibling in a 144-file Topic', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedReader(page);
  await page.waitForFunction(() => typeof window.finishCatalog === 'function');
  await page.evaluate(() => window.finishCatalog());
  await page.getByText('Loading remaining Topic files\u2026', { exact: true }).waitFor({ state: 'hidden' });
  const seen = ['Overview.md'];
  assert.equal(await page.getByRole('navigation', { name: 'Root file pages', exact: true }).count(), 0);
  for (const name of ['Z Projects', 'Alpha', 'Planning']) await page.locator('summary').filter({ hasText: name }).click();
  const pager = page.getByRole('navigation', { name: 'File pages in Z Projects/Alpha/Planning', exact: true });
  const folder = page.locator('details[data-folder-path="Z Projects/Alpha/Planning"]');
  for (const [index, count] of [50, 50, 43].entries()) {
    const first = index * 50 + 1; const last = index * 50 + count;
    await pager.getByText(`Files ${first}–${last} of 143.`, { exact: true }).waitFor();
    const paths = await folder.locator('.note-tree-item').evaluateAll(nodes => nodes.map(node => node.dataset.path));
    assert.equal(paths.length, count);
    seen.push(...paths);
    assert.equal(await page.getByRole('button', { name: 'Read Overview.md', exact: true }).isVisible(), true);
    if (index < 2) await pager.getByRole('button', { name: 'Next files', exact: true }).press('Enter');
  }
  assert.equal(new Set(seen).size, 144);
  assert.deepEqual([...seen].sort(), await page.evaluate(() => [...window.readerPaths].sort()));
  assert.equal(await pager.getByRole('button', { name: 'Next files', exact: true }).isDisabled(), true);
  const previous = pager.getByRole('button', { name: 'Previous files', exact: true });
  assert.equal(await previous.evaluate(button => button.getRootNode().activeElement === button), true);
  await previous.press('Enter');
  await previous.press('Enter');
  await pager.getByText('Files 1–50 of 143.', { exact: true }).waitFor();
  assert.equal(await previous.isDisabled(), true);
  const requests = await page.evaluate(() => window.catalogRequests);
  assert.deepEqual(requests.map(row => row.offset), [0, 50, 100]);
  assert.ok(requests.every(row => row.cursorMatches));
  await retain('actual-fallback-pagination', { total: seen.length, unique: new Set(seen).size, pageSizes: [50, 50, 43], requests }, page);
}));

test('fallback reveals late folders, preserves independent pages through search, and restores matched selection', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedReader(page, { large: true });
  await page.waitForFunction(() => typeof window.finishCatalog === 'function');
  const summary = path => page.locator(`summary[title="${path}"]`);
  const branch = path => page.locator(`details[data-folder-path="${path}"]`);
  const pager = path => page.getByRole('navigation', { name: path ? `File pages in ${path}` : 'Root file pages', exact: true });
  const alpha = 'Archive/Alpha';
  const beta = 'Archive/Beta';
  await summary('Archive').press('Enter');
  await summary(alpha).press('Enter');
  const first = page.getByRole('button', { name: 'Read Archive/Alpha/Contract-001.md', exact: true });
  await first.focus();
  const original = await first.elementHandle();
  assert.equal(await summary('Z Last').count(), 0);
  await page.evaluate(() => window.finishCatalog());
  await page.getByText('698 Topic files available.', { exact: true }).waitFor();
  await summary('Z Last').waitFor();
  assert.equal(await first.evaluate((node, original) => node === original && node === node.getRootNode().activeElement, original), true);
  await pager(alpha).getByRole('button', { name: 'Next files', exact: true }).press('Enter');
  await pager(alpha).getByText('Files 51–100 of 111.', { exact: true }).waitFor();
  await summary(beta).press('Enter');
  await pager(beta).getByText('Files 1–50 of 85.', { exact: true }).waitFor();
  await pager().getByRole('button', { name: 'Next files', exact: true }).press('Enter');
  await pager().getByText('Files 51–56 of 56.', { exact: true }).waitFor();
  assert.equal(await branch('Reference').evaluate(node => node.open), false);
  const filter = page.getByRole('searchbox', { name: 'Filter filenames', exact: true });
  const tree = page.getByRole('region', { name: 'Topic files', exact: true });
  await tree.evaluate(node => { node.scrollTop = 200; });
  await filter.fill('z last/deep');
  await page.getByText('1 matching Topic file.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Read Z Last/Deep/Later.md', exact: true }).press('Enter');
  const content = page.getByRole('region', { name: 'Note content', exact: true });
  await content.getByRole('heading', { name: 'Z Last/Deep/Later.md', exact: true }).waitFor();
  await filter.fill('');
  for (const path of ['Archive', alpha, beta]) assert.equal(await branch(path).evaluate(node => node.open), true);
  for (const path of ['Reference', 'Z Last']) assert.equal(await branch(path).evaluate(node => node.open), false);
  await pager(alpha).getByText('Files 51–100 of 111.', { exact: true }).waitFor();
  await pager(beta).getByText('Files 1–50 of 85.', { exact: true }).waitFor();
  await pager().getByText('Files 51–56 of 56.', { exact: true }).waitFor();
  assert.equal(await tree.evaluate(node => node.scrollTop), 200);
  await content.getByRole('heading', { name: 'Z Last/Deep/Later.md', exact: true }).waitFor();
  await summary('Z Last').press('Enter');
  await summary('Z Last/Deep').press('Enter');
  assert.equal(await page.getByRole('button', { name: 'Read Z Last/Deep/Later.md', exact: true }).getAttribute('aria-current'), 'true');
}));

for (const changed of [[], [{ topicId: 'replacement-topic', name: 'Replacement Topic', usable: true }]]) {
  test(`Refresh does not transfer focus to ${changed.length ? 'changed' : 'missing'} Topic identity`, { timeout: 60000 }, async () => withNativeFixture(async page => {
    await mountDelayedTopics(page);
    const notes = page.getByRole('button', { name: 'View Notes for Fictional boundary Topic', exact: true }); await notes.waitFor();
    const original = await notes.elementHandle();
    await page.getByRole('button', { name: 'Refresh Topics', exact: true }).press('Enter');
    await page.waitForFunction(() => typeof window.finishRefresh === 'function'); await notes.focus();
    await page.evaluate(rows => { window.nextTopics = rows; window.finishRefresh(); }, changed);
    await page.waitForFunction(node => !node.isConnected, original);
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    assert.equal(await page.evaluate(() => window.openedPages.length), 0);
    if (changed.length) assert.equal(await page.getByRole('button', { name: 'View Notes for Replacement Topic', exact: true }).evaluate(node => document.activeElement === node), false);
  }));
}
test('Refresh never steals user focus moved to an unrelated control', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedTopics(page);
  const notes = page.getByRole('button', { name: 'View Notes for Fictional boundary Topic', exact: true }); await notes.waitFor(); const original = await notes.elementHandle();
  await page.getByRole('button', { name: 'Refresh Topics', exact: true }).press('Enter'); await page.waitForFunction(() => typeof window.finishRefresh === 'function');
  await notes.focus(); await page.getByRole('button', { name: 'Unrelated control', exact: true }).focus(); await page.evaluate(() => window.finishRefresh());
  await page.waitForFunction(node => !node.isConnected, original);
  assert.equal(await page.getByRole('button', { name: 'Unrelated control', exact: true }).evaluate(node => document.activeElement === node), true);
}));
test('disposed Topics completion neither republishes nor moves focus', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedTopics(page); await page.getByRole('button', { name: 'View Notes for Fictional boundary Topic', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh Topics', exact: true }).press('Enter'); await page.waitForFunction(() => typeof window.finishRefresh === 'function');
  await page.evaluate(async () => { window.view.dispose(); const outside = [...document.querySelectorAll('button')].find(node => node.textContent === 'Unrelated control'); outside.focus(); window.finishRefresh(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.equal(await page.evaluate(() => window.fixtureMount.children.length), 0);
  assert.equal(await page.getByRole('button', { name: 'Unrelated control', exact: true }).evaluate(node => document.activeElement === node), true);
}));
test('Refresh follows actual nested ShadowRoot focus without taking document-host focus as the action', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedTopics(page, { shadow: true });
  const notes = page.getByRole('button', { name: 'View Notes for Fictional boundary Topic', exact: true }); await notes.waitFor(); const original = await notes.elementHandle();
  await page.getByRole('button', { name: 'Refresh Topics', exact: true }).press('Enter'); await page.waitForFunction(() => typeof window.finishRefresh === 'function'); await notes.focus();
  await page.evaluate(() => window.finishRefresh()); await page.waitForFunction(node => !node.isConnected, original);
  const shadowFocus = await notes.evaluate(node => {
    const root = node.getRootNode(); let deep = document.activeElement;
    while (deep?.shadowRoot?.activeElement) deep = deep.shadowRoot.activeElement;
    return { exactFocused: root.activeElement === node && document.activeElement !== node,
      documentActiveTag: document.activeElement?.tagName ?? null, deepActiveTag: deep?.tagName ?? null,
      rootActiveTag: root.activeElement?.tagName ?? null, rootConnected: root.isConnected, actionConnected: node.isConnected };
  });
  assert.equal(shadowFocus.exactFocused, true, `Exact ShadowRoot action focus must survive publication: ${JSON.stringify(shadowFocus)}`);
  await page.keyboard.press('Enter'); assert.deepEqual(await page.evaluate(() => window.openedPages), [{ id: 'topic', topicMatches: true }]);
}));
test('native component receives complete catalogue without remounting its shadow-focused control', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedReader(page, { native: true }); await page.waitForFunction(() => typeof window.finishCatalog === 'function');
  await page.getByRole('searchbox', { name: 'Native fictional filter', exact: true }).focus();
  await page.evaluate(() => window.finishCatalog()); await page.waitForFunction(() => window.nativeCounts.at(-1) === 144);
  assert.equal(await page.evaluate(() => window.nativeMounts), 1);
  assert.equal(await page.evaluate(() => window.nativeSearch.isConnected && window.nativeSearch.getRootNode().activeElement === window.nativeSearch), true);
}));
test('disposed reader completion cannot recreate its catalogue or move outside focus', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedReader(page); await page.waitForFunction(() => typeof window.finishCatalog === 'function');
  await page.evaluate(() => { window.view.dispose(); const outside = document.createElement('button'); outside.textContent = 'Outside reader'; document.body.append(outside); outside.focus(); window.finishCatalog(); });
  await page.waitForFunction(() => window.completedTopics.includes('fictional-topic'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#mount').evaluate(node => node.children.length), 0);
  assert.equal(await page.getByRole('button', { name: 'Outside reader', exact: true }).evaluate(node => document.activeElement === node), true);
}));
test('old Topic catalogue completion cannot replace a newly bound Topic page', { timeout: 60000 }, async () => withNativeFixture(async page => {
  await mountDelayedReader(page); await page.waitForFunction(() => typeof window.finishCatalog === 'function');
  await page.evaluate(() => { window.oldFinishCatalog = window.finishCatalog; window.view.update({ ...window.readerContext, props: { topicId: 'replacement-topic' } }); });
  await page.waitForFunction(() => window.finishCatalog !== window.oldFinishCatalog);
  await page.evaluate(() => window.finishCatalog()); await page.waitForFunction(() => window.completedTopics.includes('replacement-topic'));
  await page.getByRole('heading', { name: 'Replacement Topic', exact: true }).waitFor();
  const row = page.getByRole('button', { name: 'Read Overview.md', exact: true }); const original = await row.elementHandle(); await row.focus();
  await page.evaluate(() => window.oldFinishCatalog()); await page.waitForFunction(() => window.completedTopics.includes('fictional-topic'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await row.evaluate((node, original) => node === original && node.isConnected && document.activeElement === node, original), true);
  await page.getByRole('heading', { name: 'Replacement Topic', exact: true }).waitFor();
}));
