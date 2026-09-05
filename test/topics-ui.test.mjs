import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chromium } from 'playwright';
import { createTopicsHttpHandler } from '../src/topics/http.mjs';
import { publicTopicDestination } from '../src/topics/snapshot.mjs';

const index = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

async function invokeRoute({ method = 'POST', body = {}, headers = { 'content-type': 'application/json' }, service = { topics: {
    async create() { return { status: 'applied', topicId: randomUUID() }; },
    async rename(input) { return { status: 'applied', topicId: input.topicId }; },
    listDestination() { return { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] }; }
  } } } = {}) {
  const request = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(request, { method, headers });
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
  await createTopicsHttpHandler(service)(request, response);
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test('Topic mutation route is POST-only, closed, size-bounded, and sanitizes failures', async () => {
  assert.equal((await invokeRoute({ method: 'GET' })).statusCode, 405);
  assert.equal((await invokeRoute({ body: { schemaVersion: 1, action: 'unknown', logicalOperationId: randomUUID() } })).statusCode, 400);
  assert.equal((await invokeRoute({ body: { schemaVersion: 1, action: 'retry-provisioning', logicalOperationId: randomUUID(), topicId: randomUUID(), expectedRevision: 1 } })).statusCode, 400);
  assert.equal((await invokeRoute({ body: { schemaVersion: 1, action: 'create', logicalOperationId: randomUUID(), name: 'Fictional', paraCategory: 'project', extra: true } })).statusCode, 400);
  const oversized = await invokeRoute({ body: JSON.stringify({ schemaVersion: 1, action: 'create', logicalOperationId: randomUUID(), name: 'x'.repeat(33_000), paraCategory: 'project' }) });
  assert.equal(oversized.statusCode, 400);
  assert.equal(JSON.stringify(oversized.body).includes('x'.repeat(100)), false);
  const logicalOperationId = randomUUID();
  const applied = await invokeRoute({ body: { schemaVersion: 1, action: 'create', topicId: randomUUID(), logicalOperationId, name: 'Fictional', paraCategory: 'project', authoritativeSession: { key: 'agent:main:dashboard:fictional', sessionId: 'fictional-session', revision: '1', idempotencyKey: logicalOperationId, label: 'Fictional' } } });
  assert.equal(applied.statusCode, 200);
  assert.deepEqual(Object.keys(applied.body.result.value.destination).sort(), ['activeGroups', 'archived', 'nextCursor', 'provisioning', 'recovery', 'retired']);
});

test('one-step restore rejects a stale caller revision before regenerating its preview', async () => {
  let previews = 0;
  const service = { topics: {
    get() { return { topicId: '11111111-1111-4111-8111-111111111111', revision: 2, paraCategory: 'archive', lifecycle: 'active' }; },
    restorePreview() { previews += 1; throw new Error('stale restore reached preview'); },
    listDestination() { return { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] }; }
  } };
  const response = await invokeRoute({ service, body: { schemaVersion: 1, action: 'restore', logicalOperationId: randomUUID(), topicId: '11111111-1111-4111-8111-111111111111', expectedRevision: 1, paraCategory: 'project' } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'conflict');
  assert.equal(previews, 0);
});

test('Topic mutation previews replace private Note Folder locators with convention descriptors', async () => {
  const topicId = randomUUID();
  const preview = (kind, from, to) => ({
    kind, topicId, structuralChangeId: randomUUID(), from, to, digest: `sha256:fictional-${kind}-preview`,
    expectedRevisions: [{ source: 'topic', id: topicId, revision: 1 }],
    changes: [
      { aspect: 'category', from, to },
      { aspect: 'note-folder-location', from: `/fictional/private/${from}/Topic`, to: `/fictional/private/${to}/Topic`, managed: true }
    ]
  });
  const service = { topics: {
    recategorizationPreview: () => preview('recategorization', 'project', 'area'),
    archivePreview: async () => preview('archive', 'area', 'archive'),
    listDestination() { return { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] }; }
  } };
  for (const [action, fields] of [['recategorize.preview', { paraCategory: 'area' }], ['archive.preview', {}]]) {
    const response = await invokeRoute({ service, body: { schemaVersion: 1, action, logicalOperationId: randomUUID(), topicId, expectedRevision: 1, ...fields } });
    assert.equal(response.statusCode, 200);
    const serialized = JSON.stringify(response.body);
    assert.doesNotMatch(serialized, /fictional\/private|\/(?:project|area|archive)\/Topic/);
    assert.deepEqual(response.body.result.preview.changes[1], { aspect: 'note-folder-location', managed: true, fromConvention: 'current-managed', toConvention: 'target-conventional' });
  }
});

test('Topics destination uses the authenticated POST lifecycle seam', () => {
  assert.match(app, /\/plugins\/command-center\/api\/topics\/actions/);
  assert.match(index, /<h2 id="topics-heading" tabindex="-1">Topics<\/h2>/);
  assert.match(index, /<script defer src="\/plugins\/command-center\/app\.js"><\/script>/);
  assert.match(app, /openclaw:capability-bridge-hello/);
  assert.doesNotMatch(index, /<script type="module"/);
  assert.match(index, /<input name="name" required/);
  assert.doesNotMatch(index, /name="name"[^>]*maxlength=/);
  assert.match(app, /new TextEncoder\(\)\.encode\(normalized\)\.length <= 255/);
  assert.match(app, /topicNameInput\.setCustomValidity/);
  assert.match(index, /<select name="paraCategory" required>/);
  assert.doesNotMatch(index, /name="(?:topicId|referenceId|session|folder|vault|identifier|recoveryPolicy)"/i);
  assert.match(app, /bridgeRequest\('command-center\.v1\.topics\.list'/);
  assert.match(app, /command-center\.v1\.topics\.list/);
  assert.doesNotMatch(app, /bridgeRequest\('command-center\.v1\.topics\.create'/);
  assert.match(app, /read[\s\S]*currentDestination/);
  assert.doesNotMatch(app, /READ_ROUTE/);
  assert.doesNotMatch(app, /api\/v1\/topics/);
  assert.match(app, /HTTP_ROUTE[\s\S]*method: 'POST'/);
  assert.match(app, /HTTP_ROUTE = '\/plugins\/command-center\/api\/topics\/actions'/);
  assert.match(app, /SHELL_ROUTE = '\/plugins\/command-center'/);
  assert.match(app, /view: 'destination'/);
  assert.match(app, /searchView: 'search'/);
  assert.match(app, /error\.destination/);
  assert.match(app, /provisioning\.retry/);
  assert.match(app, /provisioning\.rollback/);
  assert.match(app, /runAction\('rename'/);
  assert.match(app, /recategorize\.preview/);
  assert.match(app, /archive\.preview/);
  assert.doesNotMatch(app, /action:\s*'disable'/);
  assert.match(app, /Disable and retain every active Reminder and scheduled operation/);
  assert.match(app, /if \(error\.destination\) currentDestination = error\.destination/);
  assert.match(app, /Topic action failed:[\s\S]*await loadTopics\(error\.message\)/u);
  assert.match(app, /runAction\('restore'/);
  assert.match(app, /search\.query/);
  assert.match(app, /openclaw:capability-bridge/);
  assert.doesNotMatch(app, /SEARCH_ROUTE|query=fictional|parent\.|location\.hash|Bearer/i);
  assert.match(app, /recovery\.verify/);
  assert.match(app, /recovery\.relink/);
  assert.match(app, /recovery\.replace-session/);
  assert.match(app, /Relink Note Folder/);
  assert.match(app, /recovery-diagnostic/);
  assert.match(app, /expectedIdentity/);
  assert.match(app, /Blocked:/);
  assert.doesNotMatch(app, /recovery\.failure|\.routes/);
  assert.match(app, /expectedRevision: topic\.revision, expectedSourceRevision: recovery\.expectedRevision/);
  assert.match(app, /logicalOperationId: topic\.provisioningOperationId/);
  assert.match(app, /Creating Topic…/);
  assert.match(index, /id="topic-create-submit"/);
  assert.doesNotMatch(app, /topic-create-submit[^\n]+addEventListener\('click', createTopic\)/);
  assert.match(app, /topicCreateForm\?\.addEventListener\('submit', createTopic\)/);
  assert.match(app, /if \(topicCreatePending\) return;[\s\S]*validateTopicNameInput\(\);[\s\S]*if \(!topicCreateForm\.reportValidity\(\)\) return/);
  assert.match(app, /topicCreateSubmit\.disabled = true/);
  assert.match(app, /finally \{[\s\S]*topicCreatePending = false;[\s\S]*topicCreateSubmit\.disabled = false/su);
  assert.match(app, /restoreSubmitFocus[\s\S]*topicCreateSubmit\.focus\(\)/u);
  assert.match(app, /reportValidity\(\)/);
  assert.match(app, /Category:.*→/);
  assert.match(app, /Note Folder location: unchanged \(customized\)/);
  assert.match(app, /while \(value\?\.(?:result|value) !== undefined/);
  assert.match(app, /const bridgeTimer = setTimeout/);
  assert.match(app, /Topic created and verified/);
  assert.match(app, /topicCreateOperation \?\?= \{ \.\.\.intent, topicId: crypto\.randomUUID\(\), logicalOperationId: operationId\(\) \}/);
  assert.match(app, /Retry the unchanged name and category to reconcile it/);
  assert.match(app, /The Topic action response was unavailable\.[\s\S]*terminal: false/u);
  assert.match(app, /Provisioning record/);
  assert.match(index, /topic-exceptions/);
  assert.doesNotMatch(app, /WebSocket|parent\.|location\.hash|Bearer/i);
  assert.match(styles, /\.topic-create input,\.topic-create select[\s\S]*min-width:\s*0[\s\S]*box-sizing:\s*border-box/);
  assert.match(styles, /\.topic-group[\s\S]*min-width:\s*0[\s\S]*box-sizing:\s*border-box/);
  assert.match(styles, /\.topic-row>strong[^}]*overflow-wrap:\s*anywhere/);
});

test('authenticated Topics frame exercises lifecycle controls at desktop and narrow widths', { skip: !existsSync(chromium.executablePath()) && 'Playwright browser is supplied by the isolated evaluator' }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.setContent(index);
    await page.addStyleTag({ content: styles });
    const sanitizedRecoveryTopic = publicTopicDestination({
      activeGroups: { project: [], area: [], resource: [] }, provisioning: [], archived: [], retired: [],
      recovery: [{ topicId: 'recovery', name: 'Recovery Topic', revision: 1, paraCategory: 'resource', lifecycle: 'active', usable: false, recovery: [{ recoveryId: 'recovery:session:missing', topicId: 'recovery', referenceId: 'session:missing', sourceKind: 'session', state: 'required', expectedRevision: 'session-revision-1', failure: 'private provider failure', diagnostics: [{ topicId: 'recovery', referenceId: 'session:missing', sourceKind: 'session', expectedIdentity: 'exact Primary Session identity', check: 'exact-session-missing', status: 'recovery-required', retryable: true, routes: ['private-route'] }] }] }]
    }).recovery[0];
    assert.doesNotMatch(JSON.stringify(sanitizedRecoveryTopic), /private provider failure|private-route/);
    await page.evaluate((recoveryTopic) => {
      const longName = 'x'.repeat(255);
      const topic = (topicId, name, paraCategory, lifecycle = 'active', recovery = []) => ({ topicId, name, revision: 1, provisioningOperationId: '33333333-3333-4333-8333-333333333333', paraCategory, lifecycle, usable: lifecycle === 'active' && paraCategory !== 'archive' && recovery.length === 0, recovery });
      globalThis.__calls = [];
      globalThis.__created = false;
      let operationSequence = 0;
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: () => `71111111-1111-4111-8111-${String(++operationSequence).padStart(12, '0')}` });
      globalThis.prompt = () => { throw new Error('Native prompt is unavailable.'); };
      globalThis.__confirmations = [];
      globalThis.confirm = () => { throw new Error('Native confirm is unavailable.'); };
      const destination = () => ({ activeGroups: { project: [topic('active', 'Active Topic', 'project'), topic('long-active', longName, 'project'), ...(globalThis.__created ? [topic('created', 'Created Topic', 'project')] : [])], area: [], resource: [] }, provisioning: [topic('provisioning', 'Provisioning Topic', 'area', 'provisioning')], recovery: [recoveryTopic], archived: [topic('archived', 'Archived Topic', 'archive')] });
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body); globalThis.__calls.push({ method: `http:${body.action}`, params: body });
        if (body.action === 'create') globalThis.__created = true;
        const preview = { structuralChangeId: '44444444-4444-4444-8444-444444444444', digest: 'sha256:preview', expectedRevisions: [{ source: 'topic', id: body.topicId, revision: 1 }], changes: [], commitments: [] };
        return { ok: true, async json() { return body.action.endsWith('.preview') ? { status: 'applied', result: { preview } } : { status: 'applied', result: { destination: destination() } }; } };
      };
      window.addEventListener('message', (event) => {
        if (event.data?.type !== 'openclaw:capability-bridge-send') return;
        const payload = event.data.payload;
        if (payload.type === 'openclaw:capability-bridge-hello') {
          window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.sources.status', 'command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.sessions.send', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'sessions.create', 'ui.session.navigate'] } }, '*');
          return;
        }
        if (payload.type !== 'openclaw:capability-bridge-request') return;
        globalThis.__calls.push({ method: payload.method, params: payload.params, operationId: payload.operationId });
        const result = payload.method.endsWith('sources.status') ? { result: { schemaVersion: 1, mode: 'ready', unavailableCapabilities: [] } } : payload.method === 'sessions.create' ? { result: { key: `agent:main:dashboard:bridge-fictional-${payload.operationId}`, sessionId: `session-${payload.operationId}`, revision: '1' } } : payload.method.endsWith('.list') ? { result: destination() } : payload.method.endsWith('search.query') ? { result: { notes: { results: [] }, conversations: { results: [] } } } : { result: {} };
        window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: payload.requestId, result } }, '*');
      });
    }, sanitizedRecoveryTopic);
    await page.addScriptTag({ content: app });
    await page.locator('.topic-row > strong').filter({ hasText: /^Active Topic$/u }).waitFor();
    await page.getByText('Session session:missing: exact Primary Session identity; exact-session-missing (recovery-required). Blocked: messages, new conversations, and Session changes. Actions: verify exact source, relink Session, or replace Primary Session.').waitFor();
    await page.locator('#topic-create input[name="name"]').fill('Created Topic');
    await page.locator('#topic-create-submit').focus();
    await page.locator('#topic-create').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.getByText('Topic created and verified').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'topic-create-submit');
    for (const label of ['Retry', 'Roll back', 'Rename', 'Move to area', 'Archive', 'Restore to project', 'Search archive', 'Verify exact source', 'Relink Session', 'Replace Primary Session']) {
      await page.getByRole('button', { name: label }).first().click();
      const values = label.includes('Session') ? ['agent:main:replacement', 'session-id-replacement'] : label === 'Rename' ? ['Renamed Topic'] : ['Move to area', 'Archive'].includes(label) ? [undefined] : [];
      for (const value of values) {
        await page.locator('#command-dialog').waitFor({ state: 'visible' });
        await page.evaluate(() => globalThis.__confirmations.push(document.querySelector('#command-dialog-message').textContent));
        if (value !== undefined) await page.locator('#command-dialog-input').fill(value);
        await page.locator('#command-dialog-submit').press('Enter');
      }
      await page.locator('#command-dialog').waitFor({ state: 'hidden' });
    }
    await page.locator('#topic-search-query').fill('fictional');
    await page.locator('#topic-search-form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => {
      const methods = globalThis.__calls.map((call) => call.method);
      return ['http:create', 'provisioning.retry', 'provisioning.rollback', 'http:rename', 'recategorize.preview', 'archive.preview', 'http:restore', 'search.query', 'recovery.verify', 'recovery.relink', 'recovery.replace-session']
        .every((fragment) => methods.some((method) => method.includes(fragment)))
        && globalThis.__confirmations.some((message) => message.includes('Disable and retain every active Reminder and scheduled operation'));
    });
    const methods = await page.evaluate(() => globalThis.__calls.map((call) => call.method));
    assert.equal(methods.filter((method) => method === 'http:create').length, 1);
    await page.evaluate(() => {
      const node = document.querySelector('#topic-search-status'); window.__searchAnnouncements = [];
      new MutationObserver(() => window.__searchAnnouncements.push(node.textContent)).observe(node, { childList: true, subtree: true, characterData: true });
    });
    await page.locator('#topic-search-form button[type="submit"]').click();
    await page.waitForFunction(() => window.__searchAnnouncements.includes('Searching…') && window.__searchAnnouncements.includes('0 Notes · 0 Conversations'));
    for (const fragment of ['http:create', 'provisioning.retry', 'provisioning.rollback', 'http:rename', 'recategorize.preview', 'archive.preview', 'http:restore', 'search.query', 'recovery.verify', 'recovery.relink', 'recovery.replace-session']) assert.equal(methods.some((method) => method.includes(fragment)), true, fragment);
    const recoveryCall = await page.evaluate(() => globalThis.__calls.find((call) => call.method.endsWith('recovery.verify')));
    assert.equal(recoveryCall.params.expectedRevision, 1);
    assert.equal(recoveryCall.params.expectedSourceRevision, 'session-revision-1');
    assert.equal(await page.evaluate(() => globalThis.__confirmations.some((message) => message.includes('Disable and retain every active Reminder and scheduled operation (0 active of 0 commitment(s))'))), true);
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 320), true);
  } finally { await browser.close(); }
});
