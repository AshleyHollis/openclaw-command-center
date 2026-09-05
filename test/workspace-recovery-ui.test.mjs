import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';

test('delayed Topic rename preserves row focus without stealing outside focus', async () => {
  const browser = await launchPinnedChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const index = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
    await page.setContent(index.replace('<script defer src="/plugins/command-center/app.js"></script>', ''));
    await page.addScriptTag({ content: app });
    await page.evaluate(() => {
      applyOperatingState({ mode: 'ready', unavailableCapabilities: [] });
      const topics = ['first', 'second'].map((id) => ({ topicId: `fictional-${id}`, name: `Fictional ${id}`, revision: 1, paraCategory: 'project', lifecycle: 'active', usable: true }));
      const destination = { activeGroups: { project: topics }, provisioning: [], recovery: [], archived: [] };
      renderDestination(destination);
      statusNode.textContent = 'Topic renamed.';
      window.fetch = async (_url, options) => new Promise((resolve) => {
        const input = JSON.parse(options.body);
        globalThis.completeRename = () => {
          const topic = topics.find((item) => item.topicId === input.topicId);
          topic.name = input.name; topic.revision += 1;
          resolve({ ok: true, json: async () => ({ result: { destination } }) });
        };
      });
    });
    for (const [id, outside] of [['first', false], ['second', true]]) {
      const row = page.locator(`[data-topic-id="fictional-${id}"]`);
      await row.getByRole('button', { name: 'Rename', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.locator('#command-dialog-input').fill(`Renamed ${id}`);
      await page.locator('#command-dialog-input').press('Enter');
      await page.waitForFunction(() => typeof globalThis.completeRename === 'function');
      assert.equal(await page.locator('#command-dialog').isVisible(), false);
      assert.equal(await page.locator('#topic-status').innerText(), 'Topic renamed.', 'generic status may still belong to a previous rename');
      if (outside) await page.locator('#analysis-run').focus();
      await page.evaluate(() => { completeRename(); globalThis.completeRename = undefined; });
      await row.getByText(`Renamed ${id}`, { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.id || `${document.activeElement.closest('.topic-row')?.dataset.topicId}:${document.activeElement.textContent}`), outside ? 'analysis-run' : `fictional-${id}:Rename`);
    }
  } finally { await browser.close(); }
});

test('replaced unavailable Conversation retains a visible explanation without live controls', async () => {
  const browser = await launchPinnedChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const index = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
    const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
    await page.setContent(index.replace('<script defer src="/plugins/command-center/app.js"></script>', '').replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${styles}</style>`));
    await page.addScriptTag({ content: app });
    await page.evaluate(() => {
      applyOperatingState({ mode: 'ready', unavailableCapabilities: [] });
      document.querySelector('#topic-workspace').hidden = false;
      workspace.conversations = [
        { referenceId: 'fictional-old', sessionId: 'fictional-old-id', displayName: 'Former Conversation', status: 'open', isPrimary: false, availability: 'replaced-unavailable' },
        { referenceId: 'fictional-new', sessionId: 'fictional-new-id', displayName: 'Replacement Conversation', status: 'open', isPrimary: true }
      ];
      workspace.selected = workspace.conversations[0];
      renderConversations();
      syncSelectedConversationControls();
    });
    const old = page.locator('[data-reference-id="fictional-old"]');
    assert.equal(await old.getByRole('button', { name: 'Former Conversation' }).isDisabled(), true);
    assert.match(await old.innerText(), /Replaced — source unavailable; history reference retained/);
    assert.equal(await old.locator('button:not(:disabled)').count(), 0);
    assert.equal(await page.locator('#chat-open').isDisabled(), true);
    assert.equal(await page.locator('#chat-form').count(), 0);
    assert.equal(await page.locator('[data-reference-id="fictional-new"]').getByRole('button', { name: 'Replacement Conversation' }).isEnabled(), true);
    await page.locator('#conversation-refresh').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Replacement Conversation');
  } finally { await browser.close(); }
});
