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
            const card = [...(window.openLoops.highlighted ?? []), ...(window.openLoops.comingUp ?? []), ...(window.openLoops.waiting ?? []), ...(window.openLoops.suggested ?? []), ...(window.openLoops.deferred ?? []), ...(window.openLoops.reconciliation ?? []), ...window.allOpenLoops].find(item => item.loopId === params.loopId);
            return { result: { schemaVersion: 1, loop: structuredClone(card), evidence: [{ observationId: `evidence-${card.loopId}`, type: card.kind === 'payment' ? 'bill' : 'reply-request', sourceSystem: 'fictional-source', sourceKind: card.kind === 'payment' ? 'email' : 'sms', sourceVersion: 'v1', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:01:00.000Z', historicalBaseline: false, summary: card.title, ...(card.requirementId ? { eventKind: 'requirement-recorded', requirementKind: 'purchase', requirementNamespace: 'fictional-home-project', requirementId: card.requirementId } : {}), ...(card.evidence ?? {}) }] } };
          }
          if (method.endsWith('open-loops.list')) {
            const loops = window.allOpenLoops.slice(params.offset, params.offset + params.limit);
            const nextOffset = params.offset + loops.length < window.allOpenLoops.length ? params.offset + loops.length : null;
            return { result: { schemaVersion: 1, loops: structuredClone(loops), total: window.allOpenLoops.length, offset: params.offset, nextOffset, nextCursor: nextOffset === null ? null : loops.at(-1).loopId, hasMore: nextOffset !== null } };
          }
          if (method.endsWith('open-loops.payment-status')) {
            if (window.openLoopActionMode === 'unknown') throw new Error('The transport outcome is unknown.');
            const card = [...(window.openLoops.highlighted ?? []), ...(window.openLoops.comingUp ?? []), ...(window.openLoops.waiting ?? []), ...(window.openLoops.suggested ?? []), ...(window.openLoops.deferred ?? []), ...(window.openLoops.reconciliation ?? []), ...window.allOpenLoops].find(item => item.loopId === params.loopId);
            Object.assign(card, { paymentState: params.paymentState, state: params.paymentState === 'paid' ? 'resolved' : params.paymentState === 'payment-pending' ? 'monitoring' : card.state, revision: card.revision + 1 });
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: structuredClone(card) } };
          }
          if (method.endsWith('open-loops.decide')) {
            const card = [...(window.openLoops.highlighted ?? []), ...(window.openLoops.comingUp ?? []), ...(window.openLoops.waiting ?? []), ...(window.openLoops.suggested ?? []), ...(window.openLoops.deferred ?? []), ...(window.openLoops.reconciliation ?? []), ...window.allOpenLoops].find(item => item.loopId === params.loopId);
            Object.assign(card, { state: params.decision === 'confirm' ? 'confirmed' : params.decision === 'defer' ? 'waiting' : params.decision === 'dismiss' ? 'cancelled' : 'resolved', ...(params.reviewAt ? { reviewAt: params.reviewAt } : {}), revision: card.revision + 1 });
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: structuredClone(card) } };
          }
          if (method.endsWith('open-loops.renovation-decision-revise')) {
            const card = [...(window.openLoops.highlighted ?? []), ...(window.openLoops.reconciliation ?? [])].find(item => item.loopId === params.loopId);
            Object.assign(card, { state: 'resolved', revision: card.revision + 1 });
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: structuredClone(card) } };
          }
          if (method.endsWith('open-loops.renovation-purchase')) {
            const card = [...(window.openLoops.waiting ?? []), ...window.allOpenLoops].find(item => item.loopId === params.loopId);
            Object.assign(card, { state: 'resolved', revision: card.revision + 1 });
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: structuredClone(card) } };
          }
          if (method.endsWith('open-loops.renovation-fulfilment')) {
            const card = [...(window.openLoops.waiting ?? []), ...(window.openLoops.highlighted ?? []), ...window.allOpenLoops].find(item => item.loopId === params.loopId);
            Object.assign(card, { state: params.fulfilment.fulfilmentKind === 'delivered' && params.fulfilment.installationRequired ? 'monitoring' : 'resolved', revision: card.revision + 1 });
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: structuredClone(card) } };
          }
          if (method.endsWith('open-loops.renovation-replacement')) return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: { loopId: 'separate-replacement-follow-up', state: 'confirmed', revision: 1 } } };
          if (method.endsWith('open-loops.renovation-stage')) return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'inserted', observationId: 'fictional-stage-observation' } };
          if (method.endsWith('open-loops.renovation-decision-conflict')) {
            const card = [...(window.openLoops.waiting ?? []), ...(window.openLoops.highlighted ?? []), ...(window.openLoops.reconciliation ?? []), ...window.allOpenLoops].find(item => item.loopId === params.loopId);
            Object.assign(card, { state: params.conflict.recordedChoice === params.conflict.observedChoice ? card.state : 'decision-needed', revision: card.revision + 1 });
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
  const bill = page.locator('article[data-open-loop-id="bill-loop"]');
  await bill.getByRole('button', { name: 'Review evidence' }).click();
  await bill.getByText('Source evidence', { exact: true }).waitFor();
  await bill.getByText('Source: fictional-source · email · v1', { exact: true }).waitFor();
  await bill.getByText('Exact original-source navigation is not available from this item yet.', { exact: false }).waitFor();
  assert.equal(await bill.locator('details[data-open-loop-evidence] pre').count(), 0);
  await bill.getByText('Record payment status', { exact: true }).click();
  await bill.getByLabel('Evidence or rationale').fill('The fictional bank transfer was initiated; settlement remains pending.');
  if (process.env.COMMAND_CENTER_BILL_SCREENSHOT) await page.screenshot({ path: process.env.COMMAND_CENTER_BILL_SCREENSHOT, fullPage: true });
  await bill.getByRole('button', { name: 'Save payment status' }).click();
  await page.getByRole('status').filter({ hasText: 'No payment was submitted.' }).waitFor();
  const payment = await page.evaluate(() => window.requests.find(request => request.method.endsWith('open-loops.payment-status')).params);
  assert.equal(payment.paymentState, 'payment-pending');
  assert.equal(payment.paidAmount, undefined);
  assert.equal(await page.getByRole('button', { name: /^Pay|^Send$/i }).count(), 0);
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method.endsWith('attention.act')).length), 0);
}));

test('native Attention confirms or dismisses suggestions and defers quiet items with exact review times', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = {
      total: 2, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 1,
      waiting: [{ loopId: 'waiting-order', kind: 'order', title: 'Wait for the fictional delivery.', state: 'monitoring', evidenceCount: 1, revision: 2 }],
      suggestedTotal: 1, suggested: [{ loopId: 'suggested-bill', kind: 'payment', title: 'Review a possible fictional bill.', state: 'suggested', paymentState: 'potential', evidenceCount: 1, revision: 1 }],
      deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: []
    };
    window.mountInbox();
  });
  await page.getByText('Suggestions (1 shown)', { exact: true }).click();
  const suggestion = page.locator('article[data-open-loop-id="suggested-bill"]');
  await suggestion.getByText('Review suggestion', { exact: true }).click();
  const suggestionDecision = suggestion.locator('details[data-open-loop-decisions]');
  await suggestionDecision.getByLabel('Rationale', { exact: true }).fill('The exact fictional invoice and account are recognized.');
  await suggestionDecision.getByRole('button', { name: 'Save action' }).click();
  await page.waitForFunction(() => window.requests.some(request => request.method.endsWith('open-loops.decide') && request.params.decision === 'confirm'));

  await page.evaluate(() => window.mountInbox());
  await page.getByText('Waiting (1 shown)', { exact: true }).click();
  const waiting = page.locator('article[data-open-loop-id="waiting-order"]');
  await waiting.getByText('Defer or resolve', { exact: true }).click();
  await waiting.getByLabel('Review time', { exact: true }).fill('2026-10-10T09:30');
  await waiting.getByLabel('Rationale').fill('Review after the fictional supplier update is expected.');
  await waiting.getByRole('button', { name: 'Save action' }).click();
  const deferred = await page.evaluate(() => window.requests.find(request => request.method.endsWith('open-loops.decide') && request.params.decision === 'defer')?.params);
  assert.equal(deferred.reviewAt, new Date('2026-10-10T09:30').toISOString());
}));

test('native Attention records a partial payment amount without claiming settlement', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 1, highlighted: [{ loopId: 'partial-bill', kind: 'payment', title: 'Fictional staged invoice.', state: 'confirmed', paymentState: 'unpaid', amount: 48000, currency: 'AUD', evidenceCount: 1, revision: 1 }], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  const bill = page.locator('article[data-open-loop-id="partial-bill"]');
  await bill.getByText('Record payment status', { exact: true }).click();
  await bill.getByLabel('Status').selectOption('partially-paid');
  await bill.getByLabel('Amount paid').fill('120.50');
  await bill.getByLabel('Currency').fill('aud');
  await bill.getByLabel('Evidence or rationale').fill('A fictional first installment was verified.');
  await bill.getByRole('button', { name: 'Save payment status' }).click();
  const payment = await page.evaluate(() => window.requests.find(request => request.method.endsWith('open-loops.payment-status'))?.params);
  assert.equal(payment.paymentState, 'partially-paid');
  assert.equal(payment.paidAmount, 12050);
  assert.equal(payment.currency, 'AUD');
}));

test('native Attention preserves a corrected calendar due date with the local timezone', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 1, waiting: [{ loopId: 'date-only-order', kind: 'order', title: 'Fictional cabinet delivery.', state: 'monitoring', evidenceCount: 1, revision: 1 }], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  await page.getByText('Waiting (1 shown)', { exact: true }).click();
  const item = page.locator('article[data-open-loop-id="date-only-order"]');
  await item.getByText('Defer or resolve', { exact: true }).click();
  await item.getByLabel('Action').selectOption('correct-date');
  await item.getByLabel('Calendar date only').check();
  await item.getByLabel('Corrected calendar date').fill('2026-10-04');
  await item.getByLabel('Rationale').fill('The fictional supplier committed to a date without a delivery time.');
  await item.getByRole('button', { name: 'Save action' }).click();
  const correction = await page.evaluate(() => window.requests.find(request => request.method.endsWith('open-loops.decide') && request.params.decision === 'correct-date')?.params);
  assert.equal(correction.dueDate, '2026-10-04');
  assert.equal(typeof correction.dueTimeZone, 'string');
  assert.ok(correction.dueTimeZone.length > 0);
  assert.equal(correction.dueAt, undefined);
}));

test('native Attention records an explicit revised renovation decision and preserves prior evidence', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 1, reconciliation: [{ loopId: 'decision-finish', kind: 'decision', stableSubjectId: 'decision:cabinet-finish', title: 'Fictional cabinet finish choice', state: 'decision-needed', whyNow: 'A revised quote names a different finish.', evidenceCount: 2, revision: 2 }] };
    window.mountInbox();
  });
  await page.getByText('Needs reconciliation (1 shown)', { exact: true }).click();
  const decision = page.locator('article[data-open-loop-id="decision-finish"]');
  await decision.getByText('Revise recorded decision', { exact: true }).click();
  await decision.getByLabel('Chosen option').fill('cool white');
  await decision.getByLabel('Rationale').first().fill('The fictional revised quote and room palette were reviewed together.');
  await decision.getByRole('button', { name: 'Record revised decision' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-decision-revise')));
  assert.equal(request.params.chosenOption, 'cool white');
  assert.match(request.params.rationale, /revised quote/);
}));

test('native Attention links an exact renovation purchase only after reviewing requirement evidence', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 1, waiting: [{ loopId: 'buy-mixer-loop', kind: 'general', stableSubjectId: 'renovation-requirement:fictional', title: 'Buy fictional sink mixer', state: 'waiting', requirementId: 'buy-mixer', evidenceCount: 1, revision: 1 }], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  await page.getByText('Waiting (1 shown)', { exact: true }).click();
  const requirement = page.locator('article[data-open-loop-id="buy-mixer-loop"]');
  assert.equal(await requirement.getByText('Confirm exact purchased item', { exact: true }).count(), 0);
  await requirement.getByRole('button', { name: 'Review evidence' }).click();
  await requirement.getByText('Confirm exact purchased item', { exact: true }).click();
  await requirement.getByLabel('Purchase or receipt item ID').fill('receipt-line-mixer-001');
  await requirement.getByRole('button', { name: 'Link purchase to requirement' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-purchase')));
  assert.equal(request.params.reconciliation.requirement.id, 'buy-mixer');
  assert.equal(request.params.reconciliation.purchase.id, 'receipt-line-mixer-001');
  assert.equal(request.params.reconciliation.source.externalId, request.params.logicalOperationId);
}));

test('native Attention records delivery separately from required installation', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 1, waiting: [{ loopId: 'install-oven-loop', kind: 'general', title: 'Install fictional oven', state: 'waiting', requirementId: 'install-oven', evidenceCount: 1, revision: 1, evidence: { eventKind: 'requirement-recorded', requirementKind: 'installation', requirementNamespace: 'fictional-home-project', requirementId: 'install-oven' } }], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  await page.getByText('Waiting (1 shown)', { exact: true }).click();
  const row = page.locator('article[data-open-loop-id="install-oven-loop"]'); await row.getByRole('button', { name: 'Review evidence' }).click(); await row.getByText('Record delivery or installation', { exact: true }).click();
  await row.getByLabel('Outcome').selectOption('delivered'); await row.getByLabel('Installation still required').check(); await row.getByRole('button', { name: 'Record fulfilment' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-fulfilment')));
  assert.equal(request.params.fulfilment.requirement.id, 'install-oven'); assert.equal(request.params.fulfilment.fulfilmentKind, 'delivered'); assert.equal(request.params.fulfilment.installationRequired, true);
}));

test('native Attention creates a separate replacement disposition obligation', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 1, waiting: [{ loopId: 'buy-mixer-replacement-loop', kind: 'general', title: 'Buy fictional sink mixer', state: 'waiting', requirementId: 'buy-mixer', evidenceCount: 1, revision: 1 }], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  await page.getByText('Waiting (1 shown)', { exact: true }).click(); const row = page.locator('article[data-open-loop-id="buy-mixer-replacement-loop"]'); await row.getByRole('button', { name: 'Review evidence' }).click(); await row.getByText('Record replacement follow-up', { exact: true }).click();
  await row.getByLabel('Replacement purchase ID').fill('replacement-mixer-2'); await row.getByLabel('Replaced item ID').fill('faulty-mixer-1'); await row.locator('details[data-renovation-replacement] select').selectOption('return'); await row.getByLabel('Follow-up ID').fill('return-faulty-mixer-1'); await row.getByLabel('Follow-up title').fill('Return fictional faulty mixer'); await row.getByLabel('Deadline').fill('2026-09-27T10:00'); await row.getByRole('button', { name: 'Record replacement and follow-up' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-replacement'))); assert.equal(request.params.replacement.replacementPurchase.id, 'replacement-mixer-2'); assert.equal(request.params.replacement.obligation.id, 'return-faulty-mixer-1'); assert.equal(request.params.replacement.obligation.kind, 'return');
}));

test('native Attention explicitly activates an exact prerequisite stage', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 1, waiting: [{ loopId: 'clear-area-inactive-loop', kind: 'general', title: 'Clear fictional cabinet area', state: 'waiting', evidenceCount: 1, revision: 1, evidence: { eventKind: 'requirement-recorded', requirementKind: 'prerequisite', requirementNamespace: 'fictional-home-project', requirementId: 'clear-area', stageNamespace: 'fictional-home-project', stageId: 'cabinet-installation' } }], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  await page.getByText('Waiting (1 shown)', { exact: true }).click(); const row = page.locator('article[data-open-loop-id="clear-area-inactive-loop"]'); await row.getByRole('button', { name: 'Review evidence' }).click(); await row.getByText('Set exact renovation stage', { exact: true }).click(); await row.getByLabel('Stage state').selectOption('true'); await row.getByRole('button', { name: 'Save stage state' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-stage'))); assert.equal(request.params.activation.stage.id, 'cabinet-installation'); assert.equal(request.params.activation.active, true);
}));

test('native Attention records revised quote evidence without silently changing a decision', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 1, highlighted: [{ loopId: 'decision-capture-loop', kind: 'decision', title: 'Fictional cabinet finish', state: 'resolved', evidenceCount: 1, revision: 1, evidence: { eventKind: 'decision-recorded', decisionId: 'cabinet-finish', chosenOption: 'warm white' } }], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  const row = page.locator('article[data-open-loop-id="decision-capture-loop"]'); await row.getByRole('button', { name: 'Review evidence' }).click(); await row.getByText('Record changed quote or purchase', { exact: true }).click(); await row.getByLabel('Evidence kind').selectOption('revised-quote'); await row.getByLabel('Observed choice').fill('cool white'); await row.getByLabel('Summary').fill('The fictional revised quote names cool white.'); await row.getByRole('button', { name: 'Record evidence for review' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-decision-conflict'))); assert.equal(request.params.conflict.recordedChoice, 'warm white'); assert.equal(request.params.conflict.observedChoice, 'cool white'); assert.equal(request.params.conflict.conflictKind, 'revised-quote');
}));

test('native Attention presents one grouped active-stage review with individual blocker controls', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    const blocker = { loopId: 'clear-area-loop', kind: 'general', title: 'Clear the fictional cabinet work area', state: 'waiting', whyNow: 'This blocks the explicitly activated stage.', evidenceCount: 1, revision: 1 };
    window.openLoops = { total: 1, attentionTotal: 1, highlighted: [], stageReviewTotal: 1, stageReviews: [{ stage: { namespace: 'fictional-home-project', id: 'cabinet-installation' }, items: [blocker] }], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  await page.getByRole('heading', { name: 'Active renovation stage: cabinet-installation' }).waitFor();
  const blocker = page.locator('article[data-open-loop-id="clear-area-loop"]');
  await blocker.getByText('Defer or resolve', { exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Clear the fictional cabinet work area' }).count(), 1);
  if (process.env.COMMAND_CENTER_RENOVATION_SCREENSHOT) await page.screenshot({ path: process.env.COMMAND_CENTER_RENOVATION_SCREENSHOT, fullPage: true });
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
