import assert from 'node:assert/strict';

export const EVERYDAY_SESSION_LABELS = Object.freeze({ areaPrimary: 'Fictional Native Area Primary Conversation', resourcePrimary: 'Fictional Native Resource Primary Conversation', unassigned: 'Fictional unassigned Conversation', focusedCreated: 'Fictional Everyday created Conversation' });

export const FICTIONAL_TABLE = '\n| Date | Area | Decision | Notes |\n| --- | --- | --- | --- |\n| 2026-10-07 | Kitchen | Keep existing shelving | Compare two fictional quotations before ordering. |\n| 2026-10-08 | Study | Defer desk replacement | This is the final reachable cell. |\n';

export async function revealEverydayTopic(sidebar, topicId) {
  const entry = sidebar.locator(`[data-topic-id=${JSON.stringify(topicId)}]`);
  await entry.waitFor({ state: 'attached' });
  const category = entry.locator('xpath=ancestor::div[contains(@class,"topic-para-body")]');
  const categoryId = await category.getAttribute('id');
  if (!await category.isVisible()) await sidebar.locator(`[aria-controls=${JSON.stringify(categoryId)}]`).click();
  await entry.waitFor({ state: 'visible' });
  if (await entry.getAttribute('data-expanded') !== 'true') {
    await entry.locator(`[data-topic-control-key=${JSON.stringify(`toggle:${topicId}`)}]`).click();
  }
  await entry.locator('.topic-entry-children').waitFor({ state: 'visible' });
  return entry;
}

export async function chooseEverydayAssignment(row, { topicId, duplicateTopicId, name }) {
  const assign = row.getByRole('button', { name: 'Assign to Topic', exact: true });
  assert.equal(await assign.isDisabled(), true, 'Assignment starts with no implicit Topic.');
  const trigger = row.locator('.picker-select__trigger');
  await trigger.waitFor({ state: 'visible' });
  assert.match(await trigger.innerText(), /Choose a Topic/);
  await trigger.click();
  for (const [id, category] of [[topicId, 'area'], [duplicateTopicId, 'resource']]) {
    const option = row.locator(`[role="option"][data-value=${JSON.stringify(id)}]`);
    await option.waitFor({ state: 'visible' });
    assert.ok((await option.innerText()).includes(name));
    assert.match(await option.innerText(), new RegExp(`\\b${category}\\b`, 'i'), 'Same-name options retain PARA category context.');
    assert.ok((await option.innerText()).includes(id), 'Same-name Topics retain exact identity context.');
  }
  await row.locator(`[role="option"][data-value=${JSON.stringify(topicId)}]`).click();
  assert.equal(await assign.isDisabled(), false);
  await assign.press('Enter');
}

export async function exerciseEverydayCreation({ page, sidebar, fixture, composer, readSessionKey, armResponseLoss, readCreation, nativeModal = false }) {
  const entry = await revealEverydayTopic(sidebar, fixture.topicId);
  const create = entry.getByRole('button', { name: 'New Topic Conversation', exact: true });
  const originalKey = await readSessionKey();
  const draft = 'Fictional draft retained through native creation Cancel.';
  await composer.fill(draft);
  const dialog = page.getByRole('dialog', { name: `New conversation in ${fixture.name}`, exact: true });
  // The native accessible dialog is in shadow DOM; its projected form remains
  // light content of this uniquely named modal host, outside that dialog subtree.
  const content = nativeModal ? page.locator('openclaw-modal-dialog').filter({
    has: page.getByRole('heading', { name: `New conversation in ${fixture.name}`, exact: true }) }) : dialog;
  const openDialog = async () => {
    await create.click(); await dialog.waitFor({ state: 'visible' });
    await content.waitFor({ state: 'attached' });
    assert.equal(await content.count(), 1, 'Creation controls must belong to one exact Topic modal.');
  };
  for (const cancel of ['button', 'escape']) {
    await openDialog();
    if (cancel === 'button') await content.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(element => element.matches(':focus'), await create.elementHandle());
    assert.equal(await composer.inputValue(), draft);
    assert.equal(await readSessionKey(), originalKey);
  }
  await openDialog();
  const submit = content.getByRole('button', { name: 'Create Conversation', exact: true });
  await page.waitForFunction(element => !element.disabled, await submit.elementHandle());
  await content.getByLabel('Conversation label', { exact: true }).fill(EVERYDAY_SESSION_LABELS.focusedCreated);
  await armResponseLoss();
  await submit.click();
  const check = content.getByRole('button', { name: 'Check creation outcome', exact: true, includeHidden: true });
  await check.waitFor({ state: 'visible' });
  await page.waitForFunction(element => !element.disabled, await check.elementHandle());
  assert.equal(await submit.isDisabled(), true);
  await content.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue(), draft);
  await openDialog();
  // Actual inspect may already prove applied. Do not demand a fabricated
  // unknown response or force a reconcile after the real owner completed.
  const open = content.getByRole('button', { name: 'Open created Conversation', exact: true, includeHidden: true });
  await page.waitForFunction(({ open, check }) => [open, check].some(button =>
    !button.hidden && !button.disabled && button.getClientRects().length > 0), { open: await open.elementHandle(), check: await check.elementHandle() });
  if (await check.isVisible()) { await check.click(); }
  await open.waitFor({ state: 'visible' });
  await page.waitForFunction(element => !element.disabled, await open.elementHandle());
  const saved = await readCreation();
  assert.equal(saved.dispatchCount, 1, 'Inspection/reconciliation never creates another Session.');
  assert.equal(saved.responseLost, true);
  assert.ok(saved.sessionKey && saved.sessionId && saved.referenceId && saved.logicalOperationId);
  await open.click(); await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(key => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, saved.sessionKey);
  assert.equal(await readSessionKey(), saved.sessionKey);
  return saved;
}

export async function assertEverydayTable({ page, reading, source, originalText }) {
  const region = reading.getByRole('region', { name: 'Table 1', exact: true });
  await region.waitFor({ state: 'visible' });
  const metrics = await region.evaluate(element => {
    const table = element.querySelector('table'); const range = document.createRange(); range.selectNodeContents(table.rows[1].cells[0]);
    return { keyboard: element.tabIndex, headers: [...table.querySelectorAll('th')].map(cell => cell.textContent),
      dateLines: range.getClientRects().length, pageOverflow: document.documentElement.scrollWidth > innerWidth,
      overflow: element.scrollWidth > element.clientWidth };
  });
  assert.equal(metrics.keyboard, 0); assert.equal(metrics.dateLines, 1); assert.equal(metrics.pageOverflow, false);
  assert.deepEqual(metrics.headers, ['Date', 'Area', 'Decision', 'Notes']);
  if (metrics.overflow) {
    await region.evaluate(element => { element.scrollLeft = 0; });
    await region.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(element => element.scrollLeft > 0, await region.elementHandle());
  }
  await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  assert.equal(await region.evaluate(element => {
    const cell = element.querySelector('table').rows[2].cells[3]; const bounds = element.getBoundingClientRect(); const end = cell.getBoundingClientRect();
    return cell.textContent === 'This is the final reachable cell.' && end.right <= bounds.right + 2 && end.right > bounds.left;
  }), true, 'Final table cell is reachable inside the pane.');
  await source.click();
  const sourceRegion = page.getByRole('region', { name: 'Note source', exact: true });
  await sourceRegion.waitFor();
  await page.waitForFunction(({ element, text }) => element.textContent === text, { element: await sourceRegion.elementHandle(), text: originalText });
  assert.equal(await page.getByRole('region', { name: 'Note source', exact: true }).textContent(), originalText);
  await page.getByRole('button', { name: 'Reading', exact: true }).click();
  await region.waitFor({ state: 'visible' });
  return metrics;
}
