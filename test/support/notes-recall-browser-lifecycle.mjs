import assert from 'node:assert/strict';

// Disposable browser fixture only. IDs and socket owners stay in memory and
// never enter the sanitized qualification report or confer retrieval authority.
export function createRecallTurnObserver(sessionKey) {
  let serial = 0;
  const requests = [], events = [], sockets = new Set();
  const receive = (socket, direction, payload) => {
    const text = String(payload); if (text.length > 1024 * 1024) return;
    let frame; try { frame = JSON.parse(text); } catch { return; }
    if (direction === 'sent' && frame?.type === 'req' && frame.method === 'chat.send'
      && frame.params?.sessionKey === sessionKey && typeof frame.id === 'string'
      && typeof frame.params.idempotencyKey === 'string' && frame.params.idempotencyKey.trim()) {
      requests.push({ serial: ++serial, socket, requestId: frame.id, fallbackRunId: frame.params.idempotencyKey, accepted: false });
      if (requests.length > 8) requests.shift();
    } else if (direction === 'received' && frame?.type === 'res') {
      const request = requests.find(row => row.socket === socket && row.requestId === frame.id);
      if (request && frame.ok === true) { request.accepted = true; request.runId = typeof frame.payload?.runId === 'string' && frame.payload.runId.trim() ? frame.payload.runId : request.fallbackRunId; }
    } else if (direction === 'received' && frame?.type === 'event'
      && ['chat', 'agent'].includes(frame.event) && frame.payload?.sessionKey === sessionKey && typeof frame.payload.runId === 'string') {
      const value = frame.payload;
      const final = frame.event === 'chat' && value.state === 'final';
      const end = frame.event === 'agent' && value.stream === 'lifecycle' && value.data?.phase === 'end' && value.data.executionSettled === true;
      if (final || end) { events.push({ serial: ++serial, socket, runId: value.runId, final, end }); if (events.length > 32) events.shift(); }
    }
  };
  const attachSocket = socket => {
    const sent = frame => receive(socket, 'sent', frame.payload);
    const received = frame => receive(socket, 'received', frame.payload);
    socket.on('framesent', sent); socket.on('framereceived', received);
    sockets.add({ socket, sent, received });
  };
  let page;
  return {
    attach(target) { assert(!page); page = target; page.on('websocket', attachSocket); },
    mark: () => serial,
    record: receive,
    current(after) {
      const current = requests.filter(row => row.serial > after); assert(current.length <= 1, 'Recall must issue one new native Chat request');
      const request = current[0]; if (!request?.accepted) return null;
      const relevant = events.filter(event => event.serial > request.serial && event.socket === request.socket && event.runId === request.runId);
      return { runId: request.runId, sessionKey, final: relevant.some(event => event.final), executionSettled: relevant.some(event => event.end) };
    },
    dispose() { page?.off('websocket', attachSocket); for (const { socket, sent, received } of sockets) { socket.off('framesent', sent); socket.off('framereceived', received); } sockets.clear(); requests.length = 0; events.length = 0; }
  };
}

export function recallTurnSettled(turn, paneState, providerFinal = true) {
  return Boolean(turn?.final && turn.executionSettled && providerFinal && paneState?.ownerCurrent
    && !paneState.working && paneState.completionMatches);
}

export function recallProviderFinal(requests, after) {
  const current = requests.slice(after);
  const calls = current.filter(row => row.action === 'recall-call');
  assert(calls.length <= 1, 'Recall must issue one current catalog dispatch');
  const call = calls[0];
  return Boolean(call?.issuedToolCallId && current.some(row => row.action === 'final'
    && row.completedCurrentTool === true && row.currentToolResultId === call.issuedToolCallId
    && row.recallCatalogResultVerified === true));
}

export async function pinRecallChat(page, sessionKey, timeout = 30000) {
  await page.waitForFunction(key => {
    const panes = [...document.querySelectorAll('openclaw-chat-pane[aria-hidden="false"]')].filter(pane => pane.sessionKey === key);
    return panes.length === 1 && panes[0].runActivity && !panes[0].runActivity.working;
  }, sessionKey, { timeout });
  const locator = page.locator('openclaw-chat-pane[aria-hidden="false"]'); assert.equal(await locator.count(), 1);
  const pane = await locator.elementHandle();
  assert.equal(await pane.evaluate(node => node.sessionKey), sessionKey);
  const client = await pane.evaluateHandle(node => node.runActivity.client);
  const composer = locator.locator('.agent-chat__composer-combobox textarea'); await composer.waitFor({ timeout });
  return { locator, pane, client, composer, dispose: async () => { await client.dispose(); await pane.dispose(); } };
}

export async function readRecallPaneState(chat, turn) {
  return chat.pane.evaluate((pane, { client, turn }) => {
    const activity = pane.runActivity;
    return { ownerCurrent: pane.isConnected && pane.sessionKey === turn.sessionKey && activity?.client === client,
      working: activity?.working === true, completionMatches: activity?.completion?.phase === 'done'
        && activity.completion.runId === turn.runId && activity.completion.sessionKey === turn.sessionKey };
  }, { client: chat.client, turn });
}

export async function assertRetainedRecallDraft(chat, { sessionKey, draft, selection, presented, phase = 'citation-navigation' }) {
  assert(['citation-navigation', 'stale-citation-navigation'].includes(phase));
  const matches = await chat.pane.evaluate((pane, expected) => {
    const input = pane.querySelector('.agent-chat__composer-combobox textarea');
    return { mounted: pane.isConnected, session: pane.sessionKey === expected.sessionKey,
      presented: pane.getAttribute('aria-hidden') === String(!expected.presented),
      draft: input?.value === expected.draft,
      selection: input?.selectionStart === expected.selection[0] && input?.selectionEnd === expected.selection[1] };
  }, { sessionKey, draft, selection, presented }).catch(() => ({ mounted: false }));
  if (!Object.values(matches).every(Boolean)) throw Object.assign(new Error('Exact mounted native Chat draft, caret and presentation must be preserved'),
    { category: 'recall-citation-handoff', phase });
}

export async function recallBrowserState(page, sessionKey) {
  return page.evaluate(key => {
    const panes = [...document.querySelectorAll('openclaw-chat-pane')];
    const matching = panes.filter(pane => pane.sessionKey === key);
    const route = location.pathname.endsWith('/plugin') ? 'plugin' : location.pathname.includes('/chat') ? 'chat' : 'other';
    return { route, topicPage: route === 'plugin' && new URLSearchParams(location.search).get('id') === 'topic',
      paneCount: Math.min(panes.length, 8), matchingPaneCount: Math.min(matching.length, 8),
      presentedMatchingPaneCount: Math.min(matching.filter(pane => pane.getAttribute('aria-hidden') === 'false').length, 8),
      connectedMatchingPane: matching.some(pane => Boolean(pane.runActivity)),
      matchingPaneWorking: matching.some(pane => pane.runActivity?.working === true),
      topicChatButtonCount: Math.min([...document.querySelectorAll('button')].filter(button => button.textContent.trim() === 'Open Topic in Chat').length, 8),
      noteReaderCount: Math.min(document.querySelectorAll('[role="region"][aria-label="Note content"]').length, 8) };
  }, sessionKey);
}
