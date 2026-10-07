import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

test('Topic Reading tables retain readable columns and keyboard scrolling in narrow panes', { timeout: 60000 }, async t => {
  const nativeUiRoot = process.env.COMMAND_CENTER_NATIVE_UI_ROOT
    ? path.resolve(process.env.COMMAND_CENTER_NATIVE_UI_ROOT) : fileURLToPath(new URL('../src/native-ui/', import.meta.url));
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html lang="en"><title>Fictional Topic table</title><style>body{margin:0;font:16px system-ui;overflow-wrap:anywhere}#mount{height:520px;width:100%}#chat{height:90px;box-sizing:border-box;width:100%}</style><main id="mount"></main><textarea id="chat" aria-label="Native Chat draft">Fictional unsent draft</textarea></html>'); return;
    }
    const vendor = { '/vendor/markdown-it.mjs': ['markdown-it', 'dist/browser/markdown-it.esm.min.mjs'], '/vendor/purify.es.mjs': ['dompurify', 'dist/purify.es.mjs'] }[req.url];
    if (!vendor && !/^\/[a-z-]+\.mjs$/u.test(req.url)) { res.writeHead(404); res.end(); return; }
    const asset = vendor ? process.env.COMMAND_CENTER_NATIVE_UI_ROOT
      ? path.join(nativeUiRoot, 'vendor', path.basename(req.url)) : new URL(`../node_modules/${vendor[0]}/${vendor[1]}`, import.meta.url)
      : path.join(nativeUiRoot, req.url.slice(1));
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(asset)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
  page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { mountTopicPage } = await import('/topic-page.mjs');
    window.noteText = '# Fictional decisions\n\n| Date | Area | Decision | Notes |\n| --- | --- | --- | --- |\n| 2026-10-07 | Kitchen | Keep existing shelving | Compare two fictional quotations before ordering. |\n| 2026-10-08 | Study | Defer desk replacement | This is the final reachable cell. |\n\n[Unsafe](javascript:alert(1))\n\n![remote](https://example.invalid/pixel.png)';
    const signal = new AbortController().signal;
    const host = { signal, connection: { connected: true, canRead: true, canWrite: false }, sessions: {}, redact: text => text, subscribe: () => () => {},
      components: { mountFileExplorer(container, initial) {
        let props = initial; const explorer = document.createElement('div'); explorer.className = 'control-ui-file-explorer';
        const render = () => { const button = document.createElement('button'); button.textContent = 'Read decisions.md'; button.addEventListener('click', () => props.onSelect('decisions.md')); explorer.replaceChildren(button); };
        container.append(explorer); render(); return { update(next) { props = next; render(); }, dispose() { explorer.remove(); } };
      } },
      request: async (method, params) => {
        if (method.endsWith('topics.get')) return { topic: { topicId: params.topicId, name: 'Fictional records', noteFolderReferenceId: 'fictional-folder', usable: true, lifecycle: 'active' } };
        const sourceReference = { topicId: params.topicId, referenceId: 'fictional-note' };
        if (method.endsWith('notes.browse')) return { notes: [{ path: 'decisions.md', revision: 'r1', sourceReference }], total: 1, offset: 0, hasMore: false, cursor: 'fictional-catalog' };
        if (method.endsWith('notes.read')) return { path: params.path, revision: 'r1', sourceReference, contentEncoding: 'identity', contentBase64: btoa(window.noteText), byteOffset: 0, nextOffset: window.noteText.length, totalBytes: window.noteText.length, complete: true };
        throw new Error(`Unexpected method: ${method}`);
      }
    };
    window.view = mountTopicPage(document.querySelector('#mount'), { host, signal, props: { topicId: 'fictional-topic' }, presented: true, panel: { showInMain() {} } }, undefined, { panel: true });
  });
  await page.getByRole('button', { name: 'Read decisions.md', exact: true }).click();
  const reading = page.getByRole('region', { name: 'Note content', exact: true });
  const tableScroll = reading.getByRole('region', { name: 'Table 1', exact: true });
  await tableScroll.waitFor();
  for (const width of [320, 360, 412]) {
    for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.body.style.fontSize = size + 'px'; }, fontSize);
    await page.setViewportSize({ width, height: 740 });
    for (const filesVisible of [true, false]) {
      const toggle = page.getByRole('button', { name: filesVisible ? 'Show Files' : 'Hide Files', exact: true });
      if (await toggle.count()) await toggle.click();
      const metrics = await tableScroll.evaluate(region => {
        const table = region.querySelector('table'); const date = table.querySelector('tbody td');
        const range = document.createRange(); range.selectNodeContents(date);
        return { keyboard: region.tabIndex, overflow: region.scrollWidth > region.clientWidth,
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
          dateLines: range.getClientRects().length, minCell: Math.min(...[...table.querySelectorAll('th,td')].map(cell => cell.getBoundingClientRect().width)),
          headers: [...table.querySelectorAll('th')].map(cell => cell.textContent), finalCell: table.rows[2].cells[3].textContent };
      });
      assert.equal(metrics.keyboard, 0, 'wide tables are keyboard reachable');
      assert.equal(metrics.overflow, true, 'wide content scrolls inside its table');
      assert.equal(metrics.pageOverflow, false, `no page-wide overflow at ${width}px, Files ${filesVisible}`);
      assert.equal(metrics.dateLines, 1, 'ISO dates remain on one line');
      assert.ok(metrics.minCell >= 96, 'short columns retain readable minimum width');
      assert.deepEqual(metrics.headers, ['Date', 'Area', 'Decision', 'Notes']);
      assert.equal(metrics.finalCell, 'This is the final reachable cell.');
      await tableScroll.evaluate(region => { region.scrollLeft = 0; });
      await tableScroll.focus(); await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
      await tableScroll.evaluate(region => { region.scrollLeft = region.scrollWidth; });
      const endVisible = await tableScroll.evaluate(region => { const cell = region.querySelector('table').rows[2].cells[3].getBoundingClientRect(); const bounds = region.getBoundingClientRect(); return { cellRight: cell.right, regionRight: bounds.right, regionLeft: bounds.left, position: region.scrollLeft, maximum: region.scrollWidth - region.clientWidth }; });
      assert.ok(endVisible.cellRight <= endVisible.regionRight + 2 && endVisible.cellRight > endVisible.regionLeft, JSON.stringify({ width, fontSize, filesVisible, ...endVisible }));
    }
  }
  }
  await page.evaluate(() => { document.body.style.fontSize = '16px'; });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Note source"]')?.textContent === window.noteText);
  assert.equal(await page.getByRole('region', { name: 'Note source', exact: true }).textContent(), await page.evaluate(() => window.noteText));
  await page.getByRole('button', { name: 'Reading', exact: true }).click();
  await tableScroll.waitFor();
  assert.equal(await reading.locator('img,script,textarea,input').count(), 0);
  assert.equal(await reading.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Native Chat draft', exact: true }).inputValue(), 'Fictional unsent draft');
  if (process.env.COMMAND_CENTER_VISUAL_OUTPUT) {
    await page.screenshot({ path: process.env.COMMAND_CENTER_VISUAL_OUTPUT });
    await page.getByRole('button', { name: 'Show Files', exact: true }).click();
    await page.screenshot({ path: process.env.COMMAND_CENTER_VISUAL_OUTPUT.replace(/\.png$/u, '-files.png') });
  }
});