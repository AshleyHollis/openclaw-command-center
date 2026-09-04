import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

const index = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

test('Dashboard markup keeps the required first-class regions and narrow flow launcher', () => {
  for (const id of ['dashboard', 'attention-cards', 'in-progress', 'coming-up', 'topic-launcher', 'activity', 'activity-load-more', 'evidence-dialog']) assert.match(index, new RegExp(`id="${id}"`, 'u'));
  assert.match(index, /role="dialog"/u);
  assert.match(index, /aria-modal|<dialog/u);
  assert.match(styles, /48rem/u);
  assert.match(styles, /prefers-reduced-motion/u);
  assert.match(styles, /min-height: 44px/u);
  assert.match(styles, /overflow-x: hidden/u);
  assert.match(app, /openclawNotification|notificationRecord/u);
  assert.match(app, /Load more Activity/u);
  assert.match(app, /\['session', 'note'\]\.includes\(record\.navigation\.kind\)/u);
  assert.match(app, /Activity source opened\./u);
  assert.match(app, /feedback\.dataset\.activityReceipt = serialized/u);
  assert.match(app, /serialized\.length <= 4096/u);
  for (const id of ['conversation-previous', 'conversation-next', 'conversation-page-status']) assert.match(index, new RegExp(`id="${id}"`, 'u'));
  assert.match(app, /CONVERSATION_PAGE_SIZE = 50/u);
  assert.match(app, /workspace\.conversations\.slice\(start, start \+ CONVERSATION_PAGE_SIZE\)/u);
  assert.match(app, /command-center\.v1\.topics\.get/u);
  assert.match(app, /data-topic-id|dataset\.topicId/u);
  assert.match(app, /credentials: 'omit'/u);
  assert.match(app, /loadDashboard\(\)/u);
  assert.match(app, /error\?\.code === 'capability-unavailable'.*error\?\.code === 'INVALID_PARAMS'.*error\?\.message === 'Gateway rejected bridge request'/u);
  assert.match(app, /await rebuildTopicSearchProjection\(params\.topicId\)/u);
  assert.match(index, /aria-describedby="evidence-content"/u);
  assert.match(index, /id="note-action-dialog"[^>]*aria-describedby="note-action-status"/u);
});

test('deferred shell initialization exposes both bridge globals before readiness resolves', { skip: !existsSync(chromium.executablePath()) && 'Playwright browser is supplied by the isolated evaluator' }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(index);
    await page.evaluate(() => {
      globalThis.fetch = async () => ({ ok: true, async json() { return { schemaVersion: 1, status: 'applied', result: { serverTime: '2026-08-30T00:00:00.000Z', attentionBadgeCount: 0, attention: [], inProgress: [], comingUp: [], topics: [], activity: { records: [], nextOffset: null, hasMore: false } } }; } });
      window.addEventListener('message', (event) => {
        const payload = event.data?.payload;
        if (payload?.type === 'openclaw:capability-bridge-hello') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.sources.status', 'command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] } }, '*');
      });
    });
    const readiness = page.waitForFunction(async () => {
      if (!window.CommandCenterTopics || !window.CommandCenterSearch) return false;
      await Promise.all([window.CommandCenterTopics.ready, window.CommandCenterSearch.ready]);
      return typeof window.CommandCenterTopics.loadTopics === 'function' && typeof window.CommandCenterSearch.search === 'function';
    });
    await page.addScriptTag({ content: app });
    await readiness;
  } finally { await browser.close(); }
});

test('wide and narrow Topic launchers and topic.open actions open the exact verified Topic', { skip: !existsSync(chromium.executablePath()) && 'Playwright browser is supplied by the isolated evaluator' }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1200, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const document = index.replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${styles}</style>`);
      await page.setContent(document);
      await page.evaluate(() => {
        const topic = { topicId: 'topic-ui', name: 'Fictional Topic', paraCategory: 'project', lifecycle: 'active' };
        globalThis.fetch = async (_url, options = {}) => {
          if (options.method === 'POST') return { ok: true, async json() { return { schemaVersion: 1, status: 'applied', result: { navigation: { topicId: topic.topicId }, activity: { activityId: 'activity-ui-source-action', episodeId: 'episode-ui', logicalOperationId: 'operation-ui', topicId: topic.topicId, sourceReferenceId: 'source-ui', operationKind: 'topic.open', outcome: 'applied', verificationRevision: 'revision-ui', occurredAt: '2026-08-27T12:00:01.000Z' } } }; } };
          return { ok: true, async json() { return { schemaVersion: 1, status: 'applied', result: { serverTime: '2026-08-27T12:00:00.000Z', attentionBadgeCount: 1, attention: [{ episodeId: 'episode-ui', sourceCapabilityId: 'monitor', stableSubjectId: 'subject-ui', topicId: topic.topicId, revision: 1, severity: 'High', sourceKind: 'monitor', context: 'A fictional item', evidence: {}, actions: [{ actionId: 'topic.open', label: 'Open Topic', kind: 'navigation' }], eligibleSnoozeChoices: [] }], inProgress: [], comingUp: [], topics: [topic], activity: { records: [], nextOffset: null, hasMore: false }, activityOffset: 0, activityLimit: 50 } }; } };
        };
        window.__topicRequests = [];
        window.addEventListener('message', (event) => {
          const payload = event.data?.payload;
          if (payload?.type === 'openclaw:capability-bridge-hello') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.sources.status', 'command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] } }, '*');
          if (payload?.type !== 'openclaw:capability-bridge-request') return;
          window.__topicRequests.push(payload.method);
          const result = payload.method === 'command-center.v1.topics.get'
            ? { topic }
            : { activeGroups: { project: [topic], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] };
          window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: payload.requestId, result: { result } } }, '*');
        });
      });
      await page.addScriptTag({ content: app });
      await page.getByText('A fictional item').first().waitFor();
      const launcher = width >= 768 ? page.locator('#header-topic-selector') : page.locator('#flow-topic-launcher');
      await launcher.selectOption('topic-ui');
      await page.getByText('Fictional Topic opened.').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.topicId), 'topic-ui');
      const before = await page.evaluate(() => window.__topicRequests.filter((method) => method === 'command-center.v1.topics.get').length);
      await page.getByRole('button', { name: 'Open Topic' }).click();
      await page.waitForFunction((count) => window.__topicRequests.filter((method) => method === 'command-center.v1.topics.get').length > count, before);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.topicId), 'topic-ui');
      assert.deepEqual(JSON.parse(await page.locator('#dashboard-feedback').getAttribute('data-activity-receipt')), { activityId: 'activity-ui-source-action', episodeId: 'episode-ui', logicalOperationId: 'operation-ui', topicId: 'topic-ui', sourceReferenceId: 'source-ui', operationKind: 'topic.open', outcome: 'applied', verificationRevision: 'revision-ui', occurredAt: '2026-08-27T12:00:01.000Z' });
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Dashboard is keyboard-usable at 320px and opens a scrollable evidence dialog', { skip: !existsSync(chromium.executablePath()) && 'Playwright browser is supplied by the isolated evaluator' }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 720 }, reducedMotion: 'reduce' });
    const document = index.replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${styles}</style>`);
    await page.setContent(document);
    await page.evaluate(() => {
      globalThis.fetch = async (_url, options = {}) => {
        if (options.method === 'POST') return { ok: true, async json() { return { schemaVersion: 1, status: 'applied', result: { episode: { state: 'Action running' } } }; } };
        const result = { schemaVersion: 1, status: 'applied', result: { serverTime: '2026-08-27T12:00:00.000Z', attentionBadgeCount: 1, attention: [{ episodeId: 'episode-ui', notificationRecordId: 'record-ui', sourceCapabilityId: 'monitor', stableSubjectId: 'subject-ui', topicId: 'topic-ui', sourceReferenceId: 'source-ui', revision: 1, severity: 'High', sourceKind: 'monitor', context: 'A fictional item', evidence: { context: 'A fictional item', explanation: 'A long but safe explanation '.repeat(30) }, actions: [], eligibleSnoozeChoices: [] }], inProgress: [], comingUp: [], topics: [{ topicId: 'topic-ui', name: 'Fictional Topic' }], activity: { records: [], nextOffset: null, hasMore: false }, activityOffset: 0, activityLimit: 50 } };
        return { ok: true, async json() { return result; } };
      };
      window.addEventListener('message', (event) => {
        const payload = event.data?.payload;
        if (payload?.type === 'openclaw:capability-bridge-hello') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.sources.status', 'command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] } }, '*');
        if (payload?.type === 'openclaw:capability-bridge-request') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: payload.requestId, result: { result: { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] } } } }, '*');
      });
    });
    await page.addScriptTag({ content: app });
    await page.getByText('A fictional item').first().waitFor();
    await page.getByRole('button', { name: 'View evidence' }).click();
    assert.equal(await page.getByRole('dialog').getAttribute('open'), '');
    assert.equal(await page.locator('.evidence-scroll').evaluate((node) => getComputedStyle(node).overflowY), 'auto');
    await page.getByRole('button', { name: 'Close' }).click();
    assert.equal(await page.getByRole('dialog').getAttribute('open'), null);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 320), true);
    assert.equal(await page.locator('button').evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).display !== 'none').every((node) => node.getBoundingClientRect().height >= 44)), true);
  } finally { await browser.close(); }
});

test('authenticated operating modes preserve safe reads and suppress unsupported mounted mutations', { skip: !existsSync(chromium.executablePath()) && 'Playwright browser is supplied by the isolated evaluator' }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      { mode: 'ready', unavailableCapabilities: [], mutations: true },
      { mode: 'degraded', unavailableCapabilities: ['sessions.write'], mutations: false },
      { mode: 'degraded', unavailableCapabilities: ['notes.write', 'search.rebuild'], mutations: false },
      { mode: 'recovery-only', unavailableCapabilities: ['database-schema'], mutations: false },
      { mode: 'recovery-only', unavailableCapabilities: ['compatibility-tuple', 'binding'], mutations: false }
    ]) {
      const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
      const document = index.replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${styles}</style>`).replace('<script defer src="/plugins/command-center/app.js"></script>', '');
      await page.setContent(document);
      await page.evaluate(({ mode, unavailableCapabilities }) => {
        const topic = { topicId: 'topic-mode-fixture', name: 'Fictional Mode Topic', revision: 1, paraCategory: 'project', lifecycle: 'active', usable: true, sourceReferences: [] };
        globalThis.__modePosts = [];
        globalThis.fetch = async (url, options = {}) => {
          if (options.method === 'POST') globalThis.__modePosts.push(url);
          if (url.includes('/api/dashboard')) return { ok: true, async json() { return { status: 'ok', result: { serverTime: '2026-08-30T00:00:00.000Z', attention: [], attentionBadgeCount: 0, inProgress: [], comingUp: [], topics: [topic], activity: { records: [], hasMore: false }, notificationSettings: null } }; } };
          if (url.endsWith('/api/topic-analysis')) return { ok: true, async json() { return { status: 'ok', result: { schedule: null, review: null } }; } };
          return { ok: false, async json() { return { status: 'error', message: 'Mutation refused by fixture.' }; } };
        };
        window.addEventListener('message', (event) => {
          const payload = event.data?.payload;
          if (payload?.type === 'openclaw:capability-bridge-hello') { window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.sources.status', 'command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] } }, '*'); return; }
          if (payload?.type !== 'openclaw:capability-bridge-request') return;
          const result = payload.method.endsWith('sources.status') ? { schemaVersion: 1, mode, unavailableCapabilities } : payload.method.endsWith('topics.list') ? { activeGroups: { project: [topic], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] } : payload.method.endsWith('topics.get') ? { topic } : {};
          window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: payload.requestId, result: { result } } }, '*');
        });
      }, variant);
      await page.addScriptTag({ content: app });
      await page.getByText(variant.mode === 'ready' ? 'Ready' : variant.mode === 'degraded' ? 'Degraded · safe reads only' : 'Recovery-only · diagnostics and safe reads only', { exact: true }).waitFor();
      await page.getByText('Fictional Mode Topic').first().waitFor();
      assert.equal(await page.getByRole('button', { name: 'Open Topic' }).isVisible(), true, `${variant.mode} must retain safe Topic reads`);
      assert.equal(await page.locator('#topic-search-form button[type="submit"]').isVisible(), true, `${variant.mode} must retain safe indexed reads`);
      for (const selector of ['#topic-create', '#notification-settings-form', '#topic-analysis-schedule', '#topic-search-rebuild']) assert.equal(await page.locator(selector).isVisible(), variant.mutations, `${variant.mode} mutation visibility mismatch for ${selector}`);
      assert.equal(await page.getByRole('button', { name: 'Rename' }).isVisible(), variant.mutations);
      if (!variant.mutations) {
        await assert.rejects(() => page.evaluate(() => window.CommandCenterTopics.mutate('create', { name: 'Blocked', paraCategory: 'project' })), /Mutations are unavailable/iu);
        assert.deepEqual(await page.evaluate(() => globalThis.__modePosts), []);
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
