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
      window.requests = []; window.opened = []; window.actionMode = 'success'; window.openLoopActionMode = 'success'; window.activity = []; window.allOpenLoops = [];
      window.openLoops = { total: 0, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, suggestedTotal: 0, deferredTotal: 0, reconciliationTotal: 0 };
      const action = { actionId: 'reminder.complete', label: 'Reminder Complete', kind: 'mutation', target: { topicId: 'fictional-topic', sourceReferenceId: 'fictional-source' }, parameterSchema: { type: 'object', properties: { expectedConfigRevision: { type: 'string' } }, required: ['expectedConfigRevision'], additionalProperties: false }, sideEffects: ['Disables the exact reminder.'], approvalMode: 'preauthorized', idempotency: { idempotent: true, transientRetryable: true } };
      window.cards = ['one', 'two'].map((id) => ({ notificationRecordId: `record-${id}`, episodeId: `episode-${id}`, topicId: 'fictional-topic', sourceReferenceId: 'fictional-source', sourceCapabilityId: 'reminders', sourceRevision: 'source-r1', revision: 3, severity: 'Reminder', state: 'Active', context: `Fictional ${id}`, diagnosis: { reason: '<img src=x onerror=alert(1)>' }, evidenceFacts: { facts: ['Fictional evidence'] }, actions: [action], eligibleSnoozeChoices: [] }));
      let context; let view; let scope;
      const host = { signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: true }, redact: (value) => value,
        subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
        navigation: { openPage: (target) => window.opened.push(target) }, sessions: { openChat: (target) => window.opened.push({ session: target }), open() { throw new Error('Attention must not open arbitrary Sessions'); } },
        ui: { registerPanel: () => () => {}, registerPage: (page) => { pages.set(page.id, page); return () => pages.delete(page.id); }, registerNavigation: () => () => {} },
        request: async (method, params) => {
          window.requests.push({ method, params: structuredClone(params) });
          if (method.endsWith('dashboard.get')) return { result: { attention: structuredClone(window.cards), inProgress: [], openLoops: structuredClone(window.openLoops), activity: { records: structuredClone(window.activity) } } };
          if (method.endsWith('open-loops.get')) {
            const card = [...window.openLoops.highlighted, ...window.openLoops.comingUp].find(item => item.loopId === params.loopId);
            return { result: { schemaVersion: 1, loop: structuredClone(card), evidence: [{ observationId: `evidence-${card.loopId}`, type: card.kind === 'payment' ? 'bill' : 'reply-request', sourceSystem: 'fictional-source', sourceKind: card.kind === 'payment' ? 'email' : 'sms', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:01:00.000Z', historicalBaseline: false, summary: card.title }] } };
          }
          if (method.endsWith('open-loops.list')) {
            const loops = window.allOpenLoops.slice(params.offset, params.offset + params.limit);
            const nextOffset = params.offset + loops.length < window.allOpenLoops.length ? params.offset + loops.length : null;
            return { result: { schemaVersion: 1, loops: structuredClone(loops), total: window.allOpenLoops.length, offset: params.offset, nextOffset, nextCursor: nextOffset === null ? null : loops.at(-1).loopId, hasMore: nextOffset !== null } };
          }
          if (method.endsWith('open-loops.payment-status')) {
            if (window.openLoopActionMode === 'unknown') throw new Error('The transport outcome is unknown.');
            const card = [...window.openLoops.highlighted, ...window.openLoops.comingUp].find(item => item.loopId === params.loopId);
            Object.assign(card, { paymentState: params.paymentState, state: params.paymentState === 'paid' ? 'resolved' : params.paymentState === 'payment-pending' ? 'monitoring' : card.state, revision: card.revision + 1 });
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: structuredClone(card) } };
          }
          if (method.endsWith('open-loops.decide')) {
            const card = [...window.openLoops.highlighted, ...window.openLoops.comingUp].find(item => item.loopId === params.loopId);
            Object.assign(card, { state: 'resolved', revision: card.revision + 1 });
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: structuredClone(card) } };
          }
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
          if (method.endsWith('sessions.resolve-native')) return { result: { sessionKey: 'agent:main:fictional-activity' } };
          throw new Error(`Unexpected method ${method}`);
        } };
      const deactivate = plugin.activate(host);
      if (!pages.has('attention')) throw new Error('First-live activation must register the native Attention destination.');
      window.mountRecord = (record = 'record-one') => {
        scope?.abort(); view?.dispose(); scope = new AbortController();
        context = { host, props: { notificationRecord: record }, signal: scope.signal, presented: true };
        view = mountAttentionPage(document.querySelector('#mount'), context, operations);
      };
      window.mountInbox = () => window.mountRecord(null);
      window.selectRecord = (record) => { context = { ...context, props: { notificationRecord: record } }; view.update(context); };
      window.setPresented = (presented) => { context = { ...context, presented }; view.update(context); };
      window.setAccess = (value) => { host.connection = { ...host.connection, ...value }; for (const fn of subscribers) fn(); };
      window.abortView = () => scope.abort();
      window.shutdown = () => { scope.abort(); view.dispose(); lifetime.abort(); deactivate(); return { pages: pages.size, subscribers: subscribers.size }; };
      window.mountRecord();
    });
    await page.getByRole('heading', { name: 'Fictional one' }).waitFor();
    await run(page);
    for (const request of await page.evaluate(() => window.requests)) if (!request.method.endsWith('sessions.resolve-native')) validateBridgeRequest(request.method, request.params);
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

test('native Attention inbox exposes verified non-Session Activity through its exact Topic', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.activity = [{ activityId: 'activity-source', topicId: 'fictional-topic', sourceReferenceId: 'fictional-source', operationKind: 'reminder.complete', outcome: 'applied', occurredAt: '2035-09-20T04:30:00.000Z', navigation: { kind: 'source', topicId: 'fictional-topic', referenceId: 'fictional-source', sourceKind: 'reminder_schedule', verified: true } }];
    window.mountInbox();
  });
  await page.getByRole('heading', { name: 'Recent Activity' }).waitFor();
  await page.getByRole('button', { name: 'Open Topic', exact: true }).click();
  await page.waitForFunction(() => window.opened.some((target) => target?.id === 'topic'));
  assert.deepEqual(await page.evaluate(() => window.opened.at(-1)), { id: 'topic', params: { topicId: 'fictional-topic' } });
}));

test('native open-loop retry reconciles the same logical operation after an unknown outcome', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoopActionMode = 'unknown';
    window.openLoops = { total: 1, attentionTotal: 1, highlighted: [{ loopId: 'retry-bill', kind: 'payment', title: 'Fictional bill requiring reconciliation.', state: 'confirmed', paymentState: 'unpaid', actions: ['Record payment status'], evidenceCount: 1, revision: 1 }], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  const bill = page.locator('article[data-open-loop-id="retry-bill"]');
  await bill.getByText('Record payment status', { exact: true }).click();
  await bill.getByLabel('Evidence or rationale').fill('Fictional bank evidence.');
  await bill.getByRole('button', { name: 'Save payment status' }).click();
  await page.getByRole('status').filter({ hasText: 'transport outcome is unknown' }).waitFor();
  await page.evaluate(() => { window.openLoopActionMode = 'success'; });
  await bill.getByRole('button', { name: 'Save payment status' }).click();
  await page.getByRole('status').filter({ hasText: 'No payment was submitted.' }).waitFor();
  const ids = await page.evaluate(() => window.requests.filter(request => request.method.endsWith('open-loops.payment-status')).map(request => request.params.logicalOperationId));
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
}));

test('native on-demand inventory pages through every quiet open loop', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.allOpenLoops = Array.from({ length: 25 }, (_, index) => ({ schemaVersion: 1, loopId: `quiet-${index}`, kind: 'order', stableSubjectId: `order:fictional:${index}`, title: `Quiet fictional loose end ${index}`, state: 'monitoring', evidenceObservationIds: [`evidence-${index}`], revision: 1 }));
    window.openLoops = { total: 25, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 25, waiting: window.allOpenLoops.slice(0, 20).map(loop => ({ ...loop, evidenceCount: 1, actions: [] })), suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  await page.getByText('Review all open loops (25)', { exact: true }).click();
  await page.getByRole('button', { name: 'Load open loops' }).click();
  await page.getByRole('button', { name: 'Load more open loops' }).click();
  await page.getByRole('heading', { name: 'Quiet fictional loose end 24' }).waitFor();
  assert.equal(await page.locator('details[data-open-loop-inventory] article').count(), 25);
}));

test('native Attention reviews evidence and records status without paying or sending', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = {
      total: 2,
      attentionTotal: 1,
      highlighted: [{ loopId: 'reply-loop', kind: 'reply', title: 'Confirm the fictional cabinet delivery access window.', state: 'confirmed', reason: 'response-requested', whyNow: 'The source explicitly asks for a response.', actions: ['Open original', 'Draft reply', 'Remind me'], evidenceCount: 1, revision: 1 }, { loopId: 'bill-loop', kind: 'payment', title: 'A fictional renovation progress invoice is ready.', state: 'confirmed', paymentState: 'unpaid', amount: 245000, currency: 'AUD', dueAt: '2026-10-04T13:59:59.000Z', reason: 'due-window', whyNow: 'The accepted payment date is approaching.', actions: ['Open bill', 'Record payment status', 'Remind me'], evidenceCount: 2, revision: 2 }],
      comingUpTotal: 0,
      comingUp: [],
      waitingTotal: 0,
      waiting: [{ loopId: 'waiting-loop', kind: 'order', title: 'Wait for the fictional cabinet delivery.', state: 'monitoring', actions: [], evidenceCount: 2, revision: 2 }],
      suggestedTotal: 0,
      suggested: [],
      deferredTotal: 0,
      deferred: [],
      reconciliationTotal: 0,
      reconciliation: []
    };
    window.mountInbox();
  });
  await page.getByRole('heading', { name: 'Open loops' }).waitFor();
  await page.getByRole('heading', { name: 'Confirm the fictional cabinet delivery access window.' }).waitFor();
  await page.getByText('AUD 2450.00', { exact: false }).waitFor();
  await page.getByText('Waiting (1 shown)', { exact: true }).click();
  await page.getByRole('heading', { name: 'Wait for the fictional cabinet delivery.' }).waitFor();
  await page.getByText('Available actions: Open bill, Record payment status, Remind me.', { exact: true }).waitFor();
  const bill = page.locator('article[data-open-loop-id="bill-loop"]');
  await bill.getByRole('button', { name: 'Review evidence' }).click();
  await bill.getByText('Source evidence', { exact: true }).waitFor();
  await bill.getByText('Record payment status', { exact: true }).click();
  await bill.getByLabel('Evidence or rationale').fill('The fictional bank transfer was initiated; settlement remains pending.');
  await bill.getByRole('button', { name: 'Save payment status' }).click();
  await page.getByRole('status').filter({ hasText: 'No payment was submitted.' }).waitFor();
  const payment = await page.evaluate(() => window.requests.find(request => request.method.endsWith('open-loops.payment-status')).params);
  assert.equal(payment.paymentState, 'payment-pending');
  assert.equal(payment.paidAmount, undefined);
  assert.equal(await page.getByRole('button', { name: /^Pay|^Send$/i }).count(), 0);
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method.endsWith('attention.act')).length), 0);
}));

test('native Attention re-resolves verified Session Activity before opening native Chat', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.activity = [{ activityId: 'activity-session', topicId: 'fictional-topic', sourceReferenceId: 'fictional-source', operationKind: 'conversation.update', outcome: 'applied', navigation: { kind: 'session', topicId: 'fictional-topic', referenceId: 'fictional-source', sessionKey: 'agent:main:stale-is-not-used', sessionId: 'fictional-session-id', verified: true } }];
    window.mountInbox();
  });
  await page.getByRole('button', { name: 'Open Conversation', exact: true }).click();
  await page.waitForFunction(() => window.opened.some((target) => target?.session));
  assert.deepEqual(await page.evaluate(() => window.opened.at(-1)), { session: { sessionKey: 'agent:main:fictional-activity', agentId: 'main' } });
  const request = await page.evaluate(() => window.requests.find((entry) => entry.method.endsWith('sessions.resolve-native')));
  assert.deepEqual(request.params, { schemaVersion: 1, topicId: 'fictional-topic', referenceId: 'fictional-source', expectedSessionId: 'fictional-session-id' });
}));
