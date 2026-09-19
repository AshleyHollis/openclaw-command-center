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
  const trigger = page.locator('button.sidebar-session-sort:not(.sidebar-session-catalog-grouping)');
  try {
    await trigger.scrollIntoViewIfNeeded({ timeout: 10_000 });
    if (await trigger.isVisible()) await trigger.click({ timeout: 10_000 });
    else await trigger.evaluate(button => button.click());
  }
  catch (error) {
    const controls = await page.locator('button').evaluateAll(buttons => buttons.slice(0, 40).map(button => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return { label: button.getAttribute('aria-label'), text: button.textContent?.trim(), className: button.className,
        display: style.display, visibility: style.visibility, opacity: style.opacity,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }));
    throw new Error(`Native session grouping control is unavailable: ${JSON.stringify(controls)}`, { cause: error });
  }
  await page.locator('wa-dropdown-item[value="grouping:category"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('wa-dropdown-item[value="grouping:category"]').click({ timeout: 10_000 });
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
  const group = page.locator(`[data-session-section="category:${fixture.name}"]`).filter({ visible: true });
  try { await group.waitFor({ state: 'visible', timeout: 30_000 }); }
  catch (error) {
    const rosters = observedRosters().slice(-3).map(item => ({
      keys: Object.keys(item),
      matching: (item.value?.sessions ?? item.sessions ?? []).filter(session => session.key === fixture.sessionKey).map(session => ({ category: session.category, kind: session.kind, ownerPresent: Boolean(session.ownerId) }))
    }));
    const sections = await page.locator('[data-session-section]').evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-session-section'), visible: element.getClientRects().length > 0 })));
    throw new Error(`Native grouping sidebar not visible: ${JSON.stringify({ rosters, sections })}`, { cause: error });
  }
  const toggle = group.getByRole('button', { name: fixture.name, exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await group.locator(`[data-session-key="${fixture.sessionKey}"]`).waitFor({ state: 'visible' });
}

export async function verifyNativeTopicNotesPane({ page, fixture, onPromoted, onStage } = {}) {
  await onStage?.('inspect-side-panel');
  const sidebar = page.locator('.sidebar-region__right-runtime .side-panel');
  // Keep this in lockstep with the native host's panel helper. A union followed
  // by .first() can select a not-yet-rendered alternative and spend the full
  // inherited acceptance timeout waiting for it, even though the other native
  // panel surface is already available.
  const hasHeader = await sidebar.locator('[data-region-header="side"]').isVisible({ timeout: 10_000 });
  const hasSelector = await sidebar.locator('.side-panel-empty--selector').isVisible({ timeout: 10_000 });
  if (!hasHeader && !hasSelector) {
    await onStage?.('open-side-panel');
    await page.locator('.chat-side-panel-toggle').click();
  }
  await onStage?.('select-topic-notes-tab');
  await sidebar.locator('.side-panel-empty__types, .side-panel__header-tabs').first().waitFor({ timeout: 10_000 });
  const emptyChoice = sidebar.locator('.side-panel-empty__type').filter({ hasText: 'Topic Notes' });
  if (await emptyChoice.count()) {
    await emptyChoice.click();
  } else {
    await sidebar.getByRole('button', { name: 'Add side panel tab', exact: true }).click();
    await sidebar.locator('wa-dropdown-item').filter({ hasText: 'Topic Notes' }).click();
  }
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
