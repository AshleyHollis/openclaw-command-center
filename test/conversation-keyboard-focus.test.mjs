import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';
import { tabTo } from './support/keyboard-navigation.mjs';
import { closeOpenConversation } from './support/conversation-lifecycle.mjs';

test('closing a Conversation retains a keyboard path to its filter during asynchronous readback', async () => {
  const browser = await launchPinnedChromium();
  try {
    const [index, app, styles] = await Promise.all(['index.html', 'app.js', 'styles.css'].map((file) => readFile(new URL(`../src/ui/${file}`, import.meta.url), 'utf8')));
    for (const width of [320, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(3000);
        await page.setContent('<button>Host navigation</button><iframe title="Command Center" style="width:100%;height:800px;border:0"></iframe>');
        const frame = page.frames()[1];
        await frame.setContent(index.replace('<script defer src="/plugins/command-center/app.js"></script>', '').replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${styles}</style>`));
        await frame.addScriptTag({ content: app });
        await frame.evaluate(() => {
          applyOperatingState({ mode: 'ready', unavailableCapabilities: [] });
          const primary = { topicId: 'fictional-topic', referenceId: 'fictional-primary', sessionId: 'fictional-primary-session', displayName: 'Primary Conversation', status: 'open', isPrimary: true };
          const extra = { topicId: 'fictional-topic', referenceId: 'fictional-extra', sessionId: 'fictional-extra-session', displayName: 'Extra Conversation', status: 'open', isPrimary: false };
          workspace.topic = { topicId: 'fictional-topic', revision: 1, paraCategory: 'project' };
          workspace.selected = extra;
          workspace.conversations = [primary, extra];
          workspace.mobileSection = 'conversations';
          setWorkspaceVisible(true);
          selectMobileSection('conversations');
          globalThis.fetch = async () => { await new Promise((resolve) => { window.__releaseClose = resolve; }); extra.status = 'closed'; return { ok: true, async json() { return { result: {} }; } }; };
          bridgeRequest = async (method) => ({ result: method === 'command-center.v1.sessions.browse' ? { conversations: [primary, extra].filter((item) => document.querySelector('#conversation-view').value === 'closed' ? item.status === 'closed' : item.status === 'open') } : { messages: [] } });
          renderConversations();
        });
        const row = frame.locator('[data-reference-id="fictional-extra"]');
        let finished = false;
        const closing = closeOpenConversation(row, { keyboard: true, timeout: 3000, activate: async (control) => { await control.focus(); await page.keyboard.press('Enter'); } }).then(() => { finished = true; });
        await frame.waitForFunction(() => typeof window.__releaseClose === 'function');
        // Hold the actual response across multiple browser turns, proving that
        // the shared journey step cannot return merely because Enter was sent.
        await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(finished, false, `${width}px close step returned before its asynchronous list readback`);
        await frame.evaluate(() => window.__releaseClose());
        await closing;
        const filter = frame.locator('#conversation-view');
        await tabTo(filter);
        assert.equal(await frame.locator('#conversation-view').evaluate((node) => document.activeElement === node), true);
        await page.close();
    }
  } finally { await browser.close(); }
});

test('a close that never removes its open-list row still fails within the owning operation budget', async () => {
  const failure = new Error('Conversation remained open');
  let activated = false;
  const row = {
    getByRole(role, options) { assert.equal(role, 'button'); assert.deepEqual(options, { name: 'Close', exact: true }); return 'close-control'; },
    async waitFor(options) { assert.equal(activated, true); assert.deepEqual(options, { state: 'detached', timeout: 123 }); throw failure; }
  };
  await assert.rejects(closeOpenConversation(row, { keyboard: true, timeout: 123, activate: async (control, keyboard) => { assert.equal(control, 'close-control'); assert.equal(keyboard, true); activated = true; } }), (error) => error === failure);
});
