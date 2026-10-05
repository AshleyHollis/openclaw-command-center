import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createCommitmentCaptureService } from '../../src/open-loops/commitment-capture.mjs';
import { controlUiPluginUrl } from '../../src/acceptance-readiness.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { WRITE_METHODS, ADMIN_METHODS } from '../../src/bridge/contracts.mjs';

// Only the issued fictional world's existing metadata owner seeds these rows.
// Browser requests and replies below still pass through the installed Gateway.
export async function seedAttentionLoops(metadata, topicId, peerTopicId) {
  const capture = createCommitmentCaptureService({ metadata });
  const loops = [];
  for (let index = 0; index < 7; index++) {
    const value = await capture.capture({ schemaVersion: 1, logicalOperationId: randomUUID(),
      sourceKind: 'chat', sourceExternalId: `agent:main:fictional-attention-${index}`, sourceVersion: 'fixture-v1',
      topicId: index === 6 ? peerTopicId : topicId, title: `Fictional installed item ${index}`,
      obligationId: `fictional-installed-${index}`, provenance: index === 5 ? 'idea' : 'explicit',
      occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), historicalBaseline: false,
      importance: 'critical', importanceOrigin: 'processing' });
    const loop = value.loop;
    loops.push(metadata.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: randomUUID(),
      expectedRevision: loop.revision, loop: { ...loop, revision: loop.revision + 1,
        attention: { ...loop.attention, activated: true, currentEvidence: true, reason: 'material-change' } } }).loop);
  }
  return loops;
}

// Lifecycle retirement removes a Topic from the real authorized Dashboard
// projection without inventing an unsupported archived lifecycle value.
export function setAttentionTopicAvailable(metadata, topicId, available) {
  return metadata.updateTopic({ topicId, lifecycle: available ? 'active' : 'retired',
    expectedRevision: metadata.getTopic(topicId).revision });
}

// Faults retain or discard authentic server replies, never fabricate payloads,
// grants, successful mutations or scopes. The regular native owner closes all
// sockets/browser/host and verifies traffic and sealed bytes on every outcome.
export function attentionTransportProbe() {
  const pending = new Map(); const writes = []; let holdDashboard = false; let held; let discardDecision = false; let holdDecision = false; let heldDecision;
  return {
    writes,
    request(message) {
      if (message?.type !== 'req') return;
      pending.set(message.id, message);
      if ([...WRITE_METHODS, ...ADMIN_METHODS].includes(message.method)) writes.push(structuredClone(message));
    },
    response(message, deliver) {
      const request = pending.get(message?.id); pending.delete(message?.id);
      if (!request || message?.type !== 'res' || message.ok !== true) return true;
      if (holdDashboard && request.method === 'command-center.v1.dashboard.get') {
        holdDashboard = false; held = { deliver, id: message.id }; return false;
      }
      if (holdDecision && request.method === 'command-center.v1.open-loops.decide') { holdDecision = false; heldDecision = { deliver, id: message.id }; return false; }
      if (discardDecision && request.method === 'command-center.v1.open-loops.decide') { discardDecision = false; return false; }
      return true;
    },
    holdNextDashboard() { assert.equal(held, undefined); holdDashboard = true; },
    hasHeldDashboard() { return !!held; },
    releaseDashboard() { assert.ok(held); const reply = held; held = undefined; reply.deliver(); return reply.id; },
    holdNextDecision() { assert.equal(heldDecision, undefined); holdDecision = true; },
    releaseDecision() { assert.ok(heldDecision); const reply = heldDecision; heldDecision = undefined; reply.deliver(); return reply.id; },
    discardNextDecision() { discardDecision = true; }
  };
}

export async function exerciseNativeAttentionStates({ page, world, fixture, peer, loops, probe, signal, nativeSelector = 'openclaw-plugin-page', enterPlanner, remount, responseObservations }) {
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(world.root, '.openclaw') });
  const native = page.locator(nativeSelector);
  const refresh = () => native.getByRole('button', { name: 'Refresh Planner', exact: true });
  const row = index => native.locator(`[data-open-loop-id="${loops[index].loopId}"]`).first();
  const openDraft = async (index, kind) => {
    const suggestions = native.locator('[data-open-loop-group="Suggestions"]');
    if (index === 5 && await suggestions.count() && !await suggestions.evaluate(node => node.open)) await suggestions.locator(':scope > summary').click();
    const card = row(index);
    assert.equal(await card.isVisible(), true, `Draft card ${loops[index].loopId} must be mounted in the ordinary projection`);
    const details = card.locator(kind === 'clarification' ? '[data-open-loop-clarification]' : '[data-open-loop-decisions]');
    if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
    return details;
  };
  const settledRefresh = async () => {
    await refresh().evaluate(node => node.click());
    await native.locator('.cc-planner-controls').waitFor();
  };
  const topic = () => native.getByRole('combobox', { name: 'Topic', exact: true }).first();
  const originalLoops = metadata.listOpenLoops();
  const originalActions = metadata.listOpenLoopUserActionReceiptsPage({ limit: 50 }).actions;
  const received = responseObservations ?? new Set();
  const observeSocket = socket => socket.on('framereceived', ({ payload }) => {
    let message; try { message = JSON.parse(String(payload)); } catch { return; }
    if (message?.type === 'res' && received.size < 256) received.add(message.id);
  });
  page.on('websocket', observeSocket);
  try {
    if (enterPlanner) await enterPlanner();
    else await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'planner',
      fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await native.getByRole('heading', { name: 'Planner', exact: true }).waitFor();
    await topic().locator(`option[value="${fixture.topicId}"]`).waitFor({ state: 'attached' });
    assert.equal(await native.locator('iframe').count(), 0);
    // Names come from the actual authorized projection. Exact option identities
    // are checked separately from visible duplicate labels.
    const labels = await topic().locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent })));
    for (const id of [fixture.topicId, peer.topicId]) assert.ok(labels.some(item => item.value === id && item.text === `${fixture.name} (${id})`));
    await topic().selectOption(peer.topicId);
    metadata.setTopicName({ topicId: peer.topicId, name: 'Fictional renamed peer', expectedRevision: metadata.getTopic(peer.topicId).revision });
    await topic().focus(); await settledRefresh();
    assert.equal(await topic().inputValue(), peer.topicId);
    assert.equal(await topic().locator(`option[value="${peer.topicId}"]`).textContent(), 'Fictional renamed peer');
    assert.equal(await topic().evaluate(node => node === document.activeElement), true);
    setAttentionTopicAvailable(metadata, peer.topicId, false); await settledRefresh();
    assert.equal(await topic().inputValue(), peer.topicId);
    assert.match(await topic().locator(`option[value="${peer.topicId}"]`).textContent(), /unavailable/iu);
    assert.equal(await topic().locator('option').filter({ hasText: 'Fictional renamed peer' }).count(), 0);
    setAttentionTopicAvailable(metadata, peer.topicId, true); await settledRefresh(); await topic().selectOption('');

    await exerciseAttentionPlannerControls({ page, native, topicId: fixture.topicId, peerLoopId: loops[6].loopId, settledRefresh });

    const mountedDraftIndices = async () => {
      const ids = await native.locator('[data-open-loop-id]').evaluateAll(nodes => [...new Set(nodes.filter(node => node.getClientRects().length && !node.closest('[hidden]') && node.querySelector('[data-open-loop-decisions]')).map(node => node.dataset.openLoopId))]);
      return ids.map(id => loops.findIndex(loop => loop.loopId === id)).filter(index => index >= 0);
    };
    const initialDrafts = (await mountedDraftIndices()).filter(index => metadata.getOpenLoop(loops[index].loopId).topicId === fixture.topicId);
    assert.ok(initialDrafts.length >= 2, `Two ordinary cards bound to the first Topic must be mounted; found ${JSON.stringify(initialDrafts)}`);
    const [firstDraftIndex, secondDraftIndex] = initialDrafts;
    const first = await openDraft(firstDraftIndex, 'clarification'); const second = await openDraft(secondDraftIndex, 'decision');
    await first.getByLabel('What needs correcting?').fill('  Fictional unsent clarification  ');
    await second.locator('select').selectOption('resolve');
    await second.locator('select').selectOption('defer');
    const futureReview = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    await second.getByLabel('Review time', { exact: true }).fill(futureReview);
    await second.locator('select').selectOption('resolve');
    await second.getByLabel('Rationale', { exact: true }).fill('Fictional independent unsent decision');
    await first.getByLabel('What needs correcting?').focus();
    await first.getByLabel('What needs correcting?').evaluate(node => node.setSelectionRange(2, 12, 'backward'));
    // Refresh by DOM activation keeps current textarea focus, as in the native
    // owner receiving an external refresh while the user is still editing.
    await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent === 'Refresh Planner').click());
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.selectionStart === 2);
    assert.equal(await (await openDraft(firstDraftIndex, 'clarification')).getByLabel('What needs correcting?').inputValue(), '  Fictional unsent clarification  ');
    assert.equal(await (await openDraft(secondDraftIndex, 'decision')).getByLabel('Rationale', { exact: true }).inputValue(), 'Fictional independent unsent decision');
    await (await openDraft(secondDraftIndex, 'decision')).locator('select').selectOption('defer');
    assert.equal(await (await openDraft(secondDraftIndex, 'decision')).getByLabel('Review time', { exact: true }).inputValue(), futureReview);
    await (await openDraft(secondDraftIndex, 'decision')).locator('select').selectOption('resolve');
    assert.deepEqual(metadata.listOpenLoops(), originalLoops);
    assert.deepEqual(metadata.listOpenLoopUserActionReceiptsPage({ limit: 50 }).actions, originalActions);
    assert.equal(probe.writes.length, 0, 'Editing, filtering, views and refresh must issue zero mutations');

    // Deliver an older genuine projection after a newer genuine projection.
    probe.holdNextDashboard(); await refresh().click();
    for (let attempt = 0; !probe.hasHeldDashboard() && attempt < 500; attempt++) { signal.throwIfAborted(); await page.waitForTimeout(20); }
    assert.equal(probe.hasHeldDashboard(), true);
    const prior = metadata.getOpenLoop(loops[firstDraftIndex].loopId);
    metadata.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: prior.revision,
      loop: { ...prior, title: 'Fictional newer revision', revision: prior.revision + 1 } });
    // Explicitly exercise the existing native refresh event during a pending
    // response. No payload is substituted; both generations reach the Gateway.
    await refresh().dispatchEvent('click'); await native.locator('.cc-planner-controls').waitFor();
    const oldReply = probe.releaseDashboard();
    for (let attempt = 0; !received.has(oldReply) && attempt < 500; attempt++) { signal.throwIfAborted(); await page.waitForTimeout(20); }
    assert.equal(received.has(oldReply), true, 'The stale genuine response must actually reach the browser');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await row(firstDraftIndex).getByRole('heading', { name: 'Fictional newer revision', exact: true }).count(), 1);
    assert.equal(await (await openDraft(firstDraftIndex, 'clarification')).getByLabel('What needs correcting?').inputValue(), '');
    assert.equal(await (await openDraft(secondDraftIndex, 'decision')).getByLabel('Rationale', { exact: true }).inputValue(), 'Fictional independent unsent decision');
    const bound = metadata.getOpenLoop(loops[secondDraftIndex].loopId);
    metadata.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: bound.revision,
      loop: { ...bound, topicId: peer.topicId, revision: bound.revision + 1 } }); await settledRefresh();
    assert.equal(await (await openDraft(secondDraftIndex, 'decision')).getByLabel('Rationale', { exact: true }).inputValue(), '');
    await (await openDraft(secondDraftIndex, 'decision')).getByLabel('Rationale', { exact: true }).fill('Fictional binding remains private');
    setAttentionTopicAvailable(metadata, peer.topicId, false); await settledRefresh();
    setAttentionTopicAvailable(metadata, peer.topicId, true); await settledRefresh();
    assert.equal(await (await openDraft(secondDraftIndex, 'decision')).getByLabel('Rationale', { exact: true }).inputValue(), '');
    setAttentionTopicAvailable(metadata, fixture.topicId, false); await settledRefresh();
    setAttentionTopicAvailable(metadata, fixture.topicId, true); await settledRefresh();
    assert.equal(await (await openDraft(secondDraftIndex, 'decision')).getByLabel('Rationale', { exact: true }).inputValue(), '');

    // Uncertain delivery withholds one real successful reply past the UI wait.
    // A changed choice must not submit; exact retry reaches the real journal.
    const suggestion = await openDraft(5, 'decision');
    await suggestion.getByLabel('Rationale', { exact: true }).fill('Fictional immutable confirmation');
    probe.holdNextDecision(); await suggestion.getByRole('button', { name: 'Save action', exact: true }).click();
    await suggestion.getByRole('button', { name: 'Save action', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(id => (() => { const button = document.querySelector(`[data-open-loop-id="${CSS.escape(id)}"] [data-open-loop-decisions] button`); return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'; })(), loops[5].loopId, { timeout: 60_000 });
    const sent = probe.writes.at(-1); assert.equal(sent.method, 'command-center.v1.open-loops.decide');
    await suggestion.locator('select').selectOption('dismiss');
    await suggestion.getByRole('button', { name: 'Save action', exact: true }).click();
    assert.equal(probe.writes.length, 1);
    const unknownStatus = await native.getByRole('status').first().textContent();
    const lateReply = probe.releaseDecision();
    for (let attempt = 0; !received.has(lateReply) && attempt < 500; attempt++) { signal.throwIfAborted(); await page.waitForTimeout(20); }
    assert.equal(received.has(lateReply), true, 'The authentic late decision reply must reach the browser');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await native.getByRole('status').first().textContent(), unknownStatus, 'A late reply cannot claim success or discard recovery');
    assert.equal(probe.writes.length, 1, 'Late delivery never automatically retries');
    await suggestion.locator('select').selectOption('confirm');
    await suggestion.getByRole('button', { name: 'Save action', exact: true }).click();
    await page.waitForFunction(id => (() => { const button = document.querySelector(`[data-open-loop-id="${CSS.escape(id)}"] [data-open-loop-decisions] button`); return !button || !button.disabled && button.getAttribute('aria-disabled') !== 'true'; })(), loops[5].loopId);
    assert.equal(probe.writes.length, 2); assert.deepEqual(probe.writes[1].params, sent.params);
    assert.equal(metadata.listOpenLoopUserActionReceiptsPage({ limit: 50 }).actions.filter(item => item.logicalOperationId === sent.params.logicalOperationId).length, 1);

    // Confirmed removals must give keyboard focus to the next/previous actual
    // visible card, never a hidden projection. All writes are fictional.
    await native.getByRole('button', { name: 'Open Dashboard', exact: true }).click();
    await native.getByRole('heading', { name: 'Command Center', exact: true }).waitFor();
    await native.locator('[data-open-loop-id] [data-open-loop-decisions]').first().waitFor({ state: 'visible', timeout: 10_000 });
    const remountDraftIndex = (await mountedDraftIndices())[0]; assert.ok(Number.isInteger(remountDraftIndex));
    await (await openDraft(remountDraftIndex, 'clarification')).getByLabel('What needs correcting?').fill('Must clear across actual remount');
    if (remount) await remount(); else await page.reload({ waitUntil: 'domcontentloaded' });
    await native.getByRole('heading', { name: 'Command Center', exact: true }).waitFor();
    await row(remountDraftIndex).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await (await openDraft(remountDraftIndex, 'clarification')).getByLabel('What needs correcting?').inputValue(), '');
    const positions = ['first', 'middle', 'first', 'first', 'last', 'first', 'first'];
    for (const position of positions) {
      const before = await native.locator('[data-open-loop-id],[data-workspace-loop-id]').evaluateAll(nodes => [...new Set(nodes.filter(node => node.getClientRects().length && !node.closest('[hidden]')).map(node => node.dataset.openLoopId ?? node.dataset.workspaceLoopId))]);
      assert.ok(before.length > 0);
      const eligible = await mountedDraftIndices(); assert.ok(eligible.length > 0, 'A surviving ordinary decision form must be mounted');
      const index = eligible[position === 'last' ? eligible.length - 1 : position === 'middle' ? Math.floor(eligible.length / 2) : 0];
      const at = before.indexOf(loops[index].loopId); assert.ok(at >= 0);
      if (position === 'last') assert.equal(at, before.length - 1, 'Last removal must exercise the full visible order previous-neighbor fallback');
      const form = await openDraft(index, 'decision'); await form.locator('select').selectOption('resolve');
      await form.getByLabel('Rationale', { exact: true }).fill('Fictional explicit removal');
      await form.getByRole('button', { name: 'Save action', exact: true }).press('Enter');
      await page.waitForFunction(id => {
        const content = document.querySelector('section[aria-label="Attention items"]');
        return content?.getAttribute('aria-busy') === 'false'
          && !!content.querySelector('[data-open-loop-id],[data-workspace-loop-id],[data-attention-empty]')
          && [...content.querySelectorAll(`[data-open-loop-id="${CSS.escape(id)}"],[data-workspace-loop-id="${CSS.escape(id)}"]`)].every(node => !node.getClientRects().length || node.closest('[hidden]'));
      }, loops[index].loopId, { timeout: 10_000 });
      const expected = before[at + 1] ?? before[at - 1];
      if (expected) assert.equal(await page.evaluate(() => (() => { const owner = document.activeElement?.closest('[data-open-loop-id],[data-workspace-loop-id]'); return owner?.dataset.openLoopId ?? owner?.dataset.workspaceLoopId; })()), expected,
        JSON.stringify({ position, before, removed: loops[index].loopId, active: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 100)) }));
      else assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H2');
    }
    assert.ok(metadata.listOpenLoops().every(loop => loop.state === 'resolved'));
    return { installedAttentionPlanner: true, fictionalFixture: true, topicNames: true, narrowControls: true,
      boundedDrafts: true, staleProjection: true, immutableRetry: true, removalFocus: true, emptyStateFocus: true,
      topicBindingLoss: true, crossRemountCleared: true, readPrincipalLossExercised: false };
  } finally { page.off('websocket', observeSocket); metadata.close(); }
}


async function selectAttentionFilterWithKeyboard(select, value) {
  const index = await select.locator('option').evaluateAll((nodes, target) => nodes.findIndex(node => node.value === target), value);
  assert.ok(index >= 0, 'The exact authorized filter option must exist');
  // Open the native menu before Home; starting selection can change during
  // pointer hit-target exercises and closed-select key behavior varies by host.
  await select.click(); await select.press('Home');
  for (let step = 0; step < index; step++) await select.press('ArrowDown');
  await select.press('Enter');
  assert.equal(await select.inputValue(), value);
}

export async function exerciseAttentionPlannerControls({ page, native, topicId, peerLoopId, settledRefresh }) {
  const topic = () => native.getByRole('combobox', { name: 'Topic', exact: true }).first();
  // Actual host pane/CSS and hit targets at narrow and intermediate widths.
  for (const width of [640, 800, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const controls = native.locator('.cc-planner-controls');
    const pane = await native.locator('.cc-command-center-page').boundingBox(); assert.ok(pane && pane.width > 0);
    for (const control of await controls.locator('input,select,button').all()) {
      await control.scrollIntoViewIfNeeded(); const box = await control.boundingBox();
      assert.ok(box && box.width > 0 && box.x >= pane.x - 1 && box.x + box.width <= pane.x + pane.width + 1,
        `Control must stay inside the actual native pane at ${width}px`);
        await control.click(); await control.focus(); assert.equal(await control.evaluate(node => node === document.activeElement), true);
        if (await control.evaluate(node => node.tagName === 'SELECT')) await control.press('Escape');
    }
    for (const name of ['Board', 'List', 'Agenda']) {
      const button = controls.getByRole('button', { name, exact: true }); await button.press('Space');
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
    }
    // Traverse every filter and view control using the real Tab order.
    const search = controls.getByRole('searchbox'); await search.focus();
    for (const target of [topic(), controls.getByRole('combobox', { name: 'Status', exact: true }), controls.getByRole('combobox', { name: 'Priority', exact: true }),
      ...['Board', 'List', 'Agenda'].map(name => controls.getByRole('button', { name, exact: true }))]) {
      await page.keyboard.press('Tab'); assert.equal(await target.evaluate(node => node === document.activeElement), true);
    }
    assert.equal(await native.locator(`.cc-planner-list [data-workspace-loop-id="${peerLoopId}"]`).count(), 1, 'The peer must exist before filters hide it');
    await search.fill('Fictional installed'); await search.press('Tab'); await selectAttentionFilterWithKeyboard(topic(), topicId);
    assert.equal(await topic().inputValue(), topicId);
    await page.keyboard.press('Tab'); await selectAttentionFilterWithKeyboard(controls.getByRole('combobox', { name: 'Status', exact: true }), 'confirmed');
    await page.keyboard.press('Tab'); await selectAttentionFilterWithKeyboard(controls.getByRole('combobox', { name: 'Priority', exact: true }), 'critical');
    await controls.getByRole('button', { name: 'List', exact: true }).press('Space');
    await settledRefresh();
    assert.equal(await controls.getByRole('searchbox').inputValue(), 'Fictional installed');
    assert.equal(await topic().inputValue(), topicId);
    assert.equal(await controls.getByRole('combobox', { name: 'Status', exact: true }).inputValue(), 'confirmed');
    assert.equal(await controls.getByRole('combobox', { name: 'Priority', exact: true }).inputValue(), 'critical');
    assert.equal(await controls.getByRole('button', { name: 'List', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await native.locator(`.cc-planner-list [data-workspace-loop-id="${peerLoopId}"]`).isVisible(), false);
    assert.ok(await native.locator(`.cc-planner-list [data-card-topic="${topicId}"]`).evaluateAll(nodes => nodes.some(node => node.getClientRects().length && !node.hidden)), 'Selected Topic must still have visible filtered work');
    await controls.getByRole('searchbox').fill(''); await topic().selectOption('');
    await controls.getByRole('combobox', { name: 'Status', exact: true }).selectOption('');
    await controls.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('');
    await controls.getByRole('button', { name: 'Board', exact: true }).click();
  }
  await page.setViewportSize({ width: 640, height: 900 });
  const board = native.locator('.cc-planner-board');
  await board.focus(); await board.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.cc-planner-board')?.scrollLeft > 0);
  const scroll = await board.evaluate(node => {
    node.scrollLeft = 200; const captured = node.scrollLeft;
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh Planner').click();
    return captured;
  });
  await native.locator('.cc-planner-controls').waitFor(); assert.equal(await board.evaluate(node => node.scrollLeft), scroll);
  assert.equal(await board.evaluate(node => node === document.activeElement), true);
  await native.getByRole('button', { name: 'List', exact: true }).click();

}
