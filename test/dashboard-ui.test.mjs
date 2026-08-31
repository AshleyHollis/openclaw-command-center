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
  assert.match(app, /command-center\.v1\.topics\.get/u);
  assert.match(app, /data-topic-id|dataset\.topicId/u);
  assert.match(app, /credentials: 'omit'/u);
  assert.match(app, /loadDashboard\(\)/u);
  assert.match(app, /error\?\.code !== 'capability-unavailable'/u);
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
        if (payload?.type === 'openclaw:capability-bridge-hello') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] } }, '*');
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
          if (options.method === 'POST') return { ok: true, async json() { return { schemaVersion: 1, status: 'applied', result: { navigation: { topicId: topic.topicId } } }; } };
          return { ok: true, async json() { return { schemaVersion: 1, status: 'applied', result: { serverTime: '2026-08-27T12:00:00.000Z', attentionBadgeCount: 1, attention: [{ episodeId: 'episode-ui', sourceCapabilityId: 'monitor', stableSubjectId: 'subject-ui', topicId: topic.topicId, revision: 1, severity: 'High', sourceKind: 'monitor', context: 'A fictional item', evidence: {}, actions: [{ actionId: 'topic.open', label: 'Open Topic', kind: 'navigation' }], eligibleSnoozeChoices: [] }], inProgress: [], comingUp: [], topics: [topic], activity: { records: [], nextOffset: null, hasMore: false }, activityOffset: 0, activityLimit: 50 } }; } };
        };
        window.__topicRequests = [];
        window.addEventListener('message', (event) => {
          const payload = event.data?.payload;
          if (payload?.type === 'openclaw:capability-bridge-hello') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] } }, '*');
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
        if (payload?.type === 'openclaw:capability-bridge-hello') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] } }, '*');
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
