import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openNativeTopicFiles, organizeNativeTopicConversations, selectNativeCategoryGrouping, swapNativeTopicFilesWithChat } from './support/native-topic-workspace.mjs';

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

test('native Files resolution ignores a hidden predecessor and follows slot reconciliation', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<openclaw-chat-pane aria-hidden="false" style="display:block;width:200px;height:100px">Chat</openclaw-chat-pane><openclaw-app-sidebar hidden><div class="topic-sidebar"><section data-topic-id="topic-one" data-expanded="true"><button data-topic-control-key="files:topic-one">Hidden predecessor Files</button></section></div></openclaw-app-sidebar><openclaw-app-sidebar><div class="topic-sidebar"><button data-topic-control-key="para:project" aria-expanded="false" aria-controls="projects">Projects</button><div id="projects" hidden><section data-topic-id="topic-one" data-expanded="true"><button data-topic-control-key="files:topic-one">Files</button></section></div></div></openclaw-app-sidebar><section hidden data-panel-slot="workspace"><openclaw-plugin-view><div data-topic-reader-page="panel">Hidden predecessor</div></openclaw-plugin-view></section><main id="slots"></main>');
    await page.evaluate(() => {
      document.querySelector('openclaw-chat-pane').sessionKey = 'agent:fictional:topic-one';
      const category = document.querySelector('openclaw-app-sidebar:not([hidden]) [data-topic-control-key="para:project"]');
      category.addEventListener('click', () => { category.setAttribute('aria-expanded', 'true'); document.querySelector('#projects').hidden = false; });
      document.querySelector('openclaw-app-sidebar:not([hidden]) [data-topic-control-key="files:topic-one"]').addEventListener('click', () => {
        const slot = document.createElement('section'); slot.dataset.panelSlot = 'workspace'; slot.dataset.region = 'side';
        const view = document.createElement('openclaw-plugin-view'); view.kind = 'replacement'; view.contributionKey = 'topic-files'; view.presented = true; view.props = { sessionKey: 'agent:fictional:topic-one' };
        view.innerHTML = '<div data-topic-reader-page="panel">Current workspace</div>'; slot.append(view); document.querySelector('#slots').replaceChildren(slot);
      });
    });
    const workspace = await openNativeTopicFiles({ page, fixture: { topicId: 'topic-one', paraCategory: 'project', sessionKey: 'agent:fictional:topic-one' } });
    assert.equal(await page.locator('openclaw-app-sidebar:visible [data-topic-control-key="para:project"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await workspace.innerText(), 'Current workspace');
    await page.evaluate(() => {
      const replacement = document.querySelector('[data-panel-slot="workspace"]:not([hidden])').cloneNode(true);
      replacement.dataset.region = 'main'; replacement.querySelector('openclaw-plugin-view').presented = true;
      replacement.querySelector('openclaw-plugin-view').props = { sessionKey: 'agent:fictional:topic-one' };
      replacement.querySelector('[data-topic-reader-page]').textContent = 'Reconciled workspace'; document.querySelector('#slots').replaceChildren(replacement);
    });
    assert.equal(await workspace.innerText(), 'Reconciled workspace');
  } finally { await browser.close(); }
});

test('native Files resolution reuses an already-open exact workspace', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<openclaw-chat-pane aria-hidden="false" style="display:block;width:200px;height:100px">Chat</openclaw-chat-pane><openclaw-app-sidebar><div class="topic-sidebar"><button data-topic-control-key="para:project" aria-expanded="true">Projects</button><section data-topic-id="topic-one" data-expanded="true"><button data-topic-control-key="files:topic-one">Files</button></section></div></openclaw-app-sidebar><section data-panel-slot="workspace" data-region="side"><openclaw-plugin-view><div data-topic-reader-page="panel">Already open</div></openclaw-plugin-view></section>');
    await page.evaluate(() => {
      document.querySelector('openclaw-chat-pane').sessionKey = 'agent:fictional:topic-one';
      const view = document.querySelector('openclaw-plugin-view'); view.kind = 'replacement'; view.contributionKey = 'topic-files'; view.presented = true; view.props = { sessionKey: 'agent:fictional:topic-one' };
      document.querySelector('[data-topic-control-key="files:topic-one"]').addEventListener('click', () => { document.body.dataset.reused = 'true'; });
    });
    const workspace = await openNativeTopicFiles({ page, fixture: { topicId: 'topic-one', paraCategory: 'project', sessionKey: 'agent:fictional:topic-one' } });
    assert.equal(await workspace.innerText(), 'Already open');
    assert.equal(await page.locator('body').getAttribute('data-reused'), 'true');
  } finally { await browser.close(); }
});

test('native Files swap uses the active Chat pane control and current replacement label', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<openclaw-chat-pane aria-hidden="true" hidden><button class="chat-panel-swap" aria-label="Swap Topic Notes and Chat">Hidden predecessor</button></openclaw-chat-pane><openclaw-chat-pane aria-hidden="false"><button class="chat-panel-swap" aria-label="Swap Topic Files and Chat">Swap</button></openclaw-chat-pane>');
    await page.evaluate(() => document.querySelector('openclaw-chat-pane[aria-hidden="false"] .chat-panel-swap').addEventListener('click', () => { document.body.dataset.swapped = 'true'; }));
    const nativeChat = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    await swapNativeTopicFilesWithChat({ page, nativeChat });
    assert.equal(await page.locator('body').getAttribute('data-swapped'), 'true');
  } finally { await browser.close(); }
});
