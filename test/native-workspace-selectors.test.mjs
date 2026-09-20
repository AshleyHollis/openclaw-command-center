import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { organizeNativeTopicConversations, selectNativeCategoryGrouping, selectNativeSidePanelType } from './support/native-topic-workspace.mjs';

test('native grouping journey selects a Topic row relative to its shadow-root page', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent('<button id="expand" aria-label="Expand sidebar">Expand</button><openclaw-app-sidebar hidden><div class="topic-sidebar"><details aria-label="All native conversations" open><summary>All conversations</summary><button class="sidebar-session-sort">Hidden predecessor sort</button></details></div><section data-session-section="category:Sample"><button aria-expanded="true">Sample</button></section></openclaw-app-sidebar><openclaw-app-sidebar id="sidebar" hidden><button hidden class="sidebar-session-sort">Retired sort</button><div class="topic-sidebar"><button id="collapse-topics">Collapse all Topics</button><details id="native-conversations" aria-label="All native conversations"><summary>All conversations</summary><div class="sidebar-session-toolbar"><button id="visible-global-sort" class="sidebar-session-sort">Sort sessions</button></div></details></div><section data-session-section="category:Sample"><button aria-expanded="true">Sample</button><div data-session-key="agent:main:sample">Overview</div></section></openclaw-app-sidebar><button id="catalog-sort" class="sidebar-session-sort sidebar-session-catalog-grouping">Catalog view</button><div role="menu"><wa-dropdown-item hidden value="grouping:category" role="menuitemradio">Category</wa-dropdown-item></div><openclaw-plugin-page></openclaw-plugin-page>');
    await page.evaluate(() => {
      for (const id of ['visible-global-sort', 'catalog-sort']) {
        document.getElementById(id).addEventListener('click', () => {
          document.body.dataset.clickedSort = id;
          document.querySelector('wa-dropdown-item[value="grouping:category"]').hidden = false;
        });
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
    assert.equal(await page.locator('#native-conversations').evaluate(element => element.open), true);
    await organizeNativeTopicConversations({ page, nativePage: page.locator('openclaw-plugin-page'), fixture: { name: 'Sample', sessionKey: 'agent:main:sample' } });
  } finally { await browser.close(); }
});

test('native grouping journey leaves team mode through the workspace menu', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent('<openclaw-app-sidebar><button class="sidebar-workspace-header__main">Workspace</button></openclaw-app-sidebar><wa-dropdown hidden class="sidebar-agent-menu"><wa-dropdown-item value="command:sidebar-agents">Show one agent</wa-dropdown-item></wa-dropdown><div hidden id="menu"><wa-dropdown-item value="grouping:category">Category</wa-dropdown-item></div>');
    await page.evaluate(() => {
      const sidebar = document.querySelector('openclaw-app-sidebar');
      const workspace = sidebar.querySelector('.sidebar-workspace-header__main');
      const agentMenu = document.querySelector('wa-dropdown.sidebar-agent-menu');
      const showOne = document.querySelector('wa-dropdown-item[value="command:sidebar-agents"]');
      workspace.addEventListener('click', () => { agentMenu.hidden = false; });
      showOne.addEventListener('click', () => {
        workspace.remove();
        sidebar.insertAdjacentHTML('afterbegin', '<button class="sidebar-agent-card__main">Agent</button><div class="topic-sidebar"><button id="collapse-topics">Collapse all Topics</button><details id="team-native-conversations" aria-label="All native conversations"><summary>All conversations</summary><div class="sidebar-session-toolbar"><button id="single-agent-sort" class="sidebar-session-sort">Sort sessions</button></div></details></div>');
        document.querySelector('#collapse-topics').addEventListener('click', () => { document.body.dataset.collapsedTopics = 'true'; });
        document.querySelector('#single-agent-sort').addEventListener('click', () => {
          document.querySelector('#menu').hidden = false;
          document.body.dataset.clickedSort = 'single-agent-sort';
        });
        setTimeout(() => { agentMenu.hidden = true; }, 25);
      });
    });
    await selectNativeCategoryGrouping(page);
    assert.equal(await page.locator('body').getAttribute('data-collapsed-topics'), 'true');
    assert.equal(await page.locator('#team-native-conversations').evaluate(element => element.open), true);
    assert.equal(await page.locator('body').getAttribute('data-clicked-sort'), 'single-agent-sort');
  } finally { await browser.close(); }
});

test('native grouping journey scrolls after opening the Conversations disclosure', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.setContent('<openclaw-app-sidebar><div class="sidebar-shell__body" style="height: 200px; overflow-y: auto"><div class="topic-sidebar"><div style="height: 500px"></div><details id="scrolled-native-conversations" aria-label="All native conversations"><summary>All conversations</summary><button id="scrolled-sort" class="sidebar-session-sort">Sort sessions</button></details></div></div></openclaw-app-sidebar><wa-dropdown-item hidden value="grouping:category">Category</wa-dropdown-item>');
    await page.evaluate(() => {
      document.querySelector('#scrolled-sort').addEventListener('click', () => {
        document.querySelector('wa-dropdown-item[value="grouping:category"]').hidden = false;
        document.body.dataset.clickedSort = 'scrolled-sort';
      });
    });
    await selectNativeCategoryGrouping(page);
    assert.equal(await page.locator('body').getAttribute('data-clicked-sort'), 'scrolled-sort');
    assert.equal(await page.locator('#scrolled-native-conversations').evaluate(element => element.open), true);
    assert.ok(await page.locator('.sidebar-shell__body').evaluate(element => element.scrollTop > 0));
  } finally { await browser.close(); }
});

test('native grouping journey reuses an already-open Conversations disclosure', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<openclaw-app-sidebar><div class="topic-sidebar"><details id="open-native-conversations" open aria-label="All native conversations"><summary>All conversations</summary><button id="open-sort" class="sidebar-session-sort">Sort sessions</button></details></div></openclaw-app-sidebar><wa-dropdown-item hidden value="grouping:category">Category</wa-dropdown-item>');
    await page.evaluate(() => {
      document.querySelector('#open-native-conversations > summary').addEventListener('click', () => { document.body.dataset.summaryClicked = 'true'; });
      document.querySelector('#open-sort').addEventListener('click', () => {
        document.querySelector('wa-dropdown-item[value="grouping:category"]').hidden = false;
        document.body.dataset.clickedSort = 'open-sort';
      });
    });
    await selectNativeCategoryGrouping(page);
    assert.equal(await page.locator('body').getAttribute('data-summary-clicked'), null);
    assert.equal(await page.locator('body').getAttribute('data-clicked-sort'), 'open-sort');
    assert.equal(await page.locator('#open-native-conversations').evaluate(element => element.open), true);
  } finally { await browser.close(); }
});

test('native grouping journey reports a missing visible control within its local deadline', { timeout: 25_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<openclaw-app-sidebar><div class="topic-sidebar"><details aria-label="All native conversations"><summary>All conversations</summary><button hidden class="sidebar-session-sort">Retired sort</button></details></div></openclaw-app-sidebar>');
    await assert.rejects(selectNativeCategoryGrouping(page), /Native session grouping control is unavailable/u);
  } finally { await browser.close(); }
});

test('native side panel selection ignores a hidden populated predecessor', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<div hidden class="sidebar-region__right-runtime"><div class="side-panel"><div class="side-panel__header-tabs"><button aria-label="Add side panel tab">Hidden add</button></div></div></div><div class="sidebar-region__right-runtime" style="width:400px;height:200px"><div class="side-panel" style="position:relative;width:0;height:0;overflow:visible"><div class="side-panel-empty--selector" style="position:absolute;width:300px;height:100px"><div class="side-panel-empty__types"><button class="side-panel-empty__type">Topic Notes</button></div></div></div></div>');
    assert.equal(await page.locator('.sidebar-region__right-runtime:not([hidden]) .side-panel').isVisible(), false);
    assert.equal(await page.locator('.sidebar-region__right-runtime:not([hidden]) .side-panel-empty--selector').isVisible(), true);
    await page.evaluate(() => {
      document.querySelector('.sidebar-region__right-runtime:not([hidden]) .side-panel-empty__type').addEventListener('click', () => { document.body.dataset.selectedPanel = 'visible-empty'; });
    });
    await selectNativeSidePanelType({ page, label: 'Topic Notes' });
    assert.equal(await page.locator('body').getAttribute('data-selected-panel'), 'visible-empty');
  } finally { await browser.close(); }
});

test('native side panel selection uses the visible populated panel menu', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<div hidden class="sidebar-region__right-runtime"><div class="side-panel"><div class="side-panel-empty--selector"><div class="side-panel-empty__types"><button class="side-panel-empty__type">Topic Notes</button></div></div></div></div><div class="sidebar-region__right-runtime" style="width:400px;height:200px"><div class="side-panel" style="position:relative;width:0;height:0;overflow:visible"><div data-region-header="side" style="position:absolute;width:300px;height:100px"><div class="side-panel__header-tabs"><button aria-label="Add side panel tab">Add</button><wa-dropdown-item hidden>Topic Notes</wa-dropdown-item></div></div></div></div>');
    assert.equal(await page.locator('.sidebar-region__right-runtime:not([hidden]) .side-panel').isVisible(), false);
    assert.equal(await page.locator('.sidebar-region__right-runtime:not([hidden]) [data-region-header="side"]').isVisible(), true);
    await page.evaluate(() => {
      const region = document.querySelector('.sidebar-region__right-runtime:not([hidden])');
      region.querySelector('[aria-label="Add side panel tab"]').addEventListener('click', () => { region.querySelector('wa-dropdown-item').hidden = false; });
      region.querySelector('wa-dropdown-item').addEventListener('click', () => { document.body.dataset.selectedPanel = 'visible-menu'; });
    });
    await selectNativeSidePanelType({ page, label: 'Topic Notes' });
    assert.equal(await page.locator('body').getAttribute('data-selected-panel'), 'visible-menu');
  } finally { await browser.close(); }
});
