import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { EVERYDAY_SESSION_LABELS, FICTIONAL_TABLE, revealEverydayInbox, revealEverydayTopic, chooseEverydayAssignment, exerciseEverydayCreation, assertEverydayFilesTarget, assertEverydayResolvedTarget, assertEverydayNoteRead, assertEverydayTable } from './support/everyday-native-workspace.mjs';

// Exercises the same driver against the frozen packaged UI. These asynchronous
// contract fixtures diagnose driver behavior, not installed/native owner proof.
// An explicitly supplied Native26 component build additionally exercises its
// real header renderer, picker, modal and Files component; RPCs and Chat remain
// fixture boundaries. Never count this mode as full native-shell acceptance.
test('frozen packaged Everyday journey uses asynchronous picker/dialog/navigation and applied inspection after response loss', { timeout: 60000 }, async t => {
  assert.ok(process.env.COMMAND_CENTER_NATIVE_UI_ROOT, 'An extracted frozen PR368 archive is required; no source UI fallback.');
  const root = path.resolve(process.env.COMMAND_CENTER_NATIVE_UI_ROOT);
  const nativeComponentsRoot = process.env.COMMAND_CENTER_NATIVE_COMPONENTS_ROOT;
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><style>body{margin:0;font:16px system-ui;overflow-wrap:anywhere}#side{width:280px;max-width:100%}#reader{width:340px;max-width:100%;height:520px}button{max-width:100%}dialog{min-width:300px}</style><main id="side"></main><openclaw-chat-pane aria-hidden="false"><textarea aria-label="Chat composer"></textarea></openclaw-chat-pane><main id="reader"></main>'); return; }
    if (nativeComponentsRoot && /^\/_native\/[-a-zA-Z0-9_./]+\.(?:js|css)$/u.test(req.url ?? '') && !req.url.split('/').includes('..')) {
      try { res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(path.join(nativeComponentsRoot, req.url.slice('/_native/'.length)))); }
      catch { res.writeHead(404); res.end(); } return;
    }
    if (!/^\/(?:vendor\/)?[a-z.-]+\.mjs$/u.test(req.url ?? '')) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(path.join(root, req.url.slice(1)))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async ({ text, labels, nativeComponents }) => {
    const { mountTopicSidebar } = await import('/topic-sidebar.mjs');
    const { mountTopicPage } = await import('/topic-page.mjs');
    const { createNativeState } = await import('/mutations.mjs');
    const delay = () => new Promise(resolve => setTimeout(resolve, 15));
    const topics = ['fixture-area', 'fixture-resource'].map((topicId, index) => ({ topicId, name: 'Fictional Same Name', paraCategory: index ? 'resource' : 'area', revision: 4, lifecycle: 'active', usable: true, health: 'ready', noteFolderReferenceId: 'fictional-folder' }));
    const signal = new AbortController().signal;
    const chat = document.querySelector('openclaw-chat-pane'); chat.sessionKey = 'agent:main:fictional-primary';
    // This host boundary models the pinned native independent Files contract.
    // The actual Native26 host/pane test separately proves Chat/draft retention.
    const filesView = document.createElement('openclaw-plugin-view');
    filesView.surface = 'session-files'; filesView.presented = true;
    filesView.props = { sessionKey: chat.sessionKey, agentId: 'main' };
    const reader = document.querySelector('#reader'); reader.before(filesView); filesView.append(reader);
    window.fixture = { dispatchCount: 0, responseLost: false, armed: false, assignment: null, operation: null };
    const f = window.fixture;
    const claimedLabels = new Set();
    for (const role of ['areaPrimary', 'resourcePrimary', 'unassigned']) {
      if (claimedLabels.has(labels[role])) throw new Error('Native setup label already in use');
      claimedLabels.add(labels[role]);
    }
    f.seedLabels = [...claimedLabels];
    const host = { signal, connection: { connected: true, canRead: true, canWrite: true }, redact: x => x, subscribe: () => () => {},
      sessions: { async openChat({ sessionKey }) { await delay(); chat.sessionKey = sessionKey; },
        async openFiles(target) { await delay(); f.filesTarget = target; filesView.props = target;
          window.reader.update({ host, signal, presented: true, props: { topicId: 'fixture-resource' }, panel: { showInMain() {} } }); } },
      navigation: { async openPage() { await delay(); } },
      components: {
        mountSelectPicker(container, props) {
          let active = true; let element;
          void delay().then(() => { if (!active) return;
            element = document.createElement('div'); const trigger = document.createElement('button'); trigger.className = 'picker-select__trigger'; trigger.setAttribute('aria-label', props.accessibleLabel); trigger.textContent = 'Choose a Topic…'; trigger.disabled = props.disabled;
            const menu = document.createElement('div'); menu.setAttribute('role', 'listbox'); menu.hidden = true;
            for (const option of props.options) { const item = document.createElement('button'); item.setAttribute('role', 'option'); item.dataset.value = option.value; item.textContent = [option.label, option.description].filter(Boolean).join(' · '); item.onclick = () => { props.onSelect(option.value); trigger.textContent = item.textContent; menu.hidden = true; }; menu.append(item); }
            trigger.onclick = () => { menu.hidden = !menu.hidden; }; element.append(trigger, menu); container.append(element);
          }); return { dispose() { active = false; element?.remove(); } };
        },
        mountDialog(container, props) {
          let active = true; let element;
          void delay().then(() => { if (!active) return; element = document.createElement('dialog'); element.setAttribute('aria-label', props.label); element.append(props.content); container.append(element); element.addEventListener('cancel', event => { event.preventDefault(); props.onCancel(); }); element.showModal(); });
          return { dispose() { active = false; element?.close(); element?.remove(); queueMicrotask(() => props.returnFocusTarget?.focus()); } };
        },
        mountFileExplorer(container, props) {
          let active = true; let element; const draw = next => { if (!active) return; element?.remove(); element = document.createElement('div'); element.className = 'control-ui-file-explorer'; const notePath = next.entries?.[0]?.path ?? 'Overview.md'; const button = document.createElement('button'); button.textContent = `Read ${notePath}`; button.onclick = () => next.onSelect(notePath); element.append(button); container.append(element); };
          void delay().then(() => draw(props)); return { update(next) { void delay().then(() => draw(next)); }, dispose() { active = false; element?.remove(); } };
        }
      },
      async request(method, params) {
        await delay();
        if (method.endsWith('topics.list')) return { result: { activeGroups: { area: [topics[0]], resource: [topics[1]] }, recovery: [], archived: [] } };
        if (method.endsWith('topics.get')) return { result: { topic: topics.find(topic => topic.topicId === params.topicId) } };
        if (method.endsWith('sessions.topic-context')) return { result: f.assignment ? { status: 'bound', ...f.assignment } : { status: 'unbound' } };
        if (method.endsWith('sessions.assign-topic')) { f.assignment = params; return { result: { status: 'applied', logicalOperationId: params.logicalOperationId, referenceId: `conversation-assignment:${params.logicalOperationId}`, topicId: params.topicId, sessionKey: params.sessionKey, sessionId: params.expectedSessionId } }; }
        if (method.endsWith('sessions.browse')) return { result: { topicId: params.topicId, conversations: [{ referenceId: `${params.topicId}-primary`, sessionId: `${params.topicId}-primary-id`, status: 'open', isPrimary: true }, ...(f.operation && params.topicId === f.operation.topicId ? [{ referenceId: 'fictional-created-ref', sessionId: 'fictional-created-id', status: 'open' }] : [])] } };
        if (method.endsWith('histories.list')) return { result: { histories: [] } };
        if (method.endsWith('sessions.create')) { f.dispatchCount++; assertInput(params); if (claimedLabels.has(params.label)) throw new Error('Native label already in use'); claimedLabels.add(params.label); f.operation = params; if (f.armed) { f.armed = false; f.responseLost = true; throw new Error('Fictional response lost after owner settlement'); } throw new Error('An unexpected second creation is forbidden.'); }
        if (method.endsWith('sessions.resolve-native')) { const sessionKey = params.referenceId === 'fixture-resource-primary' ? 'agent:main:fictional-resource' : params.referenceId === 'fixture-area-primary' ? 'agent:main:fictional-primary' : 'agent:main:fictional-created';
          const value = { sessionKey }; f.navigation = { input: params, value }; return { result: value }; }
        const isResource = params.topicId === 'fixture-resource';
        const sourceReference = { topicId: params.topicId, referenceId: isResource ? 'fictional-resource-note' : 'fictional-note', observedRevision: 'r1' };
        if (method.endsWith('notes.browse')) return { notes: [{ path: isResource ? 'Resource-05.md' : 'Overview.md', revision: 'r1', sourceReference }], total: 1, offset: 0, hasMore: false, cursor: 'fictional-catalog' };
        if (method.endsWith('notes.read')) { const noteText = isResource ? '# Fictional Resource 5\nRead-only fixture content.\n' : text;
          const value = { path: params.path, revision: 'r1', sourceReference, contentEncoding: 'identity', contentBase64: btoa(noteText), byteOffset: 0, nextOffset: noteText.length, totalBytes: noteText.length, complete: true };
          f.note = { input: params, value }; return value; }
        throw new Error(`Unexpected fixture method ${method}`);
      },
      async httpRequest({ body }) {
        await delay(); const input = JSON.parse(body);
        if (!input.action.endsWith('.inspect') && !input.action.endsWith('.reconcile')) throw new Error('Fixture never dispatches creation from HTTP recovery.');
        return { status: 200, body: JSON.stringify({ schemaVersion: 1, status: f.operation ? 'applied' : 'clear', logicalOperationId: f.operation?.logicalOperationId,
          result: { action: input.action, topicId: input.topicId, ...(f.operation ? { referenceId: 'fictional-created-ref', sessionId: 'fictional-created-id', expectedTopicRevision: f.operation.expectedRevision, label: f.operation.label } : {}) } }) };
      }
    };
    if (nativeComponents) {
      const { createControlUiComponents, renderAppSidebarBrand, render } = await import('/_native/native-components.js');
      const components = createControlUiComponents({ signal, onError: error => { throw error; }, current: () => ({
        gateway: { subscribe: () => () => {} }, agents: { subscribe: () => () => {}, state: {} } }) });
      host.components.mountDialog = components.mountDialog;
      host.components.mountSelectPicker = components.mountSelectPicker;
      host.components.mountFileExplorer = components.mountFileExplorer;
      const nativeSidebar = document.createElement('openclaw-app-sidebar');
      document.body.prepend(nativeSidebar);
      render(renderAppSidebarBrand({ basePath: '', sidebarAgentsMode: 'agent',
        readNewSessionAccess: () => ({ allowed: true }), expandedAgentId: () => 'main',
        activeChipAgent: () => ({ activeId: 'main', agent: { id: 'main' }, agents: [], identity: {} }),
        sidebarMenus: { agentMenuPosition: null }, agentUnreadCount: () => 0,
        onToggleSidebar() {}, onOpenPalette() {}, requestOpenNewSession() {} }), nativeSidebar);
    }
    function assertInput(params) { if (params.isPrimary !== false || params.topicId !== topics[0].topicId || !params.logicalOperationId) throw new Error('Invalid closed creation fixture input.'); }
    window.sidebar = mountTopicSidebar(document.querySelector('#side'), { host, signal, presented: true, props: { sessions: [{ key: 'agent:main:fictional-unassigned', sessionId: 'fictional-unassigned-id', updatedAt: 8, displayName: 'Fictional Inbox' }] }, mountDefault: () => () => {} }, undefined, createNativeState());
    window.reader = mountTopicPage(document.querySelector('#reader'), { host, signal, props: { topicId: topics[0].topicId }, presented: true, panel: { showInMain() {} } }, undefined, { panel: true });
  }, { text: '# Fictional Note\n' + FICTIONAL_TABLE, labels: EVERYDAY_SESSION_LABELS, nativeComponents: !!nativeComponentsRoot });
  if (nativeComponentsRoot) {
    const headerNew = page.locator('openclaw-app-sidebar .sidebar-brand__actions').getByRole('link', { name: 'New conversation', exact: true });
    await headerNew.waitFor({ state: 'visible' });
    assert.equal(await headerNew.count(), 1);
    assert.notEqual(await headerNew.getAttribute('aria-disabled'), 'true');
    assert.equal(new URL(await headerNew.getAttribute('href'), page.url()).pathname, '/new');
  }
  const sidebar = page.getByRole('navigation', { name: 'Topics and Conversations', exact: true });
  // Regression: the installed driver's old exact heading never matched the
  // frozen product's counted name and inherited a 185-second attribute wait.
  const oldInbox = sidebar.getByRole('heading', { name: 'Inbox / Unassigned', exact: true }).locator('xpath=..');
  assert.equal(await oldInbox.count(), 0);
  await assert.rejects(oldInbox.locator('[data-topic-control-key="inbox"]').getAttribute('aria-expanded', { timeout: 100 }), /Timeout/);
  const inbox = await revealEverydayInbox(sidebar);
  assert.equal(await inbox.getByRole('heading', { name: 'Inbox / Unassigned (1)', exact: true }).count(), 1);
  await revealEverydayInbox(sidebar); // An already open Inbox stays open.
  await chooseEverydayAssignment(inbox.getByRole('listitem').filter({ hasText: 'Fictional Inbox' }), { topicId: 'fixture-area', duplicateTopicId: 'fixture-resource', name: 'Fictional Same Name' });
  await page.waitForFunction(() => window.fixture.assignment !== null);
  assert.equal((await page.evaluate(() => window.fixture.assignment)).expectedSessionId, 'fictional-unassigned-id');
  await revealEverydayTopic(sidebar, 'fixture-area');
  const created = await exerciseEverydayCreation({ page, sidebar, fixture: { topicId: 'fixture-area', name: 'Fictional Same Name' }, composer: page.getByLabel('Chat composer'),
    nativeModal: !!nativeComponentsRoot,
    readSessionKey: () => page.locator('openclaw-chat-pane').evaluate(element => element.sessionKey),
    armResponseLoss: () => page.evaluate(() => { window.fixture.armed = true; }),
    readCreation: () => page.evaluate(() => ({ ...window.fixture, logicalOperationId: window.fixture.operation.logicalOperationId, referenceId: 'fictional-created-ref', sessionId: 'fictional-created-id', sessionKey: 'agent:main:fictional-created' })) });
  assert.equal(created.dispatchCount, 1);
  assert.deepEqual(created.seedLabels, [EVERYDAY_SESSION_LABELS.areaPrimary, EVERYDAY_SESSION_LABELS.resourcePrimary, EVERYDAY_SESSION_LABELS.unassigned]);
  assert.equal(created.operation.label, EVERYDAY_SESSION_LABELS.focusedCreated);
  await page.getByRole('button', { name: nativeComponentsRoot ? 'Overview.md' : 'Read Overview.md', exact: true }).click();
  for (const width of [1440, 412, 360, 320]) { await page.setViewportSize({ width, height: 900 }); await assertEverydayTable({ page, reading: page.getByRole('region', { name: 'Note content', exact: true }), source: page.getByRole('button', { name: 'Source', exact: true }), originalText: '# Fictional Note\n' + FICTIONAL_TABLE }); }
  assert.equal(await page.getByLabel('Chat composer').inputValue(), 'Fictional draft retained through native creation Cancel.');
  await page.setViewportSize({ width: 1440, height: 900 });
  const area = await revealEverydayTopic(sidebar, 'fixture-area');
  await area.getByRole('button', { name: 'Primary Conversation', exact: true }).click();
  const chatPane = page.locator('openclaw-chat-pane');
  await page.waitForFunction(pane => pane.sessionKey === 'agent:main:fictional-primary', await chatPane.elementHandle());
  const resource = await revealEverydayTopic(sidebar, 'fixture-resource');
  await resource.getByRole('button', { name: 'Open Topic Files', exact: true }).click();
  const resourceFixture = { topicId: 'fixture-resource', sessionReferenceId: 'fixture-resource-primary', sessionId: 'fixture-resource-primary-id',
    sessionKey: 'agent:main:fictional-resource', notePath: 'Resource-05.md' };
  const filesView = page.locator('openclaw-plugin-view').filter({ has: page.locator('[data-topic-reader-page="panel"]') });
  const explorer = await assertEverydayFilesTarget({ page, chatPane, filesView, fixture: resourceFixture,
    chatKey: 'agent:main:fictional-primary', draft: 'Fictional draft retained through native creation Cancel.' });
  assertEverydayResolvedTarget(await page.evaluate(() => window.fixture.navigation), resourceFixture);
  await assert.rejects(page.waitForFunction(pane => pane.sessionKey === 'agent:main:fictional-resource', await chatPane.elementHandle(), { timeout: 100 }), /Timeout/);
  await explorer.getByRole('button', { name: nativeComponentsRoot ? 'Resource-05.md' : 'Read Resource-05.md', exact: true }).click();
  await filesView.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { name: 'Fictional Resource 5', exact: true }).waitFor();
  assertEverydayNoteRead(await page.evaluate(() => window.fixture.note), resourceFixture);
  assert.throws(() => assertEverydayResolvedTarget({ input: { topicId: 'fixture-area' } }, resourceFixture), /AssertionError/);
  assert.throws(() => assertEverydayNoteRead({ input: { topicId: 'fixture-area' } }, resourceFixture), /AssertionError/);
  assert.equal(await chatPane.evaluate(pane => pane.sessionKey), 'agent:main:fictional-primary');
  assert.equal(await chatPane.getByLabel('Chat composer', { exact: true }).inputValue(), 'Fictional draft retained through native creation Cancel.');
});
