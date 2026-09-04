import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';
import { assertWebSocketDestination, TrafficGuard } from '../src/isolation.mjs';
import { createTopicPageActionsHandler } from '../src/topics/page-http.mjs';

const index = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const markdown = await readFile(new URL('../src/ui/markdown.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const fixtureIndex = index.replace('<script defer src="/plugins/command-center/app.js"></script>', '');
let browser;
let topicPageServer;
let topicPageBaseUrl;
const pageTrafficGuards = new WeakMap();

before(async () => {
  browser = await launchPinnedChromium();
  const guard = new TrafficGuard();
  guard.assert('127.0.0.1', 'Topic Page isolated browser fixture');
  topicPageServer = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/plugins/command-center') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixtureIndex); return; }
    if (pathname === '/plugins/command-center/styles.css') { response.setHeader('Content-Type', 'text/css; charset=utf-8'); response.end(styles); return; }
    if (pathname === '/plugins/command-center/app.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(app); return; }
    if (pathname === '/plugins/command-center/markdown.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(markdown); return; }
    response.statusCode = 404; response.end('Not found');
  });
  await new Promise((resolve, reject) => { topicPageServer.once('error', reject); topicPageServer.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  topicPageBaseUrl = `http://127.0.0.1:${topicPageServer.address().port}`;
  guard.assertClean();
});
after(async () => {
  await browser?.close();
  if (topicPageServer?.listening) await new Promise((resolve, reject) => topicPageServer.close((error) => error ? reject(error) : resolve()));
});

async function guardBrowserTraffic(page, source) {
  const guard = new TrafficGuard();
  pageTrafficGuards.set(page, guard);
  page.on('request', (request) => {
    let hostname = '';
    try { hostname = new URL(request.url()).hostname; } catch { /* malformed destinations stay prohibited */ }
    try { guard.assert(hostname, `${source} observed`); }
    catch { /* assertClean reports the bounded prohibited attempt after the controller egress boundary blocks it */ }
  });
  await page.route('**/*', async (route) => {
    let hostname = '';
    try { hostname = new URL(route.request().url()).hostname; } catch { /* malformed destinations stay prohibited */ }
    try { guard.assert(hostname, source); } catch { await route.abort(); return; }
    await route.continue();
  });
  await page.routeWebSocket('**/*', (socket) => {
    try { assertWebSocketDestination(guard, socket.url()); socket.connectToServer(); }
    catch { /* omitting connectToServer rejects prohibited sockets */ }
  });
}

async function closeGuardedPage(page) {
  try { pageTrafficGuards.get(page)?.assertClean(); }
  finally { pageTrafficGuards.delete(page); await page.close(); }
}

async function submit(page, selector) { await page.locator(selector).evaluate((form) => form.requestSubmit()); }

async function submitChatAndWaitForCompletion(page, message) {
  await page.locator('#chat-message').fill(message);
  await submit(page, '#chat-form');
  await page.waitForFunction((expectedMessage) => {
    const messageVisible = [...document.querySelectorAll('#chat-messages .chat-message')].some((node) => node.textContent?.includes(expectedMessage));
    const status = document.querySelector('#chat-status');
    const input = document.querySelector('#chat-message');
    const sendButton = document.querySelector('#chat-send');
    return messageVisible && status?.textContent === 'Message sent.' && input?.value === '' && sendButton?.disabled === false;
  }, message);
}

async function invokeTopicPageHandler(handler, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { method: 'POST', headers: { 'content-type': 'application/json' } });
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
  await handler(request, response);
  return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body: JSON.parse(response.body) };
}

function boundedOpaqueText(value, maximum = 160) {
  return String(value ?? 'unavailable').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, maximum);
}

function boundedOpaqueEvidence(value) {
  return JSON.stringify(value).slice(0, 2_048);
}

async function listenLoopback(server, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen({ host, port: 0 }, () => { server.off('error', onError); resolve(); });
  });
}

async function closeLoopbackServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('opaque sandboxed Topic Page frame preflights and applies through the real action handler', async () => {
  const guard = new TrafficGuard(); guard.assert('127.0.0.1', 'Topic Page preflight browser'); guard.assert('127.0.0.2', 'Topic Page action browser');
  const topicId = '11111111-1111-4111-8111-111111111111'; const methods = []; const preflightEvidence = []; const calls = [];
  let preflightComplete = false;
  const handler = createTopicPageActionsHandler({
    topics: { get: () => ({ topicId, revision: 4, lifecycle: 'active' }) },
    async sessionsCreate(input) { calls.push(input); return { status: 'applied' }; }
  });
  const actionServer = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/plugins/command-center/api/topic/actions') {
      methods.push(request.method);
      if (request.method === 'OPTIONS') {
        const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((value) => value.trim());
        const requestedMethod = request.headers['access-control-request-method'];
        const requestValid = request.headers.origin === 'null' && requestedMethod === 'POST' && requestedHeaders.includes('content-type');
        await handler(request, response);
        const responseValid = response.statusCode === 204 && response.getHeader('access-control-allow-origin') === 'null' && response.getHeader('access-control-allow-methods') === 'POST, OPTIONS' && response.getHeader('access-control-allow-headers') === 'Content-Type' && response.getHeader('access-control-allow-private-network') === 'true';
        preflightComplete = requestValid && responseValid;
        if (preflightEvidence.length < 4) preflightEvidence.push({
          origin: boundedOpaqueText(request.headers.origin ?? 'absent', 32),
          method: boundedOpaqueText(request.headers['access-control-request-method'] ?? 'absent', 16),
          headers: boundedOpaqueText(request.headers['access-control-request-headers'] ?? 'absent', 64),
          privateNetwork: boundedOpaqueText(request.headers['access-control-request-private-network'] ?? 'absent', 16),
          status: response.statusCode,
          mutationCalls: calls.length,
          allowOrigin: boundedOpaqueText(response.getHeader('access-control-allow-origin') ?? 'absent', 32),
          allowMethods: boundedOpaqueText(response.getHeader('access-control-allow-methods') ?? 'absent', 32),
          allowHeaders: boundedOpaqueText(response.getHeader('access-control-allow-headers') ?? 'absent', 32),
          allowPrivateNetwork: boundedOpaqueText(response.getHeader('access-control-allow-private-network') ?? 'absent', 16)
        });
        return;
      }
      if (request.method === 'POST' && !preflightComplete) {
        response.statusCode = 428;
        response.setHeader('Access-Control-Allow-Origin', 'null');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'preflight-required' }));
        return;
      }
      await handler(request, response); return;
    }
    response.statusCode = 404; response.end('Not found');
  });
  let actionUrl;
  const frameServer = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (pathname === '/frame') {
      response.end(`<p id="result">pending</p><script>
        const terminal = document.querySelector('#result');
        const bounded = (value) => String(value ?? 'unavailable').replace(/[\\u0000-\\u001f\\u007f]/gu, ' ').slice(0, 160);
        const fail = (failedPhase, detail) => { terminal.textContent = 'failed:' + failedPhase + ':' + bounded(detail); };
        globalThis.runOpaqueAction = async () => {
          let phase = 'POST';
          try {
            const response = await fetch('${actionUrl}', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action: 'conversations.create', topicId: '${topicId}', label: 'Opaque Fictional Conversation', expectedRevision: 4, logicalOperationId: '33333333-3333-4333-8333-333333333333', authoritativeSession: { key: 'agent:main:dashboard:opaque', sessionId: 'opaque-session', revision: '1', idempotencyKey: '33333333-3333-4333-8333-333333333333', label: 'Opaque Fictional Conversation' } }) });
            phase = 'http-status';
            if (!response.ok) { fail(phase, response.status); return; }
            phase = 'json-parse';
            let value;
            try { value = await response.json(); }
            catch (error) { fail(phase, error?.name); return; }
            phase = 'POST';
            if (value?.status !== 'applied') { fail(phase, value?.status); return; }
            terminal.textContent = 'applied';
          } catch (error) {
            fail('fetch-rejection', error?.name);
          }
        };
      </script>`);
      return;
    }
    response.end('<iframe title="Opaque Topic Page" sandbox="allow-scripts" src="/frame"></iframe>');
  });
  try {
    await listenLoopback(actionServer, '127.0.0.2');
    const actionAddress = actionServer.address();
    actionUrl = `http://127.0.0.2:${actionAddress.port}/plugins/command-center/api/topic/actions`;
    await listenLoopback(frameServer, '127.0.0.1');
  } catch (error) {
    try { await closeLoopbackServer(frameServer); }
    finally { await closeLoopbackServer(actionServer); }
    assert.fail(`opaque frame setup failed: ${boundedOpaqueEvidence({ phase: 'servers-listen', error: boundedOpaqueText(error?.message) })}`);
  }
  const frameAddress = frameServer.address();
  let context;
  let page;
  const requestFailures = [];
  const consoleEvidence = [];
  try {
    context = await browser.newContext();
    page = await context.newPage();
  } catch (error) {
    try { if (page) await closeGuardedPage(page); }
    finally {
      try { if (context) await context.close(); }
      finally {
        try { await closeLoopbackServer(frameServer); }
        finally { await closeLoopbackServer(actionServer); }
      }
    }
    assert.fail(`opaque frame setup failed: ${boundedOpaqueEvidence({ phase: 'browser-context', error: boundedOpaqueText(error?.message) })}`);
  }
  page.on('requestfailed', (request) => {
    if (requestFailures.length >= 8) return;
    let path = 'unparseable';
    try { path = new URL(request.url()).pathname; } catch { /* retain bounded fallback */ }
    requestFailures.push({ method: request.method(), path: boundedOpaqueText(path), error: boundedOpaqueText(request.failure()?.errorText) });
  });
  page.on('console', (message) => {
    if (consoleEvidence.length < 8) consoleEvidence.push({ type: boundedOpaqueText(message.type(), 32), text: boundedOpaqueText(message.text()) });
  });
  try {
    await guardBrowserTraffic(page, 'Topic Page preflight browser');
    await page.goto(`http://127.0.0.1:${frameAddress.port}/`);
    const result = page.frameLocator('iframe').locator('#result');
    await result.waitFor();
    // Playwright HTTP routing can bypass Chromium's CORS machinery. Release it only
    // after the isolated fixture is loaded so the opaque frame produces a genuine
    // browser-generated OPTIONS request before its JSON POST.
    await page.unroute('**/*');
    await result.evaluate(() => globalThis.runOpaqueAction());
    try {
      await result.filter({ hasText: /^(?:applied|failed:)/u }).waitFor({ timeout: 10_000 });
    } catch {
      const terminal = await result.textContent().catch(() => 'unavailable');
      assert.fail(`opaque frame did not reach a terminal result: ${boundedOpaqueEvidence({ terminal: boundedOpaqueText(terminal), methods: methods.slice(0, 8), preflightEvidence, requestFailures, consoleEvidence })}`);
    }
    const terminal = await result.textContent();
    const failedBoundary = methods.includes('OPTIONS') && !methods.includes('POST') ? 'post-dispatch' : methods.length === 0 ? 'preflight-dispatch' : 'response';
    assert.equal(terminal, 'applied', `opaque frame action failed: ${boundedOpaqueEvidence({ failedBoundary, terminal: boundedOpaqueText(terminal), methods: methods.slice(0, 8), preflightEvidence, requestFailures, consoleEvidence })}`);
    assert.equal(methods[0], 'OPTIONS');
    assert.equal(methods.filter((method) => method === 'OPTIONS').length >= 1, true);
    assert.equal(preflightComplete, true, `opaque frame preflight contract failed: ${boundedOpaqueEvidence(preflightEvidence)}`);
    assert.equal(preflightEvidence.length, 1);
    assert.equal(preflightEvidence[0].origin, 'null');
    assert.equal(preflightEvidence[0].method, 'POST');
    assert.equal(preflightEvidence[0].headers.split(',').map((value) => value.trim()).includes('content-type'), true);
    assert.equal(preflightEvidence.every((evidence) => evidence.status === 204), true);
    assert.equal(preflightEvidence.every((evidence) => evidence.mutationCalls === 0), true);
    assert.equal(preflightEvidence.every((evidence) => evidence.allowOrigin === 'null'), true);
    assert.equal(preflightEvidence.every((evidence) => evidence.allowMethods === 'POST, OPTIONS'), true);
    assert.equal(preflightEvidence.every((evidence) => evidence.allowHeaders === 'Content-Type'), true);
    assert.equal(preflightEvidence.every((evidence) => evidence.allowPrivateNetwork === 'true'), true);
    assert.equal(methods.filter((method) => method === 'POST').length, 1);
    assert.equal(methods.every((method) => method === 'OPTIONS' || method === 'POST'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].isPrimary, false);
    guard.assertClean();
  } finally {
    try {
      if (page) await closeGuardedPage(page);
    } finally {
      try { if (context) await context.close(); }
      finally {
        try { await closeLoopbackServer(frameServer); }
        finally { await closeLoopbackServer(actionServer); }
      }
    }
  }
});

async function setupPage({ width = 1200, height = 900, queryless = false, reducedMotion = 'no-preference' } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  await guardBrowserTraffic(page, 'Topic Page browser');
  const topicId = '11111111-1111-4111-8111-111111111111';
  const topicBId = '22222222-2222-4222-8222-222222222222';
  const topicBPrimaryId = 'session:fictional-topic-b:primary';
  const folderId = 'note-folder:fictional-topic';
  const noteRoot = '/fictional/notes/topic';
  const routeTopics = new Map([
    [topicId, { topicId, revision: 4, lifecycle: 'active' }],
    [topicBId, { topicId: topicBId, revision: 2, lifecycle: 'active' }]
  ]);
  const routeReferences = new Map([
    [folderId, { referenceId: folderId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: noteRoot, observedRevision: 'folder-revision' }],
    ['note:fictional-topic:brief', { referenceId: 'note:fictional-topic:brief', topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${noteRoot}/nested/brief.md`, observedRevision: 'note-revision' }],
    ['note:fictional-topic:other', { referenceId: 'note:fictional-topic:other', topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${noteRoot}/nested/deeper/other.md`, observedRevision: 'other-revision' }],
    ...['primary', 'conversation', 'closed'].map((suffix) => [`session:fictional-topic:${suffix}`, { referenceId: `session:fictional-topic:${suffix}`, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: `agent:main:${suffix}`, observedRevision: null }])
  ]);
  routeReferences.set(topicBPrimaryId, { referenceId: topicBPrimaryId, topicId: topicBId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:topic-b-primary', observedRevision: null });
  const routeService = {
    topics: { get(requestedTopicId) { return routeTopics.get(requestedTopicId) ?? null; } },
    getTopicSourceReference({ topicId: requestedTopicId, referenceId }) { const source = routeReferences.get(referenceId); if (!source || source.topicId !== requestedTopicId) throw Object.assign(new Error('missing source'), { code: 'source-recovery' }); return source; },
    listTopicSourceReferences(requestedTopicId) { return [...routeReferences.values()].filter((source) => source.topicId === requestedTopicId); },
    async sessionsCreate(input) { const referenceId = 'session:fictional-topic:created-3'; routeReferences.set(referenceId, { referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:created-3', observedRevision: null }); return { status: 'applied' }; },
    async sessionsSend() { return { status: 'applied' }; },
    async sessionsClose() { return { status: 'applied' }; },
    async sessionsReopen() { return { status: 'applied' }; },
    async notesCreate(input) { const referenceId = `note:fictional-topic:${input.path}`; const revision = 'created-revision-2'; routeReferences.set(referenceId, { referenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${noteRoot}/${input.path}`, observedRevision: revision }); return { status: 'applied', note: { path: input.path, revision } }; },
    async notesEdit(input) { if (input.text.includes('Unsaved fictional draft.')) throw Object.assign(new Error('conflict'), { code: 'conflict' }); const revision = 'saved-revision'; const source = routeReferences.get(input.referenceId); routeReferences.set(input.referenceId, { ...source, observedRevision: revision }); return { status: 'applied', note: { path: input.path, revision } }; },
    async notesRename(input) { return moveRouteNote(input, 'notes.rename-revision'); },
    async notesMove(input) { return moveRouteNote(input, 'notes.move-revision'); }
  };
  function moveRouteNote(input, revision) { const source = routeReferences.get(input.referenceId); routeReferences.delete(input.referenceId); const referenceId = `note:fictional-topic:${input.destinationPath}`; routeReferences.set(referenceId, { ...source, referenceId, externalSourceId: `${noteRoot}/${input.destinationPath}`, observedRevision: revision }); return { status: 'applied', note: { path: input.destinationPath, previousPath: input.path, revision } }; }
  const actionHandler = createTopicPageActionsHandler(routeService);
  await page.exposeFunction('__invokeTopicPageAction', (body) => invokeTopicPageHandler(actionHandler, body));
  await page.goto(`${topicPageBaseUrl}/plugins/command-center${queryless ? '' : `?topicId=${topicId}`}`);
  assert.equal(await page.evaluate(() => globalThis.isSecureContext), true);
  assert.equal(await page.evaluate(() => typeof globalThis.crypto.randomUUID), 'function');
  await page.evaluate(() => {
    const topicId = '11111111-1111-4111-8111-111111111111';
    const folderId = 'note-folder:fictional-topic';
    const primaryId = 'session:fictional-topic:primary';
    const conversationId = 'session:fictional-topic:conversation';
    const closedId = 'session:fictional-topic:closed';
    const topicBId = '22222222-2222-4222-8222-222222222222';
    const topicBPrimaryId = 'session:fictional-topic-b:primary';
    const noteReference = (path, revision, referenceId = `note:fictional-topic:${path}`) => ({ referenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `fictional/${path}`, observedRevision: revision });
    const topic = { topicId, name: 'Fictional Topic with a deliberately long responsive workspace name', revision: 4, paraCategory: 'project', lifecycle: 'active', usable: true, health: 'ready', recovery: [], sourceReferences: [
      { referenceId: folderId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', observedRevision: 'folder-revision' },
      noteReference('nested/brief.md', 'note-revision', 'note:fictional-topic:brief'),
      noteReference('nested/deeper/other.md', 'other-revision', 'note:fictional-topic:other'),
      noteReference('nested/utf8-boundary.md', 'utf8-boundary-revision', 'note:fictional-topic:utf8-boundary'),
      ...[primaryId, conversationId, closedId].map((referenceId) => ({ referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', observedRevision: null }))
    ] };
    const topicBNote = noteReference('topic-b.md', 'topic-b-note-revision', 'note:fictional-topic-b:brief'); topicBNote.topicId = topicBId; topicBNote.externalSourceId = 'fictional-topic-b/topic-b.md';
    const topicB = { topicId: topicBId, name: 'Second Fictional Topic', revision: 2, paraCategory: 'area', lifecycle: 'active', usable: true, health: 'ready', recovery: [], sourceReferences: [{ referenceId: 'note-folder:fictional-topic-b', topicId: topicBId, sourceSystem: 'obsidian', sourceKind: 'note_folder', observedRevision: 'folder-b-revision' }, topicBNote, { referenceId: topicBPrimaryId, topicId: topicBId, sourceSystem: 'openclaw', sourceKind: 'session', observedRevision: null }] };
    const destinationTopic = (value) => {
      const { sourceReferences: _privateReferences, ...publicTopic } = value;
      return { ...publicTopic, noteFolderReferenceId: value.sourceReferences.find((reference) => reference.sourceKind === 'note_folder').referenceId };
    };
    const topicBConversation = { referenceId: topicBPrimaryId, topicId: topicBId, sessionId: 'topic-b-primary-session-id', sessionKey: 'agent:main:topic-b-primary', displayName: 'Second Topic Primary', status: 'open', isPrimary: true, wasPrimary: false, updatedAt: '2026-08-27T00:00:00.000Z' };
    let conversations = [
      { referenceId: primaryId, topicId, sessionId: 'primary-session-id', sessionKey: 'agent:main:primary', displayName: 'Primary Conversation', status: 'open', isPrimary: true, wasPrimary: false, updatedAt: '2026-08-27T00:00:00.000Z' },
      { referenceId: conversationId, topicId, sessionId: 'conversation-session-id', sessionKey: 'agent:main:conversation', displayName: 'Independent Conversation', status: 'open', isPrimary: false, wasPrimary: false, updatedAt: '2026-08-27T00:00:00.000Z' },
      { referenceId: closedId, topicId, sessionId: 'closed-session-id', sessionKey: 'agent:main:closed', displayName: 'Closed Conversation', status: 'closed', isPrimary: false, wasPrimary: false, updatedAt: '2026-08-27T00:00:00.000Z' }
    ];
    const structuredNoteReference = { kind: 'note', topicId, referenceId: 'note:fictional-topic:brief', path: 'nested/brief.md', heading: null, observedRevision: 'note-revision' };
    const histories = {
      [primaryId]: [{ role: 'user', content: 'Imported immutable prefix' }, { role: 'assistant', content: 'Native suffix after import' }, { role: 'assistant', content: 'Structured context result', details: structuredNoteReference }, { role: 'assistant', content: 'Free-form [Note](nested/brief.md) is not authoritative.' }],
      [conversationId]: [{ role: 'assistant', content: 'Independent transcript only' }],
      [closedId]: [{ role: 'assistant', content: 'Closed searchable transcript' }],
      [topicBPrimaryId]: [{ role: 'assistant', content: 'Second Topic isolated transcript' }]
    };
    let notes = [
      { path: 'nested/brief.md', text: '# Fictional Brief\n\nAuthoritative brief.', revision: 'note-revision', sourceReference: noteReference('nested/brief.md', 'note-revision', 'note:fictional-topic:brief') },
      { path: 'nested/deeper/other.md', text: '# Other Note\n\nIndependent bytes.', revision: 'other-revision', sourceReference: noteReference('nested/deeper/other.md', 'other-revision', 'note:fictional-topic:other') },
      { path: 'nested/utf8-boundary.md', text: `${'x'.repeat(524287)}é terminal`, revision: 'utf8-boundary-revision', sourceReference: noteReference('nested/utf8-boundary.md', 'utf8-boundary-revision', 'note:fictional-topic:utf8-boundary') },
      { path: 'topic-b.md', text: '# Topic B Note\n\nSecond Topic authoritative bytes.', revision: 'topic-b-note-revision', sourceReference: topicBNote }
    ];
    const copy = (value) => structuredClone(value);
    const noteChunk = (note, offset = 0) => { const bytes = note ? new TextEncoder().encode(note.text) : new Uint8Array(); const nextOffset = Math.min(offset + 524288, bytes.length); let binary = ''; for (let index = offset; index < nextOffset; index += 1) binary += String.fromCharCode(bytes[index]); return note ? { schemaVersion: 1, path: note.path, contentBase64: btoa(binary), byteOffset: offset, nextOffset, totalBytes: bytes.length, revision: note.revision, complete: nextOffset === bytes.length, sourceReference: note.sourceReference } : {}; };
    const browseNotes = (params) => { const rows = notes.filter((note) => note.sourceReference.topicId === params.topicId).map(({ text: _text, ...note }) => note); if (!fixture.serverPageNotes) return rows; const offset = params.offset ?? 0; const limit = params.limit ?? 100; const page = rows.slice(offset, offset + limit); const nextOffset = offset + page.length < rows.length ? offset + page.length : null; return { schemaVersion: 1, notes: page, total: rows.length, offset, nextOffset, hasMore: nextOffset !== null, cursor: fixture.notesCursor }; };
    const respond = (requestId, result, error = null) => window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId, ...(error ? { error } : { result: copy(result) }) } }, '*');
    const fixture = globalThis.__topicPageFixture = {
      topicId, folderId, primaryId, conversationId, closedId, topic, topicB, topicBPrimaryId, conversations, calls: [], failNextNoteEdit: false, foreignNextNoteRead: false, deferNoteEdit: false, noteEditPending: false, noteEditResolver: null, deferSend: false, sendPending: false, deferredSendResolvers: [], interruptNextSendResponse: false, appliedSendOperations: new Set(), completedSends: 0, deliveredActionResponses: 0, deliveredBridgeResponses: 0, unknownNextSessionCreate: false, deferConversationCreate: false, conversationCreatePending: false, conversationCreateResolver: null, interruptNextConversationCreateResponse: false, appliedConversationCreateOperations: new Set(), deferSearch: false, searchPending: false, searchResolver: null, completedSearches: 0, deferProjectionRebuild: false, projectionRebuildPending: false, projectionRebuildResolver: null, deferNavigateReference: null, deferredNavigate: null, deferHistoryReferences: new Set(), deferredHistories: new Map(), deferNoteReadPath: null, deferredNoteRead: null, deferTopicGetId: null, deferredTopicGet: null, histories,
      serverPageNotes: false, notesCursor: 'opaque-fixture-notes-snapshot',
      setScaleNotes(count) { notes = notes.filter((note) => note.sourceReference.topicId !== topicId); for (let index = 0; index < count; index += 1) { const path = `scale/note-${String(index).padStart(4, '0')}.md`; notes.push({ path, text: `# Scale ${index}`, revision: `scale-revision-${index}`, sourceReference: noteReference(path, `scale-revision-${index}`) }); } },
      deferNotesBrowse: false, notesBrowsePending: false, notesBrowseRequest: null,
      resolveNotesBrowse() { if (!this.notesBrowseRequest) return; const request = this.notesBrowseRequest; this.notesBrowseRequest = null; this.notesBrowsePending = false; respond(request.requestId, browseNotes(request.params)); },
      rejectDeferredHistory(referenceId) { const deferred = this.deferredHistories.get(referenceId); if (!deferred) return; this.deferredHistories.delete(referenceId); respond(deferred.requestId, null, { code: 'unavailable', message: 'Delayed fictional history failure.' }); },
      resolveDeferredHistory(referenceId) { const deferred = this.deferredHistories.get(referenceId); if (!deferred) return; this.deferredHistories.delete(referenceId); respond(deferred.requestId, { messages: histories[referenceId] ?? [] }); },
      resolveDeferredNoteRead() { if (!this.deferredNoteRead) return; const deferred = this.deferredNoteRead; this.deferredNoteRead = null; respond(deferred.requestId, noteChunk(notes.find((note) => note.path === deferred.path), deferred.offset)); },
      rejectDeferredNoteRead() { if (!this.deferredNoteRead) return; const deferred = this.deferredNoteRead; this.deferredNoteRead = null; respond(deferred.requestId, null, { code: 'unavailable', message: 'Delayed fictional Note failure.' }); },
      resolveDeferredNoteEdit() { this.noteEditResolver?.(); this.noteEditResolver = null; },
      resolveDeferredSend() { this.deferredSendResolvers.shift()?.(); },
      resolveDeferredConversationCreate() { this.conversationCreateResolver?.(); this.conversationCreateResolver = null; },
      resolveDeferredNavigate() { if (!this.deferredNavigate) return; const deferred = this.deferredNavigate; this.deferredNavigate = null; respond(deferred.requestId, deferred.result); },
      resolveDeferredSearch() { this.searchResolver?.(); this.searchResolver = null; },
      resolveProjectionRebuild() { this.projectionRebuildResolver?.(); this.projectionRebuildResolver = null; },
      resolveDeferredTopicGet() { if (!this.deferredTopicGet) return; const deferred = this.deferredTopicGet; this.deferredTopicGet = null; respond(deferred.requestId, { topic: deferred.topic }); },
      async waitForApplicationSettlement(channel, target) {
        const field = channel === 'action' ? 'deliveredActionResponses' : 'deliveredBridgeResponses';
        while (this[field] < target) await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    };

    globalThis.fetch = async (_url, options) => {
      if (String(_url).endsWith('/api/search/rebuild')) { if (fixture.deferProjectionRebuild) { fixture.deferProjectionRebuild = false; fixture.projectionRebuildPending = true; await new Promise((resolve) => { fixture.projectionRebuildResolver = resolve; }); fixture.projectionRebuildPending = false; } return { ok: true, status: 200, async json() { return { schemaVersion: 1, status: 'applied' }; } }; }
      const body = JSON.parse(options.body); fixture.calls.push({ transport: 'http', ...copy(body) });
      const routed = await globalThis.__invokeTopicPageAction(body);
      if (!routed.ok) return { ok: false, status: routed.status, async json() { fixture.deliveredActionResponses += 1; return routed.body; } };
      if (body.action === 'conversations.create' && fixture.deferConversationCreate) { fixture.deferConversationCreate = false; fixture.conversationCreatePending = true; await new Promise((resolve) => { fixture.conversationCreateResolver = resolve; }); fixture.conversationCreatePending = false; }
      if (body.action === 'conversations.create' && !fixture.appliedConversationCreateOperations.has(body.logicalOperationId)) { fixture.appliedConversationCreateOperations.add(body.logicalOperationId); const referenceId = `session:fictional-topic:created-${conversations.length}`; const created = { referenceId, topicId, sessionId: `created-session-${conversations.length}`, sessionKey: `agent:main:created-${conversations.length}`, displayName: body.label, status: 'open', isPrimary: false, wasPrimary: false, updatedAt: '2026-08-27T00:01:00.000Z' }; conversations = [...conversations, created]; histories[referenceId] = []; }
      if (body.action === 'conversations.create' && fixture.interruptNextConversationCreateResponse) { fixture.interruptNextConversationCreateResponse = false; throw new TypeError('Fictional interrupted Conversation create response.'); }
      if (body.action === 'conversations.close' || body.action === 'conversations.reopen') conversations = conversations.map((item) => item.referenceId === body.referenceId ? { ...item, status: body.action.endsWith('close') ? 'closed' : 'open' } : item);
      const decodedText = body.contentBase64 === undefined ? undefined : new TextDecoder().decode(Uint8Array.from(atob(body.contentBase64), (character) => character.charCodeAt(0)));
      if (body.action === 'notes.create') notes = [...notes, { path: body.path, text: decodedText, revision: `created-revision-${notes.length}`, sourceReference: noteReference(body.path, `created-revision-${notes.length}`) }];
      if (body.action === 'notes.rename' || body.action === 'notes.move') notes = notes.map((note) => note.path === body.path ? { ...note, path: body.destinationPath, revision: `${body.action}-revision`, sourceReference: noteReference(body.destinationPath, `${body.action}-revision`) } : note);
      if (body.action === 'notes.edit' && fixture.deferNoteEdit) { fixture.deferNoteEdit = false; fixture.noteEditPending = true; await new Promise((resolve) => { fixture.noteEditResolver = resolve; }); fixture.noteEditPending = false; }
      if (body.action === 'notes.edit') notes = notes.map((note) => note.path === body.path ? { ...note, text: decodedText, revision: 'saved-revision', sourceReference: { ...note.sourceReference, observedRevision: 'saved-revision' } } : note);
      const changed = notes.find((note) => note.path === (body.destinationPath ?? body.path));
      return { ok: true, status: routed.status, async json() { fixture.deliveredActionResponses += 1; return routed.body; } };
    };

    window.addEventListener('message', async (event) => {
      if (event.data?.type !== 'openclaw:capability-bridge-send') return;
      const payload = event.data.payload;
      if (payload.type === 'openclaw:capability-bridge-hello') { window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.sources.status', 'command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.sessions.send', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'sessions.create', 'ui.session.navigate'] } }, '*'); return; }
      if (payload.type !== 'openclaw:capability-bridge-request') return;
      fixture.calls.push({ transport: 'bridge', method: payload.method, params: copy(payload.params), operationId: payload.operationId });
      if (payload.method === 'sessions.create' && fixture.unknownNextSessionCreate) { fixture.unknownNextSessionCreate = false; respond(payload.requestId, null, { code: 'MUTATION_OUTCOME_UNKNOWN', message: 'Fictional unknown Session creation outcome.' }); return; }
      let result = {};
      if (payload.method.endsWith('sources.status')) result = { schemaVersion: 1, mode: 'ready', unavailableCapabilities: [] };
      if (payload.method.endsWith('topics.list')) result = { activeGroups: { project: [destinationTopic(topic), destinationTopic(topicB)], area: [], resource: [] }, provisioning: [], recovery: [], archived: [] };
      if (payload.method.endsWith('topics.get')) { const requestedTopic = payload.params.topicId === topicBId ? topicB : topic; if (fixture.deferTopicGetId === payload.params.topicId) { fixture.deferTopicGetId = null; fixture.deferredTopicGet = { requestId: payload.requestId, topic: requestedTopic }; return; } result = { topic: requestedTopic }; }
      if (payload.method === 'sessions.create') result = { key: `agent:main:dashboard:bridge-fictional-${payload.operationId}`, sessionId: `created-${payload.operationId}`, revision: '1' };
      if (payload.method === 'command-center.v1.sessions.send') {
        const item = [...conversations, topicBConversation].find((conversation) => conversation.referenceId === payload.params.referenceId && conversation.topicId === payload.params.topicId);
        if (!item) { respond(payload.requestId, null, { code: 'INVALID_REQUEST', message: 'Fictional unknown Session reference.' }); return; }
        const defer = fixture.deferSend === true || Number.isInteger(fixture.deferSend) && fixture.deferSend > 0;
        if (defer) { fixture.deferSend = fixture.deferSend === true ? false : fixture.deferSend - 1; fixture.sendPending = true; await new Promise((resolve) => { fixture.deferredSendResolvers.push(resolve); }); fixture.sendPending = fixture.deferredSendResolvers.length > 0; }
        if (!fixture.appliedSendOperations.has(payload.operationId)) { fixture.appliedSendOperations.add(payload.operationId); histories[item.referenceId].push({ role: 'user', content: payload.params.message }); }
        fixture.completedSends += 1;
        if (fixture.interruptNextSendResponse) { fixture.interruptNextSendResponse = false; respond(payload.requestId, null, { code: 'MUTATION_OUTCOME_UNKNOWN', message: 'Fictional interrupted send response.' }); return; }
        result = { schemaVersion: 1, status: 'applied', logicalOperationId: payload.operationId };
      }
      if (payload.method.endsWith('sessions.browse')) { const topicConversations = payload.params.topicId === topicBId ? [topicBConversation] : conversations; result = { schemaVersion: 1, topicId: payload.params.topicId, conversations: topicConversations.filter((item) => payload.params.includeClosed === true || item.status === 'open').map(({ sessionKey: _private, ...item }) => item) }; }
      if (payload.method.endsWith('sessions.history')) { if (fixture.deferHistoryReferences.has(payload.params.referenceId)) { fixture.deferHistoryReferences.delete(payload.params.referenceId); fixture.deferredHistories.set(payload.params.referenceId, { requestId: payload.requestId }); return; } result = { messages: histories[payload.params.referenceId] ?? [] }; }
      if (payload.method.endsWith('sessions.navigate')) { const item = [...conversations, topicBConversation].find((conversation) => conversation.referenceId === payload.params.referenceId); result = item ? { schemaVersion: 1, status: 'applied', sessionKey: item.sessionKey, sessionId: item.sessionId, sourceReference: { referenceId: item.referenceId, topicId: item.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: item.sessionKey, observedRevision: null } } : {}; if (fixture.deferNavigateReference === payload.params.referenceId) { fixture.deferNavigateReference = null; fixture.deferredNavigate = { requestId: payload.requestId, result }; return; } }
      if (payload.method.endsWith('notes.browse')) { if (fixture.deferNotesBrowse && payload.params.topicId === topicId) { fixture.deferNotesBrowse = false; fixture.notesBrowsePending = true; fixture.notesBrowseRequest = { requestId: payload.requestId, params: copy(payload.params) }; return; } result = browseNotes(payload.params); }
      if (payload.method.endsWith('notes.read')) {
        if (fixture.deferNoteReadPath === payload.params.path) { fixture.deferNoteReadPath = null; fixture.deferredNoteRead = { requestId: payload.requestId, path: payload.params.path, offset: payload.params.offset }; return; }
        result = noteChunk(notes.find((item) => item.path === payload.params.path), payload.params.offset);
        if (fixture.foreignNextNoteRead && result.sourceReference) { fixture.foreignNextNoteRead = false; result = { ...result, sourceReference: { ...result.sourceReference, topicId: topicBId } }; }
      }
      if (payload.method.endsWith('search.query')) {
        const brief = notes.find((note) => note.path === 'nested/brief.md') ?? notes[0];
        const query = payload.params.query.toLowerCase();
        const closed = conversations.find((conversation) => conversation.status === 'closed' && conversation.displayName.toLowerCase().includes(query)) ?? conversations.find((conversation) => conversation.referenceId === closedId);
        result = {
          schemaVersion: 1, topicId: payload.params.topicId, query: payload.params.query,
          notes: { results: payload.params.topicId === topicBId ? [] : [{ path: brief.path, heading: 'Fictional Brief', snippet: query === 'stale' ? 'Stale revision Note result' : query === 'older query' ? 'Older Search result' : query === 'newer query' ? 'Newer Search result' : 'Grouped Note result', navigation: { kind: 'note', topicId, referenceId: brief.sourceReference.referenceId, path: brief.path, heading: null, observedRevision: query === 'stale' ? 'stale-revision' : brief.revision } }] },
          conversations: { results: payload.params.topicId === topicBId ? [] : [{ conversationName: closed.displayName, snippet: 'Grouped Closed Conversation result', provenance: { role: 'topic-conversation', status: closed.status, importedPrimaryHistory: false }, navigation: { kind: 'conversation', topicId, referenceId: closed.referenceId, sessionKey: closed.sessionKey, sessionId: closed.sessionId, messageId: 'closed-message-1' } }] }
        };
        if (fixture.deferSearch) { fixture.deferSearch = false; fixture.searchPending = true; await new Promise((resolve) => { fixture.searchResolver = resolve; }); fixture.searchPending = false; }
      }
      respond(payload.requestId, result);
      if (payload.method.endsWith('search.query')) fixture.completedSearches += 1;
    });
  });
  await page.addScriptTag({ url: `${topicPageBaseUrl}/plugins/command-center/app.js` });
  await page.evaluate(() => window.addEventListener('message', (event) => {
    if (event.data?.type === 'openclaw:capability-bridge-receive' && event.data.payload?.type === 'openclaw:capability-bridge-response') globalThis.__topicPageFixture.deliveredBridgeResponses += 1;
  }));
  if (queryless) {
    await page.getByText('Topics are current.').waitFor();
    return page;
  }
  await page.getByText('Imported immutable prefix').waitFor();
  await page.getByText('Topic workspace ready.').waitFor();
  return page;
}

test('queryless external tab browses Topics and opens the selected workspace', async () => {
  const page = await setupPage({ queryless: true });
  try {
    const row = page.locator('.topic-row').filter({ hasText: 'Fictional Topic with a deliberately long responsive workspace name' });
    await row.getByRole('button', { name: 'Open Topic' }).click();
    await page.getByText('Topic workspace ready.').waitFor();
    await page.getByRole('button', { name: 'New Note' }).click();
    await page.locator('#note-action-path').fill('queryless-created.md');
    await page.locator('#note-action-text').fill('# Queryless creation');
    await submit(page, '#note-action-form');
    await page.getByRole('heading', { name: 'queryless-created.md', exact: true }).waitFor();
    const openEvidence = await page.evaluate(() => ({
      topicGets: globalThis.__topicPageFixture.calls.filter((call) => call.method === 'command-center.v1.topics.get').length,
      createReferenceId: globalThis.__topicPageFixture.calls.find((call) => call.action === 'notes.create' && call.path === 'queryless-created.md')?.referenceId
    }));
    assert.deepEqual(openEvidence, { topicGets: 0, createReferenceId: 'note-folder:fictional-topic' });
    const listCalls = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.method === 'command-center.v1.topics.list').length);
    await page.locator('#workspace-back').click();
    await page.waitForFunction((previous) => globalThis.__topicPageFixture.calls.filter((call) => call.method === 'command-center.v1.topics.list').length > previous, listCalls);
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'topics-heading');
  } finally { await closeGuardedPage(page); }
});

test('workspace readiness does not wait for initial Primary history', async () => {
  const page = await setupPage({ queryless: true });
  try {
    await page.evaluate(() => globalThis.__topicPageFixture.deferHistoryReferences.add(globalThis.__topicPageFixture.primaryId));
    const row = page.locator('.topic-row').filter({ hasText: 'Fictional Topic with a deliberately long responsive workspace name' });
    await row.getByRole('button', { name: 'Open Topic' }).click();
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredHistories.has(globalThis.__topicPageFixture.primaryId));
    await page.getByText('Topic workspace ready.').waitFor({ timeout: 1_000 });
    assert.equal(await page.locator('#chat-conversation-name').textContent(), 'Primary Conversation');
    assert.equal(await page.locator('#chat-messages .chat-message').count(), 0);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredHistory(globalThis.__topicPageFixture.primaryId));
    await page.getByText('Imported immutable prefix').waitFor();
  } finally { await closeGuardedPage(page); }
});

test('workspace shell readiness does not wait for independent Notes hydration', async () => {
  const page = await setupPage({ queryless: true });
  try {
    await page.evaluate(() => { const fixture = globalThis.__topicPageFixture; fixture.deferNotesBrowse = true; fixture.deferTopicGetId = fixture.topicId; });
    const row = page.locator('.topic-row').filter({ hasText: 'Fictional Topic with a deliberately long responsive workspace name' });
    await row.getByRole('button', { name: 'Open Topic' }).click();
    await page.waitForFunction(() => globalThis.__topicPageFixture.notesBrowsePending === true);
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.deferredTopicGet), null);
    await page.getByText('Topic workspace ready.').waitFor({ timeout: 1_000 });
    await page.getByText('Loading Notes…', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#chat-conversation-name')?.textContent === 'Primary Conversation');
    await page.evaluate(() => globalThis.__topicPageFixture.resolveNotesBrowse());
    await page.getByText('3 Notes.', { exact: true }).waitFor();
  } finally { await closeGuardedPage(page); }
});

test('Conversation pane keeps a 51-record authoritative catalog in a bounded 50-row window', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => {
      const fixture = globalThis.__topicPageFixture;
      for (let index = fixture.conversations.length; index < 51; index += 1) fixture.conversations.push({ referenceId: `session:fictional-topic:scale-${index}`, topicId: fixture.topicId, sessionId: `scale-session-${index}`, sessionKey: `agent:main:scale-${index}`, displayName: `Scale Conversation ${index}`, status: 'open', isPrimary: false, wasPrimary: false, updatedAt: '2026-08-27T00:00:00.000Z' });
    });
    await page.locator('#conversation-view').selectOption('all');
    await page.getByText('51 Conversations.', { exact: true }).waitFor();
    assert.equal(await page.locator('#conversation-list .conversation-item').count(), 50);
    await page.locator('#conversation-next').click();
    await page.getByText('Page 2 of 2', { exact: true }).waitFor();
    assert.equal(await page.locator('#conversation-list .conversation-item').count(), 1);
    assert.deepEqual(await page.locator('#conversation-list .conversation-item').evaluate((row) => ({ referenceId: row.dataset.referenceId, sessionId: row.dataset.sessionId })), { referenceId: 'session:fictional-topic:scale-50', sessionId: 'scale-session-50' });
    await page.getByRole('button', { name: 'Scale Conversation 50', exact: true }).click();
    assert.equal(await page.locator('#chat-conversation-name').textContent(), 'Scale Conversation 50');
    await page.waitForFunction(() => globalThis.__topicPageFixture.calls.some((call) => call.method === 'command-center.v1.sessions.history' && call.params?.referenceId === 'session:fictional-topic:scale-50'));
  } finally { await closeGuardedPage(page); }
});

test('large Notes loading and bounded transcript rendering yield to unrelated controls', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => {
      const fixture = globalThis.__topicPageFixture;
      fixture.setScaleNotes(5_000);
      fixture.serverPageNotes = true;
      fixture.histories[fixture.primaryId] = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Fictional bounded history message ${index}` }));
      fixture.deferNotesBrowse = true;
    });
    await page.locator('#notes-refresh').click();
    await page.waitForFunction(() => globalThis.__topicPageFixture.notesBrowsePending === true);
    const browseWhileNotesPending = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.method?.endsWith('sessions.browse')).length);
    await page.locator('#conversation-refresh').click();
    await page.waitForFunction((before) => globalThis.__topicPageFixture.calls.filter((call) => call.method?.endsWith('sessions.browse')).length > before, browseWhileNotesPending);
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.notesBrowsePending), true);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveNotesBrowse());
    await page.getByText(/5000 Notes · Page 1 of 50/u).waitFor();
    assert.equal(await page.locator('#notes-tree .note-tree-item').count(), 100);
    assert.equal(await page.locator('#notes-tree .note-tree-item').first().textContent(), 'scale/note-0000.md');
    await page.locator('#note-next').click();
    await page.getByText(/5000 Notes · Page 2 of 50/u).waitFor();
    assert.equal(await page.locator('#notes-tree .note-tree-item').count(), 100);

    const browseBefore = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.method?.endsWith('sessions.browse')).length);
    await page.getByRole('button', { name: 'Primary Conversation', exact: true }).click();
    await page.waitForFunction(() => { const count = document.querySelectorAll('#chat-messages .chat-message').length; return count >= 50 && count < 100; });
    await page.locator('#conversation-refresh').click();
    await page.waitForFunction((before) => globalThis.__topicPageFixture.calls.filter((call) => call.method?.endsWith('sessions.browse')).length > before, browseBefore);
    await page.waitForFunction(() => document.querySelectorAll('#chat-messages .chat-message').length === 100);
    assert.equal(await page.locator('#chat-messages').getAttribute('data-total-messages'), '100');
  } finally { await closeGuardedPage(page); }
});

test('projection rebuild completion can remain pending while a safe read control completes', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferProjectionRebuild = true; });
    await page.locator('#workspace-search-rebuild').click();
    await page.waitForFunction(() => globalThis.__topicPageFixture.projectionRebuildPending === true);
    const browseBefore = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.method?.endsWith('sessions.browse')).length);
    await page.locator('#conversation-refresh').click();
    await page.waitForFunction((before) => globalThis.__topicPageFixture.calls.filter((call) => call.method?.endsWith('sessions.browse')).length > before, browseBefore);
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.projectionRebuildPending), true);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveProjectionRebuild());
    await page.getByText('Topic Search index rebuilt from authoritative sources.', { exact: true }).waitFor();
  } finally { await closeGuardedPage(page); }
});

test('Primary Chat phase: initial focus and imported-history ordering', async () => {
  const page = await setupPage();
  try {
    await page.locator('#chat-message').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat-message');
    const history = await page.locator('#chat-messages .chat-message').allTextContents();
    assert.ok(history.findIndex((text) => text.includes('Imported immutable prefix')) < history.findIndex((text) => text.includes('Native suffix after import')));
  } finally { await closeGuardedPage(page); }
});

test('Primary Chat phase: completed send resolves the exact Primary Session before the capability mutation', async () => {
  const page = await setupPage();
  try {
    await submitChatAndWaitForCompletion(page, 'ordinary primary message');
    assert.equal(await page.locator('#chat-status').textContent(), 'Message sent.');
    assert.equal(await page.locator('#chat-message').inputValue(), '');
    assert.equal(await page.locator('#chat-send').isEnabled(), true);
    const evidence = await page.evaluate(() => { const calls = globalThis.__topicPageFixture.calls; const sendIndex = calls.findLastIndex((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send'); return { send: calls[sendIndex], resolve: calls.slice(0, sendIndex).findLast((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.navigate') }; });
    assert.deepEqual(evidence.resolve.params, { schemaVersion: 1, topicId: '11111111-1111-4111-8111-111111111111', referenceId: 'session:fictional-topic:primary' });
    assert.deepEqual(Object.keys(evidence.send.params).sort(), ['logicalOperationId', 'message', 'referenceId', 'schemaVersion', 'topicId'].sort());
    assert.equal(evidence.send.params.referenceId, 'session:fictional-topic:primary');
    assert.match(evidence.send.operationId, /^[0-9a-f-]{36}$/u);
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.calls.some((call) => call.method === 'chat.send')), false);
  } finally { await closeGuardedPage(page); }
});

test('Primary Chat retains one logical send across duplicate and changed-intent submission', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = true; });
    await page.locator('#chat-message').fill('one retained logical message'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.sendPending === true);
    const first = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').at(-1));
    await submit(page, '#chat-form');
    await page.locator('#chat-message').fill('changed message must not dispatch'); await submit(page, '#chat-form');
    assert.equal(await page.locator('#chat-status').textContent(), 'A different Chat send is already settling and was not sent.');
    const pendingCalls = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send'));
    assert.equal(pendingCalls.length, 1); assert.equal(pendingCalls[0].operationId, first.operationId);
    const completedSends = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const deliveredActions = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend());
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, completedSends + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), deliveredActions + 1);
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').length), 1);
    assert.equal(await page.locator('#chat-message').inputValue(), 'changed message must not dispatch');
    assert.equal(await page.locator('#chat-status').textContent(), 'Message sent; the current draft was retained.');
  } finally { await closeGuardedPage(page); }
});

test('Primary Chat retries an interrupted response with the retained logical operation ID', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.interruptNextSendResponse = true; });
    await page.locator('#chat-message').fill('retry this exact logical message'); await submit(page, '#chat-form');
    await page.getByText('Message delivery is not yet confirmed. Retry the unchanged message to reconcile it.', { exact: true }).waitFor();
    const first = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').at(-1));
    assert.equal(await page.locator('#chat-message').inputValue(), 'retry this exact logical message');
    await submit(page, '#chat-form'); await page.getByText('Message sent.', { exact: true }).waitFor();
    const attempts = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send'));
    assert.equal(attempts.length, 2); assert.equal(attempts[0].operationId, first.operationId); assert.equal(attempts[1].operationId, first.operationId);
    assert.equal(await page.getByText('retry this exact logical message', { exact: true }).count(), 1);
  } finally { await closeGuardedPage(page); }
});

test('equivalent retry keeps its logical operation after switching away and back', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.interruptNextSendResponse = true; });
    await page.locator('#chat-message').fill('retry after Conversation switch'); await submit(page, '#chat-form');
    await page.getByText('Message delivery is not yet confirmed. Retry the unchanged message to reconcile it.', { exact: true }).waitFor();
    const first = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').at(-1));
    await page.getByRole('button', { name: 'Independent Conversation', exact: true }).click(); await page.getByText('Independent transcript only').waitFor(); await page.getByRole('button', { name: 'Primary Conversation', exact: true }).click(); await page.getByText('Imported immutable prefix').waitFor();
    await submit(page, '#chat-form'); await page.getByText('Message sent.', { exact: true }).waitFor();
    const attempts = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send'));
    assert.equal(attempts.length, 2); assert.equal(attempts[1].operationId, first.operationId); assert.equal(await page.getByText('retry after Conversation switch', { exact: true }).count(), 1);
  } finally { await closeGuardedPage(page); }
});

test('a late Topic send retires only its operation while the newer Topic send remains pending', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = 2; });
    await page.locator('#chat-message').fill('Topic A delayed send'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredSendResolvers.length === 1);
    await page.evaluate(() => window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topicB)); await page.getByText('Topic workspace ready.').waitFor();
    await page.locator('#chat-message').fill('Topic B pending send'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredSendResolvers.length === 2);
    const initialCalls = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send'));
    assert.equal(initialCalls.length, 2); assert.notEqual(initialCalls[0].operationId, initialCalls[1].operationId);
    const firstCompleted = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const firstDelivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend());
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, firstCompleted + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), firstDelivered + 1);
    assert.equal(await page.locator('#chat-message').inputValue(), 'Topic B pending send'); assert.equal(await page.locator('#chat-status').textContent(), 'Sending message…'); assert.equal(await page.locator('#chat-send').isDisabled(), true);
    await submit(page, '#chat-form');
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').length), 2);
    const secondCompleted = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const secondDelivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend());
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, secondCompleted + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), secondDelivered + 1);
    assert.equal(await page.locator('#chat-status').textContent(), 'Message sent.'); assert.equal(await page.getByText('Topic B pending send', { exact: true }).count(), 1);
  } finally { await closeGuardedPage(page); }
});

test('different Conversations can keep independently captured sends pending', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = 2; });
    await page.locator('#chat-message').fill('Primary pending send'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredSendResolvers.length === 1);
    await page.getByRole('button', { name: 'Independent Conversation', exact: true }).click(); await page.getByText('Independent transcript only').waitFor();
    await page.locator('#chat-message').fill('Independent pending send'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredSendResolvers.length === 2);
    const sends = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send'));
    assert.deepEqual(sends.map((send) => send.params.referenceId), ['session:fictional-topic:primary', 'session:fictional-topic:conversation']);
    assert.notEqual(sends[0].operationId, sends[1].operationId);
    const firstCompleted = await page.evaluate(() => globalThis.__topicPageFixture.completedSends); const firstDelivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend()); await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, firstCompleted + 1); await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), firstDelivered + 1);
    assert.equal(await page.locator('#chat-message').inputValue(), 'Independent pending send'); assert.equal(await page.locator('#chat-status').textContent(), 'Sending message…'); assert.equal(await page.locator('#chat-send').isDisabled(), true);
    const secondCompleted = await page.evaluate(() => globalThis.__topicPageFixture.completedSends); const secondDelivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend()); await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, secondCompleted + 1); await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), secondDelivered + 1);
    assert.equal(await page.locator('#chat-status').textContent(), 'Message sent.'); assert.equal(await page.getByText('Independent pending send', { exact: true }).count(), 1);
  } finally { await closeGuardedPage(page); }
});

test('same-Conversation reselection cannot turn a pending send into a duplicate', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = true; });
    await page.locator('#chat-message').fill('one send across harmless reselection'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredSendResolvers.length === 1);
    await page.getByRole('button', { name: 'Primary Conversation', exact: true }).click();
    const completed = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const delivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend());
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, completed + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), delivered + 1);
    assert.equal(await page.locator('#chat-message').inputValue(), ''); assert.equal(await page.locator('#chat-status').textContent(), 'Message sent.');
    await submit(page, '#chat-form');
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').length), 1);
    assert.equal(await page.getByText('one send across harmless reselection', { exact: true }).count(), 1);
  } finally { await closeGuardedPage(page); }
});

test('an earlier send history refresh cannot overwrite a newer pending send status', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => globalThis.__topicPageFixture.deferHistoryReferences.add(globalThis.__topicPageFixture.primaryId));
    await page.locator('#chat-message').fill('First message before delayed refresh'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredHistories.has(globalThis.__topicPageFixture.primaryId));
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = true; });
    await page.locator('#chat-message').fill('Newer pending message'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredSendResolvers.length === 1);
    const delivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => { const fixture = globalThis.__topicPageFixture; fixture.deferHistoryReferences.delete(fixture.primaryId); fixture.resolveDeferredHistory(fixture.primaryId); });
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), delivered + 1);
    assert.equal(await page.locator('#chat-status').textContent(), 'Sending message…');
    const completed = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const actionDelivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend());
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, completed + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), actionDelivered + 1);
    assert.equal(await page.locator('#chat-status').textContent(), 'Message sent.');
  } finally { await closeGuardedPage(page); }
});

test('an earlier rejected history refresh cannot overwrite a newer pending send status', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => globalThis.__topicPageFixture.deferHistoryReferences.add(globalThis.__topicPageFixture.primaryId));
    await page.locator('#chat-message').fill('First message before rejected refresh'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredHistories.has(globalThis.__topicPageFixture.primaryId));
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = true; });
    await page.locator('#chat-message').fill('Newer pending message'); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredSendResolvers.length === 1);
    const delivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => { const fixture = globalThis.__topicPageFixture; fixture.deferHistoryReferences.delete(fixture.primaryId); fixture.rejectDeferredHistory(fixture.primaryId); });
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), delivered + 1);
    assert.equal(await page.locator('#chat-status').textContent(), 'Sending message…');
    const completed = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const actionDelivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend());
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, completed + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), actionDelivered + 1);
    assert.equal(await page.locator('#chat-status').textContent(), 'Message sent.');
  } finally { await closeGuardedPage(page); }
});

test('a retained-operation retry supersedes an earlier rejected history status', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.interruptNextSendResponse = true; });
    await page.locator('#chat-message').fill('retry while history settles'); await submit(page, '#chat-form');
    await page.getByText('Message delivery is not yet confirmed. Retry the unchanged message to reconcile it.', { exact: true }).waitFor();
    const firstCall = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').at(-1));
    await page.evaluate(() => globalThis.__topicPageFixture.deferHistoryReferences.add(globalThis.__topicPageFixture.primaryId));
    await page.getByRole('button', { name: 'Primary Conversation', exact: true }).click();
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredHistories.has(globalThis.__topicPageFixture.primaryId));
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = true; }); await submit(page, '#chat-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.deferredSendResolvers.length === 1);
    const retryCall = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').at(-1));
    assert.equal(retryCall.operationId, firstCall.operationId);
    const delivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => { const fixture = globalThis.__topicPageFixture; fixture.deferHistoryReferences.delete(fixture.primaryId); fixture.rejectDeferredHistory(fixture.primaryId); });
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), delivered + 1);
    assert.equal(await page.locator('#chat-status').textContent(), 'Sending message…');
    const completed = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const actionDelivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSend());
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, completed + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), actionDelivered + 1);
    assert.equal(await page.locator('#chat-status').textContent(), 'Message sent.');
  } finally { await closeGuardedPage(page); }
});

test('Primary Chat switch race reports each integration boundary', async (context) => {
  const page = await setupPage();
  try {
    await context.test('switch phase: exact old and new history requests are deferred', async () => {
      await submitChatAndWaitForCompletion(page, 'ordinary primary message');
      await page.evaluate(() => { const fixture = globalThis.__topicPageFixture; fixture.deferHistoryReferences.add(fixture.primaryId); fixture.deferHistoryReferences.add(fixture.conversationId); });
      await page.getByRole('button', { name: 'Primary Conversation', exact: true }).click();
      await page.waitForFunction(() => globalThis.__topicPageFixture.deferredHistories.has(globalThis.__topicPageFixture.primaryId));
      await page.getByRole('button', { name: 'Independent Conversation', exact: true }).click();
      await page.waitForFunction(() => globalThis.__topicPageFixture.deferredHistories.has(globalThis.__topicPageFixture.conversationId));
    });
    await context.test('switch phase: selected presentation immediately clears the Primary transcript', async () => {
      assert.equal(await page.getByText('Imported immutable prefix').count(), 0);
      assert.equal(await page.locator('#chat-conversation-name').textContent(), 'Independent Conversation');
    });
    await context.test('switch phase: Independent history wins over stale Primary rejection', async () => {
      await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredHistory(globalThis.__topicPageFixture.conversationId));
      await page.getByText('Independent transcript only').waitFor();
      await page.evaluate(() => globalThis.__topicPageFixture.rejectDeferredHistory(globalThis.__topicPageFixture.primaryId));
      await page.waitForFunction(() => document.querySelector('#chat-conversation-name')?.textContent === 'Independent Conversation');
      assert.equal(await page.getByRole('button', { name: 'Independent Conversation', exact: true }).getAttribute('aria-current'), 'true');
    });
    await context.test('switch phase: post-race send targets Independent and excludes Primary transcript', async () => {
      await submitChatAndWaitForCompletion(page, 'message after delayed failure');
      const send = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').at(-1));
      assert.equal(send.params.referenceId, 'session:fictional-topic:conversation');
      assert.equal(await page.getByText('ordinary primary message').count(), 0);
    });
  } finally { await closeGuardedPage(page); }
});

test('a delayed Topic open cannot replace the newer visible Topic identity or send target', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { const fixture = globalThis.__topicPageFixture; fixture.deferTopicGetId = fixture.topicId; void window.CommandCenterTopics.openTopic(fixture.topic); });
    await page.waitForFunction(() => Boolean(globalThis.__topicPageFixture.deferredTopicGet));
    await page.evaluate(() => window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topicB));
    await page.getByRole('heading', { name: 'Second Fictional Topic', exact: true }).waitFor();
    await page.getByText('Second Topic isolated transcript').waitFor();
    await page.evaluate(async () => { globalThis.__topicPageFixture.resolveDeferredTopicGet(); await new Promise((resolve) => requestAnimationFrame(resolve)); });
    assert.equal(await page.locator('#topic-workspace-heading').textContent(), 'Second Fictional Topic');
    await page.locator('#chat-message').fill('Second Topic message'); await submit(page, '#chat-form'); await page.getByText('Second Topic message').waitFor();
    const evidence = await page.evaluate(() => { const calls = globalThis.__topicPageFixture.calls; const sendIndex = calls.findLastIndex((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send'); return { send: calls[sendIndex], resolve: calls.slice(0, sendIndex).findLast((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.navigate') }; });
    assert.equal(evidence.resolve.params.topicId, '22222222-2222-4222-8222-222222222222');
    assert.equal(evidence.resolve.params.referenceId, 'session:fictional-topic-b:primary');
    assert.equal(evidence.send.params.referenceId, 'session:fictional-topic-b:primary');
  } finally { await closeGuardedPage(page); }
});

test('late send and Search completions cannot clear or populate a newer Topic workspace', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = true; }); await page.locator('#chat-message').fill('Delayed Primary send'); await submit(page, '#chat-form'); await page.waitForFunction(() => globalThis.__topicPageFixture.sendPending === true);
    await page.getByRole('button', { name: 'Independent Conversation', exact: true }).click(); await page.getByText('Independent transcript only').waitFor(); await page.locator('#chat-message').fill('New Conversation unsent draft');
    assert.equal(await page.locator('#chat-status').textContent(), ''); assert.equal(await page.locator('#chat-send').isDisabled(), false);
    const firstCompletedSends = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const firstDeliveredActions = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => { globalThis.__topicPageFixture.resolveDeferredSend(); });
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, firstCompletedSends + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), firstDeliveredActions + 1);
    assert.equal(await page.locator('#chat-message').inputValue(), 'New Conversation unsent draft'); assert.equal(await page.locator('#chat-conversation-name').textContent(), 'Independent Conversation');
    assert.equal(await page.locator('#chat-send').isDisabled(), false);

    await page.evaluate(() => { globalThis.__topicPageFixture.deferSend = true; }); await submit(page, '#chat-form'); await page.waitForFunction(() => globalThis.__topicPageFixture.sendPending === true);
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').at(-1).params.referenceId), 'session:fictional-topic:conversation');
    await page.evaluate(() => window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topicB)); await page.getByRole('heading', { name: 'Second Fictional Topic', exact: true }).waitFor(); await page.locator('#chat-message').fill('New Topic unsent draft');
    assert.equal(await page.locator('#chat-status').textContent(), ''); assert.equal(await page.locator('#chat-send').isDisabled(), false); assert.equal(await page.locator('#chat-message').isDisabled(), false);
    const secondCompletedSends = await page.evaluate(() => globalThis.__topicPageFixture.completedSends);
    const secondDeliveredActions = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => { globalThis.__topicPageFixture.resolveDeferredSend(); });
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSends === count, secondCompletedSends + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), secondDeliveredActions + 1);
    assert.equal(await page.locator('#chat-message').inputValue(), 'New Topic unsent draft'); assert.equal(await page.locator('#chat-status').textContent(), '');

    await page.evaluate(() => window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topic)); await page.getByText('Topic workspace ready.').waitFor();
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSearch = true; }); await page.locator('#workspace-search-query').fill('delayed Topic A search'); await submit(page, '#workspace-search-form'); await page.waitForFunction(() => globalThis.__topicPageFixture.searchPending === true);
    await page.evaluate(() => { globalThis.__topicPageFixture.deferTopicGetId = globalThis.__topicPageFixture.topicB.topicId; window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topicB); }); await page.waitForFunction(() => Boolean(globalThis.__topicPageFixture.deferredTopicGet));
    assert.equal(await page.locator('#workspace-search-query').inputValue(), ''); assert.equal(await page.locator('#workspace-search-query').isDisabled(), true); assert.equal(await page.locator('#workspace-search-form button[type="submit"]').isDisabled(), true);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredTopicGet()); await page.getByRole('heading', { name: 'Second Fictional Topic', exact: true }).waitFor(); await page.getByText('Topic workspace ready.').waitFor();
    assert.equal(await page.locator('#workspace-search-query').isDisabled(), false); assert.equal(await page.locator('#workspace-search-form button[type="submit"]').isDisabled(), false);
    assert.equal(await page.locator('#workspace-search-status').textContent(), ''); assert.equal(await page.locator('#workspace-notes-results article').count(), 0); assert.equal(await page.locator('#workspace-conversations-results article').count(), 0);
    await page.evaluate(() => {
      const fixture = globalThis.__topicPageFixture; fixture.staleSearchPainted = false;
      fixture.staleSearchObserver = new MutationObserver(() => {
        const inTopicB = document.querySelector('#topic-workspace-heading')?.textContent === 'Second Fictional Topic';
        const hasResults = document.querySelectorAll('#workspace-notes-results article, #workspace-conversations-results article').length > 0;
        if (inTopicB && hasResults) fixture.staleSearchPainted = true;
      });
      fixture.staleSearchObserver.observe(document.querySelector('#workspace-notes-results'), { childList: true, subtree: true });
      fixture.staleSearchObserver.observe(document.querySelector('#workspace-conversations-results'), { childList: true, subtree: true });
    });
    const completedSearches = await page.evaluate(() => globalThis.__topicPageFixture.completedSearches);
    const deliveredSearchResponses = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => { globalThis.__topicPageFixture.resolveDeferredSearch(); });
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSearches === count, completedSearches + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), deliveredSearchResponses + 1);
    assert.equal(await page.locator('#workspace-notes-results article').count(), 0); assert.equal(await page.locator('#workspace-conversations-results article').count(), 0); assert.equal(await page.locator('#workspace-search-status').textContent(), '');
    await page.locator('#workspace-search-query').fill('current Topic B search'); await submit(page, '#workspace-search-form');
    await page.locator('#workspace-search-status').filter({ hasText: '0 Notes · 0 Conversations' }).waitFor();
    assert.equal(await page.locator('#workspace-notes-results article').count(), 0); assert.equal(await page.locator('#workspace-conversations-results article').count(), 0); assert.equal(await page.locator('#workspace-search-status').textContent(), '0 Notes · 0 Conversations'); assert.equal(await page.evaluate(() => { const fixture = globalThis.__topicPageFixture; fixture.staleSearchObserver.disconnect(); return fixture.staleSearchPainted; }), false);
  } finally { await closeGuardedPage(page); }
});

test('Conversations create, switch, close, browse Closed, reopen, refresh, and protect Primary', async () => {
  const page = await setupPage();
  try {
    await page.locator('#conversation-create input[name="label"]').fill('Fresh Root Conversation'); await submit(page, '#conversation-create');
    let row = page.locator('.conversation-item').filter({ hasText: 'Fresh Root Conversation' }); await row.waitFor(); await row.getByRole('button', { name: 'Fresh Root Conversation' }).evaluate((node) => node.click()); await page.locator('#chat-conversation-name').filter({ hasText: 'Fresh Root Conversation' }).waitFor();
    assert.equal(await page.getByText('Imported immutable prefix').count(), 0);
    await row.getByRole('button', { name: 'Close' }).evaluate((node) => node.click());
    await page.waitForFunction(() => globalThis.__topicPageFixture.calls.some((call) => call.transport === 'http' && call.action === 'conversations.close' && call.referenceId?.includes('created-')));
    await row.waitFor({ state: 'hidden' });
    await page.locator('#conversation-view').selectOption('closed'); row = page.locator('.conversation-item').filter({ hasText: 'Fresh Root Conversation' }); await row.waitFor(); await row.getByRole('button', { name: 'Fresh Root Conversation' }).evaluate((node) => node.click());
    await page.locator('#workspace-search-query').fill('Fresh Root Conversation'); await submit(page, '#workspace-search-form'); const searchResult = page.locator('#workspace-conversations-results article').filter({ hasText: 'Fresh Root Conversation' }); await searchResult.waitFor(); await searchResult.getByText('Closed', { exact: true }).waitFor();
    await page.locator('#conversation-refresh').click(); await page.getByText('2 closed Conversations.').waitFor(); await row.getByRole('button', { name: 'Reopen' }).click(); await row.waitFor({ state: 'hidden' });
    await page.locator('#conversation-view').selectOption('open'); row = page.locator('.conversation-item').filter({ hasText: 'Fresh Root Conversation' }); await row.waitFor(); await row.getByRole('button', { name: 'Fresh Root Conversation' }).evaluate((node) => node.click());
    await page.locator('#chat-message').fill('Message after reopen'); await submit(page, '#chat-form'); await page.getByText('Message after reopen').waitFor();
    const reopenedSend = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'command-center.v1.sessions.send').at(-1));
    assert.equal(reopenedSend.params.referenceId, 'session:fictional-topic:created-3'); assert.equal(await page.getByText('Imported immutable prefix').count(), 0);
    assert.equal(await page.locator('.conversation-item').filter({ hasText: 'Primary Conversation' }).getByRole('button', { name: 'Close' }).count(), 0);
    const actions = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'http').map((call) => call.action));
    assert.ok(actions.includes('conversations.create') && actions.includes('conversations.close') && actions.includes('conversations.reopen'));
  } finally { await closeGuardedPage(page); }
});

test('closing the selected Conversation immediately makes Chat read-only', async () => {
  const page = await setupPage();
  try {
    await page.getByRole('button', { name: 'Independent Conversation', exact: true }).click(); await page.getByText('Independent transcript only').waitFor();
    let row = page.locator('.conversation-item').filter({ hasText: 'Independent Conversation' });
    const close = row.getByRole('button', { name: 'Close' }); await close.focus(); await close.press('Enter');
    const view = page.locator('#conversation-view'); await view.focus(); await view.selectOption('closed');
    row = page.locator('.conversation-item').filter({ hasText: 'Independent Conversation' }); await row.getByText('Closed', { exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement !== document.body && getComputedStyle(document.activeElement).outlineStyle !== 'none');
    assert.equal(await page.locator('#chat-conversation-name').textContent(), 'Independent Conversation');
    assert.equal(await page.locator('#chat-message').isDisabled(), true); assert.equal(await page.locator('#chat-send').isDisabled(), true);
  } finally { await closeGuardedPage(page); }
});

test('a delayed Conversation create cannot clear a newer Topic draft', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferConversationCreate = true; });
    await page.locator('#conversation-create input[name="label"]').fill('Delayed Topic A Conversation'); await submit(page, '#conversation-create');
    await page.waitForFunction(() => globalThis.__topicPageFixture.conversationCreatePending === true);
    await page.evaluate(() => window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topicB)); await page.getByRole('heading', { name: 'Second Fictional Topic', exact: true }).waitFor(); await page.getByText('Topic workspace ready.').waitFor();
    await page.locator('#conversation-create input[name="label"]').fill('Topic B retained draft');
    const delivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredActionResponses); await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredConversationCreate()); await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('action', target), delivered + 1);
    assert.equal(await page.locator('#conversation-create input[name="label"]').inputValue(), 'Topic B retained draft'); assert.equal(await page.locator('#conversation-status').textContent(), '1 Conversations.');
  } finally { await closeGuardedPage(page); }
});

test('an interrupted Conversation create retries the unchanged logical operation exactly once', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.interruptNextConversationCreateResponse = true; });
    const input = page.locator('#conversation-create input[name="label"]');
    await input.fill('Interrupted Conversation'); await submit(page, '#conversation-create');
    await page.getByText('Conversation creation is not yet confirmed. Retry the unchanged label to reconcile it.').waitFor();
    await submit(page, '#conversation-create');
    await page.locator('.conversation-item').filter({ hasText: 'Interrupted Conversation' }).waitFor();
    const calls = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'http' && call.action === 'conversations.create' && call.label === 'Interrupted Conversation'));
    const creates = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'sessions.create' && call.params.label === 'Interrupted Conversation'));
    assert.equal(calls.length, 2);
    assert.equal(creates.length, 1);
    assert.equal(calls[0].logicalOperationId, calls[1].logicalOperationId);
    assert.equal(creates[0].operationId, calls[0].logicalOperationId);
    assert.deepEqual(Object.keys(creates[0].params).sort(), ['agentId', 'label']);
    assert.equal(await page.locator('.conversation-item').filter({ hasText: 'Interrupted Conversation' }).count(), 1);
  } finally { await closeGuardedPage(page); }
});

test('an unknown capability-bridge Session outcome retains the Conversation operation for exact retry', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.unknownNextSessionCreate = true; });
    const input = page.locator('#conversation-create input[name="label"]');
    await input.fill('Unknown Session Outcome'); await submit(page, '#conversation-create');
    await page.getByText('Conversation creation is not yet confirmed. Retry the unchanged label to reconcile it.').waitFor();
    await submit(page, '#conversation-create');
    await page.locator('.conversation-item').filter({ hasText: 'Unknown Session Outcome' }).waitFor();
    const evidence = await page.evaluate(() => ({ bridge: globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'bridge' && call.method === 'sessions.create' && call.params.label === 'Unknown Session Outcome'), http: globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'http' && call.action === 'conversations.create' && call.label === 'Unknown Session Outcome') }));
    assert.equal(evidence.bridge.length, 2);
    assert.equal(evidence.bridge[0].operationId, evidence.bridge[1].operationId);
    assert.equal(evidence.http.length, 1);
    assert.equal(evidence.http[0].logicalOperationId, evidence.bridge[0].operationId);
  } finally { await closeGuardedPage(page); }
});

test('Notes preserve dirty drafts through switch, create, rename, move, conflict, preview, and 8 MiB-plus-newline save', async () => {
  const page = await setupPage();
  try {
    const dirty = '# Dirty Brief\n\nUnsaved fictional draft.';
    await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); await page.locator('#note-content').fill(dirty);
    await page.getByRole('button', { name: 'nested/deeper/other.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/deeper/other.md', exact: true }).waitFor(); assert.match(await page.locator('#note-content').inputValue(), /Independent bytes/u);
    await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); assert.equal(await page.locator('#note-content').inputValue(), dirty);
    await page.getByRole('button', { name: 'New Note' }).click(); await page.locator('#note-action-path').fill('nested/created.md'); await page.locator('#note-action-text').fill('# Created'); await submit(page, '#note-action-form');
    await page.getByRole('heading', { name: 'nested/created.md', exact: true }).waitFor(); await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); assert.equal(await page.locator('#note-content').inputValue(), dirty);
    await page.getByRole('button', { name: 'Rename', exact: true }).click(); await page.locator('#note-action-path').fill('renamed/brief.md'); await submit(page, '#note-action-form'); await page.getByRole('heading', { name: 'renamed/brief.md', exact: true }).waitFor(); assert.equal(await page.locator('#note-content').inputValue(), dirty);
    await page.getByRole('button', { name: 'Move', exact: true }).click(); await page.locator('#note-action-path').fill('moved/brief.md'); await submit(page, '#note-action-form'); await page.getByRole('heading', { name: 'moved/brief.md', exact: true }).waitFor(); assert.equal(await page.locator('#note-content').inputValue(), dirty);
    await page.evaluate(() => { globalThis.__topicPageFixture.failNextNoteEdit = true; }); await page.getByRole('button', { name: 'Save Note' }).click(); await page.getByText('The Topic Page action conflicted with newer authoritative state.').waitFor(); assert.equal(await page.locator('#note-content').inputValue(), dirty);
    const prefix = '# Large Fictional Note\n\n'; const marker = 'END-MARKER'; const expectedBytes = 8 * 1024 * 1024 + 1; const large = `${prefix}${'x'.repeat(expectedBytes - prefix.length - marker.length - 1)}${marker}\n`; assert.equal(new TextEncoder().encode(large).length, expectedBytes);
    await page.locator('#note-content').fill(large);
    assert.equal(await page.locator('#note-preview').textContent(), '');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#note-preview')?.textContent.trimEnd().endsWith('END-MARKER'));
    const previewEvidence = await page.locator('#note-preview').evaluate((node) => ({ hidden: node.hidden, display: getComputedStyle(node).display, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, textLength: node.textContent.length }));
    assert.equal(previewEvidence.hidden, false, JSON.stringify(previewEvidence));
    assert.notEqual(previewEvidence.display, 'none', JSON.stringify(previewEvidence));
    assert.ok(previewEvidence.width > 0 && previewEvidence.height > 0, JSON.stringify(previewEvidence));
    assert.equal(await page.locator('#note-preview').evaluate((node) => node.textContent.trimEnd().endsWith('END-MARKER')), true);
    await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('button', { name: 'Save Note' }).click(); await page.getByText('Note saved.').waitFor();
    const saved = await page.evaluate(() => { const contentBase64 = globalThis.__topicPageFixture.calls.filter((call) => call.action === 'notes.edit').at(-1).contentBase64; const bytes = Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0)); const text = new TextDecoder().decode(bytes); return { byteLength: bytes.byteLength, length: text.length, endsWithMarkerAndNewline: text.endsWith('END-MARKER\n') }; });
    assert.deepEqual(saved, { byteLength: expectedBytes, length: large.length, endsWithMarkerAndNewline: true });
    await page.getByRole('button', { name: 'Save Note' }).click(); await page.getByText('Note saved.').waitFor();
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.action === 'notes.edit').at(-1).expectedRevision), 'saved-revision');
  } finally { await closeGuardedPage(page); }
});

test('delayed Note reads and saves cannot replace a newer Note or discard its draft', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferNoteReadPath = 'nested/brief.md'; });
    await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click();
    await page.waitForFunction(() => Boolean(globalThis.__topicPageFixture.deferredNoteRead));
    await page.getByRole('button', { name: 'nested/deeper/other.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/deeper/other.md', exact: true }).waitFor();
    await page.evaluate(async () => { globalThis.__topicPageFixture.resolveDeferredNoteRead(); await new Promise((resolve) => requestAnimationFrame(resolve)); });
    assert.equal(await page.locator('#note-title').textContent(), 'nested/deeper/other.md');

    await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); await page.locator('#note-content').fill('Draft being saved');
    await page.evaluate(() => { globalThis.__topicPageFixture.deferNoteEdit = true; }); await page.getByRole('button', { name: 'Save Note' }).click(); await page.waitForFunction(() => globalThis.__topicPageFixture.noteEditPending === true);
    await page.getByRole('button', { name: 'nested/deeper/other.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/deeper/other.md', exact: true }).waitFor(); await page.locator('#note-content').fill('Newer independent draft');
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredNoteEdit());
    await page.getByText('Note saved; the current Note draft was retained.').waitFor();
    assert.equal(await page.locator('#note-title').textContent(), 'nested/deeper/other.md');
    assert.equal(await page.locator('#note-content').inputValue(), 'Newer independent draft');
    assert.match(await page.locator('#note-revision').textContent(), /unsaved draft/u);

    await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); await page.locator('#note-content').fill('Cross-Topic delayed save');
    await page.evaluate(() => { globalThis.__topicPageFixture.deferNoteEdit = true; }); await page.getByRole('button', { name: 'Save Note' }).click(); await page.waitForFunction(() => globalThis.__topicPageFixture.noteEditPending === true);
    await page.evaluate(() => window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topicB)); await page.getByText('Topic workspace ready.').waitFor();
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredNoteEdit()); await page.waitForFunction(() => globalThis.__topicPageFixture.noteEditPending === false);
    assert.equal(await page.locator('#notes-status').textContent(), '1 Notes.'); assert.equal(await page.locator('#note-editor').isHidden(), true);
  } finally { await closeGuardedPage(page); }
});

test('Preview follows the authoritative Note across Note and Topic changes', async () => {
  const page = await setupPage();
  try {
    await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click(); await page.getByRole('button', { name: 'Preview', exact: true }).click(); await page.getByText('Authoritative brief.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'nested/deeper/other.md', exact: true }).click(); await page.getByText('Independent bytes.', { exact: true }).waitFor(); assert.equal(await page.getByText('Authoritative brief.', { exact: true }).count(), 0);
    await page.evaluate(() => window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topicB)); await page.getByRole('heading', { name: 'Second Fictional Topic', exact: true }).waitFor(); await page.getByText('Topic workspace ready.').waitFor();
    assert.equal(await page.locator('#note-preview').textContent(), '');
    await page.getByRole('button', { name: 'topic-b.md', exact: true }).click(); await page.getByText('Second Topic authoritative bytes.', { exact: true }).waitFor(); assert.equal(await page.getByText('Independent bytes.', { exact: true }).count(), 0);
  } finally { await closeGuardedPage(page); }
});

test('a delayed failed Note read cannot restore stale selection over a newer dirty draft', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferNoteReadPath = 'nested/brief.md'; });
    await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click();
    await page.waitForFunction(() => Boolean(globalThis.__topicPageFixture.deferredNoteRead));
    await page.getByRole('button', { name: 'nested/deeper/other.md', exact: true }).click();
    await page.getByRole('heading', { name: 'nested/deeper/other.md', exact: true }).waitFor();
    await page.locator('#note-content').fill('Newer dirty draft survives stale failure');
    await page.evaluate(async () => { globalThis.__topicPageFixture.rejectDeferredNoteRead(); await new Promise((resolve) => requestAnimationFrame(resolve)); });
    assert.equal(await page.locator('#note-title').textContent(), 'nested/deeper/other.md');
    assert.equal(await page.locator('#note-content').inputValue(), 'Newer dirty draft survives stale failure');
    assert.equal(await page.locator('#notes-status').textContent(), 'Authoritative Note opened.');
  } finally { await closeGuardedPage(page); }
});

test('chunked Note reads preserve a UTF-8 code point split across the byte boundary', async () => {
  const page = await setupPage();
  try {
    await page.getByRole('button', { name: 'nested/utf8-boundary.md', exact: true }).click();
    await page.getByRole('heading', { name: 'nested/utf8-boundary.md', exact: true }).waitFor();
    const content = await page.locator('#note-content').inputValue();
    assert.equal(new TextEncoder().encode(content).length, 524298);
    assert.equal(content.endsWith('xé terminal'), true);
    assert.equal(content.includes('\uFFFD'), false);
  } finally { await closeGuardedPage(page); }
});

test('same-Topic Search keeps the newest query when an older response arrives last', async () => {
  const page = await setupPage();
  try {
    await page.evaluate(() => { globalThis.__topicPageFixture.deferSearch = true; });
    await page.locator('#workspace-search-query').fill('older query'); await submit(page, '#workspace-search-form');
    await page.waitForFunction(() => globalThis.__topicPageFixture.searchPending === true);
    await page.locator('#workspace-search-query').fill('newer query'); await submit(page, '#workspace-search-form');
    await page.getByText('Newer Search result', { exact: true }).waitFor();
    const completedSearches = await page.evaluate(() => globalThis.__topicPageFixture.completedSearches);
    const deliveredSearchResponses = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses);
    await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredSearch());
    await page.waitForFunction((count) => globalThis.__topicPageFixture.completedSearches === count, completedSearches + 1);
    await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), deliveredSearchResponses + 1);
    assert.equal(await page.getByText('Newer Search result', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Older Search result', { exact: true }).count(), 0);
    assert.equal(await page.locator('#workspace-search-status').textContent(), '1 Notes · 1 Conversations');
  } finally { await closeGuardedPage(page); }
});

test('structured Chat references and grouped Search open exact authoritative sources', async () => {
  const page = await setupPage();
  try {
    assert.equal(await page.getByRole('button', { name: 'Open referenced Note' }).count(), 1); await page.getByRole('button', { name: 'Open referenced Note' }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); await page.getByText('Authoritative Note opened.', { exact: true }).waitFor();
    await page.evaluate(() => { globalThis.__topicPageFixture.foreignNextNoteRead = true; }); await page.getByRole('button', { name: 'Open referenced Note' }).click(); await page.waitForFunction(() => globalThis.__topicPageFixture.foreignNextNoteRead === false); await page.getByText('The authoritative Note changed after this reference was created.').waitFor();
    await page.locator('#workspace-search-query').fill('fictional'); await submit(page, '#workspace-search-form'); await page.getByText('Grouped Note result').waitFor(); await page.getByText('Grouped Closed Conversation result').waitFor(); assert.match(await page.locator('#workspace-search-status').textContent(), /1 Notes · 1 Conversations/u);
    await page.locator('#workspace-notes-results').getByRole('button', { name: 'Open Note' }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); await page.getByText('Authoritative Note opened.', { exact: true }).waitFor();
    const noteBeforeStaleNavigation = await page.evaluate(() => ({ title: document.querySelector('#note-title')?.textContent, revision: document.querySelector('#note-revision')?.textContent, content: document.querySelector('#note-content')?.value }));
    await page.locator('#workspace-search-query').fill('stale'); await submit(page, '#workspace-search-form'); const staleNoteResult = page.locator('#workspace-notes-results article').filter({ hasText: 'Stale revision Note result' }); await staleNoteResult.waitFor(); await staleNoteResult.getByRole('button', { name: 'Open Note' }).click(); const staleStatus = page.locator('#notes-status').filter({ hasText: 'The authoritative Note changed during retrieval.' }); await staleStatus.waitFor(); assert.equal(await page.locator('#notes-status').textContent(), 'The authoritative Note changed during retrieval.');
    assert.deepEqual(await page.evaluate(() => ({ title: document.querySelector('#note-title')?.textContent, revision: document.querySelector('#note-revision')?.textContent, content: document.querySelector('#note-content')?.value })), noteBeforeStaleNavigation);
    await page.locator('#workspace-search-query').fill('closed'); await submit(page, '#workspace-search-form'); await page.locator('#workspace-conversations-results').getByRole('button', { name: 'Open Conversation' }).click(); await page.waitForFunction(() => document.querySelector('#chat-conversation-name')?.textContent === 'Closed Conversation'); assert.equal(await page.locator('#chat-send').isDisabled(), true);
    assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.method === 'command-center.v1.sessions.navigate').at(-1).params.referenceId), 'session:fictional-topic:closed');
  } finally { await closeGuardedPage(page); }
});

test('a delayed Conversation Search navigation cannot replace a newer Topic selection', async () => {
  const page = await setupPage();
  try {
    await page.locator('#workspace-search-query').fill('closed'); await submit(page, '#workspace-search-form');
    await page.evaluate(() => { globalThis.__topicPageFixture.deferNavigateReference = globalThis.__topicPageFixture.closedId; });
    await page.locator('#workspace-conversations-results').getByRole('button', { name: 'Open Conversation' }).click(); await page.waitForFunction(() => Boolean(globalThis.__topicPageFixture.deferredNavigate));
    await page.evaluate(() => window.CommandCenterTopics.openTopic(globalThis.__topicPageFixture.topicB)); await page.getByRole('heading', { name: 'Second Fictional Topic', exact: true }).waitFor(); await page.getByText('Second Topic isolated transcript').waitFor();
    const delivered = await page.evaluate(() => globalThis.__topicPageFixture.deliveredBridgeResponses); await page.evaluate(() => globalThis.__topicPageFixture.resolveDeferredNavigate()); await page.evaluate((target) => globalThis.__topicPageFixture.waitForApplicationSettlement('bridge', target), delivered + 1);
    assert.equal(await page.locator('#topic-workspace-heading').textContent(), 'Second Fictional Topic'); assert.equal(await page.locator('#chat-conversation-name').textContent(), 'Second Topic Primary'); assert.equal(await page.getByText('Second Topic isolated transcript').count(), 1); assert.equal(await page.getByText('Closed searchable transcript').count(), 0);
  } finally { await closeGuardedPage(page); }
});

test('desktop panes stay independent and mobile sections are exclusive and recover closed panes', async () => {
  const page = await setupPage({ width: 1440, height: 1000 });
  try {
    assert.equal(await page.locator('#conversations-pane').isVisible(), true); assert.equal(await page.locator('#notes-pane').isVisible(), true); assert.equal(await page.locator('#chat-pane').getAttribute('data-focused'), 'true');
    await page.locator('#conversation-refresh').focus(); assert.equal(await page.locator('#conversations-pane').getAttribute('data-focused'), 'true'); assert.equal(await page.locator('#notes-pane').getAttribute('data-focused'), 'false');
    await page.locator('#notes-refresh').focus(); assert.equal(await page.locator('#notes-pane').getAttribute('data-focused'), 'true'); await page.locator('#notes-close').focus(); await page.locator('#notes-close').press('Enter'); assert.equal(await page.locator('#notes-pane').isHidden(), true); assert.equal(await page.locator('#conversations-pane').isVisible(), true); assert.equal(await page.locator('#chat-pane').getAttribute('data-focused'), 'true'); assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat-heading'); assert.equal(await page.locator('#chat-heading').evaluate((node) => getComputedStyle(node).outlineWidth), '3px');
    await page.locator('#notes-open').click(); assert.equal(await page.locator('#notes-pane').isVisible(), true); assert.equal(await page.locator('#notes-pane').getAttribute('data-focused'), 'true'); assert.equal(await page.locator('#conversations-pane').isVisible(), true);
    await page.locator('#conversation-refresh').focus(); assert.equal(await page.locator('#conversations-pane').getAttribute('data-focused'), 'true'); await page.locator('#conversations-close').focus(); await page.locator('#conversations-close').press('Enter'); assert.equal(await page.locator('#conversations-pane').isHidden(), true); assert.equal(await page.locator('#notes-pane').isVisible(), true); assert.equal(await page.locator('#chat-pane').getAttribute('data-focused'), 'true');
    await page.locator('#conversations-open').click(); assert.equal(await page.locator('#conversations-pane').isVisible(), true); assert.equal(await page.locator('#conversations-pane').getAttribute('data-focused'), 'true'); assert.equal(await page.locator('#notes-pane').isVisible(), true);
    await page.locator('#notes-close').click(); await page.locator('#conversations-close').click();
    await page.setViewportSize({ width: 320, height: 900 });
    const assertLongDynamicContentIsContained = async () => {
      await page.evaluate((content) => {
        document.querySelector('#chat-conversation-name').textContent = content;
        for (const id of ['workspace-status', 'chat-status', 'conversation-status', 'notes-status', 'workspace-search-status']) document.querySelector(`#${id}`).textContent = content;
      }, 'FictionalUnbrokenAuthoritativeContent'.repeat(24));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 320), true);
    };
    const paneId = { Chat: 'chat-pane', Conversations: 'conversations-pane', Notes: 'notes-pane', Search: 'workspace-search-pane' };
    const sectionNavigation = page.getByRole('navigation', { name: 'Topic sections' });
    for (const section of Object.keys(paneId)) {
      await sectionNavigation.getByRole('button', { name: section, exact: true }).click();
      const visible = await page.evaluate(() => [...document.querySelectorAll('.workspace-layout > [data-pane]')].filter((pane) => getComputedStyle(pane).display !== 'none').map((pane) => pane.id));
      assert.deepEqual(visible, [paneId[section]]); assert.equal(await page.locator(`#${paneId[section]}`).getAttribute('inert'), null);
      if (section === 'Chat') { await page.locator('#chat-message').fill('Mobile Chat message'); await submit(page, '#chat-form'); await page.getByText('Mobile Chat message').waitFor(); }
      if (section === 'Conversations') { await page.locator('#conversation-create input[name="label"]').fill('Mobile Conversation'); await submit(page, '#conversation-create'); await page.getByRole('button', { name: 'Mobile Conversation', exact: true }).waitFor(); }
      if (section === 'Notes') { await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); const noteTargets = await page.locator('.note-tree-item').evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))); assert.equal(noteTargets.every(({ width, height }) => width >= 44 && height >= 44), true); }
      if (section === 'Search') { await page.locator('#workspace-search-query').fill('mobile'); await submit(page, '#workspace-search-form'); await page.getByText('Grouped Note result').waitFor(); await page.locator('#workspace-notes-results').getByRole('button', { name: 'Open Note' }).click(); await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor(); assert.equal(await page.evaluate(() => document.activeElement?.id), 'notes-heading'); }
      await assertLongDynamicContentIsContained();
    }
    assert.equal(await page.locator('#conversations-pane').getAttribute('hidden'), null); assert.equal(await page.locator('#notes-pane').getAttribute('hidden'), null); assert.equal(await page.locator('#conversations-close').evaluate((node) => getComputedStyle(node).display), 'none'); assert.equal(await page.locator('#notes-close').evaluate((node) => getComputedStyle(node).display), 'none'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 320), true);
    const targets = await page.locator('.workspace-sections button').evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))); assert.equal(targets.every(({ width, height }) => width >= 44 && height >= 44), true);
    await page.setViewportSize({ width: 768, height: 900 });
    await page.waitForFunction(() => document.querySelector('#chat-pane')?.inert === false && document.querySelector('#conversations-pane')?.inert === false && document.querySelector('#notes-pane')?.inert === false);
    assert.equal(await page.locator('#chat-pane').isVisible(), true); assert.equal(await page.locator('#conversations-pane').isVisible(), true); assert.equal(await page.locator('#notes-pane').isVisible(), true);
  } finally { await closeGuardedPage(page); }
});

test('keyboard Note dialog is semantic, traps focus, and restores its invoker', async () => {
  const page = await setupPage({ width: 320 });
  try {
    await page.getByRole('button', { name: 'Notes', exact: true }).click(); const newNote = page.getByRole('button', { name: 'New Note' }); await newNote.focus(); const beforeCalls = await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'http').length); await newNote.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Create Note' }); await dialog.waitFor(); assert.equal(await page.evaluate(() => document.querySelector('#note-action-dialog').contains(document.activeElement)), true); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.querySelector('#note-action-dialog').contains(document.activeElement)), true); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.equal(await newNote.evaluate((node) => document.activeElement === node), true); assert.equal(await page.evaluate(() => globalThis.__topicPageFixture.calls.filter((call) => call.transport === 'http').length), beforeCalls);
  } finally { await closeGuardedPage(page); }
});

test('successful mobile Note creation restores focus after authoritative refresh', async () => {
  const page = await setupPage({ width: 320 });
  try {
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    const newNote = page.getByRole('button', { name: 'New Note' });
    await newNote.focus(); await newNote.press('Enter');
    await page.locator('#note-action-path').fill('mobile-focus.md'); await page.locator('#note-action-text').fill('# Mobile focus'); await submit(page, '#note-action-form');
    await page.getByRole('heading', { name: 'mobile-focus.md', exact: true }).waitFor();
    assert.equal(await newNote.evaluate((node) => document.activeElement === node), true);
  } finally { await closeGuardedPage(page); }
});

test('successful mobile Note rename restores focus after authoritative refresh', async () => {
  const page = await setupPage({ width: 320 });
  try {
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('button', { name: 'nested/brief.md', exact: true }).click();
    await page.getByRole('heading', { name: 'nested/brief.md', exact: true }).waitFor();
    const rename = page.getByRole('button', { name: 'Rename', exact: true });
    await rename.focus(); await rename.press('Enter'); await page.locator('#note-action-path').fill('mobile-focus-renamed.md'); await submit(page, '#note-action-form');
    await page.getByRole('heading', { name: 'mobile-focus-renamed.md', exact: true }).waitFor();
    assert.equal(await rename.evaluate((node) => document.activeElement === node), true);
  } finally { await closeGuardedPage(page); }
});

test('mobile section navigation keeps inactive panes inert and keyboard focus visible', async () => {
  const page = await setupPage({ width: 320 });
  try {
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    assert.equal(await page.locator('#chat-pane').getAttribute('inert'), ''); const chatSection = page.getByRole('button', { name: 'Chat', exact: true }); await chatSection.focus(); await page.waitForFunction(() => document.activeElement === document.querySelector('.workspace-sections [data-section="chat"]')); assert.equal(await chatSection.evaluate((node) => getComputedStyle(node).outlineWidth), '3px'); await chatSection.press('Enter'); assert.equal(await page.locator('#chat-pane').getAttribute('inert'), null); assert.equal(await page.locator('#chat-pane').isVisible(), true);
  } finally { await closeGuardedPage(page); }
});

test('reduced-motion context settles with the media query active and no pane transition', async () => {
  const page = await setupPage({ width: 320, reducedMotion: 'reduce' });
  try {
    await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    const duration = await page.locator('#chat-pane').evaluate((node) => getComputedStyle(node).transitionDuration);
    assert.equal(duration.split(',').every((value) => value.trim().endsWith('ms')
      ? Number.parseFloat(value) <= 0.01
      : Number.parseFloat(value) <= 0.00001), true);
  } finally { await closeGuardedPage(page); }
});

test('workspace status regions independently expose live announcements', async () => {
  const page = await setupPage({ width: 320 });
  try {
    for (const id of ['workspace-status', 'chat-status', 'conversation-status', 'notes-status', 'workspace-search-status']) assert.ok(['polite', 'assertive'].includes(await page.locator(`#${id}`).getAttribute('aria-live')));
  } finally { await closeGuardedPage(page); }
});
