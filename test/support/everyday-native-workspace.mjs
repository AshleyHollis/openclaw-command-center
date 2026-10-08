import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { selectors } from 'playwright';

export const EVERYDAY_SESSION_LABELS = Object.freeze({ areaPrimary: 'Fictional Native Area Primary Conversation', resourcePrimary: 'Fictional Native Resource Primary Conversation', unassigned: 'Fictional unassigned Conversation', focusedCreated: 'Fictional Everyday created Conversation' });

export const FICTIONAL_TABLE = '\n| Date | Area | Decision | Notes |\n| --- | --- | --- | --- |\n| 2026-10-07 | Kitchen | Keep existing shelving | Compare two fictional quotations before ordering. |\n| 2026-10-08 | Study | Defer desk replacement | This is the final reachable cell. |\n';

export async function revealEverydayInbox(sidebar) {
  // The accessible heading includes the current count. Bind the existing
  // disclosure identity, then verify its public name rather than dropping it.
  const disclosure = sidebar.locator('[data-topic-control-key="inbox"]');
  await disclosure.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await disclosure.count(), 1, 'There must be one exact Inbox disclosure.');
  assert.equal(await sidebar.getByRole('button', { name: /^Inbox \/ Unassigned \(\d+\)$/ }).and(disclosure).count(), 1,
    'The exact Inbox disclosure must retain its counted accessible name.');
  const inbox = disclosure.locator('xpath=ancestor::section[1]');
  assert.equal(await inbox.count(), 1, 'Inbox rows must belong to the disclosure section.');
  if (await disclosure.getAttribute('aria-expanded', { timeout: 30_000 }) !== 'true') {
    await disclosure.click({ timeout: 30_000 });
  }
  assert.equal(await disclosure.getAttribute('aria-expanded', { timeout: 30_000 }), 'true');
  return inbox;
}

export async function assertEverydayFilesTarget({ page, chatPane, filesView, fixture, chatKey, draft }) {
  await filesView.waitFor({ state: 'attached', timeout: 30_000 });
  assert.equal(await filesView.count(), 1, 'One mounted Topic Files contribution must own the independent target.');
  await page.waitForFunction(({ view, key, agentId }) => view.isConnected && view.surface === 'session-files' && view.presented === true &&
    view.props?.sessionKey === key && view.props?.agentId === agentId,
  { view: await filesView.elementHandle(), key: fixture.sessionKey, agentId: fixture.sessionKey.split(':')[1] }, { timeout: 30_000 });
  assert.equal(await chatPane.evaluate(pane => pane.sessionKey), chatKey, 'Opening Files must preserve the exact current Chat.');
  assert.equal(await chatPane.getByLabel('Chat composer', { exact: true }).inputValue(), draft, 'Opening Files must preserve the unsent Chat draft.');
  const explorer = filesView.locator('.control-ui-file-explorer');
  await explorer.waitFor({ state: 'visible', timeout: 30_000 });
  return explorer;
}

export function assertEverydayResolvedTarget(observation, fixture) {
  assert.equal(observation?.input.topicId, fixture.topicId);
  assert.equal(observation?.input.referenceId, fixture.sessionReferenceId);
  assert.equal(observation?.input.expectedSessionId, fixture.sessionId);
  assert.equal(observation?.value?.sessionKey ?? observation?.value?.result?.sessionKey, fixture.sessionKey);
}

export function assertEverydayNoteRead(observation, fixture) {
  assert.equal(observation?.input.topicId, fixture.topicId);
  assert.equal(observation?.input.path, fixture.notePath);
  assert.equal(observation?.value.path, fixture.notePath);
  assert.equal(observation?.value.sourceReference?.topicId, fixture.topicId);
  assert.ok(typeof observation?.input.referenceId === 'string' && observation.input.referenceId.length > 0);
  assert.equal(observation?.value.sourceReference?.referenceId, observation.input.referenceId);
  assert.ok(typeof observation?.value.revision === 'string' && observation.value.revision.length > 0);
  assert.equal(observation?.value.revision, observation.input.observedRevision);
  assert.equal(observation?.value.sourceReference?.observedRevision, observation.value.revision);
}

export async function waitForEverydayChat({ page, chatPane, sessionKey }) {
  await page.waitForFunction(key => {
    const panes = [...document.querySelectorAll('openclaw-chat-pane')].filter(pane =>
      pane.sessionKey === key && pane.active === true && pane.presented === true &&
      pane.getAttribute('aria-hidden') === 'false' && !pane.closest('[inert]'));
    return panes.length === 1;
  }, sessionKey, { timeout: 30_000 });
  assert.equal(await chatPane.count(), 1, 'Exactly one current Chat owner may be presented.');
  assert.equal(await chatPane.evaluate(pane => pane.sessionKey), sessionKey);
}

await selectors.register('everyday-files', () => ({
    queryAll(root, identity) {
      const target = JSON.parse(identity); const pending = [root]; const matches = [];
      if (root.shadowRoot) pending.push(root.shadowRoot);
      // Native owner hosts use display:contents. Their public presented/props
      // contract supplies identity; child-reader visibility is checked later.
      while (pending.length) {
        for (const element of pending.pop().querySelectorAll('*')) {
          if (element.shadowRoot) pending.push(element.shadowRoot);
          if (element.localName === 'openclaw-plugin-view' && element.isConnected &&
              element.surface === 'session-files' && element.presented === true &&
              element.props?.sessionKey === target.sessionKey && element.props?.agentId === target.agentId) matches.push(element);
        }
      }
      return matches;
    }
  }));

export async function locateEverydayFilesView({ page, chatPane, fixture }) {
  return chatPane.locator('everyday-files=' + JSON.stringify({ sessionKey: fixture.sessionKey, agentId: fixture.sessionKey.split(':')[1] }))
    .filter({ has: page.locator('[data-topic-reader-page="panel"]') });
}

export async function openEverydayTopicFiles({ page, sidebar, chatPane, fixture, chatKey, draft, readNavigation }) {
  const entry = await revealEverydayTopic(sidebar, fixture.topicId);
  const previousSequence = (await readNavigation())?.sequence ?? 0;
  await entry.getByRole('button', { name: 'Open Topic Files', exact: true }).press('Enter');
  const deadline = performance.now() + 30_000;
  let observation;
  while ((observation = await readNavigation())?.sequence <= previousSequence || !observation) {
    assert.ok(performance.now() < deadline, 'The Files action must complete a new native resolver request.');
    await delay(25);
  }
  assertEverydayResolvedTarget(observation, fixture);
  const filesView = await locateEverydayFilesView({ page, chatPane, fixture });
  const explorer = await assertEverydayFilesTarget({ page, chatPane, filesView, fixture, chatKey, draft });
  const reader = filesView.locator('[data-topic-reader-page="panel"]');
  assert.equal(await reader.count(), 1, 'The verified visible Files owner must contain one reader.');
  await reader.waitFor({ state: 'visible', timeout: 30_000 });
  return { filesView, reader, explorer };
}

export const EVERYDAY_SECONDARY_TRANSCRIPT = 'Fictional secondary transcript retained while Files opens and closes.';

export async function seedEverydaySecondaryTranscript({ created, inject, readHistory }) {
  const receipt = await inject({ sessionKey: created.sessionKey, message: EVERYDAY_SECONDARY_TRANSCRIPT });
  assert.equal(receipt?.ok, true, 'The native Chat owner must acknowledge the fictional transcript append.');
  assert.ok(typeof receipt.messageId === 'string' && receipt.messageId.length > 0);
  const history = await readHistory(created.sessionKey);
  assert.equal(history.sessionKey, created.sessionKey);
  assert.equal(history.sessionId, created.sessionId);
  assert.ok(history.messages?.some(message => message.role === 'assistant'
    && (message.content === EVERYDAY_SECONDARY_TRANSCRIPT || Array.isArray(message.content)
      && message.content.some(part => part.type === 'text' && part.text === EVERYDAY_SECONDARY_TRANSCRIPT))),
  'The exact native Session history must contain the fictional assistant transcript.');
  const snapshot = JSON.stringify(history.messages);
  const assertRetained = async () => {
    const retained = await readHistory(created.sessionKey);
    assert.equal(retained.sessionKey, created.sessionKey);
    assert.equal(retained.sessionId, created.sessionId);
    assert.equal(JSON.stringify(retained.messages), snapshot, 'Files routing must preserve the populated native transcript exactly.');
  };
  assertRetained.messageId = receipt.messageId;
  return assertRetained;
}

export async function exerciseEverydaySecondaryFiles({ page, sidebar, chatPane, fixture, resourceFixture, created, readNavigation, assertTranscript, onStage }) {
  const secondary = { ...fixture, sessionReferenceId: created.referenceId, sessionId: created.sessionId, sessionKey: created.sessionKey };
  const composer = chatPane.getByLabel('Chat composer', { exact: true });
  // Explicit sidebar selection also records the exact secondary preference;
  // dialog creation alone does not populate that presentation state.
  await page.getByRole('button', { name: 'Refresh Topic workspace', exact: true }).press('Enter');
  const area = await revealEverydayTopic(sidebar, fixture.topicId);
  await area.getByRole('button', { name: EVERYDAY_SESSION_LABELS.focusedCreated, exact: true }).press('Enter');
  await waitForEverydayChat({ page, chatPane, sessionKey: secondary.sessionKey });
  const secondaryDraft = 'Fictional secondary Chat draft retained through Files close and reopen.';
  await composer.fill(secondaryDraft);
  const assertVisibleTranscript = async () => {
    await waitForEverydayChat({ page, chatPane, sessionKey: secondary.sessionKey });
    const message = chatPane.getByText(EVERYDAY_SECONDARY_TRANSCRIPT, { exact: true });
    await message.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await message.count(), 1, 'The populated transcript must belong to the exact current secondary Chat.');
    assert.equal(await composer.inputValue(), secondaryDraft);
    await assertTranscript();
  };
  await assertVisibleTranscript();
  const openAreaFiles = async (chatKey, draft) => (await openEverydayTopicFiles({ page, sidebar, chatPane,
    fixture: secondary, chatKey, draft, readNavigation })).explorer;
  const explorer = await openAreaFiles(secondary.sessionKey, secondaryDraft);
  await assertVisibleTranscript();
  const close = chatPane.getByRole('button', { name: 'Close Files', exact: true });
  await close.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await close.count(), 1, 'Close the actual native Files slot.');
  await close.press('Enter');
  await explorer.waitFor({ state: 'hidden', timeout: 30_000 });
  assert.equal(await chatPane.evaluate(pane => pane.sessionKey), secondary.sessionKey);
  assert.equal(await composer.inputValue(), secondaryDraft);
  await assertVisibleTranscript();
  await openAreaFiles(secondary.sessionKey, secondaryDraft);
  await assertVisibleTranscript();
  await onStage?.('native-secondary-files-reopened');
  const resource = await revealEverydayTopic(sidebar, resourceFixture.topicId);
  await resource.getByRole('button', { name: 'Primary Conversation', exact: true }).press('Enter');
  await waitForEverydayChat({ page, chatPane, sessionKey: resourceFixture.sessionKey });
  const resourceDraft = 'Fictional Resource Chat draft retained through remembered Area Files.';
  await composer.fill(resourceDraft);
  await openAreaFiles(resourceFixture.sessionKey, resourceDraft);
  await assertTranscript();
  const returnedArea = await revealEverydayTopic(sidebar, fixture.topicId);
  await returnedArea.getByRole('button', { name: EVERYDAY_SESSION_LABELS.focusedCreated, exact: true }).press('Enter');
  await assertVisibleTranscript();
  const returnedResource = await revealEverydayTopic(sidebar, resourceFixture.topicId);
  await returnedResource.getByRole('button', { name: 'Primary Conversation', exact: true }).press('Enter');
  await waitForEverydayChat({ page, chatPane, sessionKey: resourceFixture.sessionKey });
  assert.equal(await composer.inputValue(), resourceDraft);
  await onStage?.('native-secondary-files-remembered');
  return { currentSecondary: true, closedAndReopened: true, rememberedSecondary: true, populatedTranscriptPreserved: true,
    transcriptMessageId: assertTranscript.messageId };
}

export async function assertEverydayDownloadedOriginal(download, expectedBytes) {
  const stream = await download.createReadStream();
  assert.ok(stream, 'The completed original download must expose its actual bytes.');
  const chunks = []; let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    assert.ok(length <= expectedBytes.length, 'Downloaded bytes cannot exceed the exact fictional original.');
    chunks.push(chunk);
  }
  assert.deepEqual(Buffer.concat(chunks), expectedBytes, 'Download must deliver the exact authorized original bytes.');
}

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

export async function assertEverydayTable({ page, reader, reading, source, originalText }) {
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
  const sourceRegion = reader.getByRole('region', { name: 'Note source', exact: true });
  await sourceRegion.waitFor();
  await page.waitForFunction(({ element, text }) => element.textContent === text, { element: await sourceRegion.elementHandle(), text: originalText });
  assert.equal(await sourceRegion.textContent(), originalText);
  await reader.getByRole('button', { name: 'Reading', exact: true }).click();
  await region.waitFor({ state: 'visible' });
  return metrics;
}
