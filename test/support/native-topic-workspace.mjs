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

export async function selectNativeSidePanelType({ page, label, onStage } = {}) {
  await onStage?.('inspect-side-panel');
  const sidebar = page.locator('.sidebar-region__right-runtime:visible .side-panel:visible').first();
  const hasHeader = await sidebar.locator('[data-region-header="side"]').isVisible({ timeout: 10_000 });
  const hasSelector = await sidebar.locator('.side-panel-empty--selector').isVisible({ timeout: 10_000 });
  if (!hasHeader && !hasSelector) {
    await onStage?.('open-side-panel');
    await page.locator('.chat-side-panel-toggle:visible').first().click({ timeout: 30_000 });
  }
  await onStage?.('select-topic-notes-tab');
  try {
    await sidebar.locator('.side-panel-empty__types:visible, .side-panel__header-tabs:visible').first().waitFor({ timeout: 30_000 });
    const emptyChoice = sidebar.locator('.side-panel-empty__type:visible').filter({ hasText: label });
    if (await emptyChoice.isVisible()) {
      await emptyChoice.click({ timeout: 30_000 });
    } else {
      const add = sidebar.getByRole('button', { name: 'Add side panel tab', exact: true });
      await add.click({ timeout: 30_000 });
      await sidebar.locator('wa-dropdown-item:visible').filter({ hasText: label }).click({ timeout: 30_000 });
    }
    return sidebar;
  } catch (error) {
    const diagnostics = await page.locator('.sidebar-region__right-runtime .side-panel').evaluateAll((panels) => panels.slice(0, 8).map((panel) => ({
      visible: panel.checkVisibility?.() ?? null,
      text: panel.textContent?.trim().slice(0, 1_000) ?? '',
      selectorVisible: panel.querySelector('.side-panel-empty--selector')?.checkVisibility?.() ?? false,
      headerVisible: panel.querySelector('[data-region-header="side"]')?.checkVisibility?.() ?? false,
      addVisible: panel.querySelector('[aria-label="Add side panel tab"]')?.checkVisibility?.() ?? false
    })));
    throw new Error(`Native side panel type is unavailable: ${JSON.stringify({ label, diagnostics }).slice(0, 3_000)}`, { cause: error });
  }
}

export async function verifyNativeTopicNotesPane({ page, fixture, onPromoted, onStage } = {}) {
  const sidebar = await selectNativeSidePanelType({ page, label: 'Topic Notes', onStage });
  await onStage?.('select-overview-note');
  // The preceding reader journey deliberately leaves a filename filter and
  // selected nested Note in place.  Reusing that mounted native panel is the
  // contract we need to prove; reset only its visible filter before choosing
  // the fixture Overview.  The former assertion assumed a fresh panel and
  // therefore mistook preserved reader state for missing Conversation context.
  const reader = sidebar.locator('[data-topic-reader-page="panel"]');
  const filter = reader.getByRole('searchbox', { name: 'Filter filenames', exact: true });
  await filter.waitFor({ state: 'visible', timeout: 30_000 });
  await filter.fill('');
  const overview = reader.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true });
  try {
    await overview.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const diagnostic = await sidebar.evaluate((panel) => ({
      text: panel.innerText.slice(0, 2_000),
      pluginViews: Array.from(panel.querySelectorAll('openclaw-plugin-view'), (view) => ({
        kind: view.getAttribute('kind'),
        contributionKey: view.getAttribute('contributionkey'),
        text: (view.textContent ?? '').slice(0, 500)
      })),
      tabs: Array.from(panel.querySelectorAll('[role="tab"]'), (tab) => ({ name: tab.getAttribute('aria-label') ?? tab.textContent?.trim(), selected: tab.getAttribute('aria-selected') }))
    })).catch(() => null);
    throw new Error(`Topic Notes panel did not receive the selected native Conversation context: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  await overview.click({ timeout: 30_000 });
  // Native Chat retains its historical "primary" class when moved aside.
  // Region assignment, visible geometry and content prove actual promotion.
  const mainPanel = page.locator('.side-panel__panel[data-region="main"]');
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
  const swap = page.getByRole('button', { name: 'Swap Topic Notes and Chat', exact: true });
  await swap.waitFor();
  assert.equal(await page.locator('.sidebar-region__right-runtime').getByRole('tab', { name: 'Chat', exact: true }).count(), 1);
  await swap.click();
  await onStage?.('verify-swapped-pane');
  await page.locator('.sidebar-region__primary[data-region="main"]').waitFor({ state: 'visible', timeout: 10_000 });
  await assertNativeFormattedNote(page.locator('.side-panel__panel[data-region="side"]').getByRole('region', { name: 'Note content', exact: true }), fixture);
  await nativeChat.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await nativeChat.evaluate((pane) => pane.sessionKey), fixture.sessionKey, 'Pane swap must retain the exact linked native Conversation.');
  assert.equal(await composer.inputValue(), unsentDraft, 'Pane swap must retain the unsent native Chat draft.');
}
