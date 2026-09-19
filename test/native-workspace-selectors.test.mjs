import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { organizeNativeTopicConversations, selectNativeCategoryGrouping } from './support/native-topic-workspace.mjs';

test('native grouping journey selects a Topic row relative to its shadow-root page', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent('<div style="height:20px;overflow:hidden"><div style="height:100px"></div><div class="sidebar-session-toolbar"><button id="visible-global-sort" class="sidebar-session-sort">Sort sessions</button></div></div><button id="catalog-sort" class="sidebar-session-sort sidebar-session-catalog-grouping">Catalog view</button><div role="menu"><wa-dropdown-item value="grouping:category" role="menuitemradio">Category</wa-dropdown-item></div><openclaw-plugin-page></openclaw-plugin-page><section hidden data-session-section="category:Sample"><button aria-expanded="true">Sample</button></section><section data-session-section="category:Sample"><button aria-expanded="true">Sample</button><div data-session-key="agent:main:sample">Overview</div></section>');
    await page.evaluate(() => {
      for (const id of ['visible-global-sort', 'catalog-sort']) {
        document.getElementById(id).addEventListener('click', () => document.body.dataset.clickedSort = id);
      }
    });
    await page.evaluate(() => {
      const root = document.querySelector('openclaw-plugin-page').attachShadow({ mode: 'open' });
      root.innerHTML = '<ul><li><button>View Notes for Sample</button><button id="organize">Organize Conversations in native group</button><p role="status"></p></li></ul>';
      root.querySelector('#organize').onclick = () => { root.querySelector('[role="status"]').textContent = '1 Conversations organized. 0 already grouped and preserved. 0 blocked and left unchanged. Existing groups and Notes bindings were preserved.'; };
    });
    await selectNativeCategoryGrouping(page);
    assert.equal(await page.locator('body').getAttribute('data-clicked-sort'), 'visible-global-sort');
    await organizeNativeTopicConversations({ page, nativePage: page.locator('openclaw-plugin-page'), fixture: { name: 'Sample', sessionKey: 'agent:main:sample' } });
  } finally { await browser.close(); }
});
