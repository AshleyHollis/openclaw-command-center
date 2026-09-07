import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { FIRST_LIVE_FEATURES } from '../src/native-ui/release-scope.mjs';

// ADR 0004: preserve held feature tests without pretending they qualify the
// first-live UI. No retained Conversation, read-only Note or denial test skips.
const noteAuthoring = { timeout: 30000, skip: !FIRST_LIVE_FEATURES.noteWrite && 'Deferred #220: Note editing/creation; not first-live acceptance.' };
const topicProvisioning = { timeout: 30000, skip: !FIRST_LIVE_FEATURES.topicProvisioning && 'Deferred #221: Topic creation; not first-live acceptance.' };

async function fixture(run) {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional native host</title><main id="mount"></main></html>'); return; }
    if (!/^\/[a-z-]+\.mjs$/.test(req.url)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(`../src/native-ui${req.url}`, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const plugin = (await import('/entry.mjs')).default;
      const lifetime = new AbortController(); const registrations = new Map(); const subscribers = new Set();
      window.posts = []; window.requests = []; window.opened = []; window.mode = 'success';
      window.recovery = { status: 'clear' };
      window.notes = [{ path: 'brief.md', revision: 'r1', text: 'Authoritative brief', sourceReference: { topicId: '11111111-1111-4111-8111-111111111111', referenceId: 'note:brief' } }, { path: 'other.md', revision: 'r1', text: 'Other Note', sourceReference: { topicId: '11111111-1111-4111-8111-111111111111', referenceId: 'note:other' } }];
      const topic = { topicId: '11111111-1111-4111-8111-111111111111', name: 'Fictional project', revision: 4, usable: true, lifecycle: 'active', sourceReferences: [{ topicId: '11111111-1111-4111-8111-111111111111', referenceId: 'folder:fictional', sourceSystem: 'obsidian', sourceKind: 'note_folder' }] };
      let view; let context; let scope;
      const host = {
        signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: true }, redact: (text) => text,
        subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
        sessions: { open: (value) => window.opened.push(value) },
        navigation: { openPage: (target) => {
          scope?.abort(); view?.dispose(); scope = new AbortController();
          // The real host creates a distinct authority object for each mounted view.
          const scopedHost = { ...host, signal: AbortSignal.any([lifetime.signal, scope.signal]) };
          context = { host: scopedHost, signal: scope.signal, props: target.params ?? {}, presented: true };
          view = registrations.get(target.id).mount(document.querySelector('#mount'), context);
        } },
        request: async (method, params) => {
          window.requests.push({ method, params: structuredClone(params) });
          if (method.endsWith('sources.status')) return { result: { schemaVersion: 1, mode: 'ready', unavailableCapabilities: [] } };
          if (method.endsWith('sessions.create')) {
            window.recovery = { status: 'unknown', logicalOperationId: params.logicalOperationId,
              result: { expectedTopicRevision: params.expectedRevision, label: params.label ?? `Topic Conversation ${params.logicalOperationId}` } };
            return { result: { key: 'agent:fictional:new', sessionId: 'new-session', revision: 'fictional-session-revision' } };
          }
          if (method.endsWith('topics.get')) {
            if (window.delayTopic) { window.delayTopic = false; await new Promise((resolve) => { window.finishTopic = resolve; }); }
            return { result: { topic } };
          }
          if (method.endsWith('topics.list')) return { result: { activeGroups: { project: [topic], area: [], resource: [] } } };
          if (method.endsWith('notes.browse')) {
            if (window.notesUnavailable) throw new Error('Notes capability is unavailable.');
            const notes = structuredClone(window.notes);
            if (window.delayBrowse) { window.delayBrowse = false; await new Promise((resolve) => { window.finishBrowse = resolve; (window.finishBrowses ??= []).push(resolve); }); }
            return { result: { notes, total: notes.length, offset: 0, hasMore: false, nextOffset: null } };
          }
          if (method.endsWith('notes.read')) {
            const note = window.notes.find((note) => note.sourceReference.referenceId === params.referenceId);
            const bytes = new TextEncoder().encode(note.text);
            return { result: { ...note, contentEncoding: 'identity', contentBase64: btoa(String.fromCharCode(...bytes)), byteOffset: 0, nextOffset: bytes.length, totalBytes: bytes.length, complete: true } };
          }
          if (method.endsWith('sessions.browse')) return { result: { topicId: topic.topicId, conversations: [{ referenceId: 'session:primary', sessionId: 'primary-session', status: 'open', isPrimary: true }, { referenceId: 'session:new', sessionId: 'new-session', status: 'open', isPrimary: false }] } };
          if (method.endsWith('sessions.navigate')) {
            if (window.navigationFailure) throw new Error('Native Chat is temporarily unavailable.');
            return { result: { sessionKey: params.referenceId === 'session:primary' ? 'agent:fictional:primary' : 'agent:fictional:new', sessionId: params.referenceId === 'session:primary' ? 'primary-session' : 'new-session', sourceReference: { topicId: topic.topicId, referenceId: params.referenceId } } };
          }
          throw new Error(`Unexpected method: ${method}`);
        },
        httpRequest: async (request, { signal }) => {
          const body = JSON.parse(request.body); window.posts.push({ ...request, body });
          // Model the current server receipt protocol separately from original
          // dispatch. Inspection remains available while a dispatch is delayed.
          if (body.action.startsWith('conversations.creation.')) {
            const current = structuredClone(window.recovery);
            let value;
            if (body.action.endsWith('.inspect')) value = { schemaVersion: 1, ...current, result: { action: body.action, topicId: body.topicId, ...current.result } };
            else if (body.action.endsWith('.reconcile')) value = { schemaVersion: 1, status: window.reconcileStatus ?? 'applied', logicalOperationId: body.logicalOperationId, result: { action: body.action, topicId: body.topicId, referenceId: 'session:new' } };
            else if (body.action.endsWith('.acknowledge')) value = { schemaVersion: 1, status: 'acknowledged', logicalOperationId: body.logicalOperationId, result: { action: body.action, topicId: body.topicId, referenceId: body.referenceId } };
            else throw new Error(`Unexpected recovery action: ${body.action}`);
            if (body.action.endsWith('.acknowledge')) window.recovery = { status: 'clear' };
            if (body.action.endsWith('.reconcile')) window.recovery = { ...current, status: value.status, result: { ...current.result, referenceId: value.result.referenceId } };
            return { status: 200, body: JSON.stringify(value) };
          }
          if (window.mode === 'delay') await new Promise((resolve, reject) => { window.finishPost = resolve; if (!window.ignoreAbort) signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
          if (window.mode === 'unknown') throw new Error('Connection lost');
          if (window.mode === 'conflict') return { status: 409, body: JSON.stringify({ schemaVersion: 1, status: 'error', code: 'conflict' }) };
          let result;
          if (['notes.create', 'notes.create.reconcile'].includes(body.action)) {
            const status = body.action.endsWith('.reconcile') ? window.reconcileStatus ?? 'applied' : 'applied';
            result = { action: body.action, topicId: body.topicId, referenceId: status === 'applied' ? window.createdReferenceId ?? 'note:created' : body.referenceId, path: body.path, ...(status === 'applied' ? { revision: 'created-r1' } : {}) };
            return { status: 200, body: JSON.stringify({ schemaVersion: 1, status, logicalOperationId: body.logicalOperationId, result }) };
          }
          if (body.action === 'notes.edit.reconcile') {
            const note = window.notes.find((note) => note.sourceReference.referenceId === body.referenceId);
            const status = window.reconcileStatus ?? 'applied';
            result = { action: body.action, topicId: body.topicId, referenceId: body.referenceId, path: body.path, ...(status === 'applied' ? { revision: note.revision } : {}) };
            return { status: 200, body: JSON.stringify({ schemaVersion: 1, status, logicalOperationId: body.logicalOperationId, result }) };
          }
          if (body.action === 'notes.edit') {
            const note = window.notes.find((note) => note.sourceReference.referenceId === body.referenceId);
            note.text = new TextDecoder().decode(Uint8Array.from(atob(body.contentBase64), (c) => c.charCodeAt(0))); note.revision = 'r2';
            result = { action: body.action, topicId: body.topicId, referenceId: body.referenceId, path: body.path, revision: note.revision };
          } else if (body.action === 'create') result = { value: { status: 'applied', topicId: body.topicId } };
          else {
            result = { action: body.action, topicId: body.topicId, referenceId: 'session:new' };
            window.recovery = { ...window.recovery, status: 'applied', result: { ...window.recovery.result, referenceId: result.referenceId } };
          }
          return { status: 200, body: JSON.stringify({ schemaVersion: 1, status: 'applied', logicalOperationId: body.logicalOperationId, result }) };
        },
        ui: { registerPage: (page) => { registrations.set(page.id, page); return () => registrations.delete(page.id); }, registerNavigation: () => () => {} }
      };
      window.stop = plugin.activate(host);
      window.replaceActivation = () => { scope?.abort(); view?.dispose(); window.stop(); window.stop = plugin.activate(host); window.navigate('topic'); };
      window.navigate = (id) => host.navigation.openPage({ id, params: { topicId: topic.topicId } });
      window.setPresented = (presented) => view.update({ ...context, presented });
      window.updateTopic = (topicId) => { context = { ...context, props: { topicId } }; view.update(context); };
      window.changeTopicPolicy = (patch) => { Object.assign(topic, patch); window.navigate('topic'); };
      window.setConnection = (patch) => { Object.assign(host.connection, patch); for (const fn of subscribers) fn(); };
      window.dispose = () => { view.dispose(); window.stop(); lifetime.abort(); };
      window.navigate('topic');
    });
    await run(page);
    await page.evaluate(() => window.dispose());
  } finally { await browser?.close(); await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); }
}

test('uncertain Note creation checks the original operation without replay and retains newer local text across remount', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('textbox', { name: 'New Note path (required)' }).fill('nested/new.md');
  await page.getByRole('textbox', { name: 'New Note content' }).fill('Submitted creation');
  await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Create Note', exact: true }).click();
  await page.getByText(/Note creation outcome is unknown/).waitFor();
  await page.getByRole('textbox', { name: 'New Note content' }).fill('Newer local creation draft');
  await page.evaluate(() => { window.navigate('topics'); window.navigate('topic'); window.mode = 'success'; });
  assert.equal(await page.getByRole('textbox', { name: 'New Note content' }).inputValue(), 'Newer local creation draft');
  await page.getByRole('button', { name: 'Check creation outcome' }).focus(); await page.keyboard.press('Enter');
  await page.getByText(/Note created and verified/).waitFor();
  const posts = await page.evaluate(() => window.posts);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.referenceId, 'folder:fictional');
  assert.deepEqual(posts[1].body, { ...posts[0].body, action: 'notes.create.reconcile' });
  assert.equal(await page.getByRole('textbox', { name: 'New Note content' }).inputValue(), 'Newer local creation draft');
  assert.equal(await page.getByRole('button', { name: 'Create Note', exact: true }).isDisabled(), true);
}));

test('confirmed absent Note creation retains input and requires an explicit new submission', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('textbox', { name: 'New Note path (required)' }).fill('new.md');
  await page.getByRole('textbox', { name: 'New Note content' }).fill('Retained creation');
  await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Create Note', exact: true }).click();
  await page.getByText(/Note creation outcome is unknown/).waitFor();
  await page.evaluate(() => { window.mode = 'success'; window.reconcileStatus = 'not-applied'; });
  await page.getByRole('button', { name: 'Check creation outcome' }).click();
  await page.getByText(/creation was not applied/).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'New Note content' }).inputValue(), 'Retained creation');
  assert.equal(await page.evaluate(() => window.posts.length), 2);
  await page.getByRole('button', { name: 'Create Note', exact: true }).click();
  await page.getByText(/Note created and verified/).waitFor();
  const posts = await page.evaluate(() => window.posts);
  assert.equal(posts.length, 3); assert.notEqual(posts[2].body.logicalOperationId, posts[0].body.logicalOperationId);
}));

test('a Note creation receipt returning the Folder ID cannot acknowledge creation', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('textbox', { name: 'New Note path (required)' }).fill('new.md');
  await page.evaluate(() => { window.createdReferenceId = 'folder:fictional'; });
  await page.getByRole('button', { name: 'Create Note', exact: true }).click();
  await page.getByText(/Note creation outcome is unknown/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Note', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.mode = 'conflict'; });
  await page.getByRole('button', { name: 'Check creation outcome' }).click();
  await page.getByText(/Newer authoritative state conflicts/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Note', exact: true }).isDisabled(), true);
}));

for (const interruption of ['permission', 'topic-switch', 'activation']) test(`a late Note creation response cannot acknowledge ${interruption} cancellation`, noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('textbox', { name: 'New Note path (required)' }).fill('new.md');
  await page.getByRole('textbox', { name: 'New Note content' }).fill('Original creation draft');
  await page.evaluate(() => { window.mode = 'delay'; window.ignoreAbort = true; });
  await page.getByRole('button', { name: 'Create Note', exact: true }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.evaluate((interruption) => {
    if (interruption === 'permission') window.setConnection({ canWrite: false });
    else if (interruption === 'topic-switch') { window.navigate('topics'); window.navigate('topic'); }
    else window.replaceActivation();
  }, interruption);
  await page.getByRole('textbox', { name: 'New Note content' }).waitFor();
  await page.evaluate(async () => { window.finishPost(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  if (interruption === 'activation') {
    assert.equal(await page.getByRole('textbox', { name: 'New Note content' }).inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'Check creation outcome' }).isHidden(), true);
  } else {
    await page.getByText(/Note creation outcome is unknown/).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'New Note content' }).inputValue(), 'Original creation draft');
    assert.equal(await page.getByRole('button', { name: 'Create Note', exact: true }).isDisabled(), true);
  }
  assert.equal(await page.evaluate(() => window.posts.length), 1);
}));

test('Note creation requires the exact Folder and current active Topic write policy', noteAuthoring, () => fixture(async (page) => {
  for (const patch of [{ lifecycle: 'archived' }, { lifecycle: 'active', usable: false }, { usable: true, sourceReferences: [] }]) {
    await page.evaluate((patch) => window.changeTopicPolicy(patch), patch);
    await page.getByRole('button', { name: 'Create Note', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create Note', exact: true }).isDisabled(), true);
  }
  assert.equal(await page.evaluate(() => window.posts.length), 0);
}));

test('a superseded Note creation outcome check cannot replace a newer exact receipt', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('textbox', { name: 'New Note path (required)' }).fill('new.md');
  await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Create Note', exact: true }).click();
  await page.getByText(/Note creation outcome is unknown/).waitFor();
  await page.evaluate(() => { window.mode = 'delay'; window.ignoreAbort = true; });
  await page.getByRole('button', { name: 'Check creation outcome' }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.evaluate(() => { window.oldFinish = window.finishPost; window.navigate('topics'); window.navigate('topic'); window.mode = 'success'; });
  await page.getByRole('button', { name: 'Check creation outcome' }).click();
  await page.getByText(/Note created and verified/).waitFor();
  await page.evaluate(async () => { window.reconcileStatus = 'not-applied'; window.oldFinish(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await page.getByText(/Note created and verified/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Note', exact: true }).isDisabled(), true);
  const posts = await page.evaluate(() => window.posts);
  assert.equal(posts.filter((post) => post.body.action === 'notes.create').length, 1);
  assert.deepEqual(posts[2].body, posts[1].body);
}));

test('an uncertain save has an explicit reconcile-only action preserving exact intent and newer edits', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  const editor = page.getByRole('textbox', { name: 'Note draft' });
  await editor.fill('Submitted uncertain draft'); await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-note-state]').textContent.includes('outcome unknown'));
  await editor.fill('Newer local edit');
  await page.evaluate(() => { window.mode = 'success'; window.notes[0].text = 'Submitted uncertain draft'; window.notes[0].revision = 'r2'; });
  await page.getByRole('button', { name: 'Check save outcome' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-note-state]').textContent.includes('outcome unknown'));
  const posts = await page.evaluate(() => window.posts);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, { ...posts[0].body, action: 'notes.edit.reconcile' });
  assert.equal(await editor.inputValue(), 'Newer local edit');
  assert.match(await page.locator('[data-note-state]').textContent(), /r2.*unsaved draft/);
  assert.equal(await page.getByRole('region', { name: 'Note content', exact: true }).textContent(), 'Submitted uncertain draft');
}));

test('confirmed not-applied restores editing without silently retrying the save', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.getByRole('textbox', { name: 'Note draft' }).fill('Unsent draft');
  await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-note-state]').textContent.includes('outcome unknown'));
  await page.evaluate(() => { window.mode = 'success'; window.reconcileStatus = 'not-applied'; });
  await page.getByRole('button', { name: 'Check save outcome' }).click();
  await page.waitForFunction(() => document.querySelector('[data-note-state]').textContent.includes('not applied'));
  assert.equal(await page.getByRole('button', { name: 'Save Note', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('textbox', { name: 'Note draft' }).inputValue(), 'Unsent draft');
  assert.equal(await page.evaluate(() => window.posts.length), 2);
}));

test('native Note saves use the authoritative revision and preserve edits typed during a save', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  const editor = page.getByRole('textbox', { name: 'Note draft' });
  await editor.fill('Submitted draft');
  await page.evaluate(() => { window.mode = 'delay'; });
  await editor.press('Control+s');
  await page.waitForFunction(() => window.posts.length === 1);
  await editor.fill('Newer local draft');
  await page.evaluate(() => window.finishPost());
  await page.waitForFunction(() => document.querySelector('[data-note-state]')?.textContent.includes('r2'));
  assert.equal(await editor.inputValue(), 'Newer local draft');
  assert.equal(await page.getByRole('region', { name: 'Note content' }).innerText(), 'Submitted draft');
  const [post] = await page.evaluate(() => window.posts);
  assert.equal(post.path, '/plugins/command-center/api/topic/actions');
  assert.equal(post.body.expectedRevision, 'r1');
  assert.equal(post.body.expectedTopicRevision, 4);
  assert.equal(Buffer.from(post.body.contentBase64, 'base64').toString(), 'Submitted draft');
}));

test('native Conversation creation uses authenticated Session dispatch and its exact domain receipt before opening Chat', { timeout: 30000 }, () => fixture(async (page) => {
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('Fictional discussion');
  await page.getByRole('button', { name: 'Create Conversation' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.opened.length === 1);
  assert.deepEqual(await page.evaluate(() => window.opened), [{ sessionKey: 'agent:fictional:new', agentId: 'fictional' }]);
  const posts = await page.evaluate(() => window.posts);
  assert.deepEqual(posts.map(post => post.body.action), ['conversations.creation.inspect', 'conversations.create']);
  assert.equal(posts[1].body.expectedRevision, 4);
  assert.equal(posts[1].body.authoritativeSession, undefined);
  const dispatches = await page.evaluate(() => window.requests.filter(request => request.method.endsWith('sessions.create')));
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].params, { schemaVersion: 1, logicalOperationId: posts[1].body.logicalOperationId,
    topicId: posts[1].body.topicId, expectedRevision: 4, label: 'Fictional discussion', isPrimary: false });
}));

test('native Topic creation uses the domain HTTP owner', topicProvisioning, () => fixture(async (page) => {
  await page.evaluate(() => window.navigate('topics'));
  await page.getByRole('textbox', { name: 'Topic name (required)' }).fill('New fictional Topic');
  await page.getByRole('combobox', { name: 'PARA Category' }).selectOption('area');
  await page.getByRole('button', { name: 'Create Topic' }).click();
  await page.waitForFunction(() => window.posts.some(post => post.body.action === 'create'));
  const [post] = await page.evaluate(() => window.posts.filter(post => post.body.action === 'create'));
  assert.equal(post.path, '/plugins/command-center/api/topics/actions');
  assert.equal(post.body.name, 'New fictional Topic');
  assert.equal(post.body.paraCategory, 'area');
  assert.match(post.body.topicId, /^[0-9a-f-]{36}$/);
  assert.notEqual(post.body.topicId, post.body.logicalOperationId);
}));

test('healthy native Sessions remain usable when Notes are unavailable', { timeout: 30000 }, () => fixture(async (page) => {
  await page.evaluate(() => { window.notesUnavailable = true; window.navigate('topic'); });
  await page.getByText('Notes capability is unavailable.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat' }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Read brief.md' }).count(), 0);
  await page.getByRole('button', { name: 'Open Topic in Chat' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.opened.length === 1);
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('Discussion without Notes');
  await page.getByRole('button', { name: 'Create Conversation' }).click();
  await page.waitForFunction(() => window.opened.length === 2);
  assert.deepEqual(await page.evaluate(() => window.opened), [
    { sessionKey: 'agent:fictional:primary', agentId: 'fictional' },
    { sessionKey: 'agent:fictional:new', agentId: 'fictional' }
  ]);
  const [post] = await page.evaluate(() => window.posts.filter(post => post.body.action === 'conversations.create'));
  assert.equal(post.path, '/plugins/command-center/api/topic/actions');
  assert.equal(post.body.action, 'conversations.create');
  assert.equal(post.body.topicId, '11111111-1111-4111-8111-111111111111');
  assert.equal(post.body.expectedRevision, 4);
}));

test('refused Conversation creation does not strand a pending Notes catalog', { timeout: 30000 }, () => fixture(async (page) => {
  await page.evaluate(() => { window.delayBrowse = true; window.mode = 'conflict'; window.navigate('topic'); });
  await page.waitForFunction(() => window.finishBrowse);
  await page.getByRole('button', { name: 'Create Conversation' }).click();
  await page.getByRole('status').filter({ hasText: 'creation outcome is unknown' }).waitFor();
  await page.evaluate(() => window.finishBrowse());
  await page.getByRole('button', { name: 'Read brief.md' }).waitFor();
  assert.match(await page.getByRole('status').first().innerText(), /^Notes 1–2 of 2/);
  assert.equal(await page.getByRole('button', { name: 'Create Conversation' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Check creation outcome' }).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method.endsWith('sessions.create')).length), 1);
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}));

test('failed native Chat navigation does not strand a pending Notes catalog', { timeout: 30000 }, () => fixture(async (page) => {
  await page.evaluate(() => { window.delayBrowse = true; window.navigationFailure = true; window.navigate('topic'); });
  await page.waitForFunction(() => window.finishBrowse);
  await page.getByRole('button', { name: 'Open Topic in Chat' }).click();
  await page.getByText('Native Chat is temporarily unavailable.', { exact: true }).waitFor();
  await page.evaluate(() => window.finishBrowse());
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Note content"]')?.textContent === 'Authoritative brief');
  assert.equal(await page.getByRole('region', { name: 'Note content', exact: true }).innerText(), 'Authoritative brief');
  assert.equal(await page.getByRole('textbox', { name: 'Note draft' }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}));

for (const transition of ['write permission loss', 'read permission loss', 'disposal', 'Topic switch']) {
test(`pending Notes cannot restore Session controls after ${transition}`, { timeout: 30000 }, () => fixture(async (page) => {
  await page.evaluate(() => { window.delayBrowse = true; window.navigate('topic'); });
  await page.waitForFunction(() => window.finishBrowse);
  assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat' }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Create Conversation' }).isEnabled(), true);
  const requestsBeforeTransition = await page.evaluate(() => window.posts);
  await page.evaluate(async (transition) => {
    if (transition === 'write permission loss') window.setConnection({ canWrite: false });
    else if (transition === 'read permission loss') window.setConnection({ canRead: false });
    else if (transition === 'disposal') window.dispose();
    else window.updateTopic('22222222-2222-4222-8222-222222222222');
    window.finishBrowse();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, transition);
  if (transition === 'write permission loss') {
    assert.equal(await page.getByRole('button', { name: 'Create Conversation' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat' }).isEnabled(), true);
  } else {
    assert.equal(await page.getByRole('button', { name: 'Create Conversation' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Read brief.md' }).count(), 0);
    if (transition === 'disposal') assert.equal(await page.locator('#mount').innerText(), '');
    else assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat' }).isDisabled(), true);
  }
  assert.deepEqual(await page.evaluate(() => window.posts), requestsBeforeTransition);
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method.endsWith('sessions.create')).length), 0);
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}));
}

test('a stale Topic response cannot restore controls after switching to an invalid Topic', { timeout: 30000 }, () => fixture(async (page) => {
  await page.evaluate(() => { window.delayTopic = true; window.navigate('topic'); });
  await page.waitForFunction(() => window.finishTopic);
  await page.evaluate(() => window.updateTopic('22222222-2222-4222-8222-222222222222'));
  await page.getByText('The exact Topic is unavailable.', { exact: true }).waitFor();
  await page.evaluate(async () => { window.finishTopic(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Create Conversation' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Read brief.md' }).count(), 0);
}));

test('a hidden creation cannot navigate after a delayed receipt, even when shown again', topicProvisioning, () => fixture(async (page) => {
  await page.evaluate(() => { window.navigate('topics'); window.mode = 'delay'; });
  await page.getByRole('textbox', { name: 'Topic name (required)' }).fill('Delayed Topic');
  // Deliberately ignore cancellation at the host boundary to exercise late receipts.
  await page.evaluate(() => { window.ignoreAbort = true; });
  await page.getByRole('button', { name: 'Create Topic' }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.evaluate(async () => { window.setPresented(false); window.setPresented(true); window.finishPost(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(await page.getByRole('heading', { name: 'Topics', exact: true }).count(), 1);
}));

test('unknown Note saves retain the exact draft across remount and authoritative reload without retrying', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  const editor = page.getByRole('textbox', { name: 'Note draft' });
  await editor.fill('Unconfirmed draft');
  await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-note-state]')?.textContent.includes('outcome unknown'));
  await page.evaluate(() => { window.navigate('topics'); window.navigate('topic'); });
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  assert.equal(await editor.inputValue(), 'Unconfirmed draft');
  await page.getByRole('button', { name: 'Reload authoritative Note', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Note content"]')?.textContent === 'Authoritative brief');
  assert.equal(await page.getByRole('button', { name: 'Save Note', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Discard draft and use authoritative Note' }).isVisible(), false);
  await editor.press('Control+s');
  assert.equal(await page.evaluate(() => window.posts.length), 1);
}));

test('a conflicting draft keeps its base revision until explicit discard and never transfers to another Note', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  const editor = page.getByRole('textbox', { name: 'Note draft' });
  await editor.fill('Local conflict');
  await page.evaluate(() => { window.notes[0].text = 'External change'; window.notes[0].revision = 'r2'; window.mode = 'conflict'; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-note-state]')?.textContent.includes('conflict'));
  await page.getByRole('button', { name: 'Read other.md' }).click();
  assert.equal(await editor.inputValue(), 'Other Note');
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.getByRole('button', { name: 'Reload authoritative Note', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Note content"]')?.textContent === 'External change');
  assert.equal(await editor.inputValue(), 'Local conflict');
  assert.match(await page.locator('[data-note-state]').innerText(), /^r1 · unsaved draft/);
  await page.getByRole('button', { name: 'Discard draft and use authoritative Note' }).click();
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'External change');
  assert.match(await page.locator('[data-note-state]').innerText(), /^r2 · saved/);
}));

test('a later Note selection cancels navigation from a pending Conversation creation', { timeout: 30000 }, () => fixture(async (page) => {
  await page.evaluate(() => { window.mode = 'delay'; });
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('Delayed discussion');
  await page.getByRole('button', { name: 'Create Conversation' }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.evaluate(async () => { window.finishPost(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(await page.evaluate(() => window.opened), []);
}));

for (const responseOrder of ['older-first', 'newer-first']) test(`the latest read-only Notes refresh owns its catalog: ${responseOrder}`, { timeout: 30000 }, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.evaluate(() => { window.delayBrowse = true; window.notes[0].text = 'Older version'; window.notes[0].revision = 'r2'; window.notes[1].path = 'old-only.md'; });
  await page.getByRole('button', { name: 'Refresh Notes', exact: true }).click();
  await page.waitForFunction(() => window.finishBrowse);
  await page.evaluate(() => { window.delayBrowse = true; window.notes[0].text = 'Newest version'; window.notes[0].revision = 'r3'; window.notes[1].path = 'other.md'; });
  await page.getByRole('button', { name: 'Refresh Notes', exact: true }).click();
  await page.waitForFunction(() => window.finishBrowses.length === 2);
  const first = responseOrder === 'older-first' ? 0 : 1;
  await page.evaluate(async index => { window.finishBrowses[index](); await new Promise(resolve => setTimeout(resolve, 0)); }, first);
  assert.equal(await page.getByRole('button', { name: 'Read old-only.md', exact: true }).count(), 0);
  if (first === 0) assert.equal(await page.getByRole('button', { name: 'Read brief.md', exact: true }).count(), 0);
  await page.evaluate(async index => { window.finishBrowses[index](); await new Promise(resolve => setTimeout(resolve, 0)); }, 1 - first);
  assert.equal(await page.getByRole('button', { name: 'Read old-only.md', exact: true }).count(), 0);
  // Refresh clears selection. A new explicit read must use the newest catalog
  // revision, not the old catalog's reference or an editing-only reload control.
  await page.getByRole('button', { name: 'Read brief.md', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Note content"]')?.textContent === 'Newest version');
  assert.equal(await page.getByRole('region', { name: 'Note content' }).innerText(), 'Newest version');
}));

test('losing write access cancels an in-flight Note write and retains an unknown outcome', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.getByRole('textbox', { name: 'Note draft' }).fill('Interrupted draft');
  await page.evaluate(() => { window.mode = 'delay'; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.evaluate(() => window.setConnection({ canWrite: false }));
  await page.waitForFunction(() => document.querySelector('[data-note-state]')?.textContent.includes('outcome unknown'));
  assert.equal(await page.getByRole('textbox', { name: 'Note draft' }).inputValue(), 'Interrupted draft');
}));

test('a late save response cannot acknowledge a revoked view even when transport ignores abort', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.getByRole('textbox', { name: 'Note draft' }).fill('Interrupted draft');
  await page.evaluate(() => { window.mode = 'delay'; window.ignoreAbort = true; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.evaluate(async () => { window.setConnection({ canWrite: false }); window.finishPost(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(await page.locator('[data-note-state]').textContent(), /r1.*outcome unknown/);
}));

test('a replacement activation never receives an old save acknowledgement or its draft', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.getByRole('textbox', { name: 'Note draft' }).fill('Old activation private draft');
  await page.evaluate(() => { window.mode = 'delay'; window.ignoreAbort = true; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.evaluate(() => window.replaceActivation());
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Note draft' }).inputValue(), 'Authoritative brief');
  await page.getByRole('textbox', { name: 'Note draft' }).fill('Replacement activation draft');
  await page.evaluate(async () => { window.finishPost(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(await page.getByRole('textbox', { name: 'Note draft' }).inputValue(), 'Replacement activation draft');
  assert.match(await page.locator('[data-note-state]').textContent(), /^r1 · unsaved draft$/);
}));

test('a superseded reconcile response cannot overwrite the current operation result', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.getByRole('textbox', { name: 'Note draft' }).fill('Submitted');
  await page.evaluate(() => { window.mode = 'unknown'; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-note-state]').textContent.includes('outcome unknown'));
  await page.evaluate(() => { window.mode = 'delay'; window.ignoreAbort = true; window.notes[0].revision = 'r2'; window.notes[0].text = 'Submitted'; });
  await page.getByRole('button', { name: 'Check save outcome' }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.evaluate(() => { window.oldFinish = window.finishPost; window.navigate('topics'); window.navigate('topic'); });
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.evaluate(() => { window.mode = 'success'; });
  await page.getByRole('button', { name: 'Check save outcome' }).click();
  await page.waitForFunction(() => document.querySelector('[data-note-state]').textContent === 'r2 · saved');
  await page.evaluate(async () => { window.notes[0].revision = 'r99'; window.oldFinish(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(await page.locator('[data-note-state]').textContent(), 'r2 · saved');
  assert.equal(await page.evaluate(() => window.posts.filter((post) => post.body.action === 'notes.edit').length), 1);
}));

test('a multi-megabyte UTF-8 Note uses the bounded HTTP body and remains editable', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.getByRole('textbox', { name: 'Note draft' }).fill('é'.repeat(1024 * 1024));
  await page.getByRole('button', { name: 'Save Note', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-note-state]')?.textContent === 'r2 · saved');
  assert.equal(await page.evaluate(() => atob(window.posts[0].body.contentBase64).length), 2 * 1024 * 1024);
  assert.equal(await page.getByRole('textbox', { name: 'Note draft' }).inputValue().then((text) => text.length), 1024 * 1024);
}));

test('creation disposal retains an unknown operation and does not create a duplicate on remount', { timeout: 30000 }, () => fixture(async (page) => {
  await page.evaluate(() => { window.mode = 'delay'; });
  await page.getByRole('textbox', { name: 'Conversation label' }).fill('Interrupted Conversation');
  await page.getByRole('button', { name: 'Create Conversation' }).click();
  await page.waitForFunction(() => window.finishPost);
  await page.evaluate(() => { window.navigate('topics'); window.navigate('topic'); });
  await page.getByText(/Conversation creation outcome is unknown/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create Conversation' }).isDisabled(), true);
  assert.equal(await page.getByRole('textbox', { name: 'Conversation label' }).inputValue(), 'Interrupted Conversation');
  assert.equal(await page.evaluate(() => window.posts.filter(post => post.body.action === 'conversations.create').length), 1);
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method.endsWith('sessions.create')).length), 1);
}));

test('keyboard save returns focus to Save Note after a refused write', noteAuthoring, () => fixture(async (page) => {
  await page.getByRole('button', { name: 'Read brief.md' }).click();
  await page.getByRole('textbox', { name: 'Note draft' }).fill('Keyboard draft');
  await page.evaluate(() => { window.mode = 'conflict'; });
  await page.getByRole('button', { name: 'Save Note', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-note-state]')?.textContent.includes('conflict'));
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Save Note');
}));
