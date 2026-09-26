import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

test('reader keeps nested Files beside long Notes during consecutive selection and filtering', { timeout: 60000 }, async () => {
  const packagedRoot = process.env.COMMAND_CENTER_NATIVE_UI_ROOT;
  const nativeUiRoot = packagedRoot ? path.resolve(packagedRoot) : fileURLToPath(new URL('../src/native-ui/', import.meta.url));
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html lang="en"><title>Reader fixture</title><style>body{margin:0;font:16px system-ui}#mount{height:700px;width:900px}</style><main id="mount"></main></html>'); return;
    }
    const vendor = { '/vendor/markdown-it.mjs': ['markdown-it', 'dist/browser/markdown-it.esm.min.mjs'], '/vendor/purify.es.mjs': ['dompurify', 'dist/purify.es.mjs'] }[req.url];
    if (!vendor && !/^\/[a-z-]+\.mjs$/u.test(req.url)) { res.writeHead(404); res.end(); return; }
    const asset = vendor
      ? packagedRoot ? path.join(nativeUiRoot, 'vendor', path.basename(req.url)) : new URL(`../node_modules/${vendor[0]}/${vendor[1]}`, import.meta.url)
      : path.join(nativeUiRoot, req.url.slice(1));
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(asset)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1530, height: 780 } });
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const { mountTopicPage } = await import('/topic-page.mjs');
      const { createNativeState } = await import('/mutations.mjs');
      const signal = new AbortController().signal;
      window.readerState = createNativeState(signal);
      window.promoted = 0;
      window.largeNoteText = `${'A'.repeat(8 * 1024 * 1024)}\n`;
      const paths = [
        ...Array.from({ length: 8 }, (_, i) => `projects/renovation/invoices/invoice-${i}.md`),
        ...Array.from({ length: 110 }, (_, i) => `archive/receipts/receipt-${i}.md`),
        'projects/renovation/duplicate.md',
        'archive/duplicate.md'
      ];
      const subscribers = new Set(); window.duplicateCatalog = false;
      const catalogRows = (topicId) => {
        const rows = paths.map(path => ({ path, revision: 'r1', sourceReference: { topicId, referenceId: path } }));
        if (window.duplicateCatalog) rows.push({ path: paths[0], revision: 'r1', sourceReference: { topicId, referenceId: 'foreign-duplicate' } });
        return rows;
      };
      const host = { signal, connection: { connected: true, canRead: true, canWrite: false },
        subscribe: (callback) => { subscribers.add(callback); return () => subscribers.delete(callback); }, redact: text => text, sessions: {},
        request: async (method, params) => {
          if (method.endsWith('topics.get')) return { topic: { topicId: params.topicId, name: 'Sample Records', noteFolderReferenceId: window.folderId ?? 'folder-one', usable: true, lifecycle: 'active' } };
          if (method.endsWith('notes.browse')) {
            const notes = catalogRows(params.topicId); const offset = params.offset ?? 0; const limit = params.limit ?? 50;
            const page = notes.slice(offset, offset + limit); const nextOffset = offset + page.length; const hasMore = nextOffset < notes.length;
            return { notes: page, total: notes.length, offset, hasMore, ...(hasMore ? { nextOffset } : {}), cursor: 'fixture-catalog' };
          }
          if (method.endsWith('notes.read')) {
            const text = params.path.endsWith('invoice-7.md') ? window.largeNoteText : `---\r\ntitle: Sample invoice\r\ntags: [example]\r\n---\r\n# ${params.path}\r\n\r\n${'Long fictional paragraph.\r\n\r\n'.repeat(100)}`;
            const offset = params.offset ?? 0;
            const nextOffset = Math.min(text.length, offset + 256 * 1024);
            return { path: params.path, revision: 'r1', sourceReference: { topicId: params.topicId, referenceId: params.path }, contentEncoding: 'identity', contentBase64: btoa(text.slice(offset, nextOffset)), byteOffset: offset, nextOffset, totalBytes: text.length, complete: nextOffset === text.length };
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      };
      window.view = mountTopicPage(document.querySelector('#mount'), { host, signal, props: { topicId: 'fixture' }, presented: true, panel: { showInMain: () => window.promoted++ } }, window.readerState, { panel: true });
      window.setReaderAccess = (canRead) => { host.connection.canRead = canRead; host.connection.connected = canRead; for (const callback of subscribers) callback(); };
      window.mountNativeExplorer = () => {
        window.view.dispose();
        window.nativeExplorerUpdates = [];
        const nativeHost = {
          ...host,
          components: {
            mountFileExplorer(container, initial) {
              const explorer = document.createElement('div'); explorer.className = 'control-ui-file-explorer';
              let props = initial;
              window.nativeExplorerProps = props;
              const render = () => {
                window.nativeExplorerUpdates.push({ query: props.query, expandedPaths: [...props.expandedPaths] });
                const search = document.createElement('input'); search.type = 'search'; search.setAttribute('aria-label', 'Filter files by name or path'); search.value = props.query;
                search.addEventListener('input', () => props.onQueryChange(search.value));
                const folder = document.createElement('details');
                const folderToggle = document.createElement('summary'); folderToggle.className = 'chat-workspace-rail__file'; folderToggle.textContent = 'projects';
                folder.append(folderToggle);
                const files = props.entries.filter(entry => entry.kind === 'file').map(entry => {
                  const button = document.createElement('button'); button.type = 'button'; button.className = 'chat-workspace-rail__file'; button.textContent = entry.name;
                  button.addEventListener('click', () => props.onSelect(entry.path)); return button;
                });
                explorer.replaceChildren(search, folder, ...files);
              };
              container.replaceChildren(explorer); render();
              return { update(next) { props = next; window.nativeExplorerProps = props; render(); }, dispose() { explorer.remove(); } };
            }
          }
        };
        window.view = mountTopicPage(document.querySelector('#mount'), { host: nativeHost, signal, props: { topicId: 'fixture' }, presented: true, panel: { showInMain: () => window.promoted++ } }, window.readerState, { panel: true });
      };
    });
    const filter = page.getByRole('searchbox', { name: /Filter/ });
    await filter.waitFor();
    const assertTargets = async (selector) => {
      const sizes = await page.locator(selector).evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(el => {
        const box = el.getBoundingClientRect(); return { width: box.width, height: box.height };
      }));
      assert.ok(sizes.length > 0, `${selector} has visible controls`);
      for (const size of sizes) assert.ok(size.width >= 44 && size.height >= 44, `${selector} target is at least 44x44 CSS pixels: ${JSON.stringify(size)}`);
    };
    await assertTargets('[data-topic-notes] summary');
    await assertTargets('.note-tree-item');
    await assertTargets('.reader-files input[type="search"]');
    for (const name of ['projects', 'renovation', 'invoices']) {
      const folder = page.locator('summary').filter({ hasText: new RegExp(`^${name}$`) });
      if (!(await folder.locator('..').getAttribute('open'))) {
        // An empty open attribute is also open; inspect the native disclosure state.
        if (!(await folder.evaluate(el => el.parentElement.open))) await folder.click();
      }
    }
    for (let i = 0; i < 5; i++) {
      const row = page.getByRole('button', { name: `Read projects/renovation/invoices/invoice-${i}.md`, exact: true });
      await row.click();
      const reader = page.getByRole('region', { name: 'Note content', exact: true });
      await reader.getByRole('heading', { level: 1 }).waitFor();
      assert.deepEqual(await page.getByRole('navigation', { name: 'File path', exact: true }).getByRole('listitem').allTextContents(), ['projects', 'renovation', 'invoices']);
      assert.equal(await page.getByRole('heading', { name: `invoice-${i}.md`, exact: true }).getAttribute('title'), `projects/renovation/invoices/invoice-${i}.md`, 'filename appears once in the document heading with the complete path available');
      const filesBox = await filter.boundingBox();
      const readerBox = await reader.boundingBox();
      assert.ok(filesBox.x + filesBox.width <= readerBox.x, 'Files must remain BESIDE the reader, not above it');
      assert.ok(filesBox.y >= 0 && filesBox.y < 780, 'Files filter remains onscreen');
      assert.equal(await row.getAttribute('aria-current'), 'true');
      assert.equal(await reader.evaluate(el => el === document.activeElement), true, 'an explicit file selection moves focus to the opened reader');
    }
    assert.equal(await page.evaluate(() => window.promoted), 1, 'later selections preserve an explicit native pane swap instead of promoting Files again');
    const metadata = page.getByText('title: Sample invoice', { exact: false });
    assert.equal(await metadata.isVisible(), false, 'frontmatter should not dominate Reading');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Note source"]')?.textContent?.startsWith('---\r\ntitle: Sample invoice'));
    assert.ok((await page.getByRole('region', { name: 'Note source', exact: true }).textContent()).startsWith('---\r\ntitle: Sample invoice\r\ntags: [example]\r\n---\r\n'));
    await page.getByRole('button', { name: 'Reading', exact: true }).click();
    await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.locator('[aria-label="Note source"]').textContent(), '', 'inactive source DOM is released');
    await page.getByRole('button', { name: 'Read projects/renovation/invoices/invoice-7.md', exact: true }).click();
    await page.locator('[aria-label="Note content"] [data-large-note-viewer]').waitFor();
    const assertLargeView = async (active, inactive) => {
      assert.deepEqual(await page.evaluate(({ active, inactive }) => {
        const viewer = document.querySelector(`[aria-label="Note ${active}"] [data-large-note-viewer]`);
        const other = document.querySelector(`[aria-label="Note ${inactive}"]`);
        return { viewers: document.querySelectorAll('[data-large-note-viewer]').length, length: viewer?.value.length, newline: viewer?.value.endsWith('\n'), defaultContent: viewer?.textContent.length, readOnly: viewer?.readOnly, inactiveChildren: other?.childNodes.length };
      }, { active, inactive }), { viewers: 1, length: 8 * 1024 * 1024 + 1, newline: true, defaultContent: 0, readOnly: true, inactiveChildren: 0 });
    };
    await assertLargeView('content', 'source');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await page.locator('[aria-label="Note source"] [data-large-note-viewer]').waitFor();
    await assertLargeView('source', 'content');
    await page.getByRole('button', { name: 'Reading', exact: true }).click();
    await page.locator('[aria-label="Note content"] [data-large-note-viewer]').waitFor();
    await assertLargeView('content', 'source');
    await page.getByRole('button', { name: 'Read projects/renovation/invoices/invoice-4.md', exact: true }).click();
    await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { level: 1 }).waitFor();
    await filter.fill('invoice-4');
    await filter.fill('');
    assert.equal(await page.getByRole('button', { name: 'Read projects/renovation/invoices/invoice-4.md', exact: true }).isVisible(), true, 'filter clearing restores nested expansion');
    await page.getByRole('button', { name: 'Refresh Notes', exact: true }).click();
    await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Read projects/renovation/invoices/invoice-4.md', exact: true }).getAttribute('aria-current'), 'true');
    await page.evaluate(() => window.view.update({ props: { topicId: 'another-topic' }, presented: true }));
    await page.waitForFunction(() => document.querySelector('[aria-label="Topic files"] summary') && !document.querySelector('.note-tree-item[aria-current]'));
    await page.evaluate(() => window.view.update({ props: { topicId: 'fixture' }, presented: true }));
    await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Read projects/renovation/invoices/invoice-4.md', exact: true }).isVisible(), true);
    const skipFiles = page.getByRole('button', { name: 'Go to Files', exact: true });
    assert.equal(await skipFiles.evaluate(el => getComputedStyle(el).clipPath), 'inset(50%)', 'focus shortcuts are unobtrusive until focused');
    await skipFiles.focus();
    assert.equal(await skipFiles.evaluate(el => getComputedStyle(el).clipPath), 'none');
    await skipFiles.press('Enter');
    assert.equal(await filter.evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', { name: 'Go to reader', exact: true }).press('Enter');
    assert.equal(await page.getByRole('region', { name: 'Note content', exact: true }).evaluate(el => el === document.activeElement), true);
    if (process.env.READER_SCREENSHOT_PATH) await page.screenshot({ path: process.env.READER_SCREENSHOT_PATH });
    await page.locator('#mount').evaluate(el => el.style.width = '400px');
    await page.getByRole('button', { name: 'Show Files', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show Files', exact: true }).click();
    assert.equal(await filter.isVisible(), true);
    await assertTargets('[data-topic-notes] summary');
    await assertTargets('.note-tree-item');
    await assertTargets('.reader-files input[type="search"]');
    await page.getByRole('button', { name: 'Hide Files', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'Note content', exact: true }).isVisible(), true);
    await page.locator('#mount').evaluate(el => el.style.width = '900px');
    // A native Files pane has a narrower retained host rail. Its explorer must
    // stay visible at that normal desktop width and after selecting a Note.
    await page.locator('#mount').evaluate(el => { el.style.width = '456px'; window.mountNativeExplorer(); });
    const nativeExplorer = page.locator('.control-ui-file-explorer');
    await nativeExplorer.waitFor({ state: 'visible' });
    const nativeFilter = nativeExplorer.getByRole('searchbox', { name: 'Filter files by name or path', exact: true });
    await assertTargets('[data-native-topic-files] .chat-workspace-rail__file');
    await assertTargets('[data-native-topic-files] summary.chat-workspace-rail__file');
    await assertTargets('[data-native-topic-files] input[type="search"]');
    // A host disclosure emits the complete expanded set based on its last
    // props. Sequential nested opens must therefore update that existing
    // renderer rather than leaving it with only the initial root path.
    await page.evaluate(() => window.nativeExplorerProps.onExpandedPathsChange(['projects', 'projects/renovation']));
    await page.waitForFunction(() => JSON.stringify(window.nativeExplorerUpdates.at(-1)?.expandedPaths) === JSON.stringify(['projects', 'projects/renovation']));
    await page.evaluate(() => window.nativeExplorerProps.onExpandedPathsChange(['projects', 'projects/renovation', 'projects/renovation/invoices']));
    await page.waitForFunction(() => JSON.stringify(window.nativeExplorerUpdates.at(-1)?.expandedPaths) === JSON.stringify(['projects', 'projects/renovation', 'projects/renovation/invoices']));
    await nativeFilter.fill('invoice-0');
    await page.waitForFunction(() => window.nativeExplorerUpdates.at(-1)?.query === 'invoice-0');
    assert.deepEqual(await page.evaluate(() => window.nativeExplorerUpdates.at(-1).expandedPaths), ['projects', 'projects/renovation', 'projects/renovation/invoices']);
    await page.evaluate(() => window.nativeExplorerProps.onExpandedPathsChange([]));
    await nativeFilter.fill('');
    await page.waitForFunction(() => window.nativeExplorerUpdates.at(-1)?.query === '');
    assert.deepEqual(await page.evaluate(() => window.nativeExplorerUpdates.at(-1).expandedPaths), ['projects', 'projects/renovation', 'projects/renovation/invoices'], 'clearing a filter restores every pre-filter nested expansion preference');
    await nativeFilter.fill('invoice-0');
    await nativeExplorer.getByRole('button', { name: 'invoice-0.md', exact: true }).click();
    await page.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await nativeExplorer.isVisible(), true, 'native Files remains visible after selecting a Note');
    await page.locator('#mount').evaluate(el => el.style.width = '400px');
    assert.equal(await nativeExplorer.isVisible(), true, 'native Files does not collapse at its retained rail width');
    await assertTargets('[data-native-topic-files] .chat-workspace-rail__file');
    await assertTargets('[data-native-topic-files] summary.chat-workspace-rail__file');
    await assertTargets('[data-native-topic-files] input[type="search"]');
    await nativeFilter.fill('receipt-109');
    const laterPageFile = nativeExplorer.getByRole('button', { name: 'receipt-109.md', exact: true });
    await laterPageFile.waitFor({ state: 'visible' });
    await laterPageFile.click();
    await page.getByRole('heading', { name: 'receipt-109.md', exact: true }).waitFor();
    await nativeFilter.fill('');
    await page.waitForFunction(() => window.nativeExplorerProps.entries.length === 120);
    assert.equal(await page.evaluate(() => window.nativeExplorerProps.entries.length), 120, 'native Files receives the complete bounded cursor catalog');
    const promotionsBeforeRestore = await page.evaluate(() => window.promoted);
    await page.evaluate(() => window.mountNativeExplorer());
    await page.getByRole('heading', { name: 'receipt-109.md', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.promoted), promotionsBeforeRestore, 'passive restoration must not request another panel promotion');
    assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Note content', 'passive restoration must not steal focus');
    await page.evaluate(() => { window.folderId = 'replaced-folder'; });
    assert.equal(await page.getByRole('button', { name: 'Refresh Notes', exact: true }).count(), 0, 'native Files owns the single refresh control');
    await page.evaluate(() => window.nativeExplorerProps.onRefresh());
    await page.waitForFunction(() => document.querySelector('[aria-label="Topic files"] summary') && !document.querySelector('.note-tree-item[aria-current]'));
    assert.equal(await page.getByRole('region', { name: 'Note content', exact: true }).textContent(), '', 'replaced binding must not restore old content');
    await page.evaluate(() => window.setReaderAccess(false));
    await page.getByText('Connect with read access to view Notes.', { exact: true }).waitFor();
    await page.waitForFunction(() => window.nativeExplorerProps.entries.length === 0);
    assert.equal(await nativeExplorer.getByRole('button').count(), 0, 'disconnect must clear the prior native Files catalog');
    await page.evaluate(() => window.setReaderAccess(true));
    await page.waitForFunction(() => window.nativeExplorerProps.entries.length === 120);
    await page.evaluate(() => { window.duplicateCatalog = true; });
    await page.evaluate(() => window.nativeExplorerProps.onRefresh());
    await page.getByText('The exact Note catalogue is unavailable.', { exact: true }).waitFor();
    await page.waitForFunction(() => window.nativeExplorerProps.entries.length === 0 && window.nativeExplorerProps.error === 'The exact Note catalogue is unavailable.');
    assert.equal(await nativeExplorer.getByRole('button').count(), 0, 'an ambiguous path catalog must not permit first-match native selection');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
