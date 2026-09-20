import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RELEASE_FIXTURE_COUNTS, RELEASE_MEASUREMENTS } from '../../src/performance-baseline.mjs';
import { fetchJsonWithDeadline, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { observeBrowserResponse, hasSuccessfulBrowserResponse } from '../../src/browser-evidence.mjs';
import { requestAuthenticatedGateway, readAuthenticatedHistory, createGatewayDeviceIdentity } from './real-host-runtime.mjs';
import { assertNativeScaleSourcesUnchanged, readNativeLegacyBootstrap } from './first-live-native-bootstrap.mjs';

// The shared journey owns launch, authentication, assets and all six finalizers.
// Import lazily so the ordinary/keyboard entrypoints do not form an eager cycle.
export async function exerciseNativeScaleJourney({ descriptor, buildReceipt, signal, onFinalization, onScaleProgress }) {
  const { exerciseNativeJourney } = await import('./first-live-native-journey.mjs');
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, onScaleProgress, scale: true });
}

function request(world, signal, method, params = {}, scopes = ['operator.read']) {
  return requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
    method: `command-center.v1.${method}`, params: { schemaVersion: 1, ...params }, scopes, signal }).then(value => value?.result ?? value);
}

async function action(world, signal, input) {
  const response = await fetchJsonWithDeadline(`${world.gateway.url}/plugins/command-center/api/topic/actions`, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, ...input })
  }, { label: 'native scale authenticated Conversation owner', timeoutMs: 30_000 });
  assert.equal(response.response.ok, true);
  assert.equal(response.parseError, undefined);
  assert.equal(response.body.logicalOperationId, input.logicalOperationId);
  assert.equal(response.body.result.topicId, input.topicId);
  return response.body;
}

export async function prepareNativeScaleConversations({ world, signal, fixture }) {
  const deviceIdentity = createGatewayDeviceIdentity();
  const bootstrap = await fetchJsonWithDeadline(`${world.gateway.url}/__openclaw__/control-ui-config.json`, {
    headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal
  }, { label: 'native scale authenticated build identity', timeoutMs: 10_000 });
  assert.equal(bootstrap.response.ok, true);
  assert.equal(bootstrap.parseError, undefined);
  const controlUiBuildId = bootstrap.body.serverBuildId;
  assert.ok(typeof controlUiBuildId === 'string' && controlUiBuildId.trim());
  const references = new Set([fixture.sessionReferenceId]);
  const { topic } = await request(world, signal, 'topics.get', { topicId: fixture.topicId });
  assert.equal(topic.topicId, fixture.topicId);
  assert.equal(topic.usable, true);
  for (let index = 1; index < 100; index += 1) {
    signal.throwIfAborted();
    const logicalOperationId = randomUUID();
    // Native creation requires a live authenticated connection, not a synthetic
    // HTTP identity. Use the existing Gateway command and its domain owner.
    const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url,
      credential: world.gatewayCredential, method: 'command-center.v1.sessions.create',
      params: { schemaVersion: 1, topicId: fixture.topicId, expectedRevision: topic.revision,
        logicalOperationId, label: `Fictional Native Scale ${String(index).padStart(3, '0')}` },
      scopes: ['operator.read', 'operator.write'], signal, deviceIdentity, controlUiBuildId });
    const created = response?.result ?? response;
    assert.equal(created.status, 'applied', `Conversation corpus preparation step ${index}: ${JSON.stringify(created)}`);
    assert.equal(created.logicalOperationId, logicalOperationId);
    const reference = created.value.sourceReference;
    assert.equal(reference.topicId, fixture.topicId);
    assert.equal(typeof reference.referenceId, 'string');
    assert.equal(references.has(reference.referenceId), false);
    references.add(reference.referenceId);
    const acknowledged = await action(world, signal, { action: 'conversations.creation.acknowledge',
      topicId: fixture.topicId, logicalOperationId, referenceId: reference.referenceId });
    assert.equal(acknowledged.status, 'acknowledged');
    assert.equal(acknowledged.result.referenceId, reference.referenceId);
  }
  const catalog = await request(world, signal, 'sessions.browse', { topicId: fixture.topicId, includeClosed: false });
  assert.equal(catalog.topicId, fixture.topicId);
  assert.equal(catalog.conversations.length, 100);
  assert.deepEqual(new Set(catalog.conversations.map(row => row.referenceId)), references);
}

export function rememberNativeScaleNotePage(pages, input, value) {
  if (!(pages instanceof Map) || !Number.isSafeInteger(input?.offset) || input.offset < 0) return false;
  pages.set(input.offset, { input, value });
  return true;
}

export async function openNativeSessionRoster(page) {
  const sidebar = page.locator('openclaw-app-sidebar');
  const sessions = sidebar.getByRole('link', { name: 'Sessions', exact: true });
  // Native sidebar preferences need not pin Sessions. Open the host's own
  // overflow menu without changing preferences or bypassing its navigation.
  if (!await sessions.isVisible()) {
    await sidebar.getByRole('button', { name: 'Edit pinned items', exact: true }).click();
  }
  await sessions.click();
  const roster = page.locator('openclaw-sessions-page');
  await roster.waitFor();
  return roster;
}

export async function exerciseNativeScaleStates({ page, world, host, signal, fixture, bootstrap,
  conversationLabel, messageText, startupReadinessMs, topicsStarted, observed, measure = true, onProgress = () => {} }) {
  const now = measure ? () => performance.now() : () => 0;
  const observations = { startupReadinessMs };
  // These waits surround the measured actions; they do not replace their
  // elapsed observations. Keep enough bounded headroom to record a slow first
  // exact observation so the immutable baseline and later budget can judge it.
  const ready = (probe) => waitForConsecutiveReadiness(probe, host.earlyExit, { deadlineMs: 120_000, delayMs: 100, signal });
  const nativePage = page.locator('openclaw-plugin-page');
  onProgress('topics-ready');
  await ready(async () => !!observed().topics?.activeGroups?.project?.some(topic => topic.topicId === fixture.topicId && topic.usable));
  await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).waitFor();
  observations.topicsLoadMs = now() - topicsStarted;
  const authoritativeTopics = await request(world, signal, 'topics.list');
  assert.deepEqual(observed().topics.activeGroups, authoritativeTopics.activeGroups);

  onProgress('topic-open');
  let started = now();
  await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).click();
  await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
  await ready(async () => observed().notePages?.get(0)?.value?.total === 5_000);
  onProgress('topic-catalog-observed');
  await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).waitFor();
  onProgress('topic-catalog-rendered');
  observations.topicOpenMs = now() - started;
  onProgress('large-note-read');
  started = now();
  await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).click();
  onProgress('large-note-clicked');
  const content = nativePage.getByRole('region', { name: 'Note content', exact: true });
  await ready(async () => (await content.textContent())?.length === 8_388_609);
  onProgress('large-note-rendered');
  assert.equal(await content.textContent(), bootstrap.noteText);
  observations.largeNoteReadMs = now() - started;
  assert.equal(Buffer.byteLength(await content.textContent(), 'utf8'), 8_388_609);
  assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
  assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);

  const expectedNotePaths = [bootstrap.notePath, ...bootstrap.scaleNotes.map(note => note.path)];
  const assertNotePage = (catalog, offset) => {
    assert.equal(catalog.offset, offset);
    assert.equal(catalog.total, 5_000);
    assert.equal(catalog.notes.length, 50);
    const paths = catalog.notes.map(note => {
      assert.equal(note.sourceReference.topicId, fixture.topicId);
      assert.equal(typeof note.sourceReference.referenceId, 'string');
      return note.path;
    });
    assert.deepEqual(paths, expectedNotePaths.slice(offset, offset + 50));
    return paths;
  };
  const firstPage = observed().notePages.get(0);
  const firstCatalog = firstPage.value;
  assert.equal(firstPage.input.topicId, fixture.topicId);
  const firstPaths = assertNotePage(firstCatalog, 0);
  await ready(async () => JSON.stringify(await nativePage.getByRole('button', { name: /^Read / }).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))) === JSON.stringify(firstPaths.map(value => `Read ${value}`)));
  assert.equal(firstCatalog.nextOffset, 50);
  started = now();
  await nativePage.getByRole('button', { name: 'Next Notes', exact: true }).click();
  await ready(async () => observed().notePages?.get(50)?.value?.offset === 50);
  await nativePage.getByText('Notes 51–100 of 5000.', { exact: true }).waitFor();
  observations.noteNextPageMs = now() - started;
  assertNotePage(observed().notePages.get(50).value, 50);
  // The UI proves the interactive first transition. Sample the middle and final
  // pages through the same authenticated snapshot cursor so the 5,000-item
  // ordering and terminal boundary are covered without 98 repetitive clicks.
  for (const offset of [2_500, 4_950]) {
    onProgress(`notes-page-${offset}`);
    const catalog = await request(world, signal, 'notes.browse', { topicId: fixture.topicId,
      offset, limit: 50, includeDocuments: true, cursor: firstCatalog.cursor });
    assertNotePage(catalog, offset);
    if (offset === 4_950) {
      assert.equal(catalog.hasMore, false);
      assert.equal(catalog.nextOffset, null);
    }
  }
  assert.equal(expectedNotePaths.length, 5_000);
  assert.equal(new Set(expectedNotePaths).size, 5_000);

  onProgress('conversation-create');
  const creationResponse = observeBrowserResponse(page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).origin === new URL(world.gateway.url).origin
    && new URL(response.url()).pathname === '/plugins/command-center/api/topic/actions'
    && response.request().postDataJSON()?.action === 'conversations.create', { timeout: 30_000 }), () => {});
  await nativePage.getByRole('textbox', { name: 'Conversation label', exact: true }).fill(conversationLabel);
  started = now();
  await nativePage.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  const response = await creationResponse;
  assert.equal(hasSuccessfulBrowserResponse(response), true);
  const input = response.value.request().postDataJSON();
  assert.equal(input.topicId, fixture.topicId);
  assert.equal(input.label, conversationLabel);
  const requestHeaders = response.value.request().headers();
  assert.equal(requestHeaders.authorization === `Bearer ${world.gatewayCredential}`, true);
  assert.equal(requestHeaders['x-openclaw-control-ui-relay'], undefined);
  const receipt = await response.value.json();
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.logicalOperationId, input.logicalOperationId);
  assert.equal(receipt.result.topicId, fixture.topicId);
  assert.equal(receipt.result.action, 'conversations.create');
  assert.equal(typeof receipt.result.referenceId, 'string');
  onProgress('conversation-open');
  // Successful creation already calls the verified onCreated navigation.
  // The retained button is a recovery action; clicking it while that route is
  // detaching the plugin page makes Playwright wait on a duplicate handoff.
  try {
    await waitForConsecutiveReadiness(async () => {
      return observed().navigation?.input?.referenceId === receipt.result.referenceId
        && typeof observed().navigation?.value?.sessionKey === 'string';
    }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
  } catch (error) {
    const navigation = observed().navigation;
    onProgress(`conversation-navigation-unavailable:${JSON.stringify({ observed: Boolean(navigation),
      referenceMatches: navigation?.input?.referenceId === receipt.result.referenceId,
      expectedSessionId: typeof navigation?.input?.expectedSessionId === 'string',
      sessionKey: typeof navigation?.value?.sessionKey === 'string', valueKeys: Object.keys(navigation?.value ?? {}) })}`);
    throw error;
  }
  const resolved = observed().navigation;
  const target = { sessionKey: resolved.value.sessionKey, sessionId: resolved.input.expectedSessionId };
  assert.equal(resolved.input.topicId, fixture.topicId);
  assert.equal(resolved.input.referenceId, receipt.result.referenceId);
  assert.deepEqual(Object.keys(resolved.value), ['sessionKey']);
  const chat = page.locator('openclaw-chat-pane.chat-pane-cache__pane--visible');
  try {
    await waitForConsecutiveReadiness(async () => await page.locator('openclaw-chat-pane').evaluateAll((panes, key) => panes.some(pane =>
      pane.classList.contains('chat-pane-cache__pane--visible') && pane.sessionKey === key), target.sessionKey),
    host.earlyExit, { deadlineMs: 10_000, delayMs: 100, signal });
  } catch (error) {
    const state = await page.evaluate(key => ({
      chatRoute: location.pathname.includes('/chat/'), filesRequest: new URLSearchParams(location.search).has('__openclawFilesPanel'),
      panes: [...document.querySelectorAll('openclaw-chat-pane')].map(pane => ({ selected: pane.classList.contains('chat-pane-cache__pane--visible'),
        active: pane.classList.contains('chat-pane-cache__pane--active'), presented: pane.getAttribute('aria-hidden') === 'false',
        inert: pane.hasAttribute('inert'), target: pane.sessionKey === key }))
    }), target.sessionKey);
    onProgress(`chat-pane-unavailable:${JSON.stringify(state)}`);
    throw error;
  }
  await chat.waitFor({ state: 'visible', timeout: 5_000 });
  onProgress('chat-pane-ready');
  observations.conversationCreateMs = now() - started;
  assert.notEqual(target.sessionId, fixture.sessionId);
  const catalog = await request(world, signal, 'sessions.browse', { topicId: fixture.topicId, includeClosed: false });
  assert.equal(catalog.conversations.length, 101);
  assert.equal(catalog.conversations.find(row => row.referenceId === receipt.result.referenceId)?.sessionId, target.sessionId);
  assert.equal(catalog.conversations.find(row => row.isPrimary)?.sessionId, fixture.sessionId);

  onProgress('chat-send');
  await chat.locator('.agent-chat__composer-combobox textarea').fill(messageText);
  started = now();
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await ready(async () => !!observed().chatAcknowledgement);
  assert.equal(observed().chatAcknowledgement.ok, true);
  assert.equal(observed().chatSend.params.sessionKey, target.sessionKey);
  const containsMessage = history => history.messages?.some(message => message.role === 'user' && (message.text === messageText || message.content === messageText
    || Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text === messageText)));
  await ready(async () => {
    const response = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
      sessionKey: target.sessionKey, signal, responseTimeoutMs: 30_000 });
    const history = response?.result ?? response;
    assert.equal(history.sessionId, target.sessionId);
    assert.equal(history.sessionKey, target.sessionKey);
    return containsMessage(history);
  });
  observations.chatSendMs = now() - started;

  // Resolve the complete Topic-owned identity set independently of UI labels.
  // The label below only selects the issued fictional corpus in the native UI.
  const expectedSessions = new Map();
  onProgress('conversation-identities');
  for (const row of catalog.conversations) {
    assert.equal(row.status, 'open');
    const destination = await request(world, signal, 'sessions.navigate', { topicId: fixture.topicId, referenceId: row.referenceId, nativeChat: true }, ['operator.read', 'operator.write']);
    assert.equal(destination.sourceReference.referenceId, row.referenceId);
    assert.equal(destination.sourceReference.topicId, fixture.topicId);
    assert.equal(destination.sessionId, row.sessionId);
    assert.equal(expectedSessions.has(destination.sessionKey), false);
    expectedSessions.set(destination.sessionKey, destination.sessionId);
  }
  onProgress('native-roster');
  const roster = await openNativeSessionRoster(page);
  await roster.getByPlaceholder('Filter by key, agent, label, kind…', { exact: true }).fill('Fictional Native Scale');
  await ready(async () => observed().rosters.some(entry => entry.input.search === 'Fictional Native Scale'));
  const rosterRows = new Map();
  while (true) {
    onProgress(`roster-load-${rosterRows.size}`);
    assert.equal(observed().rosterOverflow, false, 'Native roster response evidence exceeded its bound');
    for (const entry of observed().rosters.filter(entry => entry.input.search === 'Fictional Native Scale')) {
      for (const row of entry.value.sessions) {
        assert.equal(expectedSessions.get(row.key), row.sessionId, 'Native roster must preserve exact Topic-owned Session identities');
        rosterRows.set(row.key, row.sessionId);
      }
    }
    if (rosterRows.size === 101) break;
    assert.ok(rosterRows.size < 101);
    const before = observed().rosters.length;
    await roster.getByRole('button', { name: 'Load more sessions', exact: true }).click();
    await ready(async () => observed().rosters.length > before);
  }
  assert.deepEqual(rosterRows, expectedSessions);
  await roster.getByRole('combobox', { name: 'Rows per page', exact: true }).selectOption('50');
  const keyHeader = roster.locator('th.data-table-key-col[data-sortable]');
  if (await keyHeader.getAttribute('aria-sort') !== 'ascending') await keyHeader.getByRole('button').click();
  if (await keyHeader.getAttribute('aria-sort') !== 'ascending') await keyHeader.getByRole('button').click();
  assert.equal(await keyHeader.getAttribute('aria-sort'), 'ascending');
  const expectedKeys = [...expectedSessions.keys()].sort((left, right) => left.localeCompare(right));
  const keysOnPage = () => roster.locator('tr.session-data-row input[type="checkbox"]').evaluateAll(inputs => inputs.map(input => input.getAttribute('aria-label').replace(/^Select session: /, '')));
  const allKeys = [];
  const pageCounts = [];
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    onProgress(`roster-page-${pageIndex}`);
    const expectedPage = expectedKeys.slice(pageIndex * 50, (pageIndex + 1) * 50);
    await ready(async () => JSON.stringify(await keysOnPage()) === JSON.stringify(expectedPage));
    if (pageIndex === 1) observations.conversationNextPageMs = now() - started;
    const actual = await keysOnPage();
    pageCounts.push(actual.length); allKeys.push(...actual);
    if (pageIndex < 2) {
      started = now();
      await roster.getByRole('button', { name: 'Next', exact: true }).click();
    }
  }
  assert.deepEqual(pageCounts, [50, 50, 1]);
  assert.deepEqual(allKeys, expectedKeys);
  assert.equal(new Set(allKeys).size, 101);
  assert.equal(await roster.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
  // Sending in the new Conversation must not alter the imported Primary corpus.
  onProgress('final-source-readback');
  await readNativeLegacyBootstrap({ world, host, signal, bootstrap, expectedConversationCount: 101 });
  await assertNativeScaleSourcesUnchanged(bootstrap, signal);
  assert.deepEqual(Object.keys(observations).sort(), [...RELEASE_MEASUREMENTS].sort());
  if (measure) for (const value of Object.values(observations)) assert.ok(Number.isFinite(value) && value > 0);
  const fixtureCounts = { largeNoteBytes: Buffer.byteLength(bootstrap.noteText), conversations: expectedSessions.size,
    noteFiles: expectedNotePaths.length, conversationMessages: bootstrap.prepared.occurrenceCount };
  assert.deepEqual(fixtureCounts, RELEASE_FIXTURE_COUNTS);
  // Corpus messages are the verified immutable Primary prefix; the separately
  // sent user message belongs to the final Conversation, not that denominator.
  return { ...(measure ? { observations } : { performanceQualified: false }), fixtureCounts,
    conversationPage: { firstPageCount: pageCounts[0], secondPageCount: pageCounts[1], thirdPageCount: pageCounts[2], unique: true, orderPreserved: true },
    notes: { largeNoteBytes: fixtureCounts.largeNoteBytes, readOnly: true, paginationVerified: true } };
}
