import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertResponsiveFrame } from './support/keyboard-accessibility.mjs';

test('responsive audit reacquires a replaced plugin iframe and retains every assertion', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  const document = `<!doctype html><html><head><style>button{width:48px;height:48px}</style></head><body><h1>Dashboard</h1><button aria-label="Open Topic">Open</button><dialog id="evidence-dialog"></dialog><dialog id="note-action-dialog"></dialog><dialog id="command-dialog"></dialog></body></html>`;
  await page.setContent('<iframe class="plugin-tab-embed__frame" title="Command Center"></iframe>');
  await page.locator('iframe').evaluate((node, html) => { node.srcdoc = html; }, document);
  const resolveFrame = async () => (await page.locator('iframe.plugin-tab-embed__frame').elementHandle()).contentFrame();
  const staleFrame = await resolveFrame();
  await staleFrame.locator('h1').waitFor();
  await page.locator('iframe').evaluate((node, html) => {
    const replacement = node.cloneNode();
    replacement.srcdoc = html;
    node.replaceWith(replacement);
  }, document);
  const currentFrame = await resolveFrame();
  await currentFrame.locator('h1').waitFor();
  assert.equal(staleFrame.isDetached(), true);

  const result = await assertResponsiveFrame(staleFrame, page, 320, { resolveFrame });
  assert.equal(result.noPageOverflow, true);
  assert.equal(result.frame, currentFrame);

  await currentFrame.locator('button').evaluate((node) => { node.style.width = '20px'; });
  await assert.rejects(assertResponsiveFrame(staleFrame, page, 320, { resolveFrame }), /below 44px/u);
});
