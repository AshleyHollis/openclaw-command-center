const HTTP_ROUTE = '/plugins/command-center/api/topics/actions';
const SHELL_ROUTE = '/plugins/command-center';
const topicCreateForm = document.querySelector('#topic-create');
const topicCreateSubmit = document.querySelector('#topic-create-submit');
const topicNameInput = topicCreateForm?.elements.name;
const statusNode = document.querySelector('#topic-status');
const hasTopicsDestination = Boolean(topicCreateForm && statusNode);
let currentDestination = { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [] };
let topicCreatePending = false;

function operationId() { return crypto.randomUUID(); }
function unwrap(value) { while (value?.result !== undefined || value?.value !== undefined) value = value.result ?? value.value; return value; }
const pendingBridgeRequests = new Map();
let resolveBridgeReady;
let rejectBridgeReady;
const bridgeReady = new Promise((resolve, reject) => { resolveBridgeReady = resolve; rejectBridgeReady = reject; });
const bridgeTimer = setTimeout(() => rejectBridgeReady(new Error('Command Center capability bridge did not become ready.')), 10_000);
function sendBridge(payload) { window.postMessage({ type: 'openclaw:capability-bridge-send', protocolVersion: 1, payload }, '*'); }
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'openclaw:capability-bridge-receive' || event.data.protocolVersion !== 1) return;
  const message = event.data.payload;
  if (message?.type === 'openclaw:capability-bridge-ready') {
    clearTimeout(bridgeTimer);
    const methods = new Set(Array.isArray(message.methods) ? message.methods : []);
    const required = [...(hasTopicsDestination ? ['command-center.v1.topics.list'] : []), 'command-center.v1.search.query', 'command-center.v1.notes.read', 'command-center.v1.sessions.navigate', 'ui.session.navigate'];
    if (message.upgradeRequired === true || !required.every((method) => methods.has(method))) rejectBridgeReady(new Error('Command Center requires unavailable host capabilities.'));
    else resolveBridgeReady();
    return;
  }
  if (message?.type !== 'openclaw:capability-bridge-response') return;
  const pending = pendingBridgeRequests.get(message.requestId);
  if (!pending) return;
  pendingBridgeRequests.delete(message.requestId);
  if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Capability bridge request failed.'), { code: message.error.code }));
  else pending.resolve(message.result);
});
async function bridgeRequest(method, params) {
  await bridgeReady;
  const requestId = operationId();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingBridgeRequests.delete(requestId); reject(new Error('Capability bridge request exceeded 30 seconds.')); }, 30_000);
    pendingBridgeRequests.set(requestId, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    sendBridge({ type: 'openclaw:capability-bridge-request', requestId, method, params });
  });
}
async function read(view = 'destination') {
  if (view === 'destination') return unwrap(await bridgeRequest('command-center.v1.topics.list', { schemaVersion: 1 }));
  throw new Error('Unsupported read view.');
}
async function mutate(action, input) {
  const response = await fetch(HTTP_ROUTE, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action, logicalOperationId: input.logicalOperationId ?? operationId(), ...input }) });
  const value = await response.json();
  if (!response.ok || value.status === 'error') throw Object.assign(new Error(value.message || 'Topic action failed.'), { destination: value.result?.destination });
  return value;
}
function validateTopicNameInput() {
  const normalized = topicNameInput.value.trim().normalize('NFC');
  const valid = normalized && new TextEncoder().encode(normalized).length <= 255 && !/[\\/\u0000-\u001f\u007f]/u.test(normalized) && normalized !== '.' && normalized !== '..';
  topicNameInput.setCustomValidity(valid ? '' : 'Use one safe Topic name of at most 255 UTF-8 bytes.');
  return valid;
}
function button(label, action) { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', action); return node; }
function diagnostic(topic) {
  const node = document.createElement('p'); node.className = 'recovery-diagnostic';
  const recovery = topic.recovery?.find((item) => item.state === 'required');
  if (!recovery) { node.textContent = ''; return node; }
  const detail = recovery.diagnostics?.[0] ?? {};
  const session = recovery.sourceKind === 'session';
  const kind = session ? 'Session' : 'Note Folder';
  const blocked = session ? 'messages, new conversations, and Session changes' : 'Note writes, folder moves, and automatic Note maintenance';
  const actions = session ? 'verify exact source, relink Session, or replace Primary Session' : 'verify exact source or relink Note Folder';
  node.textContent = `${kind} ${recovery.referenceId}: ${detail.expectedIdentity ?? `exact ${kind} identity`}; ${detail.check ?? 'exact-identity'} (${detail.status ?? 'recovery-required'}). Blocked: ${blocked}. Actions: ${detail.retryable === false ? 'contact an operator' : actions}.`;
  return node;
}
async function runAction(action, input, message) {
  try { const result = await mutate(action, input); currentDestination = result.result?.value?.destination ?? result.result?.destination ?? currentDestination; renderDestination(currentDestination); statusNode.textContent = message; }
  catch (error) { if (error.destination) currentDestination = error.destination; renderDestination(currentDestination); statusNode.textContent = `Topic action failed: ${error.message}`; await loadTopics(error.message); }
}
function topicRow(topic, kind) {
  const row = document.createElement('div'); row.className = 'topic-row'; const name = document.createElement('strong'); name.textContent = topic.name; row.append(name);
  if (kind === 'provisioning') {
    row.append(button('Retry', () => runAction('provisioning.retry', { topicId: topic.topicId, expectedRevision: topic.revision, logicalOperationId: topic.provisioningOperationId }, 'Provisioning record retried.')));
    row.append(button('Roll back', () => runAction('provisioning.rollback', { topicId: topic.topicId, expectedRevision: topic.revision, logicalOperationId: topic.provisioningOperationId }, 'Provisioning record rolled back.')));
  } else if (kind === 'archived') {
    row.append(button('Restore to project', () => runAction('restore', { topicId: topic.topicId, paraCategory: 'project', expectedRevision: topic.revision }, 'Topic restored.')));
    row.append(button('Search archive', () => { document.querySelector('#topic-search-topic-id').value = topic.topicId; document.querySelector('#topic-search-query').focus(); }));
  } else if (kind === 'recovery') {
    const recovery = topic.recovery.find((item) => item.state === 'required'); row.append(diagnostic(topic));
    row.append(button('Verify exact source', () => runAction('recovery.verify', { topicId: topic.topicId, referenceId: recovery.referenceId, expectedRevision: topic.revision, expectedSourceRevision: recovery.expectedRevision }, 'Source verified.')));
    if (recovery.sourceKind === 'session') {
      const exactSession = () => ({ sessionKey: prompt('Session key'), sessionId: prompt('Session ID') });
      row.append(button('Relink Session', () => runAction('recovery.relink', { topicId: topic.topicId, referenceId: recovery.referenceId, ...exactSession(), expectedRevision: topic.revision, expectedSourceRevision: recovery.expectedRevision }, 'Session relinked.')));
      row.append(button('Replace Primary Session', () => runAction('recovery.replace-session', { topicId: topic.topicId, referenceId: recovery.referenceId, ...exactSession(), expectedRevision: topic.revision, expectedSourceRevision: recovery.expectedRevision }, 'Primary Session replaced.')));
    } else {
      row.append(button('Relink Note Folder', () => runAction('recovery.verify', { topicId: topic.topicId, referenceId: recovery.referenceId, replacementLocator: prompt('Exact Note Folder path'), expectedRevision: topic.revision, expectedSourceRevision: recovery.expectedRevision }, 'Note Folder relinked.')));
    }
  } else {
    row.append(button('Rename', () => runAction('rename', { topicId: topic.topicId, name: prompt('New Topic name', topic.name), expectedRevision: topic.revision }, 'Topic renamed.')));
    const target = topic.paraCategory === 'project' ? 'area' : 'project'; row.append(button(`Move to ${target}`, async () => { const preview = await mutate('recategorize.preview', { topicId: topic.topicId, paraCategory: target, expectedRevision: topic.revision }); if (confirm(`Category: ${topic.paraCategory} → ${target}\n${preview.result.preview.changes?.length ? 'Move managed Note Folder' : 'Note Folder location: unchanged (customized)'}`)) await runAction('recategorize.apply', { topicId: topic.topicId, paraCategory: target, expectedRevision: topic.revision, structuralChangeId: preview.result.preview.structuralChangeId, previewDigest: preview.result.preview.digest, expectedRevisions: preview.result.preview.expectedRevisions }, 'Topic moved.'); }));
    row.append(button('Archive', async () => { const preview = await mutate('archive.preview', { topicId: topic.topicId, expectedRevision: topic.revision }); if (confirm(`Disable and retain every active Reminder and scheduled operation (${preview.result.preview.commitments?.filter((item) => item.enabled).length ?? 0} active of ${preview.result.preview.commitments?.length ?? 0} commitment(s))`)) await runAction('archive.apply', { topicId: topic.topicId, expectedRevision: topic.revision, structuralChangeId: preview.result.preview.structuralChangeId, previewDigest: preview.result.preview.digest, expectedRevisions: preview.result.preview.expectedRevisions }, 'Topic archived.'); }));
  }
  return row;
}
function renderList(id, topics, kind) { const target = document.querySelector(`#${id}`); target.replaceChildren(...(topics ?? []).map((topic) => topicRow(topic, kind))); if (!target.childElementCount) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'None'; target.append(empty); } }
function renderDestination(value) {
  currentDestination = value; const groups = value.activeGroups ?? value.groups; for (const category of ['project', 'area', 'resource']) renderList(`topics-${category}`, groups?.[category], 'active');
  renderList('topics-provisioning', value.provisioning, 'provisioning'); renderList('topics-recovery', value.recovery, 'recovery'); renderList('topics-archived', value.archived, 'archived');
  const select = document.querySelector('#topic-search-topic-id'); const selected = select.value; select.replaceChildren(...[...(groups?.project ?? []), ...(groups?.area ?? []), ...(groups?.resource ?? []), ...(value.archived ?? [])].map((topic) => { const option = document.createElement('option'); option.value = topic.topicId; option.textContent = topic.name; return option; })); if ([...select.options].some((item) => item.value === selected)) select.value = selected;
}
async function loadTopics(message = '') { try { renderDestination(await read('destination')); statusNode.textContent = message || 'Topics are current.'; } catch (error) { statusNode.textContent = error.message; } }
async function createTopic(event) { event.preventDefault(); if (topicCreatePending) return; validateTopicNameInput(); if (!topicCreateForm.reportValidity()) return; topicCreatePending = true; topicCreateSubmit.disabled = true; statusNode.textContent = 'Creating Topic…'; try { await runAction('create', { name: topicNameInput.value.trim().normalize('NFC'), paraCategory: topicCreateForm.elements.paraCategory.value }, 'Topic created and verified.'); topicCreateForm.reset(); } finally { topicCreatePending = false; topicCreateSubmit.disabled = false; } }
topicNameInput?.addEventListener('input', validateTopicNameInput); topicCreateForm?.addEventListener('submit', createTopic);

function renderSearch(id, results) { const target = document.querySelector(`#${id}`); target.replaceChildren(...(results ?? []).map((result) => { const row = document.createElement('article'); const heading = document.createElement('strong'); heading.textContent = result.heading || result.conversationName || result.path || 'Result'; const snippet = document.createElement('p'); snippet.textContent = result.snippet || ''; const open = button(result.navigation?.kind === 'conversation' ? 'Open Conversation' : 'Open Note', () => openResult(result)); row.append(heading, snippet, open); return row; })); }
async function openResult(result) {
  const detail = document.querySelector('#topic-search-detail');
  try {
    if (result.navigation?.kind === 'conversation') {
      const target = unwrap(await bridgeRequest('command-center.v1.sessions.navigate', { schemaVersion: 1, topicId: result.navigation.topicId, referenceId: result.navigation.referenceId }));
      if (target?.sessionKey !== result.navigation.sessionKey || target?.sessionId !== result.navigation.sessionId) throw new Error('The authoritative Conversation changed after this search result was created.');
      await bridgeRequest('ui.session.navigate', { sessionKey: target.sessionKey });
      return;
    }
    if (result.navigation?.kind !== 'note') throw new Error('Unsupported authoritative navigation target.');
    const value = unwrap(await bridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: result.navigation.topicId, referenceId: result.navigation.referenceId, path: result.navigation.path, observedRevision: result.navigation.observedRevision }));
    if (value?.path !== result.navigation.path || value?.revision !== result.navigation.observedRevision || typeof value.text !== 'string') throw new Error('The authoritative Note changed after this search result was created.');
    detail.textContent = value.text;
  } catch (error) { detail.textContent = error.message || 'Authoritative navigation was refused.'; }
}
document.querySelector('#topic-search-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const value = unwrap(await bridgeRequest('command-center.v1.search.query', { schemaVersion: 1, topicId: document.querySelector('#topic-search-topic-id').value, query: document.querySelector('#topic-search-query').value.trim(), limit: 50 })); renderSearch('notes-results', value.notes?.results); renderSearch('conversations-results', value.conversations?.results); document.querySelector('#topic-search-status').textContent = `${value.notes?.results?.length ?? 0} Notes · ${value.conversations?.results?.length ?? 0} Conversations`; });

window.CommandCenterTopics = Object.freeze({ loadTopics, renderDestination, mutate, read, openResult, routes: { HTTP_ROUTE, SHELL_ROUTE }, view: 'destination', searchView: 'search', get ready() { return bridgeReady; } });
window.CommandCenterSearch = Object.freeze({
  async search(query) {
    const topicId = document.querySelector('#topic-search-topic-id').value.trim();
    const value = unwrap(await bridgeRequest('command-center.v1.search.query', { schemaVersion: 1, topicId, query, limit: 50 }));
    renderSearch('notes-results', value.notes?.results);
    renderSearch('conversations-results', value.conversations?.results);
    return value;
  },
  openResult,
  get ready() { return bridgeReady; }
});
sendBridge({ type: 'openclaw:capability-bridge-hello', protocolVersion: 1 });
if (hasTopicsDestination) loadTopics();
