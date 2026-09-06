import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

// Exercise the production native page. Only its external host boundary is
// fictional; operating mode and Topic responses are independently delayed.
async function fixture(run) {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional operating mode</title><main></main></html>'); return; }
    if (!/^\/(?:native-ui\/[a-z-]+|sources\/errors|release-scope)\.mjs$/u.test(req.url)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(`../src${req.url}`, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(3000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const { mountTopics } = await import('/native-ui/entry.mjs');
      const lifetime = new AbortController(); const listeners = new Set();
      window.mode = 'recovery-only'; window.calls = []; window.delayed = false;
      window.destination = { activeGroups: { project: [], area: [], resource: [] }, recovery: [] };
      const host = {
        signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: true },
        redact: text => text, sessions: { open() { throw new Error('Unexpected Chat navigation'); } },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async request(method) {
          window.calls.push(method);
          if (method.endsWith('sources.status')) {
            const value = { mode: window.mode, schemaVersion: 1, unavailableCapabilities: [] };
            if (window.delayed) { window.delayed = false; await new Promise(resolve => { window.releaseStatus = resolve; }); }
            return { result: value };
          }
          if (method.endsWith('topics.list')) return { result: structuredClone(window.destination) };
          throw new Error(`Unexpected host call: ${method}`);
        }
      };
      const view = mountTopics(document.querySelector('main'), { host, signal: lifetime.signal, presented: true });
      window.connection = patch => { Object.assign(host.connection, patch); for (const listener of listeners) listener(); };
      window.dispose = () => { view.dispose(); lifetime.abort(); };
    });
    await run(page);
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}

test('native Topics distinguishes recovery-only, degraded and genuinely empty ready state', () => fixture(async page => {
  await page.getByRole('status').filter({ hasText: 'Recovery-only' }).waitFor();
  assert.equal(await page.getByText('No active Topics.', { exact: true }).count(), 0);
  assert.equal(await page.locator('form').count(), 0);
  for (const [mode, expected] of [['degraded', 'Degraded'], ['ready', 'No active Topics.']]) {
    await page.evaluate(value => { window.mode = value; }, mode);
    await page.getByRole('button', { name: 'Refresh Topics' }).click();
    await page.getByRole('status').filter({ hasText: expected }).waitFor();
  }
  await page.evaluate(() => { window.mode = 'unrecognized'; });
  await page.getByRole('button', { name: 'Refresh Topics' }).click();
  await page.getByRole('status').filter({ hasText: 'operating mode is unavailable' }).waitFor();
  assert.equal(await page.getByText('No active Topics.', { exact: true }).count(), 0);
}));

test('late operating status cannot replace a newer refresh or disclose Topics after access loss', () => fixture(async page => {
  await page.getByRole('status').filter({ hasText: 'Recovery-only' }).waitFor();
  await page.evaluate(() => { window.mode = 'ready'; window.delayed = true; });
  await page.getByRole('button', { name: 'Refresh Topics' }).click();
  await page.waitForFunction(() => typeof window.releaseStatus === 'function');
  await page.evaluate(() => { window.mode = 'recovery-only'; });
  await page.getByRole('button', { name: 'Refresh Topics' }).click();
  await page.getByRole('status').filter({ hasText: 'Recovery-only' }).waitFor();
  await page.evaluate(async () => { window.releaseStatus(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.match(await page.getByRole('status').textContent(), /Recovery-only/u);
  await page.evaluate(() => { window.mode = 'ready'; window.delayed = true; delete window.releaseStatus; });
  await page.getByRole('button', { name: 'Refresh Topics' }).click();
  await page.waitForFunction(() => typeof window.releaseStatus === 'function');
  await page.evaluate(async () => { window.connection({ canRead: false }); window.releaseStatus(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  await page.getByText('Connect with read access to view Topics.', { exact: true }).waitFor();
  assert.equal(await page.getByText('No active Topics.', { exact: true }).count(), 0);
}));

test('Topics needing Source Recovery remain visible without writable or rebound destinations', () => fixture(async page => {
  await page.getByRole('status').filter({ hasText: 'Recovery-only' }).waitFor();
  await page.evaluate(() => {
    window.mode = 'ready';
    window.destination.recovery = [{ topicId: 'fictional-recovery-topic', name: 'Fictional source unavailable', usable: false }];
  });
  await page.getByRole('button', { name: 'Refresh Topics' }).click();
  await page.getByRole('heading', { name: 'Source Recovery', exact: true }).waitFor();
  await page.getByText('Fictional source unavailable — Source Recovery required.', { exact: true }).waitFor();
  assert.equal(await page.getByText('No active Topics.', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /Open .* in Chat|Create|Relink/u }).count(), 0);
  assert.equal(await page.locator('form').count(), 0);
}));
