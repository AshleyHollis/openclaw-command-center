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
      window.requests = []; window.opened = []; window.actionMode = 'success'; window.openLoopActionMode = 'success'; window.quickCaptureMode = 'success'; window.dailyMode = 'success'; window.activity = []; window.allOpenLoops = []; window.intakeResult = null; window.intakeCoverage = []; window.briefings = []; window.briefingHistory = []; window.routineOccurrences = [];
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
          if (method.endsWith('dashboard.get')) return { result: { attention: structuredClone(window.cards), inProgress: [], openLoops: structuredClone(window.openLoops), topics: [{ topicId: 'topic-fictional-renovation', name: 'Fictional renovation', paraCategory: 'project' }], intakeCoverage: structuredClone(window.intakeCoverage), briefings: structuredClone(window.briefings), briefingHistory: structuredClone(window.briefingHistory), routineOccurrences: structuredClone(window.routineOccurrences), activity: { records: structuredClone(window.activity) } } };
          if (method.endsWith('briefings.set-read')) { const item = window.briefingHistory.find(row => row.editionId === params.editionId); item.read = params.read; window.briefings = window.briefingHistory.filter(row => !row.read); if (window.dailyMode === 'unknown-once') { window.dailyMode = 'success'; throw new Error('The transport outcome is unknown.'); } return { result: structuredClone(item) }; }
          if (method.endsWith('routines.decide')) { window.routineOccurrences = window.routineOccurrences.filter(row => !(row.routineId === params.routineId && row.occurrenceDate === params.occurrenceDate)); return { result: { schemaVersion: 1, ...params, revision: params.expectedRevision + 1 } }; }
          if (method.endsWith('topics.list')) return { result: { schemaVersion: 1, activeGroups: { project: [{ topicId: 'topic-fictional-renovation', name: 'Fictional renovation' }], area: [], resource: [] } } };
          if (method.endsWith('notes.browse')) {
            if (window.paginatedDocuments) {
              const final = params.offset === 100;
              const notes = final
                ? [{ schemaVersion: 1, path: 'invoices/page-two.pdf', revision: 'authoritative-page-two', sourceKind: 'document', sourceReference: { referenceId: 'document-page-two', topicId: params.topicId, sourceSystem: 'fictional-documents', sourceKind: 'document' } }]
                : Array.from({ length: 100 }, (_, index) => ({ schemaVersion: 1, path: `archive/document-${index}.pdf`, revision: `authoritative-${index}`, sourceKind: 'document', sourceReference: { referenceId: `document-${index}`, topicId: params.topicId, sourceSystem: 'fictional-documents', sourceKind: 'document' } }));
              return { result: { schemaVersion: 1, notes, total: 101, offset: params.offset, nextOffset: final ? null : 100, hasMore: !final, cursor: 'fictional-document-snapshot' } };
            }
            return { result: { schemaVersion: 1, notes: [{ schemaVersion: 1, path: 'invoices/fictional-progress-invoice.txt', revision: 'authoritative-v1', sourceKind: 'document', sourceReference: { referenceId: 'document-fictional-progress-invoice', topicId: params.topicId, sourceSystem: 'fictional-documents', sourceKind: 'document' } }], total: 1, offset: 0, nextOffset: null, hasMore: false, cursor: 'fictional-document-page' } };
          }
          if (method.endsWith('open-loops.intake-selected')) return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: window.intakeResult ?? { schemaVersion: 1, disposition: 'applied', checkpoint: { schemaVersion: 1 }, freshness: { status: 'available', lastObservedAt: params.selections[0].observedAt }, hasMore: false, results: [{ disposition: 'applied', observationId: 'selected-observation', sourceVersion: 'authoritative-v1', historicalBaseline: false, loop: { loopId: 'selected-loop', kind: 'payment', state: 'confirmed', revision: 1 } }] } };
          if (method.endsWith('notes.create')) return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { status: 'applied', value: { note: { schemaVersion: 1, topicId: params.topicId, path: params.path, revision: 'quick-note-v1', sourceKind: 'note', sourceReference: { referenceId: 'quick-note-reference', topicId: params.topicId, sourceSystem: 'fictional-notes', sourceKind: 'note' } } } } };
          if (method.endsWith('open-loops.capture')) {
            if (window.quickCaptureMode === 'unknown') throw new Error('The transport outcome is unknown.');
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'applied', loop: { schemaVersion: 1, loopId: `captured-${params.captureId}`, kind: 'general', stableSubjectId: `manual-${params.captureId}`, title: params.title, topicId: params.topicId, state: params.captureKind === 'idea' ? 'suggested' : 'confirmed', evidenceObservationIds: ['manual-evidence'], revision: 1 } } };
          }
          if (method.endsWith('open-loops.get')) {
            const card = [...(window.openLoops.highlighted ?? []), ...(window.openLoops.comingUp ?? []), ...(window.openLoops.waiting ?? []), ...(window.openLoops.suggested ?? []), ...(window.openLoops.deferred ?? []), ...(window.openLoops.reconciliation ?? []), ...window.allOpenLoops].find(item => item.loopId === params.loopId);
            const evidence = [{ observationId: `evidence-${card.loopId}`, type: card.kind === 'payment' ? 'bill' : 'reply-request', sourceSystem: 'fictional-source', sourceKind: card.kind === 'payment' ? 'email' : 'sms', sourceVersion: 'v1', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:01:00.000Z', historicalBaseline: false, summary: card.title, ...(card.requirementId ? { eventKind: 'requirement-recorded', requirementKind: 'purchase', requirementNamespace: 'fictional-home-project', requirementId: card.requirementId } : {}), ...(card.evidence ?? {}) }];
            if (card.purchaseId) evidence.push({ observationId: `purchase-${card.loopId}`, type: 'order', sourceSystem: 'fictional-source', sourceKind: 'receipt', sourceVersion: 'v1', occurredAt: '2026-09-20T02:00:00.000Z', observedAt: '2026-09-20T02:01:00.000Z', historicalBaseline: false, eventKind: 'item-purchased', requirementNamespace: 'fictional-home-project', requirementId: card.requirementId, purchaseNamespace: 'fictional-home-project', purchaseId: card.purchaseId });
            if (Array.isArray(card.additionalEvidence)) evidence.push(...structuredClone(card.additionalEvidence));
            return { result: { schemaVersion: 1, loop: structuredClone(card), evidence } };
          }
          if (method.endsWith('open-loops.list')) {
            const loops = window.allOpenLoops.slice(params.offset, params.offset + params.limit);
            const nextOffset = params.offset + loops.length < window.allOpenLoops.length ? params.offset + loops.length : null;
            return { result: { schemaVersion: 1, loops: structuredClone(loops), total: window.allOpenLoops.length, offset: params.offset, nextOffset, nextCursor: nextOffset === null ? null : loops.at(-1).loopId, hasMore: nextOffset !== null } };
          }
          if (method.endsWith('open-loops.organize')) {
            const collections = [window.openLoops.workspace?.today?.mandatory, window.openLoops.workspace?.today?.planned, window.openLoops.workspace?.capacity, window.openLoops.workspace?.review?.batch, ...Object.values(window.openLoops.workspace?.board ?? {})].filter(Array.isArray);
            const card = collections.flat().find(item => item.loopId === params.loopId);
            Object.assign(card, { revision: card.revision + 1, ...(params.action === 'plan' ? { planning: { ...(card.planning ?? {}), plannedAt: params.plannedAt } } : {}), ...(params.action === 'set-priority' ? { planning: { ...(card.planning ?? {}), importance: params.importance, importanceOrigin: 'user' } } : {}) });
            return { schemaVersion: 1, status: 'applied', logicalOperationId: params.logicalOperationId, result: { schemaVersion: 1, disposition: 'updated', loop: structuredClone(card) } };
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
          if (method.endsWith('open-loops.renovation-purchase-correction')) {
            const card = window.allOpenLoops.find(item => item.requirementId === params.correction.requirement.id && item.purchaseId === params.correction.purchase.id);
            Object.assign(card, { state: 'waiting', revision: card.revision + 1 });
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
          if (method.endsWith('topics.get')) return { result: { topic: { topicId: params.topicId, noteFolderReferenceId: 'fictional-note-folder' } } };
          if (method.endsWith('sessions.resolve-native')) return { result: { sessionKey: 'agent:main:fictional-activity' } };
          throw new Error(`Unexpected method ${method}`);
        } };
      const deactivate = plugin.activate(host);
      if (!pages.has('attention') || !pages.has('planner')) throw new Error('First-live activation must register Dashboard and Planner destinations.');
      window.mountRecord = (record = 'record-one') => {
        scope?.abort(); view?.dispose(); scope = new AbortController();
        context = { host, props: { notificationRecord: record }, signal: scope.signal, presented: true };
        view = mountAttentionPage(document.querySelector('#mount'), context, operations);
      };
      window.mountInbox = () => window.mountRecord(null);
      window.mountPlanner = (topicId) => {
        scope?.abort(); view?.dispose(); scope = new AbortController();
        context = { host, props: topicId ? { topicId } : {}, signal: scope.signal, presented: true };
        view = pages.get('planner').mount(document.querySelector('#mount'), context);
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
  assert.equal(await page.locator('article[data-episode-id] form').count(), 0);
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
  await page.getByRole('heading', { name: 'Needs attention' }).waitFor();
  await page.getByRole('heading', { name: 'Confirm the fictional cabinet delivery access window.' }).waitFor();
  await page.getByText('AUD 2450.00', { exact: false }).waitFor();
  await page.getByText('Waiting (1 shown)', { exact: true }).click();
  await page.getByRole('heading', { name: 'Wait for the fictional cabinet delivery.' }).waitFor();
  const bill = page.locator('article[data-open-loop-id="bill-loop"]');
  await bill.getByRole('button', { name: 'Review evidence' }).click();
  await bill.getByText('Source evidence', { exact: true }).waitFor();
  await bill.getByText('Source: fictional-source · email · v1', { exact: true }).waitFor();
  await bill.getByText('This evidence has no currently authorized exact reader destination.', { exact: false }).waitFor();
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

test('native capacity workspace plans the same item without inventing a deadline', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    const card = { loopId: 'capacity-laundry', kind: 'general', title: 'Research laundry storage', state: 'confirmed', evidenceCount: 1, revision: 1, planning: { importance: 'normal', importanceOrigin: 'processing', effortMinutes: 30, contexts: ['home'], dependencies: [], someday: false } };
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [], workspace: { today: { mandatory: [], planned: [] }, upcoming: [], capacity: [card], waiting: [], someday: [], review: { batch: [card], remaining: 0, eligibleTotal: 1 }, board: { ready: [card], doing: [], waiting: [], done: [], suggestions: [] }, agenda: [] } };
    window.mountInbox();
  });
  await page.getByText('When I have capacity (1 total) (1 shown)', { exact: true }).click();
  if (process.env.COMMAND_CENTER_CAPACITY_DESKTOP_SCREENSHOT) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: process.env.COMMAND_CENTER_CAPACITY_DESKTOP_SCREENSHOT, fullPage: true });
  }
  if (process.env.COMMAND_CENTER_CAPACITY_PHONE_SCREENSHOT) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: process.env.COMMAND_CENTER_CAPACITY_PHONE_SCREENSHOT, fullPage: true });
  }
  const card = page.locator('article[data-workspace-loop-id="capacity-laundry"]').first();
  await card.getByLabel('Action').selectOption('plan');
  await card.getByLabel('Date and time').fill('2026-09-21T10:30');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('open-loops.organize')));
  assert.equal(request.params.loopId, 'capacity-laundry');
  assert.equal(request.params.action, 'plan');
  assert.equal(request.params.plannedAt, new Date('2026-09-21T10:30').toISOString());
  assert.equal(request.params.dueAt, undefined);
}));

test('combined Dashboard uses wide Focus and dashboard regions and keeps the Kanban on Planner', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    const card = { loopId: 'dashboard-work', kind: 'general', topicId: 'topic-fictional-renovation', title: 'Review fictional joinery detail', state: 'confirmed', evidenceCount: 1, revision: 1, planning: { importance: 'normal', importanceOrigin: 'processing', contexts: ['home'], dependencies: [], someday: false } };
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [], workspace: { today: { mandatory: [], planned: [] }, upcoming: [], capacity: [card], capacityTotal: 1, waiting: [], someday: [], review: { batch: [card], remaining: 0, eligibleTotal: 1 }, board: { ready: [card], doing: [], waiting: [], done: [], suggestions: [] }, agenda: [] } };
    window.mountInbox();
  });
  await page.getByRole('heading', { name: 'Command Center' }).waitFor();
  assert.equal(await page.locator('.cc-workspace').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 2);
  const columns = await page.locator('.cc-workspace').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').map(parseFloat));
  assert.ok(columns[0] > columns[1]);
  assert.ok(columns[0] / columns[1] > 1.35 && columns[0] / columns[1] < 1.65);
  assert.equal(await page.locator('.cc-page-head').count(), 1);
  assert.equal(await page.locator('.cc-zone-head.cc-module').count(), 0);
  assert.ok(await page.locator('article.cc-work-card[data-workspace-loop-id="dashboard-work"]').count() >= 1);
  assert.ok(await page.locator('.cc-module').first().evaluate(node => parseFloat(getComputedStyle(node).borderRadius)) >= 14);
  await page.getByRole('heading', { name: 'What needs you now' }).waitFor();
  await page.getByRole('heading', { name: 'Context at a glance' }).waitFor();
  await page.getByRole('heading', { name: 'Fictional renovation' }).waitFor();
  await page.getByRole('button', { name: 'View 1 matching item in Planner' }).click();
  assert.deepEqual(await page.evaluate(() => window.opened.at(-1)), { id: 'planner', params: { topicId: 'topic-fictional-renovation' } });
  await page.evaluate(() => window.mountPlanner('topic-fictional-renovation'));
  await page.getByRole('heading', { name: 'Planner for Fictional renovation' }).waitFor();
  assert.equal(await page.locator('article[data-workspace-loop-id="dashboard-work"]').count() > 0, true);
  await page.evaluate(() => window.mountInbox());
  assert.equal(await page.locator('details[data-topic-board]').count(), 0);
  await page.getByRole('button', { name: 'Open Planner' }).click();
  assert.deepEqual(await page.evaluate(() => window.opened.at(-1)), { id: 'planner' });
  await page.evaluate(() => window.mountPlanner());
  await page.getByRole('heading', { name: 'Planner' }).waitFor();
  await page.getByText('Kanban board', { exact: true }).waitFor();
  assert.equal(await page.getByText('Intake coverage', { exact: true }).count(), 0);
}));

test('Dashboard distinguishes disconnected intake from a healthy empty day', () => fixture(async (page) => {
  await page.evaluate(() => window.setAccess({ connected: false }));
  await page.getByRole('heading', { name: 'Command Center is not connected' }).waitFor();
  await page.getByText('Email, Chat and Note processing coverage cannot be checked yet.', { exact: false }).waitFor();
  assert.equal(await page.getByText('Nothing needs you today.', { exact: false }).count(), 0);
  await page.evaluate(() => {
    window.cards = [];
    window.intakeCoverage = [{ source: 'Email intake', sourceKind: 'email', status: 'receipt-current', lastSuccessfulAt: '2026-09-21T01:00:00.000Z' }];
    window.openLoops.workspace = { today: { mandatory: [], planned: [] }, upcoming: [], capacity: [], capacityTotal: 0, waiting: [], someday: [], review: { batch: [], remaining: 0, eligibleTotal: 0 }, board: { ready: [], doing: [], waiting: [], done: [], suggestions: [] }, agenda: [] };
    window.setAccess({ connected: true }); window.mountInbox();
  });
  await page.getByRole('heading', { name: 'What needs you now' }).waitFor();
  await page.getByText('Nothing needs you today.', { exact: false }).waitFor();
  await page.getByRole('status').filter({ hasText: 'Intake coverage is shown in Dashboards.' }).waitFor();
}));

test('Dashboard reads a saved briefing and completes only the current routine occurrence', () => fixture(async (page) => {
  await page.evaluate(() => {
    const briefing = { schemaVersion: 1, briefingId: 'morning', editionId: 'morning:2026-09-22', title: 'Morning briefing', summary: 'Bins tonight and the day ahead.', publishedAt: '2026-09-21T20:30:00.000Z', priority: 100, read: false, source: { kind: 'session', sessionKey: 'agent:main:cron:morning:run:fictional' } };
    window.cards = []; window.briefings = [briefing]; window.briefingHistory = [briefing];
    window.routineOccurrences = [{ schemaVersion: 1, routineId: 'bins', occurrenceDate: '2026-09-22', title: 'Take the bins out', topicId: 'topic-fictional-renovation', sourceReferenceId: 'routine-bins', dueAt: '2026-09-22T08:00:00.000Z', visibleAt: '2026-09-21T08:00:00.000Z', priority: 100, revision: 0, actions: ['complete', 'defer'] }];
    window.mountInbox();
  });
  await page.getByRole('heading', { name: 'Morning briefing' }).waitFor();
  await page.getByText('Bins tonight and the day ahead.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open briefing' }).click();
  assert.deepEqual(await page.evaluate(() => window.opened.at(-1)), { session: { sessionKey: 'agent:main:cron:morning:run:fictional' } });
  await page.getByRole('button', { name: 'Mark read' }).click();
  await page.getByText('No unread briefings.', { exact: false }).waitFor();
  await page.getByText('Read history (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Mark unread' }).click();
  await page.getByRole('heading', { name: 'Morning briefing' }).waitFor();
  await page.getByRole('heading', { name: 'Take the bins out' }).waitFor();
  await page.getByRole('button', { name: 'Open source' }).click();
  assert.deepEqual(await page.evaluate(() => window.opened.at(-1)), { id: 'topic', params: { topicId: 'topic-fictional-renovation', sourceReferenceId: 'routine-bins' } });
  await page.getByRole('button', { name: 'Done' }).click();
  assert.equal(await page.getByRole('heading', { name: 'Take the bins out' }).count(), 0);
  const decision = (await page.evaluate(() => window.requests)).findLast(row => row.method.endsWith('routines.decide'));
  assert.equal(decision.params.occurrenceDate, '2026-09-22');
}));

test('Dashboard retries a lost briefing response with the same logical operation', () => fixture(async (page) => {
  await page.evaluate(() => {
    const briefing = { schemaVersion: 1, briefingId: 'morning', editionId: 'morning:retry', title: 'Retry briefing', summary: 'Fictional retry report.', publishedAt: '2026-09-21T20:30:00.000Z', priority: 100, read: false, source: { kind: 'session', sessionKey: 'agent:main:cron:morning:run:retry' } };
    window.cards = []; window.briefings = [briefing]; window.briefingHistory = [briefing]; window.dailyMode = 'unknown-once'; window.mountInbox();
  });
  const button = page.getByRole('button', { name: 'Mark read' }); await button.click();
  await page.getByRole('status').filter({ hasText: 'transport outcome is unknown' }).waitFor();
  await button.click(); await page.getByText('No unread briefings.', { exact: false }).waitFor();
  const requests = (await page.evaluate(() => window.requests)).filter(row => row.method.endsWith('briefings.set-read'));
  assert.equal(requests.length, 2); assert.equal(requests[0].params.logicalOperationId, requests[1].params.logicalOperationId);
}));

test('rich Dashboard presents a normal day with source-linked work and quiet optional capacity', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    const planning = (importance, effortMinutes) => ({ importance, importanceOrigin: 'processing', effortMinutes, contexts: ['home'], dependencies: [], someday: false });
    const bill = { loopId: 'visual-bill', kind: 'payment', topicId: 'topic-fictional-renovation', sourceLabel: 'Email', title: 'Review the fictional progress invoice', state: 'confirmed', paymentState: 'unpaid', amount: 245000, currency: 'AUD', dueDate: '2026-09-24', dueTimeZone: 'Australia/Brisbane', whyNow: 'The accepted due date is approaching.', evidenceCount: 2, revision: 1, planning: planning('critical', 10) };
    const decision = { loopId: 'visual-decision', kind: 'decision', topicId: 'topic-fictional-renovation', title: 'Choose the fictional cabinet finish', state: 'decision-needed', whyNow: 'A revised quote changed the recorded option.', evidenceCount: 2, revision: 1, planning: planning('high', 15) };
    const reply = { loopId: 'visual-reply', kind: 'response', topicId: 'topic-fictional-renovation', title: 'Confirm access for the fictional builder', state: 'confirmed', whyNow: 'The builder asked for a reply before tomorrow.', evidenceCount: 1, revision: 1, planning: planning('high', 5) };
    const optional = { loopId: 'visual-capacity', kind: 'general', topicId: 'topic-fictional-renovation', title: 'Compare laundry storage options', state: 'confirmed', evidenceCount: 1, revision: 1, planning: planning('low', 30) };
    window.intakeCoverage = [{ source: 'Email intake', sourceKind: 'email', status: 'receipt-current', lastSuccessfulAt: '2026-09-21T01:00:00.000Z' }, { source: 'Chat commitments', sourceKind: 'chat', status: 'receipt-current', lastSuccessfulAt: '2026-09-21T00:55:00.000Z' }, { source: 'Note processing', sourceKind: 'note', status: 'receipt-current', lastSuccessfulAt: '2026-09-21T00:50:00.000Z' }];
    window.openLoops = { total: 4, attentionTotal: 3, highlighted: [bill, decision, reply], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [], workspace: { today: { mandatory: [], planned: [] }, upcoming: [], capacity: [optional], capacityTotal: 1, waiting: [], someday: [], review: { batch: [optional], remaining: 0, eligibleTotal: 1 }, board: { ready: [bill, decision, reply, optional], doing: [], waiting: [], done: [], suggestions: [] }, agenda: [{ at: '2026-09-24T00:00:00.000Z', kind: 'due', item: bill }] } };
    window.mountInbox();
  });
  await page.getByRole('heading', { name: 'Review the fictional progress invoice' }).waitFor();
  assert.ok(await page.getByRole('heading', { name: 'Review the fictional progress invoice' }).evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('[data-workspace-section^="When I have capacity"]')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  await page.getByText('AUD 2450.00', { exact: false }).waitFor();
  await page.getByText('Topic: Fictional renovation · Source: Email', { exact: false }).waitFor();
  await page.getByText('The builder asked for a reply before tomorrow.', { exact: true }).waitFor();
  if (process.env.COMMAND_CENTER_DASHBOARD_1440_SCREENSHOT) { await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: process.env.COMMAND_CENTER_DASHBOARD_1440_SCREENSHOT, fullPage: true }); }
  if (process.env.COMMAND_CENTER_DASHBOARD_1920_SCREENSHOT) { await page.setViewportSize({ width: 1920, height: 1080 }); await page.screenshot({ path: process.env.COMMAND_CENTER_DASHBOARD_1920_SCREENSHOT, fullPage: true }); }
}));

test('busy Dashboard keeps 25 Attention items visible while 200 optional items stay collapsed', () => fixture(async (page) => {
  await page.evaluate(() => {
    const planning = { importance: 'low', importanceOrigin: 'processing', contexts: ['home'], dependencies: [], someday: false };
    window.cards = Array.from({ length: 25 }, (_, index) => ({
      notificationRecordId: `busy-record-${index + 1}`, episodeId: `busy-episode-${index + 1}`,
      topicId: 'topic-fictional-renovation', sourceReferenceId: `busy-source-${index + 1}`,
      sourceCapabilityId: 'reminders', sourceRevision: 'source-r1', revision: 1,
      severity: 'Reminder', state: 'Active', context: `Required item ${index + 1}`, actions: [], eligibleSnoozeChoices: []
    }));
    const optional = Array.from({ length: 200 }, (_, index) => ({
      loopId: `optional-${index + 1}`, kind: 'general', topicId: 'topic-fictional-renovation',
      title: `Optional item ${index + 1}`, state: 'confirmed', evidenceCount: 1, revision: 1, planning
    }));
    window.openLoops = {
      total: 200, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [],
      suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [],
      workspace: { today: { mandatory: [], planned: [] }, upcoming: [], capacity: optional, capacityTotal: 200, waiting: [], someday: [], review: { batch: optional.slice(0, 5), remaining: 195, eligibleTotal: 200 }, board: { ready: optional, doing: [], waiting: [], done: [], suggestions: [] }, agenda: [] }
    };
    window.mountInbox();
  });
  await page.getByRole('button', { name: 'Review Required item 25', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Review Required item /u }).count(), 25);
  const capacity = page.locator('details[data-workspace-section^="When I have capacity"]');
  await capacity.getByText('When I have capacity (200 total) (200 shown)', { exact: true }).waitFor();
  assert.equal(await capacity.evaluate(node => node.open), false);
  assert.equal(await capacity.locator('article[data-workspace-loop-id]').count(), 200);
  assert.equal(await capacity.locator('article[data-workspace-loop-id]:visible').count(), 0);
}));

test('returning after a week shows every overdue, due, decision and accepted review group honestly', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    const planning = { importance: 'normal', importanceOrigin: 'processing', contexts: [], dependencies: [], someday: false };
    const overdue = Array.from({ length: 20 }, (_, index) => ({ loopId: `return-overdue-${index + 1}`, kind: 'general', title: `Overdue item ${index + 1}`, topicId: 'topic-fictional-renovation', state: 'confirmed', dueDate: '2026-09-13', dueTimeZone: 'Australia/Brisbane', evidenceCount: 1, revision: 1, planning }));
    const dueToday = Array.from({ length: 3 }, (_, index) => ({ loopId: `return-today-${index + 1}`, kind: 'response', title: `Due today item ${index + 1}`, topicId: 'topic-fictional-renovation', state: 'confirmed', dueDate: '2026-09-20', dueTimeZone: 'Australia/Brisbane', evidenceCount: 1, revision: 1, planning }));
    const decision = { loopId: 'return-decision', kind: 'decision', title: 'Choose the revised fictional finish', topicId: 'topic-fictional-renovation', state: 'decision-needed', whyNow: 'A choice is required before work can continue.', evidenceCount: 1, revision: 1, planning };
    const review = { loopId: 'return-review', kind: 'general', title: 'Review the parked fictional quote', topicId: 'topic-fictional-renovation', state: 'confirmed', reviewAt: '2026-09-20T08:00:00.000Z', evidenceCount: 1, revision: 1, planning };
    const mandatory = [...overdue, ...dueToday, decision, review];
    window.openLoops = { total: 25, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [], workspace: { today: { mandatory, planned: [], groups: { overdue, dueToday, decisions: [decision], reviews: [review] } }, upcoming: [], capacity: [], capacityTotal: 0, waiting: [], someday: [], review: { batch: [], remaining: 0, eligibleTotal: 0 }, board: { ready: mandatory, doing: [], waiting: [], done: [], suggestions: [] }, agenda: [] } };
    window.mountInbox();
  });
  await page.getByRole('heading', { name: 'Overdue (20)', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Due today (3)', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Decisions and changes (1)', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Accepted reviews (1)', exact: true }).waitFor();
  assert.equal(await page.locator('.cc-focus > article.cc-work-card').count(), 25);
  const decision = page.locator('article[data-workspace-loop-id="return-decision"]');
  await decision.getByText('A choice is required before work can continue.', { exact: false }).waitFor();
  assert.equal(await decision.getByText(/Due /u).count(), 0);
}));

test('a failed producer remains a titled dashboard widget without blanking focused work', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [{ notificationRecordId: 'producer-record', episodeId: 'producer-episode', topicId: 'topic-fictional-renovation', sourceReferenceId: 'producer-source', sourceCapabilityId: 'reminders', sourceRevision: 'source-r1', revision: 1, severity: 'Reminder', state: 'Active', context: 'Review unaffected fictional work', actions: [], eligibleSnoozeChoices: [] }];
    window.intakeCoverage = [{ source: 'Email intake', sourceKind: 'email', status: 'failed', explanation: 'The last bounded producer run failed before publishing a receipt.' }];
    window.mountInbox();
  });
  await page.getByRole('button', { name: 'Review Review unaffected fictional work', exact: true }).waitFor();
  const coverage = page.locator('section[data-dashboard-section="coverage"]');
  await coverage.getByRole('heading', { name: 'Intake coverage', exact: true }).waitFor();
  await coverage.getByRole('heading', { name: 'Email intake', exact: true }).waitFor();
  await coverage.getByText('failed', { exact: true }).waitFor();
  await coverage.getByText('The last bounded producer run failed before publishing a receipt.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'What needs you now', exact: true }).isVisible(), true);
}));

test('Dashboard intake drill-through distinguishes accounted sources, pending decisions and enumeration gaps', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.intakeCoverage = [{
      source: 'Email intake', sourceKind: 'email', status: 'needs-review', lastSuccessfulAt: '2026-09-22T01:02:00.000Z',
      explanation: 'All source outcomes are accounted for, but at least one clarification still needs your decision.',
      sourceCounts: { observed: 1, accounted: 1, resolved: 0 }, outcomeCounts: { expected: 4, accounted: 4, pendingDecisions: 1, failed: 0, unresolvedTopics: 0 },
      recentSources: [{ checkpoint: 'page-2:message-42', accounted: true, resolved: false, counts: { expected: 4, accounted: 4 }, enumeration: { failedReadCount: 1, remainingCount: 3, scanCapReached: true }, outcomes: [
        { outcomeId: 'pay', summary: 'Pay fictional invoice', status: 'applied' }, { outcomeId: 'reply', summary: 'Reply with fictional reference', status: 'applied' }, { outcomeId: 'choose', summary: 'Choose fictional delivery window', status: 'pending-decision' }, { outcomeId: 'reference', summary: 'Retained fictional reference', status: 'quiet' }
      ] }]
    }];
    window.mountInbox();
  });
  const coverage = page.locator('section[data-dashboard-section="coverage"]');
  await coverage.getByText('1 of 1 sources accounted for · 0 resolved · 4 of 4 outcomes accounted for', { exact: true }).waitFor();
  await coverage.getByText('Inspect 1 recent source', { exact: true }).click();
  await coverage.getByText('page-2:message-42', { exact: true }).waitFor();
  await coverage.getByText('1 failed reads · 3 remaining · scan cap reached', { exact: true }).waitFor();
  await coverage.getByText('Choose fictional delivery window: pending-decision', { exact: true }).waitFor();
  await coverage.getByText('Retained fictional reference: quiet', { exact: true }).waitFor();
}));

test('Planner uses the full workspace and exposes every card in real Kanban lanes', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    const ready = Array.from({ length: 25 }, (_, index) => ({ loopId: `planner-ready-${index + 1}`, kind: 'general', topicId: 'topic-fictional-renovation', title: `Ready item ${index + 1}`, state: 'confirmed', evidenceCount: 1, revision: 1, planning: { importance: 'normal', importanceOrigin: 'processing', contexts: [], dependencies: [], someday: false } }));
    window.openLoops = { total: ready.length, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [], workspace: { today: { mandatory: [], planned: [] }, upcoming: [], capacity: ready.slice(0, 20), capacityTotal: ready.length, waiting: [], someday: [], review: { batch: [], remaining: 0, eligibleTotal: 0 }, board: { ready, doing: [], waiting: [], done: [], suggestions: [] }, agenda: [] } };
    window.mountPlanner();
  });
  const workspace = page.locator('.cc-workspace');
  await page.getByText('Kanban board', { exact: true }).waitFor();
  assert.equal(await workspace.getAttribute('data-page-mode'), 'planner');
  assert.equal(await workspace.locator('.cc-dashboards').count(), 0);
  assert.equal(await page.locator('.cc-planner-board').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 5);
  assert.equal(await page.locator('[data-board-lane="ready"] article[data-workspace-loop-id]').count(), 25);
  await page.locator('[data-board-lane="ready"]').getByRole('heading', { name: 'Ready item 25', exact: true }).waitFor();
  if (process.env.COMMAND_CENTER_PLANNER_SCREENSHOT) { await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: process.env.COMMAND_CENTER_PLANNER_SCREENSHOT, fullPage: true }); }
  await page.getByLabel('Search').fill('Ready item 25');
  assert.equal(await page.locator('[data-board-lane="ready"] article[data-workspace-loop-id]:visible').count(), 1);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  assert.equal(await page.locator('section[aria-label="Planner list"] article[data-workspace-loop-id]:visible').count(), 1);
  assert.equal(await page.locator('details[data-topic-board]').isHidden(), true);
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  assert.equal(await page.locator('details[data-agenda]').isVisible(), true);
  await page.getByLabel('Search').focus();
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh Planner').click());
  await page.getByLabel('Search').waitFor();
  assert.equal(await page.getByLabel('Search').inputValue(), 'Ready item 25');
  assert.equal(await page.getByLabel('Search').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('details[data-agenda]').isVisible(), true);
  assert.equal(await page.locator('section[aria-label="Planner list"]').isHidden(), true);
}));

test('Topic mini dashboard counts the complete board rather than its capacity preview', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    const ready = Array.from({ length: 25 }, (_, index) => ({ loopId: `topic-count-${index + 1}`, kind: 'general', topicId: 'topic-fictional-renovation', title: `Topic item ${index + 1}`, state: 'confirmed', evidenceCount: 1, revision: 1, planning: { importance: 'low', importanceOrigin: 'processing', contexts: [], dependencies: [], someday: false } }));
    window.openLoops = { total: ready.length, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [], workspace: { today: { mandatory: [], planned: [] }, upcoming: [], capacity: ready.slice(0, 20), capacityTotal: ready.length, waiting: [], someday: [], review: { batch: [], remaining: 0, eligibleTotal: 0 }, board: { ready, doing: [], waiting: [], done: [], suggestions: [] }, agenda: [] } };
    window.mountInbox();
  });
  await page.getByText('25 current items across the complete workspace board.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'View 25 matching items in Planner', exact: true }).waitFor();
}));

test('Dashboard quick capture saves notes quietly without turning them into obligations', () => fixture(async (page) => {
  await page.evaluate(() => { window.cards = []; window.mountInbox(); });
  const quick = page.locator('section[data-quick-capture]');
  await quick.getByLabel('What should be remembered?').fill('Call the fictional cabinet maker');
  await quick.getByRole('button', { name: 'Capture', exact: true }).click();
  await page.getByText('Task captured and acknowledged.', { exact: true }).waitFor();
  const captured = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('open-loops.capture')));
  assert.equal(captured.params.captureKind, 'task');
  assert.equal(captured.params.topicId, 'topic-fictional-renovation');
  assert.equal(captured.params.title, 'Call the fictional cabinet maker');
  assert.match(captured.params.captureId, /^[0-9a-f-]{36}$/u);

  const nextQuick = page.locator('section[data-quick-capture]');
  await nextQuick.getByLabel('Type').selectOption('note');
  await nextQuick.getByLabel('What should be remembered?').fill('Fictional splashback colour reference');
  const obligationCountBefore = await page.evaluate(() => window.requests.filter(entry => entry.method.endsWith('open-loops.capture')).length);
  await nextQuick.getByRole('button', { name: 'Save note' }).click();
  await page.getByText('Note saved quietly in the Topic. No obligation was created.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.requests.filter(entry => entry.method.endsWith('open-loops.capture')).length), obligationCountBefore);
  const note = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('notes.create')).params);
  assert.equal(note.topicId, 'topic-fictional-renovation');
  assert.equal(note.referenceId, 'fictional-note-folder');
  assert.match(note.path, /^Inbox\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/u);
  assert.equal(note.text, '# Fictional splashback colour reference\n');
}));

test('Dashboard quick capture preserves one retry identity across an ambiguous remount', () => fixture(async (page) => {
  await page.evaluate(() => { window.cards = []; window.quickCaptureMode = 'unknown'; window.mountInbox(); });
  const quick = page.locator('section[data-quick-capture]');
  await quick.getByLabel('What should be remembered?').fill('Confirm the fictional site measure');
  await quick.getByRole('button', { name: 'Capture', exact: true }).click();
  await page.getByText('The transport outcome is unknown.', { exact: true }).waitFor();
  const first = await page.evaluate(() => window.requests.filter(entry => entry.method.endsWith('open-loops.capture')).at(-1).params);
  await page.evaluate(() => { window.quickCaptureMode = 'success'; window.mountInbox(); });
  const remounted = page.locator('section[data-quick-capture]');
  assert.equal(await remounted.getByLabel('What should be remembered?').inputValue(), 'Confirm the fictional site measure');
  await remounted.getByRole('button', { name: 'Retry capture', exact: true }).click();
  await page.getByText('Task captured and acknowledged.', { exact: true }).waitFor();
  const second = await page.evaluate(() => window.requests.filter(entry => entry.method.endsWith('open-loops.capture')).at(-1).params);
  assert.equal(second.logicalOperationId, first.logicalOperationId);
  assert.equal(second.captureId, first.captureId);
  assert.equal(second.capturedAt, first.capturedAt);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('command-center.quick-capture.v1')).operation), undefined);
}));

test('Dashboard preferences persist section visibility across a remount', () => fixture(async (page) => {
  await page.evaluate(() => { window.cards = []; window.mountInbox(); });
  await page.getByText('Customize dashboards', { exact: true }).click();
  await page.getByLabel('Intake coverage', { exact: true }).uncheck();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('command-center.dashboard.preferences.v1')).hidden.includes('coverage'));
  await page.evaluate(() => window.mountInbox());
  await page.getByRole('heading', { name: 'Context at a glance' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Intake coverage' }).isHidden(), true);
}));

test('Dashboard shows receipt-backed document coverage separately from unknown email intake', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.intakeCoverage = [
      { source: 'Email intake', sourceKind: 'email', status: 'unknown', explanation: 'No maintained email-intake receipt is available.' },
      { source: 'Selected documents', sourceKind: 'document', status: 'receipt-current', lastSuccessfulAt: '2026-09-20T01:00:00.000Z', explanation: 'The selected read was acknowledged.' }
    ];
    window.mountInbox();
  });
  const coverage = page.locator('section[data-dashboard-section="coverage"]');
  await coverage.getByRole('heading', { name: 'Email intake' }).waitFor();
  await coverage.getByText('unknown', { exact: true }).waitFor();
  await coverage.getByText(/receipt-current · Last successful/u).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#mount').evaluate(node => parseFloat(getComputedStyle(node).paddingInlineStart) >= 48), true);
}));

test('Dashboard states the accepted past deadline instead of fabricating a new date', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    const overdue = { loopId: 'overdue-fictional', kind: 'general', topicId: 'topic-fictional-renovation', title: 'Pay fictional council fee', state: 'confirmed', dueDate: '2026-09-10', dueTimeZone: 'Australia/Brisbane', evidenceCount: 1, revision: 1, planning: { importance: 'high', contexts: [], dependencies: [], someday: false } };
    window.openLoops = { total: 1, attentionTotal: 1, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [], workspace: { today: { mandatory: [overdue], groups: { overdue: [overdue], dueToday: [], decisions: [], reviews: [] }, planned: [] }, upcoming: [], capacity: [], capacityTotal: 0, waiting: [], someday: [], review: { batch: [], remaining: 0, eligibleTotal: 0 }, board: { ready: [overdue], doing: [], waiting: [], done: [], suggestions: [] }, agenda: [] } };
    window.mountInbox();
  });
  await page.getByText(/Overdue since 2026-09-10 \(Australia\/Brisbane, calendar date\)/u).waitFor();
  assert.equal(await page.getByText(/Due today/u).count(), 0);
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

test('native Attention browses one authorized document and submits only its exact reference', () => fixture(async (page) => {
  await page.evaluate(() => window.mountInbox());
  await page.getByText('Import one selected document', { exact: true }).click();
  await page.getByRole('button', { name: 'Load authorized documents' }).click();
  await page.getByLabel('Document date').fill('2026-09-20T09:00');
  await page.getByLabel('Historical baseline through').fill('2026-09-01T00:00');
  await page.getByRole('button', { name: 'Import selected document' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('open-loops.intake-selected')));
  assert.deepEqual(request.params.authorization, { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document-fictional-progress-invoice' });
  assert.equal(request.params.authorization.scopeId, undefined);
  assert.equal(request.params.selections[0].path, 'invoices/fictional-progress-invoice.txt');
  assert.equal(request.params.selections[0].content, undefined);
  assert.equal(request.params.selections[0].version, undefined);
}));

test('native Attention opens exact authorized document evidence and carries its evidence version', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 1, highlighted: [{ loopId: 'document-bill', kind: 'payment', topicId: 'topic-fictional-renovation', title: 'Fictional document bill', state: 'confirmed', paymentState: 'unpaid', actions: ['Open original'], evidenceCount: 1, revision: 1, evidence: { sourceKind: 'document', sourceAvailable: true, topicId: 'topic-fictional-renovation', sourceReferenceId: 'document-fictional-progress-invoice', sourcePath: 'invoices/fictional-progress-invoice.pdf', sourceVersion: 'sha256:evidence-version' } }], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  const bill = page.locator('article[data-open-loop-id="document-bill"]');
  await bill.getByRole('button', { name: 'Review evidence' }).click();
  await bill.getByRole('button', { name: 'Open original' }).click();
  assert.deepEqual(await page.evaluate(() => window.opened.at(-1)), { id: 'topic', params: { topicId: 'topic-fictional-renovation', sourceReferenceId: 'document-fictional-progress-invoice', sourcePath: 'invoices/fictional-progress-invoice.pdf', evidenceSourceVersion: 'sha256:evidence-version' } });
}));

test('native Attention retrieves the complete authorized document catalog before selection', () => fixture(async (page) => {
  await page.evaluate(() => { window.paginatedDocuments = true; window.mountInbox(); });
  await page.getByText('Import one selected document', { exact: true }).click();
  await page.getByRole('button', { name: 'Load authorized documents' }).click();
  await page.locator('details').filter({ hasText: 'Import one selected document' }).locator('select').nth(1).selectOption({ label: 'invoices/page-two.pdf' });
  await page.getByLabel('Document date').fill('2026-09-20T09:00');
  await page.getByLabel('Historical baseline through').fill('2026-09-01T00:00');
  await page.getByRole('button', { name: 'Import selected document' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('open-loops.intake-selected')));
  assert.equal(request.params.authorization.resourceId, 'document-page-two');
  const pages = await page.evaluate(() => window.requests.filter(entry => entry.method.endsWith('notes.browse')).map(entry => entry.params.offset));
  assert.deepEqual(pages, [0, 100]);
}));

test('native Attention reports when a selected document matches no supported obligation', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.intakeResult = { schemaVersion: 1, disposition: 'applied', checkpoint: { schemaVersion: 1 }, freshness: { status: 'available', lastObservedAt: '2026-09-20T00:01:00.000Z' }, hasMore: false, results: [] };
    window.mountInbox();
  });
  await page.getByText('Import one selected document', { exact: true }).click();
  await page.getByRole('button', { name: 'Load authorized documents' }).click();
  await page.getByLabel('Document date').fill('2026-09-20T09:00');
  await page.getByLabel('Historical baseline through').fill('2026-09-01T00:00');
  await page.getByRole('button', { name: 'Import selected document' }).click();
  await page.getByRole('status').filter({ hasText: 'no supported obligation was recognized' }).waitFor();
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

test('native Attention corrects an exact purchase relationship from the full inventory', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.allOpenLoops = [{ loopId: 'resolved-buy-mixer-loop', kind: 'general', stableSubjectId: 'renovation-requirement:fictional', title: 'Buy fictional sink mixer', state: 'resolved', requirementId: 'buy-mixer', purchaseId: 'wrong-receipt-line', evidenceObservationIds: ['requirement', 'purchase'], revision: 2 }];
    window.mountInbox();
  });
  await page.getByText('Review all open loops (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Load open loops' }).click();
  const row = page.locator('article[data-open-loop-id="resolved-buy-mixer-loop"]');
  await row.getByRole('button', { name: 'Review evidence' }).click();
  await row.getByText('Correct purchased item relationship', { exact: true }).click();
  await row.getByLabel('Rationale').fill('The fictional receipt line belongs to a different mixer.');
  await row.getByRole('button', { name: 'Unlink purchase and reopen requirement' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-purchase-correction')));
  assert.equal(request.params.correction.requirement.id, 'buy-mixer');
  assert.equal(request.params.correction.purchase.id, 'wrong-receipt-line');
  assert.match(request.params.correction.rationale, /different mixer/);
}));

test('native Attention corrects an active purchase after a newer link was already corrected', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.allOpenLoops = [{ loopId: 'resolved-multi-purchase-loop', kind: 'general', stableSubjectId: 'renovation-requirement:multi', title: 'Buy fictional basin', state: 'resolved', requirementId: 'buy-basin', purchaseId: 'active-receipt-a', revision: 4, additionalEvidence: [
      { observationId: 'purchase-b', type: 'order', sourceSystem: 'fictional-source', sourceKind: 'receipt', sourceVersion: 'v2', occurredAt: '2026-09-20T03:00:00.000Z', observedAt: '2026-09-20T03:01:00.000Z', historicalBaseline: false, eventKind: 'item-purchased', requirementNamespace: 'fictional-home-project', requirementId: 'buy-basin', purchaseNamespace: 'fictional-home-project', purchaseId: 'corrected-receipt-b' },
      { observationId: 'correction-b', type: 'order', sourceSystem: 'command-center', sourceKind: 'explicit-purchase-relationship-correction', sourceVersion: 'operator-v1', occurredAt: '2026-09-20T04:00:00.000Z', observedAt: '2026-09-20T04:00:00.000Z', historicalBaseline: false, eventKind: 'purchase-relationship-corrected', requirementNamespace: 'fictional-home-project', requirementId: 'buy-basin', purchaseNamespace: 'fictional-home-project', purchaseId: 'corrected-receipt-b' }
    ] }];
    window.mountInbox();
  });
  await page.getByText('Review all open loops (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Load open loops' }).click();
  const row = page.locator('article[data-open-loop-id="resolved-multi-purchase-loop"]');
  await row.getByRole('button', { name: 'Review evidence' }).click();
  await row.getByText('Correct purchased item relationship', { exact: true }).click();
  await row.getByLabel('Rationale').fill('The older active receipt also belongs elsewhere.');
  await row.getByRole('button', { name: 'Unlink purchase and reopen requirement' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-purchase-correction')));
  assert.equal(request.params.correction.purchase.id, 'active-receipt-a');
}));

test('native Attention can correct a purchase that was explicitly relinked after correction', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 0, waiting: [], suggestedTotal: 0, deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    const link = (observationId, eventKind, sourceVersion, occurredAt) => ({ observationId, type: 'order', sourceSystem: 'fictional-source', sourceKind: 'receipt', sourceVersion, occurredAt, observedAt: occurredAt, historicalBaseline: false, eventKind, requirementNamespace: 'fictional-home-project', requirementId: 'buy-tap', purchaseNamespace: 'fictional-home-project', purchaseId: 'receipt-a' });
    window.allOpenLoops = [{ loopId: 'resolved-relinked-purchase-loop', kind: 'general', stableSubjectId: 'renovation-requirement:relinked', title: 'Buy fictional tap', state: 'resolved', requirementId: 'buy-tap', purchaseId: 'receipt-a', revision: 4, additionalEvidence: [link('relinked-a', 'item-purchased', 'v3', '2026-09-20T04:00:00.000Z'), link('correction-a', 'purchase-relationship-corrected', 'v2', '2026-09-20T03:00:00.000Z')] }];
    window.mountInbox();
  });
  await page.getByText('Review all open loops (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Load open loops' }).click();
  const row = page.locator('article[data-open-loop-id="resolved-relinked-purchase-loop"]');
  await row.getByRole('button', { name: 'Review evidence' }).click();
  await row.getByText('Correct purchased item relationship', { exact: true }).click();
  await row.getByLabel('Rationale').fill('The explicitly relinked receipt is still incorrect.');
  await row.getByRole('button', { name: 'Unlink purchase and reopen requirement' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-purchase-correction')));
  assert.equal(request.params.correction.purchase.id, 'receipt-a');
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

test('native Attention records a partial renovation delivery with exact outstanding items', () => fixture(async (page) => {
  await page.evaluate(() => {
    window.cards = [];
    window.openLoops = { total: 1, attentionTotal: 0, highlighted: [], comingUpTotal: 0, comingUp: [], waitingTotal: 1, waiting: [{ loopId: 'tap-order-loop', kind: 'general', title: 'Await fictional tap order', state: 'waiting', evidenceCount: 1, revision: 1, evidence: { eventKind: 'requirement-recorded', requirementKind: 'purchase', requirementNamespace: 'fictional-home-project', requirementId: 'tap-order-17' } }], suggestedTotal: 0, suggested: [], deferredTotal: 0, deferred: [], reconciliationTotal: 0, reconciliation: [] };
    window.mountInbox();
  });
  await page.getByText('Waiting (1 shown)', { exact: true }).click();
  const row = page.locator('article[data-open-loop-id="tap-order-loop"]'); await row.getByRole('button', { name: 'Review evidence' }).click(); await row.getByText('Record delivery or installation', { exact: true }).click();
  await row.getByLabel('Delivered item IDs').fill('tap-body, tap-hose'); await row.getByLabel('Outstanding item IDs').fill('tap-handle'); await row.getByLabel('Corrected expected time').fill('2026-09-25T09:00'); await row.getByLabel('Update note').fill('Two fictional items were checked against the packing slip.'); await row.getByRole('button', { name: 'Record fulfilment' }).click();
  const request = await page.evaluate(() => window.requests.find(entry => entry.method.endsWith('renovation-fulfilment')));
  assert.deepEqual(request.params.fulfilment.fulfilledItemIds, ['tap-body', 'tap-hose']); assert.deepEqual(request.params.fulfilment.outstandingItemIds, ['tap-handle']); assert.equal(request.params.fulfilment.expectedAt, new Date('2026-09-25T09:00').toISOString());
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
