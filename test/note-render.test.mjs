import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('formatted Reading preserves useful Markdown while blocking active content', { timeout: 30000 }, async () => {
  const files = {
    '/note-render.mjs': '../src/native-ui/note-render.mjs',
    '/vendor/markdown-it.mjs': '../node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs',
    '/vendor/purify.es.mjs': '../node_modules/dompurify/dist/purify.es.mjs'
  };
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><main></main>'); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(files[req.url], import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const { renderReadOnlyMarkdown } = await import('/note-render.mjs');
      const root = document.querySelector('main');
      renderReadOnlyMarkdown(root, '# Fictional heading\n\n| Item | Value |\n| --- | --- |\n| Safe | 1 |\n\n![remote](https://example.invalid/pixel.png)\n\n[bad](javascript:alert(1))\n<script>window.compromised = true</script>');
      return { heading: root.querySelector('h1')?.textContent, table: !!root.querySelector('table'), images: root.querySelectorAll('img').length, scripts: root.querySelectorAll('script').length, compromised: window.compromised === true, links: [...root.querySelectorAll('a')].map(link => link.getAttribute('href')) };
    });
    assert.deepEqual(result, { heading: 'Fictional heading', table: true, images: 0, scripts: 0, compromised: false, links: [] });
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
