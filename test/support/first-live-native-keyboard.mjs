import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fetchJsonWithDeadline, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse } from '../../src/browser-evidence.mjs';
import { assertKeyboardFocus, tabTo } from './keyboard-navigation.mjs';
import { requestAuthenticatedGateway } from './real-host-runtime.mjs';

const actionPath = '/plugins/command-center/api/topic/actions';
const unwrap = response => response?.result ?? response;

// Unlike the historical iframe audit, inspect the actual composed native tree.
// This only reads DOM/CSS: it does not add names, focus styles or host authority.
async function auditNativeState(page, surface, label) {
  await assertKeyboardFocus(page);
  const audit = await surface.evaluate(root => {
    const parent = node => node.assignedSlot ?? node.parentElement ?? node.getRootNode()?.host ?? null;
    const visible = node => {
      if (!node.getClientRects().length) return false;
      for (let current = node; current; current = parent(current)) {
        const style = getComputedStyle(current);
        if (current.matches('[hidden], [inert], [aria-hidden="true"]') || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
      }
      return true;
    };
    const nodes = [];
    const visit = node => {
      if (nodes.length >= 20_000) throw new Error('Native accessibility tree exceeds its bounded audit');
      nodes.push(node);
      const children = node.shadowRoot ? node.shadowRoot.children : node instanceof HTMLSlotElement ? node.assignedElements({ flatten: true }) : node.children;
      for (const child of children) visit(child);
    };
    visit(root);
    const shown = nodes.filter(visible);
    const name = node => node.getAttribute('aria-label')?.trim()
      || (node.getAttribute('aria-labelledby') ?? '').split(/\s+/u).map(id => node.getRootNode().getElementById?.(id)?.textContent?.trim() ?? '').join(' ').trim()
      || node.labels?.[0]?.textContent?.trim() || node.textContent?.trim() || node.getAttribute('title')?.trim();
    const durations = value => value.split(',').every(part => parseFloat(part) <= 0.001);
    const layouts = [document.documentElement, document.body, ...shown.filter(node => node === root || node.matches('main, [role="main"], pre[role="region"]'))].filter(node => node.clientWidth > 0);
    const stateful = shown.filter(node => node.matches('[aria-selected], [aria-current], [aria-checked], [data-status], [role="status"], [role="alert"], :disabled'));
    return {
      forcedColors: matchMedia('(forced-colors: active)').matches,
      reducedMotionPreference: matchMedia('(prefers-reduced-motion: reduce)').matches,
      reducedMotion: shown.every(node => { const style = getComputedStyle(node); return durations(style.animationDuration) && durations(style.transitionDuration) && style.scrollBehavior !== 'smooth'; }),
      unnamed: shown.filter(node => node.matches('button, input, textarea, select, a[href]') && !name(node)).map(node => node.tagName),
      colorIndependent: stateful.every(node => !node.textContent?.trim() && node.matches('[role="status"], [role="alert"]') || Boolean(name(node))),
      overflow: layouts.filter(node => node.scrollWidth > node.clientWidth).map(node => ({ name: node.tagName, width: node.clientWidth, content: node.scrollWidth })),
      checked: shown.length
    };
  });
  assert.ok(audit.checked > 0, `${label}: no visible native content audited`);
  assert.equal(audit.forcedColors, true, `${label}: forced colors must remain enabled`);
  assert.equal(audit.reducedMotionPreference, true);
  assert.equal(audit.reducedMotion, true, `${label}: native content retains motion under reduced-motion preference`);
  assert.deepEqual(audit.unnamed, [], `${label}: native controls need accessible names`);
  assert.equal(audit.colorIndependent, true, `${label}: state must have a non-color label`);
  assert.deepEqual(audit.overflow, [], `${label}: native page/Note content has horizontal overflow`);
  return { forcedColors: audit.forcedColors, reducedMotion: audit.reducedMotion, colorIndependent: audit.colorIndependent, noPageOverflow: audit.overflow.length === 0 };
}

async function requireExactFocus(page, target, label) {
  await assertKeyboardFocus(page);
  assert.equal(await target.evaluate(node => {
    let active = node.ownerDocument.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active === node;
  }), true, label);
}

// Called only after the shared native owner admits the pinned host, imports the
// exact revisioned entry and mounts its real page. It owns no alternate runtime.
export async function exerciseNativeKeyboardStates({ page, world, host: initialHost, fixture, native, signal, restartHost, browserGuard }) {
  page.setDefaultTimeout(30_000);
  const progress = phase => console.log(`native-keyboard-progress=${JSON.stringify({ phase })}`);
  let host = initialHost;
  const states = [];
  const audits = [];
  const announcements = [];
  let focusRestored = false;
  const nativePage = page.locator('openclaw-plugin-page');
  const chatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  // Approved first-live scope exception, tracked in #228. Native OpenClaw
  // deliberately leaves this scrollable transcript without a focus outline.
  // Observe every traversal without calling that missing indicator a pass.
  const deferredIndicator = {
    locator: chatPane.locator('.chat-thread[role="log"][tabindex="0"]'),
    record: () => console.log('keyboard-focus-deferral={"issue":228,"scope":"native-chat-transcript","indicator":"missing","status":"deferred"}')
  };
  const button = name => nativePage.getByRole('button', { name, exact: true });
  const note = nativePage.getByRole('region', { name: 'Note content', exact: true });
  const creation = nativePage.locator('form').filter({ has: page.getByRole('heading', { name: 'New Conversation', exact: true }) });
  const createButton = () => creation.getByRole('button', { name: 'Create Conversation', exact: true });
  const gatewayRead = async (method, params = { schemaVersion: 1 }) => unwrap(await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method, params, signal }));
  const ready = predicate => waitForConsecutiveReadiness(predicate, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
  const press = async (target, { reverse = false } = {}) => {
    signal.throwIfAborted();
    await tabTo(target, { reverse, deferredIndicator });
    await page.keyboard.press('Enter');
  };
  const type = async (target, value) => {
    await tabTo(target);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(value);
  };
  const announced = async (owner, text) => {
    const status = owner.getByRole('status').filter({ hasText: text });
    await status.waitFor();
    const value = await status.textContent();
    assert.ok(value?.trim(), 'A dynamic status must expose actual readable text');
    announcements.push(value);
  };
  const complete = async (state, surface = nativePage) => {
    audits.push(await auditNativeState(page, surface, state));
    states.push(state);
    progress(`${state}:passed`);
  };
  const topicCatalog = () => gatewayRead('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: fixture.topicId, includeClosed: false });
  const exactConversation = async (referenceId, count) => {
    const catalog = await topicCatalog();
    assert.equal(catalog.topicId, fixture.topicId);
    assert.equal(catalog.conversations.length, count);
    assert.equal(catalog.conversations.filter(row => row.isPrimary).length, 1);
    assert.equal(catalog.conversations.find(row => row.isPrimary).referenceId, fixture.sessionReferenceId);
    assert.equal(catalog.conversations.find(row => row.isPrimary).sessionId, fixture.sessionId);
    const matches = catalog.conversations.filter(row => row.referenceId === referenceId);
    assert.equal(matches.length, 1);
    const target = await gatewayRead('command-center.v1.sessions.navigate', { schemaVersion: 1, topicId: fixture.topicId, referenceId, nativeChat: true });
    assert.equal(target.sourceReference.topicId, fixture.topicId);
    assert.equal(target.sourceReference.referenceId, referenceId);
    assert.equal(target.sessionId, matches[0].sessionId);
    assert.equal(typeof target.sessionKey, 'string');
    assert.ok(target.sessionKey);
    return target;
  };
  const verifyChat = async target => {
    await chatPane.waitFor({ timeout: 30_000 });
    await page.waitForFunction(key => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, target.sessionKey, { timeout: 30_000 });
    // Reach the actual host composer through its composed tab order. No message
    // is sent in this row; native send/readback belongs to the primary journey.
    await tabTo(chatPane.locator('.agent-chat__composer-combobox textarea'), { deferredIndicator });
    await assertKeyboardFocus(page);
  };
  const openNotes = async () => {
    await press(button(`View Notes for ${fixture.name}`));
    await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
    await button(`Read ${fixture.notePath}`).waitFor();
  };
  const returnFromChat = async () => {
    const returnLink = page.locator('openclaw-app-sidebar openclaw-plugin-contributions').getByRole('link', { name: 'Topics', exact: true });
    await press(returnLink);
    await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
    // Native sidebar navigation retains its invoker; it does not call the
    // plugin view's optional focus() hook. Verify that contract, then traverse
    // into the mounted page without a programmatic focus correction.
    await requireExactFocus(page, returnLink, 'Native return must retain visible focus on its exact navigation link');
    await tabTo(button('Refresh Topics'));
    await requireExactFocus(page, button('Refresh Topics'), 'The mounted Topics page must remain keyboard reachable');
    await openNotes();
  };
  const readNote = async () => {
    await press(button(`Read ${fixture.notePath}`));
    await note.filter({ hasText: fixture.noteText.trim() }).waitFor();
    assert.equal(await note.textContent(), fixture.noteText);
    await requireExactFocus(page, note, 'Opening a Note must restore focus to its exact content, including inside native shadow DOM');
    await announced(nativePage, /Note opened · sha256:/u);
    assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
    assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);
  };
  const actionResponse = action => observeBrowserResponse(page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === actionPath && response.request().postDataJSON()?.action === action, { timeout: 30_000 }));
  const appliedReceipt = async (observed, action, original) => {
    assert.equal(hasSuccessfulBrowserResponse(observed), true, `Actual native HTTP ${action} must succeed`);
    assert.equal(observed.value.request().headers()['x-openclaw-control-ui-relay'], '1');
    const input = observed.value.request().postDataJSON();
    assert.equal(input.action, action); assert.equal(input.topicId, fixture.topicId);
    const receipt = await observed.value.json();
    assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.status, 'applied');
    assert.equal(receipt.logicalOperationId, input.logicalOperationId);
    assert.equal(receipt.result.topicId, fixture.topicId);
    assert.equal(typeof receipt.result.referenceId, 'string'); assert.ok(receipt.result.referenceId);
    if (original) assert.equal(input.logicalOperationId, original.logicalOperationId);
    return { input, receipt };
  };
  const acknowledge = async receipt => {
    const pending = actionResponse('conversations.creation.acknowledge');
    await press(creation.getByRole('button', { name: 'Acknowledge created Conversation', exact: true }));
    const observed = await pending;
    assert.equal(hasSuccessfulBrowserResponse(observed), true);
    assert.deepEqual(observed.value.request().postDataJSON(), { schemaVersion: 1, action: 'conversations.creation.acknowledge', topicId: fixture.topicId, logicalOperationId: receipt.logicalOperationId, referenceId: receipt.result.referenceId });
    const value = await observed.value.json();
    assert.equal(value.status, 'acknowledged'); assert.equal(value.logicalOperationId, receipt.logicalOperationId);
    assert.equal(value.result.referenceId, receipt.result.referenceId);
    await ready(() => createButton().isEnabled());
  };

  assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 });
  const topics = await gatewayRead('command-center.v1.topics.list');
  assert.equal(topics.activeGroups.project.find(row => row.topicId === fixture.topicId)?.usable, true);
  await press(button('Refresh Topics'));
  await announced(nativePage, '1 Topics. Conversations open in native Chat.');
  await requireExactFocus(page, button('Refresh Topics'), 'Refreshing Topics must preserve the exact keyboard invoker');
  await complete('topics-navigation');
  await openNotes();
  await tabTo(button(`Read ${fixture.notePath}`));
  await complete('notes-list');
  const noteCatalog = await gatewayRead('command-center.v1.notes.browse', { schemaVersion: 1, topicId: fixture.topicId, offset: 0, limit: 50 });
  assert.equal(noteCatalog.notes.length, 1);
  const originalNote = noteCatalog.notes[0];
  assert.equal(originalNote.path, fixture.notePath);
  assert.equal(originalNote.sourceReference.topicId, fixture.topicId);
  assert.equal(originalNote.revision, `sha256:${createHash('sha256').update(fixture.noteText).digest('hex')}`);
  await readNote(); focusRestored = true;
  // Exercise real backward as well as forward sequential traversal.
  await tabTo(button(`Read ${fixture.notePath}`), { reverse: true });
  await readNote();
  await requireExactFocus(page, note, 'Reopening the same Note must restore its exact reader focus');
  await complete('note-reader');
  const primary = await exactConversation(fixture.sessionReferenceId, 1);
  assert.equal(primary.sessionKey, fixture.sessionKey); assert.equal(primary.sessionId, fixture.sessionId);
  await press(button('Open Topic in Chat'));
  await verifyChat(primary);
  await complete('native-chat-handoff', chatPane);
  await returnFromChat();

  await ready(() => createButton().isEnabled());
  const label = 'Fictional keyboard Conversation';
  await type(creation.getByRole('textbox', { name: 'Conversation label', exact: true }), label);
  const creating = actionResponse('conversations.create');
  await press(createButton());
  const first = await appliedReceipt(await creating, 'conversations.create');
  assert.equal(first.input.label, label);
  assert.deepEqual(Object.keys(first.input).sort(), ['action', 'expectedRevision', 'label', 'logicalOperationId', 'schemaVersion', 'topicId']);
  assert.match(first.input.logicalOperationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const created = await exactConversation(first.receipt.result.referenceId, 2);
  assert.notEqual(created.sessionId, fixture.sessionId);
  await verifyChat(created);
  await returnFromChat();
  await announced(creation, first.input.logicalOperationId);
  assert.equal(await createButton().isDisabled(), true);
  await tabTo(creation.getByRole('button', { name: 'Open created Conversation', exact: true }));
  await complete('conversation-create');
  // Release only the exact owned applied receipt before a second deliberate ID.
  await acknowledge(first.receipt);

  let lost;
  let interceptionFailure;
  let intercepted = 0;
  const loseCreationReply = async route => {
    const request = route.request();
    if (request.method() !== 'POST' || request.postDataJSON()?.action !== 'conversations.create') return route.fallback();
    let response;
    // Forward the real authenticated request once, then suppress only its reply.
    // No fabricated payload, server result, identity or permission is supplied.
    try {
      intercepted += 1;
      assert.equal(intercepted, 1, 'An uncertain operation must never automatically redispatch creation');
      assert.equal(new URL(request.url()).origin, new URL(world.gateway.url).origin);
      browserGuard.assert(new URL(request.url()).hostname, 'browser-native-lost-reply');
      assert.equal(request.headers()['x-openclaw-control-ui-relay'], '1');
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
      assert.equal(response.ok(), true);
      lost = { input: request.postDataJSON(), receipt: await response.json() };
      assert.equal(lost.receipt.status, 'applied');
      assert.equal(lost.receipt.logicalOperationId, lost.input.logicalOperationId);
      assert.equal(lost.receipt.result.topicId, fixture.topicId);
    } catch (error) { interceptionFailure = error; }
    finally { await response?.dispose(); await route.abort('failed'); }
  };
  await page.route(`**${actionPath}`, loseCreationReply);
  try {
    await type(creation.getByRole('textbox', { name: 'Conversation label', exact: true }), 'Fictional interrupted keyboard Conversation');
    await press(createButton());
    await announced(creation, /creation outcome is unknown/iu);
    if (interceptionFailure) throw interceptionFailure;
    assert.ok(lost); assert.equal(intercepted, 1);
    assert.notEqual(lost.input.logicalOperationId, first.input.logicalOperationId);
    await announced(creation, lost.input.logicalOperationId);
    assert.equal(await createButton().isDisabled(), true);
    // Do not mask a lost-focus defect by tabbing first. The settled state must
    // retain a visible, named, enabled focus destination on its own.
    await assertKeyboardFocus(page);
    await complete('unknown-creation');
    const pending = actionResponse('conversations.creation.reconcile');
    await press(creation.getByRole('button', { name: 'Check creation outcome', exact: true }));
    const recovered = await appliedReceipt(await pending, 'conversations.creation.reconcile', lost.input);
    assert.deepEqual(recovered.input, { schemaVersion: 1, action: 'conversations.creation.reconcile', topicId: fixture.topicId, logicalOperationId: lost.input.logicalOperationId });
    assert.equal(recovered.receipt.result.referenceId, lost.receipt.result.referenceId);
    const recoveredTarget = await exactConversation(lost.receipt.result.referenceId, 3);
    await press(creation.getByRole('button', { name: 'Open created Conversation', exact: true }));
    await verifyChat(recoveredTarget);
    await returnFromChat();
    await acknowledge(recovered.receipt);
    assert.equal(intercepted, 1, 'Check/open/acknowledge must never submit another create');
  } finally { await page.unroute(`**${actionPath}`, loseCreationReply); }

  const originalConfig = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
  const nativeIdentities = async () => {
    const result = await gatewayRead('sessions.list', { agentId: 'main', limit: 100, offset: 0, includeGlobal: true, includeUnknown: true, archived: 'all' });
    assert.equal(result.hasMore, false); assert.equal(result.totalCount, result.sessions.length);
    return result.sessions.map(({ key, sessionId }) => ({ key, sessionId })).sort((a, b) => a.key.localeCompare(b.key));
  };
  const retainedSessions = await nativeIdentities();
  const retainedTopic = await gatewayRead('command-center.v1.topics.get', { schemaVersion: 1, topicId: fixture.topicId });
  // Real Note reads refresh source observation timestamps, not ownership or
  // content. Retain every other public field, including locator generations.
  const withoutObservationTimes = topic => ({ ...topic,
    sourceReferences: topic.sourceReferences.map(({ updatedAt, ...reference }) => reference)
  });
  for (const state of ['source-unavailable', 'permission-refused']) {
    progress(`${state}:started`);
    // Change only the supported isolated plugin configuration. This is source
    // availability / plugin write-grant refusal, not operator-profile revocation.
    await press(button('All Topics'));
    await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
    const config = structuredClone(originalConfig);
    const plugin = config.plugins.entries['command-center'].config;
    if (state === 'source-unavailable') plugin.sourceCapabilities = { ...plugin.sourceCapabilities, sessions: false };
    else plugin.controlUiGrant = false;
    await writeFile(world.manifest.configPath, `${JSON.stringify(config)}\n`);
    progress(`${state}:restart-started`);
    host = await restartHost();
    progress(`${state}:restart-launched`);
    await ready(async () => {
      try { const catalog = await gatewayRead('plugins.controlUi.list', {}); return catalog.plugins?.some(row => row.pluginId === 'command-center' && row.revision === native.revision); }
      catch { signal.throwIfAborted(); return false; }
    });
    progress(`${state}:catalog-ready`);
    const status = await gatewayRead('command-center.v1.sources.status');
    assert.equal(status.mode, 'degraded');
    assert.equal(status.unavailableCapabilities.includes('sessions'), state === 'source-unavailable');
    assert.equal(status.unavailableCapabilities.includes('control-ui-grant'), state === 'permission-refused');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    progress(`${state}:page-reloaded`);
    await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
    await announced(nativePage, /Degraded · some capabilities are unavailable/u);
    await openNotes(); await readNote();
    progress(`${state}:note-read`);
    const currentNotes = await gatewayRead('command-center.v1.notes.browse', { schemaVersion: 1, topicId: fixture.topicId, offset: 0, limit: 50 });
    assert.equal(currentNotes.notes.length, 1);
    assert.equal(currentNotes.notes[0].sourceReference.referenceId, originalNote.sourceReference.referenceId);
    assert.equal(currentNotes.notes[0].revision, originalNote.revision);
    await announced(creation, /unavailable|recovery|write access|refused/iu);
    assert.equal(await createButton().isDisabled(), true);
    if (state === 'source-unavailable') {
      await press(button('Open Topic in Chat'));
      await announced(nativePage, /capability.*unavailable/iu);
      assert.equal(await chatPane.count(), 0);
    } else {
      const inspection = actionResponse('conversations.creation.inspect');
      await press(creation.getByRole('button', { name: 'Refresh creation status', exact: true }));
      const response = await inspection;
      assert.equal(response.observed, true); assert.equal(response.value.status(), 422);
      const refusal = await response.value.json();
      assert.equal(refusal.code, 'capability-unavailable');
      assert.equal(refusal.message, 'Control UI grant is unavailable.');
      // The native response owner intentionally does not render raw server
      // messages. An unrecognized non-success keeps creation unavailable.
      await announced(creation, /^Creation status is unavailable\./u);
      await announced(creation, /Source Recovery is required before another write\./u);
      assert.equal(await createButton().isDisabled(), true);
      await ready(() => creation.getByRole('button', { name: 'Refresh creation status', exact: true }).isEnabled());
    }
    const beforeRefusal = await gatewayRead('command-center.v1.topics.get', { schemaVersion: 1, topicId: fixture.topicId });
    assert.deepEqual(withoutObservationTimes(beforeRefusal.topic), withoutObservationTimes(retainedTopic.topic), 'Capability changes must preserve the existing Topic identity and revision');
    const refusal = await fetchJsonWithDeadline(`${world.gateway.url}${actionPath}`, {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json', 'x-openclaw-control-ui-relay': '1' },
      body: JSON.stringify({ schemaVersion: 1, action: 'conversations.create', topicId: fixture.topicId, expectedRevision: retainedTopic.topic.revision, logicalOperationId: randomUUID(), label: 'Fictional refused keyboard creation' })
    }, { label: `native keyboard ${state} authenticated refusal`, timeoutMs: 30_000 });
    assert.equal(refusal.parseError, undefined); assert.equal(refusal.response.status, 422);
    assert.equal(refusal.body.code, 'capability-unavailable');
    if (state === 'permission-refused') assert.equal(refusal.body.message, 'Control UI grant is unavailable.');
    assert.deepEqual(await nativeIdentities(), retainedSessions, 'Refused creation must not leave an unattached native Session');
    // Source observation timestamps may advance on the earlier real Note read;
    // the refused command itself must leave the complete current projection alone.
    assert.deepEqual(await gatewayRead('command-center.v1.topics.get', { schemaVersion: 1, topicId: fixture.topicId }), beforeRefusal);
    assert.equal(await note.textContent(), fixture.noteText);
    await complete(state);
  }
  assert.equal(states.length, 8); assert.equal(new Set(states).size, 8);
  assert.ok(announcements.length >= 8);
  return {
    schemaVersion: 2, viewport: page.viewportSize(), keyboardOnly: true,
    forcedColors: audits.every(audit => audit.forcedColors), reducedMotion: audits.every(audit => audit.reducedMotion),
    focusRestored, announcements: announcements.every(value => value.trim().length > 0),
    colorIndependent: audits.every(audit => audit.colorIndependent), noPageOverflow: audits.every(audit => audit.noPageOverflow), states
  };
}
