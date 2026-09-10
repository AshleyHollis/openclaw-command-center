import assert from 'node:assert/strict';

// Exercise only the visible native UI, using the authenticated journey's real
// Gateway and fixture. No mocked transport, injected app state, or raw writes.
export async function organizeNativeTopicConversations({ page, nativePage, fixture, observedRosters = () => [] }) {
  const row = nativePage.getByRole('listitem').filter({ has: page.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }) });
  await row.getByRole('button', { name: 'Organize Conversations in native group', exact: true }).click({ timeout: 30_000 });
  const status = row.getByRole('status');
  await status.filter({ hasText: /Conversations organized|Setup stopped/ }).waitFor({ timeout: 30_000 });
  assert.match(await status.textContent(), /1 Conversations organized\. 0 left unchanged\./);
  const group = page.locator(`[data-session-section="category:${fixture.name}"]`);
  try { await group.waitFor({ state: 'visible', timeout: 10_000 }); }
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

export async function verifyNativeTopicNotesPane({ page, fixture }) {
  const sidebar = page.locator('.sidebar-region__right-runtime .side-panel');
  if (!await sidebar.locator('.side-panel-empty--selector, [data-region-header="side"]').first().isVisible()) {
    await page.locator('.chat-side-panel-toggle').click();
  }
  await sidebar.locator('.side-panel-empty__types, .side-panel__header-tabs').first().waitFor();
  const emptyChoice = sidebar.locator('.side-panel-empty__type').filter({ hasText: 'Topic Notes' });
  if (await emptyChoice.count()) {
    await emptyChoice.click();
  } else {
    await sidebar.getByRole('button', { name: 'Add side panel tab', exact: true }).click();
    await sidebar.locator('wa-dropdown-item').filter({ hasText: 'Topic Notes' }).click();
  }
  await sidebar.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).click();
  const promoted = page.locator('.sidebar-region__primary').getByRole('region', { name: 'Note content', exact: true });
  await promoted.filter({ hasText: fixture.noteText.trim() }).waitFor();
  assert.equal(await promoted.textContent(), fixture.noteText);
  const swap = page.getByRole('button', { name: 'Swap Topic Notes and Chat', exact: true });
  await swap.waitFor();
  assert.equal(await page.locator('.sidebar-region__right-runtime').getByRole('tab', { name: 'Chat', exact: true }).count(), 1);
  await swap.click();
}
