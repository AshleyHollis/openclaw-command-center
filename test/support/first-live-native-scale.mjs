import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RELEASE_FIXTURE_COUNTS, RELEASE_MEASUREMENTS } from '../../src/performance-baseline.mjs';
import { fetchJsonWithDeadline, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { observeBrowserResponse, hasSuccessfulBrowserResponse } from '../../src/browser-evidence.mjs';
import { requestAuthenticatedGateway, readAuthenticatedHistory, createGatewayDeviceIdentity } from './real-host-runtime.mjs';
import { assertNativeScaleSourcesUnchanged, readNativeLegacyBootstrap } from './first-live-native-bootstrap.mjs';

// The shared journey owns launch, authentication, assets and all six finalizers.
// Import lazily so the ordinary/keyboard entrypoints do not form an eager cycle.
export async function exerciseNativeScaleJourney({ descriptor, buildReceipt, signal, onFinalization }) {
  const { exerciseNativeJourney } = await import('./first-live-native-journey.mjs');
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, scale: true });
}

function request(world, signal, method, params = {}, scopes = ['operator.read']) {
  return requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
    method: `command-center.v1.${method}`, params: { schemaVersion: 1, ...params }, scopes, signal }).then(value => value?.result ?? value);
}

async function action(world, signal, input) {
  const response = await fetchJsonWithDeadline(`${world.gateway.url}/plugins/command-center/api/topic/actions`, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json', 'x-openclaw-control-ui-relay': '1' },
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
  for (let index = 1; index < 100; index += 1) {
    signal.throwIfAborted();
    const { topic } = await request(world, signal, 'topics.get', { topicId: fixture.topicId });
    assert.equal(topic.topicId, fixture.topicId);
    assert.equal(topic.usable, true);
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

export async function exerciseNativeScaleStates({ page, world, host, signal, fixture, bootstrap,
  conversationLabel, messageText, startupReadinessMs, topicsStarted, observed }) {
  const observations = { startupReadinessMs };
  const ready = (probe) => waitForConsecutiveReadiness(probe, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
  const nativePage = page.locator('openclaw-plugin-page');
  await ready(async () => !!observed().topics?.activeGroups?.project?.some(topic => topic.topicId === fixture.topicId && topic.usable));
  await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).waitFor();
  observations.topicsLoadMs = performance.now() - topicsStarted;
  const authoritativeTopics = await request(world, signal, 'topics.list');
  assert.deepEqual(observed().topics.activeGroups, authoritativeTopics.activeGroups);

  let started = performance.now();
  await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).click();
  await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
  await ready(async () => observed().notes?.value?.offset === 0 && observed().notes?.value?.total === 5_000);
  await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).waitFor();
  observations.topicOpenMs = performance.now() - started;
  started = performance.now();
  await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).click();
  const content = nativePage.getByRole('region', { name: 'Note content', exact: true });
  await ready(async () => (await content.textContent())?.length === 8_388_609);
  assert.equal(await content.textContent(), bootstrap.noteText);
  observations.largeNoteReadMs = performance.now() - started;
  assert.equal(Buffer.byteLength(await content.textContent(), 'utf8'), 8_388_609);
  assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
  assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);

  const notePaths = [];
  let offset = 0;
  while (true) {
    const catalog = observed().notes.value;
    assert.equal(observed().notes.input.topicId, fixture.topicId);
    assert.equal(catalog.offset, offset);
    assert.equal(catalog.total, 5_000);
    assert.equal(catalog.notes.length, 50);
    const paths = catalog.notes.map(note => {
      assert.equal(note.sourceReference.topicId, fixture.topicId);
      assert.equal(typeof note.sourceReference.referenceId, 'string');
      return note.path;
    });
    await ready(async () => JSON.stringify(await nativePage.getByRole('button', { name: /^Read / }).allTextContents()) === JSON.stringify(paths.map(value => `Read ${value}`)));
    notePaths.push(...paths);
    if (!catalog.hasMore) break;
    assert.equal(catalog.nextOffset, offset + 50);
    offset = catalog.nextOffset;
    started = performance.now();
    await nativePage.getByRole('button', { name: 'Next Notes', exact: true }).click();
    await ready(async () => observed().notes?.value?.offset === offset);
    await nativePage.getByText(`Notes ${offset + 1}–${offset + 50} of 5000.`, { exact: true }).waitFor();
    if (offset === 50) observations.noteNextPageMs = performance.now() - started;
  }
  assert.equal(notePaths.length, 5_000);
  assert.equal(new Set(notePaths).size, 5_000);
  assert.deepEqual(notePaths, [bootstrap.notePath, ...bootstrap.scaleNotes.map(note => note.path)]);
  assert.equal(await nativePage.getByRole('button', { name: 'Next Notes', exact: true }).isDisabled(), true);

  const creationResponse = observeBrowserResponse(page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).origin === new URL(world.gateway.url).origin
    && new URL(response.url()).pathname === '/plugins/command-center/api/topic/actions'
    && response.request().postDataJSON()?.action === 'conversations.create', { timeout: 30_000 }), () => {});
  await nativePage.getByRole('textbox', { name: 'Conversation label', exact: true }).fill(conversationLabel);
  started = performance.now();
  await nativePage.getByRole('button', { name: 'Create Conversation', exact: true }).click();
  const response = await creationResponse;
  assert.equal(hasSuccessfulBrowserResponse(response), true);
  const input = response.value.request().postDataJSON();
  assert.equal(input.topicId, fixture.topicId);
  assert.equal(input.label, conversationLabel);
  assert.equal(response.value.request().headers()['x-openclaw-control-ui-relay'], '1');
  const receipt = await response.value.json();
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.logicalOperationId, input.logicalOperationId);
  assert.equal(receipt.result.topicId, fixture.topicId);
  assert.equal(receipt.result.action, 'conversations.create');
  await ready(async () => observed().navigation?.value?.sourceReference?.referenceId === receipt.result.referenceId);
  const target = observed().navigation.value;
  const chat = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  await chat.waitFor();
  await page.waitForFunction(key => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, target.sessionKey);
  observations.conversationCreateMs = performance.now() - started;
  assert.notEqual(target.sessionId, fixture.sessionId);
  assert.equal(target.sourceReference.topicId, fixture.topicId);
  const catalog = await request(world, signal, 'sessions.browse', { topicId: fixture.topicId, includeClosed: false });
  assert.equal(catalog.conversations.length, 101);
  assert.equal(catalog.conversations.find(row => row.referenceId === receipt.result.referenceId)?.sessionId, target.sessionId);
  assert.equal(catalog.conversations.find(row => row.isPrimary)?.sessionId, fixture.sessionId);

  await chat.locator('.agent-chat__composer-combobox textarea').fill(messageText);
  started = performance.now();
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await ready(async () => !!observed().chatAcknowledgement);
  assert.equal(observed().chatAcknowledgement.ok, true);
  assert.equal(observed().chatSend.params.sessionKey, target.sessionKey);
  const containsMessage = history => history.messages?.some(message => message.role === 'user' && (message.text === messageText || message.content === messageText
    || Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text === messageText)));
  await ready(async () => {
    const response = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: target.sessionKey, signal });
    const history = response?.result ?? response;
    assert.equal(history.sessionId, target.sessionId);
    assert.equal(history.sessionKey, target.sessionKey);
    return containsMessage(history);
  });
  observations.chatSendMs = performance.now() - started;

  // Resolve the complete Topic-owned identity set independently of UI labels.
  // The label below only selects the issued fictional corpus in the native UI.
  const expectedSessions = new Map();
  for (const row of catalog.conversations) {
    assert.equal(row.status, 'open');
    const destination = await request(world, signal, 'sessions.navigate', { topicId: fixture.topicId, referenceId: row.referenceId, nativeChat: true }, ['operator.read', 'operator.write']);
    assert.equal(destination.sourceReference.referenceId, row.referenceId);
    assert.equal(destination.sourceReference.topicId, fixture.topicId);
    assert.equal(destination.sessionId, row.sessionId);
    assert.equal(expectedSessions.has(destination.sessionKey), false);
    expectedSessions.set(destination.sessionKey, destination.sessionId);
  }
  await page.locator('openclaw-app-sidebar').getByRole('link', { name: 'Sessions', exact: true }).click();
  const roster = page.locator('openclaw-sessions-page');
  await roster.waitFor();
  await roster.getByPlaceholder('Filter by key, agent, label, kind…', { exact: true }).fill('Fictional Native Scale');
  await ready(async () => observed().rosters.some(entry => entry.input.search === 'Fictional Native Scale'));
  const rosterRows = new Map();
  while (true) {
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
    const expectedPage = expectedKeys.slice(pageIndex * 50, (pageIndex + 1) * 50);
    await ready(async () => JSON.stringify(await keysOnPage()) === JSON.stringify(expectedPage));
    if (pageIndex === 1) observations.conversationNextPageMs = performance.now() - started;
    const actual = await keysOnPage();
    pageCounts.push(actual.length); allKeys.push(...actual);
    if (pageIndex < 2) {
      started = performance.now();
      await roster.getByRole('button', { name: 'Next', exact: true }).click();
    }
  }
  assert.deepEqual(pageCounts, [50, 50, 1]);
  assert.deepEqual(allKeys, expectedKeys);
  assert.equal(new Set(allKeys).size, 101);
  assert.equal(await roster.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
  // Sending in the new Conversation must not alter the imported Primary corpus.
  await readNativeLegacyBootstrap({ world, host, signal, bootstrap, expectedConversationCount: 101 });
  await assertNativeScaleSourcesUnchanged(bootstrap, signal);
  assert.deepEqual(Object.keys(observations).sort(), [...RELEASE_MEASUREMENTS].sort());
  for (const value of Object.values(observations)) assert.ok(Number.isFinite(value) && value > 0);
  const fixtureCounts = { largeNoteBytes: Buffer.byteLength(bootstrap.noteText), conversations: expectedSessions.size,
    noteFiles: notePaths.length, conversationMessages: bootstrap.prepared.occurrenceCount };
  assert.deepEqual(fixtureCounts, RELEASE_FIXTURE_COUNTS);
  // Corpus messages are the verified immutable Primary prefix; the separately
  // sent user message belongs to the final Conversation, not that denominator.
  return { observations, fixtureCounts,
    conversationPage: { firstPageCount: pageCounts[0], secondPageCount: pageCounts[1], thirdPageCount: pageCounts[2], unique: true, orderPreserved: true },
    notes: { largeNoteBytes: fixtureCounts.largeNoteBytes, readOnly: true, paginationVerified: true } };
}
