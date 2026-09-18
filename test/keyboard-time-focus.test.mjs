import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';

test('native date/time controls retain visible keyboard focus across internal fields in both directions', async () => {
  const browser = await launchPinnedChromium();
  try {
    const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
    for (const width of [320, 1440]) for (const forcedColors of ['active', 'none']) for (const type of ['time', 'date', 'datetime-local']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', forcedColors });
      await page.setContent('<button>Host navigation</button><iframe title="Command Center"></iframe>');
      const frame = page.frames()[1];
      await frame.setContent(`<style>${styles}</style><button id="before">Before</button><label>Start <input id="start" type="${type}" required></label><label>End <input id="end" type="${type}" required></label><button id="after">After</button>`);
      await frame.locator('#before').focus();
      let nativeButtonObserved = false;
      for (const direction of ['Tab', 'Shift+Tab']) {
        let reachedBoundary = false;
        for (let step = 0; step < 24; step += 1) {
            await page.keyboard.press(direction);
            const state = await frame.evaluate(() => {
              const node = document.activeElement;
              return { name: node?.id, outline: getComputedStyle(node).outlineStyle, documentFocused: document.hasFocus(), focus: node.matches(':focus'), within: node.matches(':focus-within'), visible: node.matches(':focus-visible') };
            });
            const diagnostic = JSON.stringify({ width, forcedColors, type, direction, step, ...state });
            assert.equal(state.documentFocused, true, diagnostic);
            assert.notEqual(state.outline, 'none', diagnostic);
            if (!state.focus && state.within) nativeButtonObserved = true;
            if (state.name === (direction === 'Tab' ? 'after' : 'before')) { reachedBoundary = true; break; }
        }
        assert.equal(reachedBoundary, true, 'Tab must leave the native control without trapping focus');
      }
      assert.equal(nativeButtonObserved, true, `${type} must exercise the browser-owned picker focus, not only the text fields`);
      assert.equal(await frame.locator('#start').evaluate((node) => getComputedStyle(node).outlineStyle), 'none', 'outline must disappear after focus leaves the input');
    await page.close();
    }
  } finally { await browser.close(); }
});
