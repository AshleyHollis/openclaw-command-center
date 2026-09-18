import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Real plugin DOM and registered backend, with only the external host shell
// fictional. No live Gateway or sealed-native-loader acceptance is implied.
export async function verifyPreservedHistoryBrowser(readRpc) {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional history host</title><main id="mount"></main></html>'); return; }
      if (req.url === '/rpc' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) throw new Error('Fictional request too large'); }
        const { method, params } = JSON.parse(body);
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await readRpc(method, params))); return;
      }
      if (/^\/native-ui\/[a-z-]+\.mjs$/.test(req.url) || ['/release-scope.mjs', '/sources/errors.mjs'].includes(req.url)) {
        res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(`../../src${req.url}`, import.meta.url))); return;
      }
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end('Fictional fixture unavailable'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ acceptDownloads: true }); page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const plugin = (await import('/native-ui/entry.mjs')).default;
      const pages = new Map(); const lifetime = new AbortController(); let view; let scope;
      const host = { signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: false },
        redact: text => text, subscribe: () => () => {}, sessions: { open: () => { throw new Error('Imported history must not open an active composer'); } },
        ui: { registerPage: value => { pages.set(value.id, value); return () => pages.delete(value.id); }, registerNavigation: () => () => {} },
        request: async (method, params) => {
          const response = await (await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })).json();
          if (!response.ok) throw new Error(response.error?.message ?? 'History read refused');
          return response.payload;
        },
        navigation: { openPage: target => {
          scope?.abort(); view?.dispose(); scope = new AbortController();
          view = pages.get(target.id).mount(document.querySelector('#mount'), { host, signal: scope.signal, presented: true, props: target.params ?? {} });
        } }
      };
      window.disposeHistoryFixture = plugin.activate(host);
      host.navigation.openPage({ id: 'histories' });
    });
    await page.getByRole('button', { name: 'Read fictional-alpha', exact: true }).click();
    await page.getByText('Preserve this receipt.', { exact: true }).waitFor();
    assert.equal(await page.locator('textarea').count(), 0);
    await page.getByText('Preserved export copy: 25 bytes; source declared 100 bytes. The declared original representation is unverified.', { exact: true }).waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download receipt.txt', exact: true }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'receipt.txt');
    assert.equal(await readFile(await download.path(), 'utf8'), 'Fictional receipt bytes.\n');
    await page.getByRole('button', { name: 'All Imported Histories', exact: true }).click();
    await page.getByRole('button', { name: 'Read fictional-empty-report', exact: true }).click();
    await page.getByText('No messages in this preserved history.', { exact: true }).waitFor();
    await page.evaluate(() => window.disposeHistoryFixture());
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
