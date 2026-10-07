import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('focused Topic creation preserves Chat on Cancel and recovers one original uncertain operation on reopen', { timeout: 30000 }, async t => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><button id="new">New Conversation</button><textarea aria-label="Native Chat draft">Fictional unsent draft</textarea><main id="mount"></main>'); return; }
    if (!/^\/[a-z-]+\.mjs$/u.test(req.url ?? '')) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(`../src/native-ui${req.url}`, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage(); page.setDefaultTimeout(4000); await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { mountTopicConversationDialog } = await import('/topic-creation-dialog.mjs');
    const { createNativeState } = await import('/mutations.mjs');
    const topic = { topicId: 'fictional-topic', revision: 4, name: 'Fictional Project', lifecycle: 'active', usable: true, health: 'ready' };
    const state = createNativeState(); window.created = []; window.opened = []; window.calls = []; window.loseResponse = true;
    const host = window.host = { signal: new AbortController().signal, connection: { connected: true, canRead: true, canWrite: true }, redact: text => text,
      sessions: { openChat: target => window.opened.push(target) },
      components: { mountDialog(container, props) {
        const dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', props.label); dialog.append(props.content); container.append(dialog); dialog.showModal();
        dialog.addEventListener('cancel', event => { event.preventDefault(); props.onCancel(); });
        return { dispose() { dialog.close(); dialog.remove(); props.returnFocusTarget?.focus(); } };
      } },
      async request(method, params) {
        window.calls.push([method, params]);
        if (method.endsWith('topics.get')) return { result: { topic } };
        if (method.endsWith('sessions.create')) { window.created.push(params); if (window.loseResponse) throw new Error('Fictional response lost'); return {}; }
        if (method.endsWith('sessions.browse')) { if (window.holdBrowse) await new Promise(resolve => { window.releaseBrowse = resolve; }); return { result: { topicId: topic.topicId, conversations: [{ referenceId: 'fictional-created-ref', sessionId: 'fictional-created-id', status: 'open' }] } }; }
        if (method.endsWith('sessions.resolve-native')) return { result: { sessionKey: 'agent:main:fictional-created' } };
        throw new Error('Unexpected fixture request');
      },
      async httpRequest({ body }) {
        const input = JSON.parse(body); window.calls.push(['http', input]);
        const original = window.created[0];
        const status = input.action.endsWith('.inspect') ? original ? 'unknown' : 'clear' : 'applied';
        return { status: 200, body: JSON.stringify({ schemaVersion: 1, status, logicalOperationId: original?.logicalOperationId,
          result: { action: input.action, topicId: topic.topicId, referenceId: 'fictional-created-ref', expectedTopicRevision: 4, label: original?.label } }) };
      }
    };
    window.show = () => { window.controller = mountTopicConversationDialog(document.querySelector('#mount'), { host, state, signal: host.signal, presented: () => true, topicId: topic.topicId, returnFocusTarget: document.querySelector('#new') }); };
    document.querySelector('#new').addEventListener('click', window.show);
  });
  await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
  await page.getByRole('dialog', { name: 'New conversation in Fictional Project' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'New Conversation', exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(await page.getByLabel('Native Chat draft').inputValue(), 'Fictional unsent draft');
  assert.deepEqual(await page.evaluate(() => window.created), []);
  await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
  await page.getByLabel('Conversation label').fill('Fictional follow-up');
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Check creation outcome', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Check creation outcome', exact: true }).click();
  await page.evaluate(() => { window.holdBrowse = true; });
  await page.getByRole('button', { name: 'Open created Conversation', exact: true }).click();
  await page.waitForFunction(() => !!window.releaseBrowse);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { window.holdBrowse = false; window.releaseBrowse(); });
  assert.deepEqual(await page.evaluate(() => window.opened), [], 'Cancel wins over an awaited created-Conversation lookup');
  await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Check creation outcome', exact: true }).click();
  await page.getByRole('button', { name: 'Open created Conversation', exact: true }).click();
  await page.waitForFunction(() => window.opened.length === 1);
  assert.equal(await page.evaluate(() => window.created.length), 1);
  assert.deepEqual(await page.evaluate(() => window.opened), [{ sessionKey: 'agent:main:fictional-created', agentId: 'main' }]);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByLabel('Native Chat draft').inputValue(), 'Fictional unsent draft');
  await page.evaluate(() => { window.host.components.mountDialog = undefined; });
  await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'does not support the focused' }).waitFor();
  assert.equal(await page.evaluate(() => window.created.length), 1, 'absent native dialog cannot dispatch creation or navigate elsewhere');
});
