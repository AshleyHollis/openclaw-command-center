import assert from 'node:assert/strict';

function renderedMarkdownLines(markdown) {
  return String(markdown).split(/\r?\n/u)
    .map((line) => line.replace(/^#{1,6}\s+/u, '').trim())
    .filter(Boolean);
}

/** Reading view is formatted; Source is the exact authoritative Markdown. */
export async function assertNativeFormattedNote(noteContent, fixture) {
  const expected = renderedMarkdownLines(fixture.noteText);
  assert.ok(expected.length > 0, 'Fixture Note requires readable Markdown content');
  await noteContent.getByRole('heading', { name: expected[0], exact: true }).waitFor({ timeout: 30_000 });
  const rendered = await noteContent.innerText();
  for (const line of expected) assert.ok(rendered.includes(line), `Formatted Reading view omitted: ${line}`);
}

export async function assertNativeNoteSource(nativePage, fixture) {
  await nativePage.getByRole('button', { name: 'Source', exact: true }).click();
  const source = nativePage.getByRole('region', { name: 'Note source', exact: true });
  await source.filter({ hasText: fixture.noteText.trim() }).waitFor({ timeout: 30_000 });
  assert.equal(await source.textContent(), fixture.noteText);
  await nativePage.getByRole('button', { name: 'Reading', exact: true }).click();
}

// Native sidebar grouping is an operator presentation preference, not Topic
// ownership. Exercise the host control explicitly so this journey can prove
// that a verified Topic category is actually reachable in the sidebar.
export async function selectNativeCategoryGrouping(page) {
  let sidebar = page.locator('openclaw-app-sidebar:visible').first();
  let topicSidebar;
  let nativeDisclosure;
  let groupingControl;
  try {
    if (!await sidebar.count()) {
      const expand = page.locator('button[aria-label="Expand sidebar"]:visible').first();
      await expand.click({ timeout: 10_000 });
    }
    // A fresh isolated host can place its sticky community invitation over
    // the session toolbar. Dismiss that real native surface before exercising
    // the grouping control so the click remains an actual pointer interaction.
    const invitation = sidebar.locator('button[aria-label="Dismiss and don\'t show again"]:visible').first();
    if (await invitation.count()) await invitation.click({ timeout: 10_000 });

    // Team mode deliberately offers only roster filters. Switch through the
    // native workspace menu to the single-agent presentation before choosing
    // a category grouping, which exists only in that presentation's menu.
    const workspaceMenu = sidebar.locator('.sidebar-workspace-header__main:visible').first();
    if (await workspaceMenu.count()) {
      await workspaceMenu.click({ timeout: 10_000 });
      const showOneAgent = page.locator('wa-dropdown-item[value="command:sidebar-agents"]:visible').first();
      await showOneAgent.waitFor({ state: 'visible', timeout: 10_000 });
      await showOneAgent.click({ timeout: 10_000 });
      sidebar = page.locator('openclaw-app-sidebar:visible').first();
      await sidebar.locator('.sidebar-agent-card__main:visible').first().waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('wa-dropdown.sidebar-agent-menu').waitFor({ state: 'hidden', timeout: 10_000 });
    }
    // Keep the plugin projection compact before revealing its delegated native
    // Conversations view. The native grouping control lives inside that closed
    // disclosure and is not actionable until an operator opens it.
    const collapseTopics = sidebar.getByRole('button', { name: 'Collapse all Topics', exact: true }).first();
    if (await collapseTopics.isVisible()) await collapseTopics.click({ timeout: 10_000 });

    topicSidebar = sidebar.locator('.topic-sidebar:visible').first();
    await topicSidebar.waitFor({ state: 'visible', timeout: 10_000 });
    nativeDisclosure = topicSidebar.locator(':scope > details[aria-label="All native conversations"]').first();
    await nativeDisclosure.waitFor({ state: 'attached', timeout: 10_000 });
    if (!await nativeDisclosure.evaluate(element => element.open)) {
      await nativeDisclosure.locator(':scope > summary').click({ timeout: 10_000 });
    }
    await topicSidebar.locator(':scope > details[aria-label="All native conversations"][open]').waitFor({ state: 'attached', timeout: 10_000 });

    groupingControl = nativeDisclosure.locator('button.sidebar-session-sort:not(.sidebar-session-catalog-grouping):visible').first();
    await groupingControl.waitFor({ state: 'visible', timeout: 10_000 });
    await groupingControl.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await groupingControl.click({ timeout: 10_000 });
  }
  catch (error) {
    const state = await sidebar.count() ? await sidebar.evaluate(element => {
      const scroller = element.querySelector('.sidebar-shell__body');
      const disclosures = Array.from(element.querySelectorAll('.topic-sidebar > details[aria-label="All native conversations"]'));
      const controls = Array.from(element.querySelectorAll('button.sidebar-session-sort:not(.sidebar-session-catalog-grouping)'));
      return {
        workspaceHeader: Boolean(element.querySelector('.sidebar-workspace-header')),
        agentCard: Boolean(element.querySelector('.sidebar-agent-card__main')),
        agentRoster: Boolean(element.querySelector('.sidebar-agent-roster')),
        disclosures: disclosures.slice(0, 4).map(disclosure => ({
          open: disclosure.open,
          visible: disclosure.checkVisibility(),
          summaryVisible: disclosure.querySelector(':scope > summary')?.checkVisibility() ?? false,
          nativeMountVisible: disclosure.querySelector(':scope > div')?.checkVisibility() ?? false
        })),
        sortControls: controls.slice(0, 8).map(control => ({
          visible: control.checkVisibility(),
          disabled: control.disabled,
          ariaLabel: control.getAttribute('aria-label'),
          nearestDisclosureOpen: control.closest('details')?.open ?? null
        })),
        scroller: scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null
      };
    }) : null;
    const failure = { name: error?.name, tail: String(error?.message ?? error).split('\n').slice(-12) };
    throw new Error(`Native session grouping control is unavailable: ${JSON.stringify({ failure, state })}`, { cause: error });
  }
  const category = page.locator('wa-dropdown-item[value="grouping:category"]:visible').first();
  await category.waitFor({ state: 'visible', timeout: 10_000 });
  await category.click({ timeout: 10_000 });
}

// Exercise only the visible native UI, using the authenticated journey's real
// Gateway and fixture. No mocked transport, injected app state, or raw writes.
export async function organizeNativeTopicConversations({ page, nativePage, fixture, observedRosters = () => [] }) {
  const row = nativePage.getByRole('listitem').filter({ has: page.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }) });
  await row.getByRole('button', { name: 'Organize Conversations in native group', exact: true }).click({ timeout: 30_000 });
  const status = row.getByRole('status');
  await status.filter({ hasText: /Conversations organized|Setup stopped/ }).waitFor({ timeout: 30_000 });
  assert.match(await status.textContent(), /1 Conversations organized\. 0 already grouped and preserved\. 0 blocked and left unchanged\./);
  // Sidebar reconciliation can briefly retain a hidden predecessor beside
  // the current section. Bind the journey to the visible native section.
  const sidebar = page.locator('openclaw-app-sidebar:visible').first();
  const group = sidebar.locator(`[data-session-section="category:${fixture.name}"]`);
  try { await group.waitFor({ state: 'visible', timeout: 30_000 }); }
  catch (error) {
    const rosters = observedRosters().slice(-3).map(item => ({
      keys: Object.keys(item),
      matching: (item.value?.sessions ?? item.sessions ?? []).filter(session => session.key === fixture.sessionKey).map(session => ({ category: session.category, kind: session.kind, ownerPresent: Boolean(session.ownerId) }))
    }));
    const sections = await page.locator('[data-session-section]').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { id: element.getAttribute('data-session-section'), display: style.display, visibility: style.visibility,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        sidebarVisible: Boolean(element.closest('openclaw-app-sidebar')?.getBoundingClientRect().width) };
    }));
    throw new Error(`Native grouping sidebar not visible: ${JSON.stringify({ rosters, sections })}`, { cause: error });
  }
  const toggle = group.getByRole('button', { name: fixture.name, exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await group.locator(`[data-session-key="${fixture.sessionKey}"]`).waitFor({ state: 'visible' });
}

export async function openNativeTopicFiles({ page, fixture, onStage } = {}) {
  await onStage?.('verify-active-native-chat');
  const activeChat = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  await activeChat.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction((sessionKey) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === sessionKey, fixture.sessionKey, { timeout: 30_000 });

  await onStage?.('open-topic-files');
  const sidebar = page.locator('openclaw-app-sidebar:visible').first();
  const topicSidebar = sidebar.locator('.topic-sidebar:visible').first();
  const topic = topicSidebar.locator(`[data-topic-id="${fixture.topicId}"]`);
  try {
    await topicSidebar.waitFor({ state: 'visible', timeout: 10_000 });
    const category = topicSidebar.locator(`[data-topic-control-key="para:${fixture.paraCategory}"]`);
    await category.waitFor({ state: 'visible', timeout: 10_000 });
    if (await category.getAttribute('aria-expanded') !== 'true') {
      await category.click({ timeout: 10_000 });
      await page.waitForFunction((control) => control.getAttribute('aria-expanded') === 'true', await category.elementHandle(), { timeout: 10_000 });
    }
    await topic.waitFor({ state: 'visible', timeout: 10_000 });
    if (await topic.getAttribute('data-expanded') !== 'true') {
      await topic.locator(`[data-topic-control-key="toggle:${fixture.topicId}"]`).click({ timeout: 10_000 });
      await topic.locator(`[data-topic-control-key="files:${fixture.topicId}"]`).waitFor({ state: 'visible', timeout: 10_000 });
    }
    await topic.locator(`[data-topic-control-key="files:${fixture.topicId}"]`).click({ timeout: 10_000 });
  } catch (error) {
    const diagnostics = await sidebar.evaluate((element, topicId) => ({
      categories: Array.from(element.querySelectorAll('[data-topic-control-key^="para:"]'), (control) => ({
        key: control.getAttribute('data-topic-control-key'), expanded: control.getAttribute('aria-expanded'), visible: control.checkVisibility()
      })),
      topics: Array.from(element.querySelectorAll('[data-topic-id]'), (entry) => ({
        topicId: entry.getAttribute('data-topic-id'), expanded: entry.getAttribute('data-expanded'), visible: entry.checkVisibility(), exact: entry.getAttribute('data-topic-id') === topicId
      }))
    }), fixture.topicId).catch(() => null);
    throw new Error(`Native Topic Files action is unavailable: ${JSON.stringify(diagnostics)}`, { cause: error });
  }

  await onStage?.('resolve-topic-files-slot');
  const workspace = page.locator('[data-panel-slot="workspace"]:visible').filter({ has: page.locator('openclaw-plugin-view') });
  const reader = workspace.locator('[data-topic-reader-page="panel"]');
  try {
    await reader.waitFor({ state: 'visible', timeout: 30_000 });
    const identity = await workspace.locator('openclaw-plugin-view').evaluate((view) => ({
      kind: Reflect.get(view, 'kind'), contributionKey: Reflect.get(view, 'contributionKey'),
      presented: Reflect.get(view, 'presented'), props: Reflect.get(view, 'props')
    }));
    if (identity.presented !== true || identity.props?.sessionKey !== fixture.sessionKey) {
      throw new Error(`Resolved native Files slot has the wrong identity: ${JSON.stringify(identity)}`);
    }
    return workspace;
  } catch (error) {
    const diagnostics = await page.locator('[data-panel-slot="workspace"]').evaluateAll((slots) => slots.slice(0, 8).map((slot) => ({
      hidden: slot.hidden, region: slot.getAttribute('data-region'), text: slot.textContent?.trim().slice(0, 1_000) ?? '',
      views: Array.from(slot.querySelectorAll('openclaw-plugin-view'), (view) => ({
        kind: Reflect.get(view, 'kind'), contributionKey: Reflect.get(view, 'contributionKey'),
        presented: Reflect.get(view, 'presented'), props: Reflect.get(view, 'props')
      }))
    })));
    throw new Error(`Native Topic Files workspace is unavailable: ${JSON.stringify(diagnostics).slice(0, 4_000)}`, { cause: error });
  }
}

export async function swapNativeTopicFilesWithChat({ page, nativeChat }) {
  const swap = nativeChat.locator('.chat-panel-swap:visible').first();
  try {
    await swap.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await swap.getAttribute('aria-label'), 'Swap Topic Files and Chat');
    await swap.click({ timeout: 10_000 });
  } catch (error) {
    const diagnostics = await page.locator('.chat-panel-swap').evaluateAll((controls) => controls.slice(0, 8).map((control) => ({
      label: control.getAttribute('aria-label'), visible: control.checkVisibility(),
      activeChat: control.closest('openclaw-chat-pane')?.getAttribute('aria-hidden') === 'false'
    }))).catch(() => []);
    throw new Error(`Native Topic Files swap control is unavailable: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
}

export async function verifyNativeTopicNotesPane({ page, fixture, onPromoted, onStage } = {}) {
  const workspace = await openNativeTopicFiles({ page, fixture, onStage });
  await onStage?.('select-overview-note');
  // The preceding reader journey deliberately leaves a filename filter and
  // selected nested Note in place.  Reusing that mounted native panel is the
  // contract we need to prove; reset only its visible filter before choosing
  // the fixture Overview.  The former assertion assumed a fresh panel and
  // therefore mistook preserved reader state for missing Conversation context.
  const reader = workspace.locator('[data-topic-reader-page="panel"]');
  const filter = reader.getByRole('searchbox', { name: 'Filter files by name or path', exact: true });
  try {
    await filter.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const diagnostic = await workspace.evaluate((panel) => ({
      text: panel.innerText.slice(0, 2_000),
      statuses: Array.from(panel.querySelectorAll('[role="status"], [role="alert"]'), (status) => status.textContent?.trim().slice(0, 500) ?? ''),
      pluginViews: Array.from(panel.querySelectorAll('openclaw-plugin-view'), (view) => ({
        kind: Reflect.get(view, 'kind'),
        contributionKey: Reflect.get(view, 'contributionKey'),
        presented: Reflect.get(view, 'presented'),
        props: Reflect.get(view, 'props'),
        text: (view.textContent ?? '').slice(0, 500)
      })),
      tabs: Array.from(panel.querySelectorAll('[role="tab"]'), (tab) => ({ name: tab.getAttribute('aria-label') ?? tab.textContent?.trim(), selected: tab.getAttribute('aria-selected') }))
    })).catch(() => null);
    throw new Error(`Topic Notes panel did not mount its native reader: ${JSON.stringify(diagnostic).slice(0, 3_000)}`, { cause: error });
  }
  await filter.fill('');
  await filter.fill(fixture.notePath);
  const overview = reader.getByRole('button', { name: fixture.notePath.split('/').at(-1), exact: true });
  try {
    await overview.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const diagnostic = await workspace.evaluate((panel) => ({
      text: panel.innerText.slice(0, 2_000),
      pluginViews: Array.from(panel.querySelectorAll('openclaw-plugin-view'), (view) => ({
        kind: Reflect.get(view, 'kind'),
        contributionKey: Reflect.get(view, 'contributionKey'),
        text: (view.textContent ?? '').slice(0, 500)
      })),
      tabs: Array.from(panel.querySelectorAll('[role="tab"]'), (tab) => ({ name: tab.getAttribute('aria-label') ?? tab.textContent?.trim(), selected: tab.getAttribute('aria-selected') }))
    })).catch(() => null);
    throw new Error(`Topic Notes panel did not receive the selected native Conversation context: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  await overview.click({ timeout: 30_000 });
  // Native Chat retains its historical "primary" class when moved aside.
  // Region assignment, visible geometry and content prove actual promotion.
  const mainPanel = page.locator('[data-panel-slot="workspace"][data-region="main"]:visible');
  const promoted = mainPanel.getByRole('region', { name: 'Note content', exact: true });
  try {
    await assertNativeFormattedNote(promoted, fixture);
  } catch (error) {
    // Keep an acceptance failure bounded but actionable. This records only the
    // fixture UI state, not a host path, credential, or unredacted transport.
    const diagnostic = await mainPanel.evaluate((panel) => ({
      text: panel.innerText.slice(0, 2_000),
      topicStatus: panel.querySelector('[role="status"]')?.textContent?.slice(0, 500) ?? null,
      noteTitle: panel.querySelector('[aria-label="Note content"]')?.textContent?.slice(0, 500) ?? null
    })).catch(() => null);
    throw new Error(`Promoted Topic Notes did not render the selected authoritative Note: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  await onStage?.('verify-centre-pane');
  const sideChat = page.locator('.sidebar-region__primary[data-region="side"]');
  await sideChat.waitFor({ state: 'visible', timeout: 10_000 });
  const [notesBox, chatBox] = await Promise.all([mainPanel.boundingBox(), sideChat.boundingBox()]);
  assert.ok(notesBox && chatBox && notesBox.width > 0 && chatBox.width > 0);
  assert.ok(notesBox.x + notesBox.width <= chatBox.x + 2, 'Selected Note must occupy the center pane before Chat on the right');
  await onPromoted?.();
  // Pane promotion is host-owned.  Put an unsent value into its actual native
  // composer before swapping so the reader journey proves that the host moves
  // the existing Chat surface rather than replacing its session or draft.
  const nativeChat = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  const composer = nativeChat.locator('.agent-chat__composer-combobox textarea');
  const unsentDraft = 'Fictional unsent native Chat draft retained through pane swap.';
  await composer.fill(unsentDraft);
  assert.equal(await nativeChat.evaluate((pane) => pane.sessionKey), fixture.sessionKey);
  assert.equal(await composer.inputValue(), unsentDraft);
  await onStage?.('swap-pane');
  assert.equal(await page.locator('.sidebar-region__right-runtime').getByRole('tab', { name: 'Chat', exact: true }).count(), 1);
  await swapNativeTopicFilesWithChat({ page, nativeChat });
  await onStage?.('verify-swapped-pane');
  await page.locator('.sidebar-region__primary[data-region="main"]').waitFor({ state: 'visible', timeout: 10_000 });
  await assertNativeFormattedNote(page.locator('[data-panel-slot="workspace"][data-region="side"]:visible').getByRole('region', { name: 'Note content', exact: true }), fixture);
  await nativeChat.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await nativeChat.evaluate((pane) => pane.sessionKey), fixture.sessionKey, 'Pane swap must retain the exact linked native Conversation.');
  assert.equal(await composer.inputValue(), unsentDraft, 'Pane swap must retain the unsent native Chat draft.');
}
