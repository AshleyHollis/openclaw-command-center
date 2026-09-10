import assert from 'node:assert/strict';

// Exercise only the visible native UI, using the authenticated journey's real
// Gateway and fixture. No mocked transport, injected app state, or raw writes.
export async function organizeNativeTopicConversations({ page, nativePage, fixture }) {
  const row = nativePage.getByRole('listitem').filter({ has: nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }) });
  await row.getByRole('button', { name: 'Organize Conversations in native group', exact: true }).click({ timeout: 30_000 });
  await row.getByRole('status').filter({ hasText: '1 Conversations organized. 0 left unchanged.' }).waitFor({ timeout: 30_000 });
  const group = page.locator(`[data-session-section="category:${fixture.name}"]`);
  await group.waitFor({ state: 'visible' });
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
