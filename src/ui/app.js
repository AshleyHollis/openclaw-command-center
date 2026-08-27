const form = document.querySelector('#topic-search-form');
const topicIdInput = document.querySelector('#topic-search-topic-id');
const queryInput = document.querySelector('#topic-search-query');
const status = document.querySelector('#topic-search-status');
const detail = document.querySelector('#topic-search-detail');
const initialTopicId = new URLSearchParams(window.location.search).get('topicId') || document.body.dataset.topicId || '';
if (topicIdInput) topicIdInput.value = initialTopicId;

const pendingBridgeRequests = new Map();
let resolveBridgeReady;
let rejectBridgeReady;
const bridgeReady = new Promise((resolve, reject) => {
  resolveBridgeReady = resolve;
  rejectBridgeReady = reject;
});
const bridgeTimer = setTimeout(() => rejectBridgeReady(new Error('Command Center capability bridge did not become ready.')), 10_000);

function sendBridge(payload) {
  window.postMessage({ type: 'openclaw:capability-bridge-send', protocolVersion: 1, payload }, '*');
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'openclaw:capability-bridge-receive' || event.data.protocolVersion !== 1) return;
  const message = event.data.payload;
  if (message?.type === 'openclaw:capability-bridge-ready') {
    clearTimeout(bridgeTimer);
    const methods = new Set(Array.isArray(message.methods) ? message.methods : []);
    const required = ['command-center.v1.search.query', 'command-center.v1.notes.read', 'command-center.v1.sessions.navigate', 'ui.session.navigate'];
    if (!required.every((method) => methods.has(method)) || message.upgradeRequired === true) {
      rejectBridgeReady(new Error('Command Center requires unavailable host capabilities.'));
      return;
    }
    resolveBridgeReady();
    return;
  }
  if (message?.type !== 'openclaw:capability-bridge-response') return;
  const pending = pendingBridgeRequests.get(message.requestId);
  if (!pending) return;
  pendingBridgeRequests.delete(message.requestId);
  if (message.error) {
    const error = new Error(message.error.message || 'Capability bridge request failed.');
    error.code = message.error.code;
    pending.reject(error);
  }
  else pending.resolve(message.result);
});

async function bridgeRequest(method, params) {
  await bridgeReady;
  const requestId = crypto.randomUUID();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBridgeRequests.delete(requestId);
      reject(new Error('Capability bridge request exceeded 30 seconds.'));
    }, 30_000);
    pendingBridgeRequests.set(requestId, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); }
    });
    sendBridge({ type: 'openclaw:capability-bridge-request', requestId, method, params });
  });
}

function setStatus(value, searchState) {
  status.textContent = value;
  if (searchState) status.dataset.searchState = searchState;
}

function renderSnippet(target, text, highlights) {
  text = typeof text === 'string' ? text : '';
  const spans = Array.isArray(highlights) ? highlights : [];
  let offset = 0;
  for (const span of spans) {
    if (!Number.isInteger(span?.start) || !Number.isInteger(span?.end) || span.start < offset || span.end <= span.start || span.end > text.length) continue;
    target.append(document.createTextNode(text.slice(offset, span.start)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(span.start, span.end);
    target.append(mark);
    offset = span.end;
  }
  target.append(document.createTextNode(text.slice(offset)));
}

function renderGroup(id, results, kind) {
  const target = document.querySelector(`#${id}`);
  target.replaceChildren();
  results = Array.isArray(results) ? results : [];
  if (results.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = `No ${kind} matched this search.`;
    target.append(empty);
    return;
  }
  for (const result of results) {
    const article = document.createElement('article');
    article.className = 'result-card';
    const heading = document.createElement('h3');
    heading.textContent = result.heading || result.conversationName || result.path || 'Untitled result';
    const identity = document.createElement('p');
    identity.className = 'identity';
    identity.textContent = kind === 'Notes' ? result.path : result.date;
    const provenance = document.createElement('p');
    provenance.className = 'provenance';
    provenance.textContent = result.provenance
      ? `${result.provenance.importedPrimaryHistory ? 'Imported history' : 'Native history'}${result.provenance.status === 'closed' ? ' · Closed Conversation' : ''}${result.provenance.role === 'primary' ? ' · Primary' : ''}`
      : 'Authoritative Note';
    const snippet = document.createElement('p');
    renderSnippet(snippet, result.snippet, result.highlights);
    const context = document.createElement('p');
    context.className = 'context';
    context.textContent = [result.contextBefore, result.contextAfter].filter(Boolean).join(' · ');
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = kind === 'Notes' ? 'Open Note' : 'Open Conversation';
    open.addEventListener('click', () => openResult(result));
    article.append(heading, identity, provenance, snippet, context, open);
    target.append(article);
  }
}

async function openResult(result) {
  detail.textContent = 'Reading the authoritative record…';
  try {
    if (result.navigation?.kind === 'conversation') {
      const resolved = await bridgeRequest('command-center.v1.sessions.navigate', {
        schemaVersion: 1,
        topicId: result.navigation.topicId,
        referenceId: result.navigation.referenceId
      });
      const target = resolved?.result;
      if (target?.sessionKey !== result.navigation.sessionKey || target?.sessionId !== result.navigation.sessionId || target?.sourceReference?.referenceId !== result.navigation.referenceId) {
        throw new Error('The authoritative Conversation changed after this search result was created.');
      }
      await bridgeRequest('ui.session.navigate', { sessionKey: target.sessionKey });
      return;
    }
    if (result.navigation?.kind !== 'note') throw new Error('Unsupported authoritative navigation target.');
    const response = await bridgeRequest('command-center.v1.notes.read', {
      schemaVersion: 1,
      topicId: result.navigation.topicId,
      referenceId: result.navigation.referenceId,
      path: result.navigation.path,
      observedRevision: result.navigation.observedRevision
    });
    const value = response?.result;
    if (value?.path !== result.navigation.path || value?.revision !== result.navigation.observedRevision) {
      throw new Error('The authoritative Note changed after this search result was created.');
    }
    if (typeof value.text !== 'string') throw new Error('The authoritative Note is unavailable.');
    detail.textContent = value.text;
  } catch (error) {
    detail.textContent = error.message || 'Authoritative navigation was refused.';
  }
}

async function search(query) {
  const topicId = topicIdInput.value.trim();
  if (!topicId) throw new Error('Choose an exact Topic ID before searching.');
  setStatus('Searching…', 'searching');
  const request = { schemaVersion: 1, topicId, query, limit: 50 };
  const response = await bridgeRequest('command-center.v1.search.query', request);
  const value = response?.result;
  if (!value?.notes?.results || !value?.conversations?.results) throw new Error('Topic Search is unavailable.');
  renderGroup('notes-results', value.notes.results, 'Notes');
  renderGroup('conversations-results', value.conversations.results, 'Conversations');
  setStatus(`${value.notes.results.length} Note results · ${value.conversations.results.length} Conversation results`, 'complete');
  return value;
}

let lastSearchPromise = null;
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  lastSearchPromise = search(queryInput.value.trim());
  try { await lastSearchPromise; } catch (error) { setStatus(error.message, 'error'); }
});

for (const [id, kind] of [['notes-results', 'Notes'], ['conversations-results', 'Conversations']]) renderGroup(id, [], kind);
window.CommandCenterSearch = Object.freeze({
  search,
  renderGroup,
  renderSnippet,
  openResult,
  get ready() { return bridgeReady; },
  get settled() { return lastSearchPromise; }
});
sendBridge({ type: 'openclaw:capability-bridge-hello', protocolVersion: 1 });
