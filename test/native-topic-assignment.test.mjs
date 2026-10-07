import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('native picker assignment starts empty, disambiguates Topics and never replaces a revoked choice', { timeout: 30000 }, async t => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><style>#mount{width:260px}</style><main id="mount"></main><textarea aria-label="Native draft">Fictional draft</textarea>'); return; }
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
    const { mountTopicSidebar } = await import('/topic-sidebar.mjs'); window.assignments = []; window.pickers = [];
    window.topics = ['fictional-one', 'fictional-two'].map(topicId => ({ topicId, name: 'Fictional Topic', paraCategory: 'project', revision: 4, usable: true, health: 'ready', lifecycle: 'active' }));
    const signal = new AbortController().signal;
    const host = window.host = { signal, connection: { connected: true, canRead: true, canWrite: true }, redact: text => text, sessions: { openChat() {} },
      navigation: { openPage() {} }, components: { mountSelectPicker(container, props) {
        window.pickers.push(props); const select = document.createElement('select'); select.setAttribute('aria-label', props.accessibleLabel); select.disabled = props.disabled;
        for (const option of props.options) { const node = document.createElement('option'); node.value = option.value; node.textContent = [option.label, option.description].filter(Boolean).join(' · '); select.append(node); }
        select.value = props.value; select.addEventListener('change', () => props.onSelect(select.value)); container.append(select);
        return { dispose() { select.remove(); } };
      } }, async request(method, params) {
        if (method.endsWith('topics.list')) return { result: { activeGroups: { project: window.topics }, recovery: [], archived: [] } };
        if (method.endsWith('sessions.browse')) return { result: { topicId: params.topicId, conversations: [{ referenceId: `${params.topicId}-primary`, sessionId: `${params.topicId}-session`, status: 'open', isPrimary: true }] } };
        if (method.endsWith('histories.list')) return { result: { histories: [] } };
        if (method.endsWith('sessions.topic-context')) return { result: { status: 'unbound' } };
        if (method.endsWith('sessions.assign-topic')) { window.assignments.push(params); throw new Error('Fictional response lost'); }
        throw new Error('Unexpected fixture request');
      } };
    const context = window.context = { host, signal, presented: true, props: { sessions: [{ key: 'agent:main:fictional-inbox', sessionId: 'fictional-inbox', updatedAt: 8, displayName: 'Fictional Inbox' }] }, mountDefault: () => () => {} };
    window.sidebar = mountTopicSidebar(document.querySelector('#mount'), context);
  });
  await page.getByRole('button', { name: 'Inbox / Unassigned (1)' }).click();
  const picker = page.getByRole('combobox', { name: 'Assign Fictional Inbox to Topic' });
  const assign = page.getByRole('button', { name: 'Assign to Topic', exact: true });
  assert.equal(await picker.inputValue(), ''); assert.equal(await assign.isDisabled(), true);
  assert.match(await picker.innerText(), /fictional-one/); assert.match(await picker.innerText(), /fictional-two/);
  await picker.selectOption('fictional-two'); assert.equal(await assign.isDisabled(), false);
  if (process.env.COMMAND_CENTER_VISUAL_OUTPUT) await page.screenshot({ path: process.env.COMMAND_CENTER_VISUAL_OUTPUT, fullPage: true });
  await assign.click(); await page.waitForFunction(() => window.assignments.length === 1);
  await page.getByRole('status').filter({ hasText: 'Fictional response lost' }).waitFor();
  await page.evaluate(() => { window.topics[1].revision = 9; });
  await page.getByRole('button', { name: 'Refresh Topic workspace' }).click();
  await page.waitForFunction(() => window.pickers.length >= 2);
  assert.equal(await picker.inputValue(), ''); assert.equal(await assign.isDisabled(), true);
  await picker.selectOption('fictional-two'); await assign.click(); await page.waitForFunction(() => window.assignments.length === 2);
  assert.deepEqual(await page.evaluate(() => window.assignments[0]), await page.evaluate(() => window.assignments[1]), 'retry retains original UUID and Topic revision rather than adopting a new base');
  await page.evaluate(() => { window.oldPicker = window.pickers.at(-1); window.topics = [window.topics[0]]; });
  await page.getByRole('button', { name: 'Refresh Topic workspace' }).click();
  await page.waitForFunction(() => window.pickers.at(-1).options.length === 2);
  await page.evaluate(() => window.oldPicker.onSelect('fictional-two'));
  assert.equal(await picker.inputValue(), ''); assert.equal(await assign.isDisabled(), true);
  await picker.selectOption('fictional-one');
  await page.evaluate(() => { window.host.connection.canWrite = false; window.sidebar.update(window.context); });
  await page.waitForFunction(() => document.querySelector('select')?.disabled === true);
  assert.equal(await assign.isDisabled(), true); assert.equal(await page.evaluate(() => window.assignments.length), 2);
  await page.evaluate(() => { window.host.connection.canWrite = true; window.topics = []; window.sidebar.update(window.context); });
  await page.waitForFunction(() => window.pickers.at(-1).options.length === 1);
  assert.equal(await picker.inputValue(), ''); assert.equal(await assign.isDisabled(), true);
  assert.equal(await page.getByLabel('Native draft').inputValue(), 'Fictional draft');
});
