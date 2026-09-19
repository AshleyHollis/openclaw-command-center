import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { organizeNativeTopicConversations, selectNativeCategoryGrouping } from './support/native-topic-workspace.mjs';

test('native grouping journey selects a Topic row relative to its shadow-root page', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent('<button id="expand" aria-label="Expand sidebar">Expand</button><openclaw-app-sidebar hidden><button class="sidebar-session-sort">Hidden sort</button><section data-session-section="category:Sample"><button aria-expanded="true">Sample</button></section></openclaw-app-sidebar><openclaw-app-sidebar id="sidebar" hidden><div class="sidebar-session-toolbar"><button id="visible-global-sort" class="sidebar-session-sort">Sort sessions</button></div><section data-session-section="category:Sample"><button aria-expanded="true">Sample</button><div data-session-key="agent:main:sample">Overview</div></section></openclaw-app-sidebar><button id="catalog-sort" class="sidebar-session-sort sidebar-session-catalog-grouping">Catalog view</button><div role="menu"><wa-dropdown-item value="grouping:category" role="menuitemradio">Category</wa-dropdown-item></div><openclaw-plugin-page></openclaw-plugin-page>');
    await page.evaluate(() => {
      for (const id of ['visible-global-sort', 'catalog-sort']) {
        document.getElementById(id).addEventListener('click', () => document.body.dataset.clickedSort = id);
      }
      document.getElementById('expand').addEventListener('click', () => {
        document.getElementById('sidebar').hidden = false;
        document.getElementById('expand').hidden = true;
      });
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

test('native grouping journey leaves team mode through the workspace menu', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent('<openclaw-app-sidebar><button class="sidebar-workspace-header__main">Workspace</button></openclaw-app-sidebar><wa-dropdown-item hidden value="command:sidebar-agents">Show one agent</wa-dropdown-item><div hidden id="menu"><wa-dropdown-item value="grouping:category">Category</wa-dropdown-item></div>');
    await page.evaluate(() => {
      const sidebar = document.querySelector('openclaw-app-sidebar');
      const workspace = sidebar.querySelector('.sidebar-workspace-header__main');
      const showOne = document.querySelector('wa-dropdown-item[value="command:sidebar-agents"]');
      workspace.addEventListener('click', () => { showOne.hidden = false; });
      showOne.addEventListener('click', () => {
        workspace.remove();
        sidebar.insertAdjacentHTML('afterbegin', '<button class="sidebar-agent-card__main">Agent</button><div class="sidebar-session-toolbar"><button id="single-agent-sort" class="sidebar-session-sort">Sort sessions</button></div>');
        document.querySelector('#single-agent-sort').addEventListener('click', () => {
          document.querySelector('#menu').hidden = false;
          document.body.dataset.clickedSort = 'single-agent-sort';
        });
      });
    });
    await selectNativeCategoryGrouping(page);
    assert.equal(await page.locator('body').getAttribute('data-clicked-sort'), 'single-agent-sort');
  } finally { await browser.close(); }
});
