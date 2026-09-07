import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { validateBridgeRequest } from '../src/bridge/contracts.mjs';

async function fixture(run) {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional Attention host</title><main id="mount"></main></html>'); return; }
    if (!/^\/[a-z-]+\.mjs$/.test(req.url)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(`../src/native-ui${req.url}`, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(3000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const plugin = (await import('/entry.mjs')).default;
      const { mountAttentionPage } = await import('/attention-page.mjs');
      const operations = new Map();
      const lifetime = new AbortController(); const pages = new Map(); const subscribers = new Set();
      window.requests = []; window.opened = []; window.actionMode = 'success';
      const action = { actionId: 'reminder.complete', label: 'Reminder Complete', kind: 'mutation', target: { topicId: 'fictional-topic', sourceReferenceId: 'fictional-source' }, parameterSchema: { type: 'object', properties: { expectedConfigRevision: { type: 'string' } }, required: ['expectedConfigRevision'], additionalProperties: false }, sideEffects: ['Disables the exact reminder.'], approvalMode: 'preauthorized', idempotency: { idempotent: true, transientRetryable: true } };
      window.cards = ['one', 'two'].map((id) => ({ notificationRecordId: `record-${id}`, episodeId: `episode-${id}`, topicId: 'fictional-topic', sourceReferenceId: 'fictional-source', sourceCapabilityId: 'reminders', sourceRevision: 'source-r1', revision: 3, severity: 'Reminder', state: 'Active', context: `Fictional ${id}`, diagnosis: { reason: '<img src=x onerror=alert(1)>' }, evidenceFacts: { facts: ['Fictional evidence'] }, actions: [action], eligibleSnoozeChoices: [] }));
      let context; let view; let scope;
      const host = { signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: true }, redact: (value) => value,
        subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
        navigation: { openPage: (target) => window.opened.push(target) }, sessions: { open() { throw new Error('Attention must not open arbitrary Sessions'); } },
        ui: { registerPage: (page) => { pages.set(page.id, page); return () => pages.delete(page.id); }, registerNavigation: () => () => {} },
        request: async (method, params) => {
          window.requests.push({ method, params: structuredClone(params) });
          if (method.endsWith('dashboard.get')) return { result: { attention: structuredClone(window.cards), inProgress: [] } };
          if (method.endsWith('attention.get')) {
            const episode = structuredClone(window.cards.find((card) => card.episodeId === params.episodeId));
            if (window.delayGet) { window.delayGet = false; await new Promise((resolve) => { window.finishGet = resolve; }); }
            return { result: { episode } };
          }
          if (method.endsWith('attention.act')) {
            if (window.actionMode === 'unknown') throw new Error('The transport outcome is unknown.');
            if (window.actionMode === 'delay') await new Promise((resolve) => { window.finishAction = resolve; });
            const episode = structuredClone(window.cards.find((card) => card.episodeId === params.episodeId));
            const navigation = window.actionNavigation;
            return { schemaVersion: 1, logicalOperationId: params.logicalOperationId, result: { status: 'applied', episode, ...(navigation ? { navigation } : {}) } };
          }
          if (method.endsWith('topics.get')) return { result: { topic: { topicId: params.topicId } } };
          throw new Error(`Unexpected method ${method}`);
        } };
      const deactivate = plugin.activate(host);
      // Attention is deferred (#224): retain the real page owner's regression
      // tests without claiming it is registered or available in first-live UI.
      if (pages.has('attention')) throw new Error('First-live activation must not register deferred Attention.');
      window.mountRecord = (record = 'record-one') => {
        scope?.abort(); view?.dispose(); scope = new AbortController();
        context = { host, props: { notificationRecord: record }, signal: scope.signal, presented: true };
        view = mountAttentionPage(document.querySelector('#mount'), context, operations);
      };
      window.selectRecord = (record) => { context = { ...context, props: { notificationRecord: record } }; view.update(context); };
      window.setPresented = (presented) => { context = { ...context, presented }; view.update(context); };
      window.setAccess = (value) => { host.connection = { ...host.connection, ...value }; for (const fn of subscribers) fn(); };
      window.abortView = () => scope.abort();
      window.shutdown = () => { scope.abort(); view.dispose(); lifetime.abort(); deactivate(); return { pages: pages.size, subscribers: subscribers.size }; };
      window.mountRecord();
    });
    await page.getByRole('heading', { name: 'Fictional one' }).waitFor();
    await run(page);
    for (const request of await page.evaluate(() => window.requests)) validateBridgeRequest(request.method, request.params);
    assert.deepEqual(await page.evaluate(() => window.shutdown()), { pages: 0, subscribers: 0 });
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
}

test('native Attention resolves the exact server-issued record and renders evidence as text', () => fixture(async (page) => {
  assert.deepEqual(await page.evaluate(() => window.requests.map(({ method, params }) => [method, params.episodeId ?? null])), [['command-center.v1.dashboard.get', null], ['command-center.v1.attention.get', 'episode-one']]);
  await page.getByText('Evidence', { exact: true }).click();
  assert.match(await page.locator('pre').innerText(), /<img src=x/);
  assert.equal(await page.locator('img').count(), 0);
  await page.getByRole('button', { name: 'Reminder Complete', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.requests.some((r) => r.method.endsWith('attention.act')));
  const action = await page.evaluate(() => window.requests.find((r) => r.method.endsWith('attention.act')).params);
  assert.equal(action.episodeId, 'episode-one'); assert.equal(action.expectedEpisodeRevision, 3); assert.equal(action.expectedSourceRevision, 'source-r1');
  assert.deepEqual(action.input, { expectedConfigRevision: 'source-r1' });
}));

test('native Attention never substitutes another card for a missing or duplicate notification record', () => fixture(async (page) => {
  await page.evaluate(() => window.selectRecord('record-missing'));
  await page.getByRole('status').filter({ hasText: 'exact Attention item is no longer available' }).waitFor();
  assert.equal(await page.locator('article').count(), 0);
  await page.evaluate(() => { window.cards.push({ ...window.cards[0] }); window.selectRecord('record-one'); });
  await page.getByRole('status').filter({ hasText: 'exact Attention item is no longer available' }).waitFor();
  assert.equal(await page.locator('article').count(), 0);
}));

test('native Attention ignores an older detail response after selection changes', () => fixture(async (page) => {
  await page.evaluate(() => { window.delayGet = true; window.selectRecord('record-two'); });
  await page.waitForFunction(() => window.finishGet);
  await page.evaluate(() => window.selectRecord('record-one'));
  await page.getByRole('heading', { name: 'Fictional one' }).waitFor();
  await page.evaluate(async () => { window.finishGet(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(await page.getByRole('heading', { name: 'Fictional two' }).count(), 0);
}));

for (const cancellation of ['hidden', 'disconnected', 'permission', 'abort']) test(`native Attention suppresses delayed action navigation after ${cancellation}`, () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards[0].actions = [{ actionId: 'topic.open', label: 'Open Topic', kind: 'navigation', target: { topicId: 'fictional-topic' }, parameterSchema: { type: 'object', properties: {} }, sideEffects: [] }];
    window.actionMode = 'delay'; window.actionNavigation = { actionId: 'topic.open', kind: 'navigation', target: { topicId: 'fictional-topic' } };
    window.mountRecord();
  });
  await page.getByRole('button', { name: 'Open Topic', exact: true }).click();
  await page.waitForFunction(() => window.finishAction);
  await page.evaluate((mode) => { if (mode === 'hidden') window.setPresented(false); else if (mode === 'disconnected') window.setAccess({ connected: false }); else if (mode === 'permission') window.setAccess({ canWrite: false }); else window.abortView(); }, cancellation);
  await page.evaluate(async () => { window.finishAction(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(await page.evaluate(() => window.opened), []);
  if (cancellation === 'hidden') { await page.evaluate(() => window.setPresented(true)); await page.getByRole('heading', { name: 'Fictional one' }).waitFor(); }
}));

test('native Attention approval submits the exact disclosed approval identity', () => fixture(async (page) => {
  await page.evaluate(() => { window.cards[0].actions = [{ actionId: 'approval.approve', label: 'Approve', kind: 'mutation', target: { approvalId: 'approval-fictional', disclosure: { actionId: 'source.fix', parameters: { target: 'fictional-source' }, sideEffects: ['Changes this source only.'] } }, parameterSchema: { type: 'object', properties: {} }, sideEffects: ['Executes the disclosed action.'] }]; window.mountRecord(); });
  await page.getByText('parameters: {"target":"fictional-source"}', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => window.requests.some((r) => r.method.endsWith('attention.act')));
  assert.equal(await page.evaluate(() => window.requests.find((r) => r.method.endsWith('attention.act')).params.approvalId), 'approval-fictional');
}));

test('native Attention retains an unknown operation across remount and reconciles its unchanged identity', () => fixture(async (page) => {
  await page.evaluate(() => { window.actionMode = 'unknown'; });
  await page.getByRole('button', { name: 'Reminder Complete', exact: true }).click();
  await page.getByRole('button', { name: 'Reconcile same action' }).waitFor();
  await page.evaluate(() => window.mountRecord());
  await page.getByRole('button', { name: 'Reconcile same action' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reminder Complete', exact: true }).count(), 0);
  await page.evaluate(() => { window.actionMode = 'success'; });
  await page.getByRole('button', { name: 'Reconcile same action' }).click();
  await page.getByRole('status').filter({ hasText: 'Action applied.' }).waitFor();
  const writes = await page.evaluate(() => window.requests.filter((r) => r.method.endsWith('attention.act')).map((r) => r.params));
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
}));

test('native Attention explicitly leaves global Topic Review decisions unavailable', () => fixture(async (page) => {
  await page.evaluate(() => { window.cards[0].sourceCapabilityId = 'topic-review'; window.cards[0].topicId = null; window.cards[0].sourceReferenceId = null; window.mountRecord(); });
  await page.getByText('Topic Review decisions are not yet available on this native page.', { exact: false }).waitFor();
  assert.equal(await page.locator('form').count(), 0);
  assert.equal(await page.evaluate(() => window.requests.filter((r) => r.method.endsWith('attention.act')).length), 0);
}));
