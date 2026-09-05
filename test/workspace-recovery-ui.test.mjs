import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';

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
    assert.equal(await page.locator('#chat-send').isDisabled(), true);
    assert.equal(await page.locator('#chat-message').isDisabled(), true);
    assert.equal(await page.locator('[data-reference-id="fictional-new"]').getByRole('button', { name: 'Replacement Conversation' }).isEnabled(), true);
    await page.locator('#conversation-refresh').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Replacement Conversation');
  } finally { await browser.close(); }
});
