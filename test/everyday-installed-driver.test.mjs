import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { EVERYDAY_SESSION_LABELS, FICTIONAL_TABLE, revealEverydayTopic, chooseEverydayAssignment, exerciseEverydayCreation, assertEverydayTable } from './support/everyday-native-workspace.mjs';

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
    window.fixture = { dispatchCount: 0, responseLost: false, armed: false, assignment: null, operation: null };
    const f = window.fixture;
    const claimedLabels = new Set();
    for (const role of ['areaPrimary', 'resourcePrimary', 'unassigned']) {
      if (claimedLabels.has(labels[role])) throw new Error('Native setup label already in use');
      claimedLabels.add(labels[role]);
    }
    f.seedLabels = [...claimedLabels];
    const host = { signal, connection: { connected: true, canRead: true, canWrite: true }, redact: x => x, subscribe: () => () => {},
      sessions: { async openChat({ sessionKey }) { await delay(); chat.sessionKey = sessionKey; } }, navigation: { async openPage() { await delay(); } },
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
          let active = true; let element; const draw = next => { if (!active) return; element?.remove(); element = document.createElement('div'); element.className = 'control-ui-file-explorer'; const button = document.createElement('button'); button.textContent = 'Read Overview.md'; button.onclick = () => next.onSelect('Overview.md'); element.append(button); container.append(element); };
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
        if (method.endsWith('sessions.resolve-native')) return { result: { sessionKey: 'agent:main:fictional-created' } };
        const sourceReference = { topicId: params.topicId, referenceId: 'fictional-note' };
        if (method.endsWith('notes.browse')) return { notes: [{ path: 'Overview.md', revision: 'r1', sourceReference }], total: 1, offset: 0, hasMore: false, cursor: 'fictional-catalog' };
        if (method.endsWith('notes.read')) return { path: params.path, revision: 'r1', sourceReference, contentEncoding: 'identity', contentBase64: btoa(text), byteOffset: 0, nextOffset: text.length, totalBytes: text.length, complete: true };
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
  await sidebar.getByRole('button', { name: 'Inbox / Unassigned (1)', exact: true }).click();
  await chooseEverydayAssignment(sidebar.getByRole('listitem').filter({ hasText: 'Fictional Inbox' }), { topicId: 'fixture-area', duplicateTopicId: 'fixture-resource', name: 'Fictional Same Name' });
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
});
