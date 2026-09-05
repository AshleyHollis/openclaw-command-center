import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';

test('Dashboard refresh retains exact Attention focus and snooze draft, or moves to its owner when removed', async () => {
  const browser = await launchPinnedChromium();
  try {
    for (const width of [320, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const [index, app, styles] = await Promise.all(['index.html', 'app.js', 'styles.css'].map((file) => readFile(new URL(`../src/ui/${file}`, import.meta.url), 'utf8')));
      await page.setContent(index.replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${styles}</style>`));
      await page.evaluate(() => {
        const episode = (id) => ({ episodeId: id, sourceCapabilityId: 'reminders', stableSubjectId: id, topicId: 'fictional-topic', sourceReferenceId: id, revision: 1, sourceRevision: 'config-1', context: id, actions: [{ actionId: 'reminder.complete', label: 'Reminder Complete' }], eligibleSnoozeChoices: ['NEXT_0700', 'PT72H', 'custom'] });
        window.__attention = [episode('fictional-first'), episode('fictional-second')];
        globalThis.fetch = async () => ({ ok: true, async json() { return { result: {} }; } });
        window.addEventListener('message', (event) => {
          const payload = event.data?.payload;
          const send = (value) => window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: value }, '*');
          if (payload?.type === 'openclaw:capability-bridge-hello') return send({ type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.dashboard.get', 'command-center.v1.sources.status', 'command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.attention.act', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigateResolved'] });
          if (payload?.type !== 'openclaw:capability-bridge-request') return;
          let result = {};
          if (payload.method === 'command-center.v1.dashboard.get') result = { attention: window.__attention, attentionBadgeCount: window.__attention.length, inProgress: [], comingUp: [], topics: [], activity: { records: [], hasMore: false } };
          if (payload.method === 'command-center.v1.sources.status') result = { mode: 'ready', unavailableCapabilities: [] };
          if (payload.method === 'command-center.v1.topics.list') result = { activeGroups: { project: [], area: [], resource: [] } };
          const deliver = () => send({ type: 'openclaw:capability-bridge-response', requestId: payload.requestId, result: { result } });
          if (payload.method === 'command-center.v1.dashboard.get' && window.__deferDashboard) { window.__deferDashboard = false; window.__releaseDashboard = deliver; }
          else deliver();
        });
      });
      await page.addScriptTag({ content: app });
      const card = page.locator('[data-episode-id="fictional-second"]');
      const select = card.getByLabel('Snooze duration');
      await select.waitFor({ timeout: 3000 }).catch(async (error) => { throw new Error(`${error.message}; ${await page.locator('#dashboard-feedback').textContent()}; ${await page.locator('#operating-mode-status').textContent()}`); });
      await select.selectOption('PT72H');
      await select.focus();
      await page.evaluate(async () => { window.__attention.shift(); await loadDashboard(); });
      assert.equal(await select.evaluate((node) => document.activeElement === node), true, `${width}px refresh detached the focused Snooze select`);
      assert.equal(await select.inputValue(), 'PT72H');
      await select.selectOption('custom');
      const custom = card.getByLabel('Custom snooze time');
      await custom.fill('2099-01-02T12:30');
      await custom.focus();
      await page.evaluate(() => loadDashboard());
      assert.equal(await custom.evaluate((node) => document.activeElement === node), true);
      assert.equal(await custom.inputValue(), '2099-01-02T12:30');
      await card.getByRole('button', { name: 'Reminder Complete', exact: true }).focus();
      await page.evaluate(() => loadDashboard());
      assert.equal(await card.getByRole('button', { name: 'Reminder Complete', exact: true }).evaluate((node) => document.activeElement === node), true);
      await page.evaluate(() => { window.__deferDashboard = true; window.__refresh = loadDashboard(); });
      await page.waitForFunction(() => typeof window.__releaseDashboard === 'function');
      await page.locator('#topic-create input[name="name"]').focus();
      await page.evaluate(async () => { window.__releaseDashboard(); await window.__refresh; });
      assert.equal(await page.locator('#topic-create input[name="name"]').evaluate((node) => document.activeElement === node), true, 'refresh must not steal newer focus outside Attention');
      await select.focus();
      await page.evaluate(async () => { window.__attention[0].episodeId = 'fictional-replacement'; await loadDashboard(); });
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'attention-heading');
      assert.equal(await page.locator('#attention-heading').evaluate((node) => getComputedStyle(node).outlineStyle), 'solid');
      await page.evaluate(() => { window.__deferDashboard = true; window.__releaseDashboard = null; window.__refresh = loadDashboard(); });
      await page.waitForFunction(() => typeof window.__releaseDashboard === 'function');
      await page.evaluate(async () => { window.__attention = []; await loadDashboard(); });
      assert.equal(await page.locator('#attention-cards .attention-card').count(), 0);
      await page.evaluate(async () => { window.__releaseDashboard(); await window.__refresh; });
      assert.equal(await page.locator('#attention-cards .attention-card').count(), 0, 'an older Dashboard response must not resurrect removed Attention');
      await page.close();
    }
  } finally { await browser.close(); }
});
