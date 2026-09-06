import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

// The production plugin mounts in a real DOM. Only the external native host is
// fictional; no internal UI owner is replaced and no live Gateway is contacted.
async function fixture(run, options = {}) {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional first-live host</title><main id="mount"></main></html>'); return; }
    const file = ['/release-scope.mjs', '/sources/errors.mjs'].includes(req.url) || /^\/native-ui\/[a-z-]+\.mjs$/.test(req.url) ? `../src${req.url}` : null;
    if (!file) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(file, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(4000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const mountFixture = () => page.evaluate(async options => {
      const plugin = (await import('/native-ui/entry.mjs')).default;
      const mount = options.shadow ? document.querySelector('#mount').attachShadow({ mode: 'open' }) : document.querySelector('#mount');
      let lifetime = new AbortController(); const pages = new Map(); const subscribers = new Set();
      const topicId = '11111111-1111-4111-8111-111111111111';
      const topic = { topicId, name: 'Fictional project', revision: 4, usable: true, lifecycle: 'active', sourceReferences: [{ topicId, referenceId: 'folder:fictional', sourceSystem: 'obsidian', sourceKind: 'note_folder' }] };
      window.posts = []; window.requests = []; window.opened = []; window.mode = 'success';
      window.recovery = options.recovery ?? { status: 'clear' };
      window.recoveryUnavailable = options.recoveryUnavailable ?? false;
      window.delayActions = options.delayActions ?? []; window.pendingHttp = [];
      window.notes = Array.from({ length: options.paginated ? 51 : 1 }, (_, index) => ({ path: `note-${index}.md`, revision: 'r1', sourceReference: { topicId, referenceId: `note:${index}` } }));
      window.text = options.large ? 'Large authoritative Note.\n'.repeat(50000) : 'Authoritative Note';
      let view; let context; let scope;
      const host = {
        signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: true }, redact: text => text,
        subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); },
        sessions: { open: value => window.opened.push(value) },
        navigation: { openPage(target) {
          scope?.abort(); view?.dispose(); scope = new AbortController();
          context = { host: { ...host, signal: AbortSignal.any([lifetime.signal, scope.signal]) }, signal: scope.signal, props: target.params ?? {}, presented: true };
          view = pages.get(target.id).mount(mount, context);
        } },
        async request(method, params) {
          window.requests.push({ method, params });
          if (method.endsWith('histories.read')) {
            const offset = params.offset; const end = Math.min(offset + 10, 30);
            return { result: { schemaVersion: 1, historyId: params.historyId, title: 'Fictional preserved history', readOnly: true,
              totalMessages: 30, offset, nextOffset: end < 30 ? end : null, hasMore: end < 30,
              messages: Array.from({ length: end - offset }, (_, index) => ({ messageId: `event-${offset + index}`, author: 'Fictional author',
                bot: false, timestamp: '2026-01-01T00:00:00Z', text: `Preserved message ${offset + index + 1}`, detailsJson: '{}', attachments: [] })) } };
          }
          if (method.endsWith('sources.status')) return { result: { schemaVersion: 1, mode: 'ready', unavailableCapabilities: [] } };
          if (method.endsWith('topics.list')) return { result: { activeGroups: { project: [topic], area: [], resource: [] } } };
          if (method.endsWith('topics.get')) return { result: { topic: window.wrongTopic ? { ...topic, topicId: 'wrong-topic' } : structuredClone(topic) } };
          if (method.endsWith('notes.browse')) {
            if (window.notesUnavailable) throw new Error('Notes are unavailable.');
            const offset = params.offset ?? 0; const next = Math.min(offset + 50, window.notes.length);
            return { result: { notes: window.notes.slice(offset, next), offset, total: window.notes.length, hasMore: next < window.notes.length, nextOffset: next, cursor: 'fictional-cursor' } };
          }
          if (method.endsWith('notes.read')) {
            const note = structuredClone(window.notes.find(note => note.sourceReference.referenceId === params.referenceId));
            const bytes = new TextEncoder().encode(window.text); const end = Math.min(params.offset + 16384, bytes.length);
            const value = { ...note, contentEncoding: 'identity', contentBase64: btoa(String.fromCharCode(...bytes.subarray(params.offset, end))), byteOffset: params.offset, nextOffset: end, totalBytes: bytes.length, complete: end === bytes.length };
            if (window.wrongNote) value.sourceReference.referenceId = 'note:unrelated';
            if (window.delayRead) { window.delayRead = false; await new Promise(resolve => { window.finishRead = resolve; }); }
            return { result: value };
          }
          if (method.endsWith('sessions.browse')) return { result: { topicId, conversations: [{ referenceId: 'session:primary', sessionId: 'primary-id', status: 'open', isPrimary: true }, { referenceId: 'session:new', sessionId: 'new-id', status: 'open', isPrimary: false }] } };
          if (method.endsWith('sessions.navigate')) return { result: { sessionKey: params.referenceId === 'session:primary' ? 'agent:fictional:primary' : 'agent:fictional:new', sessionId: params.referenceId === 'session:primary' ? 'primary-id' : 'new-id', sourceReference: { topicId, referenceId: params.referenceId } } };
          throw new Error(`Unsupported native host call: ${method}`);
        },
        async httpRequest(request, { signal }) {
          const body = JSON.parse(request.body); window.posts.push({ ...request, body });
          if (body.action.startsWith('conversations.creation.')) {
            const current = structuredClone(window.recovery);
            let value;
            if (body.action.endsWith('.inspect')) value = { schemaVersion: 1, ...current, result: { action: body.action, topicId, ...current.result } };
            else if (body.action.endsWith('.reconcile')) value = { schemaVersion: 1, status: window.reconcileStatus ?? 'applied', logicalOperationId: body.logicalOperationId, result: { action: body.action, topicId, referenceId: 'session:new' } };
            else value = { schemaVersion: 1, status: 'acknowledged', logicalOperationId: body.logicalOperationId, result: { action: body.action, topicId, referenceId: body.referenceId } };
            if (window.wrongRecoveryId) value.logicalOperationId = '33333333-3333-4333-8333-333333333333';
            if (window.wrongRecoveryReference) value.result.referenceId = 'session:unrelated';
            if (window.delayActions.includes(body.action)) await new Promise(resolve => { window.pendingHttp.push({ action: body.action, resolve }); });
            if (window.recoveryUnavailable) throw new Error('Recovery unavailable');
            if (body.action.endsWith('.acknowledge')) window.recovery = { status: 'clear' };
            if (body.action.endsWith('.reconcile')) window.recovery = { ...current, status: value.status, result: { ...current.result, referenceId: value.result.referenceId } };
            return { status: 200, body: JSON.stringify(value) };
          }
          if (!window.ignoreClaim) window.recovery = { status: 'unknown', logicalOperationId: body.logicalOperationId, result: { expectedTopicRevision: body.expectedRevision, label: body.label ?? `Topic Conversation ${body.logicalOperationId}` } };
          if (window.mode === 'unknown') throw new Error('Connection lost');
          if (window.mode === 'delay') await new Promise((resolve, reject) => { window.finishPost = resolve; signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
          if (window.mode === 'ignore-abort') await new Promise(resolve => { window.finishPost = resolve; });
          if (!window.ignoreClaim) window.recovery = { ...window.recovery, status: 'applied', result: { ...window.recovery.result, referenceId: 'session:new' } };
          return { status: 200, body: JSON.stringify({ schemaVersion: 1, status: 'applied', logicalOperationId: body.logicalOperationId, result: { action: body.action, topicId: body.topicId, referenceId: 'session:new' } }) };
        },
        ui: { registerPage(page) { pages.set(page.id, page); return () => pages.delete(page.id); }, registerNavigation() { return () => {}; } }
      };
      window.stop = plugin.activate(host); window.registeredPages = [...pages.keys()];
      window.mountDeferredForms = async () => {
        const { createNativeCreationForm, createNativeNoteCreationForm } = await import('/native-ui/creation-form.mjs');
        const { createNativeState } = await import('/native-ui/mutations.mjs');
        const args = { host, state: createNativeState(lifetime.signal), document, signal: lifetime.signal, presented: () => true, onCreated() {} };
        const forms = [createNativeCreationForm(args), createNativeNoteCreationForm({ ...args, getTopic: () => topic })];
        document.querySelector('#mount').replaceChildren(...forms.map(value => value.form));
        for (const value of forms) { value.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); value.sync(); }
      };
      window.navigate = id => host.navigation.openPage({ id, params: { topicId } });
      window.openHistory = historyId => host.navigation.openPage({ id: 'histories', params: { historyId } });
      window.setConnection = patch => { Object.assign(host.connection, patch); for (const fn of subscribers) fn(); };
      window.setPolicy = patch => { Object.assign(topic, patch); window.navigate('topic'); };
      window.setPresented = presented => view.update({ ...context, presented });
      window.reactivate = () => { scope?.abort(); view?.dispose(); window.stop(); lifetime.abort(); lifetime = new AbortController(); host.signal = lifetime.signal; window.stop = plugin.activate(host); window.navigate('topic'); };
      window.dispose = () => { scope?.abort(); view?.dispose(); window.stop(); lifetime.abort(); };
      window.navigate(options.start ?? 'topics');
    }, options);
    await mountFixture();
    await run(page, { reload: async () => { await page.reload(); await mountFixture(); } });
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}

test('Imported History Previous returns to the actual prior byte-limited page', { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => window.openHistory('a'.repeat(64)));
  await page.getByText('Messages 1–10 of 30.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next Messages', exact: true }).click();
  await page.getByText('Messages 11–20 of 30.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next Messages', exact: true }).click();
  await page.getByText('Messages 21–30 of 30.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Previous Messages', exact: true }).click();
  await page.getByRole('button', { name: 'Next Messages', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('status').textContent(), 'Messages 11–20 of 30.');
  await page.getByRole('button', { name: 'Previous Messages', exact: true }).click();
  await page.getByText('Messages 1–10 of 30.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Previous Messages', exact: true }).isDisabled(), true);
}));

test('Conversation creation waits for a current server inspection before enabling a new ID', { timeout: 30000 }, () => fixture(async page => {
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  await page.waitForFunction(() => window.pendingHttp.length === 1);
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body)), [{ schemaVersion: 1, action: 'conversations.creation.inspect', topicId: '11111111-1111-4111-8111-111111111111' }]);
  await page.evaluate(() => window.pendingHttp.shift().resolve());
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
  assert.equal(await page.evaluate(() => window.posts.length), 1);
}, { start: 'topic', delayActions: ['conversations.creation.inspect'] }));

const recoveredCreation = (status) => ({ status, logicalOperationId: '22222222-2222-4222-8222-222222222222',
  result: { expectedTopicRevision: 1, label: 'Original server-owned label', ...(status === 'applied' ? { referenceId: 'session:new' } : {}) } });

test('native shadow form keeps exact keyboard focus through unknown creation, reconciliation and acknowledgement', { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => { window.mode = 'unknown'; });
  const submit = page.getByRole('button', { name: 'Create Conversation', exact: true });
  await submit.focus(); await page.keyboard.press('Enter');
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  const check = page.getByRole('button', { name: 'Check creation outcome', exact: true });
  assert.equal(await check.evaluate(node => node.matches(':focus')), true, 'Unknown creation must retain an exact keyboard recovery path in the native shadow root');
  await page.keyboard.press('Enter');
  const open = page.getByRole('button', { name: 'Open created Conversation', exact: true });
  await open.waitFor();
  assert.equal(await open.evaluate(node => node.matches(':focus')), true, 'Reconciliation must move focus off its now-hidden Check action');
  const acknowledge = page.getByRole('button', { name: 'Acknowledge created Conversation', exact: true });
  await acknowledge.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#mount').shadowRoot.querySelector('button[type=submit]').disabled);
  assert.equal(await submit.evaluate(node => node.matches(':focus')), true, 'Acknowledgement must move focus off its now-hidden action');
}, { start: 'topic', shadow: true }));

test('late recovery settlement does not steal newer keyboard focus in the native shadow root', { timeout: 30000 }, () => fixture(async page => {
  const check = page.getByRole('button', { name: 'Check creation outcome', exact: true });
  await check.waitFor(); await check.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.pendingHttp.length === 1);
  const refresh = page.getByRole('button', { name: 'Refresh Notes', exact: true });
  await refresh.focus();
  await page.evaluate(() => window.pendingHttp.shift().resolve());
  await page.getByRole('button', { name: 'Open created Conversation', exact: true }).waitFor();
  assert.equal(await refresh.evaluate(node => node.matches(':focus')), true);
}, { start: 'topic', shadow: true, recovery: recoveredCreation('unknown'), delayActions: ['conversations.creation.reconcile'] }));

test('a fresh activation recovers original unknown intent and requires explicit reconcile, open and acknowledgement', { timeout: 30000 }, () => fixture(async page => {
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Conversation label' }).inputValue(), 'Original server-owned label');
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect']);
  await page.getByRole('button', { name: 'Check creation outcome', exact: true }).click();
  await page.getByRole('button', { name: 'Open created Conversation', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.opened), []);
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Open created Conversation', exact: true }).click();
  await page.waitForFunction(() => window.opened.length === 1);
  assert.deepEqual(await page.evaluate(() => window.opened[0]), { sessionKey: 'agent:fictional:new', agentId: 'fictional' });
  await page.getByRole('button', { name: 'Acknowledge created Conversation', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
  const posts = await page.evaluate(() => window.posts.map(row => row.body));
  const base = { schemaVersion: 1, topicId: '11111111-1111-4111-8111-111111111111', logicalOperationId: '22222222-2222-4222-8222-222222222222' };
  assert.deepEqual(posts.slice(1), [{ ...base, action: 'conversations.creation.reconcile' }, { ...base, action: 'conversations.creation.acknowledge', referenceId: 'session:new' }]);
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('New deliberate label');
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  await page.waitForFunction(() => window.opened.length === 2);
  const created = await page.evaluate(() => window.posts.at(-1).body);
  assert.equal(created.action, 'conversations.create'); assert.equal(created.expectedRevision, 4);
  assert.notEqual(created.logicalOperationId, base.logicalOperationId);
}, { start: 'topic', recovery: recoveredCreation('unknown') }));

test('document reload recovers a server-owned applied receipt without any browser intent storage', { timeout: 30000 }, () => fixture(async (page, { reload }) => {
  await page.getByRole('button', { name: 'Open created Conversation', exact: true }).waitFor();
  await reload();
  await page.getByRole('button', { name: 'Open created Conversation', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Conversation label' }).inputValue(), 'Original server-owned label');
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect']);
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}, { start: 'topic', recovery: recoveredCreation('applied') }));

test('normal creation keeps an applied receipt across reactivation until explicit acknowledgement', { timeout: 30000 }, () => fixture(async page => {
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('Original new Conversation');
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  await page.waitForFunction(() => window.opened.length === 1);
  const original = await page.evaluate(() => window.posts[1].body);
  await page.evaluate(() => window.reactivate());
  await page.getByRole('button', { name: 'Open created Conversation', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Conversation label' }).inputValue(), original.label);
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect', 'conversations.create', 'conversations.creation.inspect']);
  assert.equal(await page.evaluate(() => window.opened.length), 1);
}, { start: 'topic' }));

for (const unavailable of [false, true]) test(`server ${unavailable ? 'unavailability' : 'foreign ownership'} blocks new creation without automatic actions`, { timeout: 30000 }, () => fixture(async page => {
  await page.getByText(unavailable ? /Creation status is unavailable/ : /blocked by another operator/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Check creation outcome', exact: true }).isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Open created Conversation', exact: true }).isVisible(), false);
  await page.getByRole('button', { name: 'Read note-0.md', exact: true }).click();
  await page.getByRole('region', { name: 'Note content' }).filter({ hasText: 'Authoritative Note' }).waitFor();
  await page.getByRole('button', { name: 'Open Topic in Chat', exact: true }).click();
  await page.waitForFunction(() => window.opened.length === 1);
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect']);
}, { start: 'topic', recovery: { status: 'blocked' }, recoveryUnavailable: unavailable }));

test('a clear inspection cannot release a local dispatch that may claim the server later', { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => { window.ignoreClaim = true; window.mode = 'ignore-abort'; });
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  await page.waitForFunction(() => typeof window.finishPost === 'function');
  const original = await page.evaluate(() => window.posts[1].body);
  await page.evaluate(() => { window.navigate('topics'); window.navigate('topic'); });
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  await page.evaluate(() => window.finishPost());
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect', 'conversations.create', 'conversations.creation.inspect']);
  assert.equal(await page.getByText(new RegExp(original.logicalOperationId)).count(), 1);
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}, { start: 'topic' }));

for (const action of ['inspect', 'reconcile', 'acknowledge']) test(`late ${action} cannot publish after write authority is revoked and restored`, { timeout: 30000 }, () => fixture(async page => {
  if (action !== 'inspect') {
    await page.getByRole('button', { name: action === 'reconcile' ? 'Check creation outcome' : 'Acknowledge created Conversation', exact: true }).click();
  }
  await page.waitForFunction(() => window.pendingHttp.length === 1);
  await page.evaluate(() => { window.setConnection({ canWrite: false }); window.setConnection({ canWrite: true }); window.pendingHttp.shift().resolve(); });
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  if (action === 'reconcile') {
    await page.getByText(/Conversation creation outcome is unknown/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Open created Conversation', exact: true }).isVisible(), false);
  }
  if (action === 'acknowledge') await page.getByRole('button', { name: 'Acknowledge created Conversation', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.posts.length), action === 'inspect' ? 1 : 2);
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}, { start: 'topic', recovery: action === 'inspect' ? { status: 'clear' } : recoveredCreation(action === 'reconcile' ? 'unknown' : 'applied'), delayActions: [`conversations.creation.${action}`] }));

test('a retired activation cannot publish its delayed own receipt into a new foreign-blocked activation', { timeout: 30000 }, () => fixture(async page => {
  await page.waitForFunction(() => window.pendingHttp.length === 1);
  await page.evaluate(() => { window.recovery = { status: 'blocked' }; window.delayActions = []; window.reactivate(); });
  await page.getByText(/blocked by another operator/).waitFor();
  await page.evaluate(() => window.pendingHttp.shift().resolve());
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('textbox', { name: 'Conversation label' }).inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Open created Conversation', exact: true }).isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect', 'conversations.creation.inspect']);
}, { start: 'topic', recovery: recoveredCreation('applied'), delayActions: ['conversations.creation.inspect'] }));

test('an omitted label retains its exact local input while inspecting the server-assigned display label', { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  const original = await page.evaluate(() => window.posts[1].body);
  assert.equal(Object.hasOwn(original, 'label'), false);
  await page.evaluate(() => { window.navigate('topics'); window.navigate('topic'); });
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  await page.waitForFunction(() => document.querySelector('input').value.startsWith('Topic Conversation '));
  await page.evaluate(() => { window.reconcileStatus = 'unknown'; });
  await page.getByRole('button', { name: 'Check creation outcome', exact: true }).click();
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  const posts = await page.evaluate(() => window.posts.map(row => row.body));
  assert.deepEqual(posts.map(row => row.action), ['conversations.creation.inspect', 'conversations.create', 'conversations.creation.inspect', 'conversations.creation.reconcile']);
  assert.deepEqual(posts[1], original);
  assert.deepEqual(posts[3], { schemaVersion: 1, action: 'conversations.creation.reconcile', topicId: original.topicId, logicalOperationId: original.logicalOperationId });
}, { start: 'topic' }));

for (const mismatch of ['Id', 'Reference']) test(`an acknowledgement with the wrong ${mismatch} cannot release creation`, { timeout: 30000 }, () => fixture(async page => {
  await page.getByRole('button', { name: 'Acknowledge created Conversation', exact: true }).waitFor();
  await page.evaluate(mismatch => { window[`wrongRecovery${mismatch}`] = true; }, mismatch);
  await page.getByRole('button', { name: 'Acknowledge created Conversation', exact: true }).click();
  await page.getByText(/The outcome is unknown/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Open created Conversation', exact: true }).isVisible(), true);
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect', 'conversations.creation.acknowledge']);
}, { start: 'topic', recovery: recoveredCreation('applied') }));

test('default native activation exposes existing Topics without Attention or Topic provisioning', { timeout: 30000 }, () => fixture(async page => {
  await page.getByRole('button', { name: 'View Notes for Fictional project' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.registeredPages), ['topics', 'topic', 'histories']);
  assert.equal(await page.locator('form').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Create Topic', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Refresh Topics' }).focus(); await page.keyboard.press('Enter');
  await page.getByText('1 Topics. Conversations open in native Chat.').waitFor();
  assert.deepEqual(await page.evaluate(() => window.posts), []);
}));

test('Notes remain authoritative read-only content without any authoring controls', { timeout: 30000 }, () => fixture(async page => {
  await page.getByRole('button', { name: 'Read note-0.md', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Note content' }).filter({ hasText: 'Authoritative Note' }).waitFor();
  assert.equal(await page.locator('textarea').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Save Note|Check save outcome|Create Note|Discard draft/ }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'New Note path (required)' }).count(), 0);
  await page.getByText('Notes are read-only in this release. Edit them in your external Note application.').waitFor();
  await page.evaluate(() => { window.text = 'Externally updated Note'; window.notes[0].revision = 'r2'; });
  await page.getByRole('button', { name: 'Refresh Notes' }).click();
  await page.getByRole('button', { name: 'Read note-0.md', exact: true }).click();
  await page.getByRole('region', { name: 'Note content' }).filter({ hasText: 'Externally updated Note' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect', 'conversations.creation.inspect']);
}, { start: 'topic' }));

test('deferred form constructors expose no controls or submission effects', { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => window.mountDeferredForms());
  assert.equal(await page.locator('input, textarea, select, button, form').count(), 0);
  await page.getByText('New Topic creation is not available in this release.').waitFor();
  await page.getByText('Note authoring is not available in this release.').waitFor();
  assert.deepEqual(await page.evaluate(() => window.posts), []);
}));

test('keyboard native Chat and Conversation creation remain usable when Notes are unavailable', { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => { window.notesUnavailable = true; window.navigate('topic'); });
  await page.getByText('Notes are unavailable.').waitFor();
  await page.getByRole('button', { name: 'Open Topic in Chat', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.opened.length === 1);
  assert.deepEqual(await page.evaluate(() => window.opened[0]), { sessionKey: 'agent:fictional:primary', agentId: 'fictional' });
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('Fictional follow-up');
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.opened.length === 2);
  const posts = await page.evaluate(() => window.posts);
  assert.deepEqual(posts.map(row => row.body.action), ['conversations.creation.inspect', 'conversations.create']);
  assert.equal(posts[1].method, 'POST'); assert.equal(posts[1].path, '/plugins/command-center/api/topic/actions');
  assert.deepEqual({ ...posts[1].body, logicalOperationId: 'retained-uuid' }, { schemaVersion: 1, logicalOperationId: 'retained-uuid', action: 'conversations.create', topicId: '11111111-1111-4111-8111-111111111111', expectedRevision: 4, label: 'Fictional follow-up' });
  assert.match(posts[1].body.logicalOperationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await page.evaluate(() => window.opened[1]), { sessionKey: 'agent:fictional:new', agentId: 'fictional' });
}));

test('unknown Conversation delivery retains its original submission across scoped remounts and never retries automatically', { timeout: 30000 }, () => fixture(async page => {
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('Original uncertain Conversation');
  await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  const original = await page.evaluate(() => window.posts[1]);
  await page.evaluate(() => { window.navigate('topics'); window.navigate('topic'); window.mode = 'success'; });
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Conversation label' }).inputValue(), 'Original uncertain Conversation');
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText(new RegExp(original.body.logicalOperationId)).count(), 1);
  const posts = await page.evaluate(() => window.posts);
  assert.deepEqual(posts.map(row => row.body.action), ['conversations.creation.inspect', 'conversations.create', 'conversations.creation.inspect']);
  assert.deepEqual(posts[1], original);
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}, { start: 'topic' }));

for (const interruption of ['remount', 'permission']) test(`a late Conversation receipt cannot clear an interrupted submission after ${interruption}`, { timeout: 30000 }, () => fixture(async page => {
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('Original interrupted Conversation');
  await page.evaluate(() => { window.mode = 'ignore-abort'; });
  await page.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  await page.waitForFunction(() => typeof window.finishPost === 'function');
  const original = await page.evaluate(() => window.posts[1]);
  await page.evaluate(interruption => {
    if (interruption === 'remount') { window.navigate('topics'); window.navigate('topic'); }
    else { window.setConnection({ canWrite: false }); window.setConnection({ canWrite: true }); }
  }, interruption);
  await page.getByRole('heading', { name: 'Fictional project', exact: true }).waitFor();
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  await page.evaluate(() => window.finishPost());
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Conversation label' }).inputValue(), 'Original interrupted Conversation');
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText(new RegExp(original.body.logicalOperationId)).count(), 1);
  const posts = await page.evaluate(() => window.posts);
  assert.deepEqual(posts.map(row => row.body.action), ['conversations.creation.inspect', 'conversations.create', ...(interruption === 'remount' ? ['conversations.creation.inspect'] : [])]);
  assert.deepEqual(posts[1], original);
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}, { start: 'topic' }));

test('large Notes and catalog pagination retain exact revision and cursor reads', { timeout: 30000 }, () => fixture(async page => {
  await page.getByRole('button', { name: 'Next Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Read note-50.md', exact: true }).click();
  await page.getByText('Note opened · r1', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Note content' }).textContent(), 'Large authoritative Note.\n'.repeat(50000));
  const requests = await page.evaluate(() => window.requests);
  assert.ok(requests.some(row => row.method.endsWith('notes.browse') && row.params.offset === 50 && row.params.cursor === 'fictional-cursor'));
  const reads = requests.filter(row => row.method.endsWith('notes.read'));
  assert.ok(reads.length > 2);
  assert.ok(reads.every(row => row.params.referenceId === 'note:50' && row.params.path === 'note-50.md' && row.params.observedRevision === 'r1'));
  await page.getByRole('button', { name: 'Previous Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Read note-0.md', exact: true }).waitFor();
  assert.equal(await page.locator('textarea').count(), 0);
}, { start: 'topic', large: true, paginated: true }));

test('wrong Note identity cannot publish content', { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => { window.wrongNote = true; });
  await page.getByRole('button', { name: 'Read note-0.md', exact: true }).click();
  await page.getByText('The exact authoritative Note is unavailable.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Note content' }).textContent(), '');
}, { start: 'topic' }));

for (const interruption of ['permission', 'remount', 'dispose']) test(`a delayed Note cannot publish after ${interruption}`, { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => { window.delayRead = true; });
  await page.getByRole('button', { name: 'Read note-0.md', exact: true }).click();
  await page.waitForFunction(() => typeof window.finishRead === 'function');
  await page.evaluate(interruption => {
    if (interruption === 'permission') window.setConnection({ canRead: false, canWrite: false });
    if (interruption === 'remount') window.navigate('topics');
    if (interruption === 'dispose') window.dispose();
    window.finishRead();
  }, interruption);
  if (interruption === 'permission') await page.getByText('Connect with read access to view Notes.').waitFor();
  if (interruption === 'remount') await page.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
  assert.equal(await page.getByText('Authoritative Note', { exact: true }).count(), 0);
  assert.equal(await page.locator('textarea').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.posts.map(row => row.body.action)), ['conversations.creation.inspect']);
}, { start: 'topic' }));

test('wrong or read-only Topic cannot expose a writable Conversation or native Chat destination', { timeout: 30000 }, () => fixture(async page => {
  await page.evaluate(() => { window.wrongTopic = true; window.navigate('topic'); });
  await page.getByText('The exact Topic is unavailable.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.wrongTopic = false; window.setPolicy({ lifecycle: 'archived', usable: false }); });
  await page.getByRole('button', { name: 'Read note-0.md', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.posts), []);
}));
