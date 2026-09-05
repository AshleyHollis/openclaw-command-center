import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { hasKeyboardFocusIndicator } from '../src/browser-evidence.mjs';
import { afterKeyboardPaint } from './support/keyboard-paint.mjs';

test('keyboard evidence observes painted reduced-motion focus and still rejects missing indicators', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.setContent(`<style>
      button { background: transparent; outline: none; border: 0; transition: background-color 20ms 120ms; }
      button:focus-visible { background: color-mix(in srgb, #bcbcc0 7%, transparent); }
      #missing:focus-visible { background: transparent; }
      @media (prefers-reduced-motion: reduce) { * { transition-duration: 0.01ms !important; } }
      </style><button id="painted">Fictional conversation</button><button id="missing">Missing indicator</button>`);
    for (const id of ['painted', 'missing']) {
      const target = page.locator(`#${id}`);
      const baselineBackgroundColor = await target.evaluate((node) => getComputedStyle(node).backgroundColor);
      await page.keyboard.press('Tab');
      // Reset the transition inside one render task to make its initial frame deterministic.
      await target.evaluate((node) => { node.blur(); getComputedStyle(node).backgroundColor; node.focus(); getComputedStyle(node).backgroundColor; });
      await target.evaluate(afterKeyboardPaint);
      const state = await target.evaluate((node) => ({ focused: document.activeElement === node, outline: getComputedStyle(node).outlineStyle, focusVisible: node.matches(':focus-visible'), backgroundColor: getComputedStyle(node).backgroundColor }));
      assert.equal(state.focused, true);
      assert.equal(hasKeyboardFocusIndicator({ ...state, baselineBackgroundColor }), id === 'painted', JSON.stringify(state));
    }
    await page.addStyleTag({ content: '#painted { transition-delay: 60s; }' });
    const stalled = page.locator('#painted');
    await stalled.focus();
    await assert.rejects(stalled.evaluate(afterKeyboardPaint), /Keyboard focus transition did not settle within 1000ms/);
  } finally { await browser.close(); }
});
