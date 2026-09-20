import { createNativeTopicNavigation } from './topic-navigation.mjs';

/** Display preferences outlive a Session-scoped mount, never its plugin activation.
 * No catalogs, source authority, DOM nodes or scoped host callbacks are retained. */
export function createTopicSidebarState(signal) {
  const state = { expandedTopics: new Set(), collapsedCategories: new Set(['project', 'area', 'resource', 'archive']), lastConversations: new Map(), inboxOpen: false, nativeOpen: false, scrollTop: null, focusKey: null, active: !signal?.aborted,
    retire() { state.active = false; state.expandedTopics.clear(); state.collapsedCategories.clear(); state.lastConversations.clear(); state.inboxOpen = false; state.nativeOpen = false; state.scrollTop = null; state.focusKey = null; signal?.removeEventListener('abort', state.retire); } };
  signal?.addEventListener('abort', state.retire, { once: true });
  return state;
}

/** PARA is presentation only; exact Topic references remain the authority. */
export function mountTopicSidebar(container, context, viewState = createTopicSidebarState()) {
  const { host } = context;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  const document = container.ownerDocument;
  let activeContext = context;
  let presented = context.presented;
  let generation = 0;
  let defaultView;
  let destination;
  let topicRows = [];
  let assignments = new Map();
  let assignmentFailures = 0;
  let renderedSnapshot = '';
  const { expandedTopics, collapsedCategories, lastConversations } = viewState;
  let hasRendered = false;
  let restoringScroll = false;
  const paraId = `topic-para-${crypto.randomUUID()}`;
  const assignmentOperations = new Map();
  const navigation = createNativeTopicNavigation({ signal, get connection() { return host.connection; }, request: (method, params) => host.request(method, params), sessions: host.sessions });
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh Topic workspace';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const projection = document.createElement('nav'); projection.setAttribute('aria-label', 'Topics and Conversations');
  const native = document.createElement('details'); native.setAttribute('aria-label', 'All native conversations');
  native.open = viewState.nativeOpen;
  const nativeSummary = document.createElement('summary'); nativeSummary.textContent = 'All conversations'; native.append(nativeSummary);
  // Keep host-native conversation rendering in its own mount. The optional
  // pagination control must not become part of, or be removed by, that view.
  const nativeMount = document.createElement('div'); native.append(nativeMount);
  const shell = document.createElement('div'); shell.className = 'topic-sidebar';
  const header = document.createElement('div'); header.className = 'topic-sidebar-header';
  const title = document.createElement('span'); title.textContent = 'Topics';
  refresh.textContent = '↻'; refresh.setAttribute('aria-label', 'Refresh Topic workspace'); refresh.title = 'Refresh Topics';
  header.append(title, refresh);
  const styles = document.createElement('style');
  styles.textContent = `
    .topic-sidebar { font:inherit; font-size:13px; color:var(--text,inherit); padding:4px 8px; }
    .topic-sidebar [hidden] { display:none !important; }
    .topic-sidebar-header { display:flex; align-items:center; justify-content:space-between; padding:4px 8px; color:var(--muted,inherit); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
    .topic-sidebar button, .topic-sidebar summary { font:inherit; color:inherit; cursor:pointer; border:0; background:transparent; border-radius:var(--radius-md,6px); box-sizing:border-box; min-height:30px; padding:6px 8px; text-align:start; }
    .topic-sidebar button:hover, .topic-sidebar summary:hover { background:var(--bg-hover,color-mix(in srgb,currentColor 8%,transparent)); }
    .topic-sidebar :is(button,summary,select):focus-visible { outline:2px solid var(--accent,currentColor); outline-offset:-2px; }
    .topic-sidebar button[aria-current] { background:var(--bg-accent,color-mix(in srgb,currentColor 12%,transparent)); font-weight:600; }
    .topic-sidebar nav > section { margin:4px 0; }
    .topic-sidebar h2 { margin:0; font:inherit; font-size:11px; font-weight:600; color:var(--muted,inherit); }
    .topic-sidebar h2 > button { width:100%; display:flex; gap:6px; align-items:center; text-transform:uppercase; letter-spacing:.04em; }
    .topic-sidebar h2 > button::before { content:''; inline-size:5px; block-size:5px; border-inline-end:1px solid; border-block-end:1px solid; transform:rotate(-45deg); transition:transform .1s; }
    .topic-sidebar h2 > button[aria-expanded=true]::before { transform:rotate(45deg); }
    .topic-sidebar ul { list-style:none; margin:0; padding:0; }
    .topic-sidebar .topic-para-body { padding-inline-start:14px; }
    .topic-sidebar .topic-entry { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; }
    .topic-sidebar .topic-entry-children { grid-column:1 / -1; padding-inline-start:15px; border-inline-start:1px solid var(--border,color-mix(in srgb,currentColor 12%,transparent)); margin-inline-start:42px; }
    .topic-sidebar .topic-name { min-width:0; text-align:start; }
    .topic-sidebar .topic-toggle { inline-size:30px; padding-inline:8px; }
    .topic-sidebar .topic-toggle::before { content:''; display:inline-block; inline-size:5px; block-size:5px; border-inline-end:1px solid; border-block-end:1px solid; transform:rotate(-45deg); }
    .topic-sidebar .topic-entry[data-expanded=true] > .topic-toggle::before { transform:rotate(45deg); }
    .topic-sidebar li button { display:block; width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .topic-sidebar summary { list-style:none; display:flex; align-items:center; gap:6px; }
    .topic-sidebar summary::-webkit-details-marker { display:none; }
    .topic-sidebar summary::before { content:''; flex:none; inline-size:5px; block-size:5px; border-inline-end:1px solid; border-block-end:1px solid; transform:rotate(-45deg); }
    .topic-sidebar details[open] > summary::before { transform:rotate(45deg); }
    .topic-sidebar p { font-size:12px; line-height:1.4; margin:4px 8px; color:var(--muted,inherit); }
    .topic-sidebar p:empty { display:none; }
    .topic-sidebar .topic-empty { font-size:12px; margin:4px 8px 8px; color:var(--muted,inherit); }
    .topic-sidebar .topic-history-label { margin:6px 8px 2px 27px; font-size:11px; }
    .topic-sidebar .topic-tools { display:flex; gap:2px; padding-inline-start:22px; }
    .topic-sidebar .topic-tools button { width:auto; font-size:12px; color:var(--muted,inherit); }
    .topic-sidebar .topic-general { display:block; width:100%; }
    .topic-sidebar > details { margin-top:8px; border-top:1px solid var(--border,color-mix(in srgb,currentColor 12%,transparent)); }
    .topic-sidebar select { max-width:100%; font:inherit; background:var(--bg,transparent); color:inherit; border:1px solid var(--border,currentColor); border-radius:6px; padding:5px; }
    @media (prefers-reduced-motion:reduce) { .topic-sidebar h2 > button::before { transition:none; } }
  `;
  shell.append(header, status, projection, native); container.replaceChildren(styles, shell);

  // The host owns the scroll region. Locate it by scrolling behavior, not a
  // private host selector; a replacement can also be mounted through a shadow root.
  const parentElement = node => node.parentElement ?? node.getRootNode().host;
  let scrollRegion = container instanceof HTMLElement ? container : container.host;
  while (scrollRegion && scrollRegion !== document.body && !/^(auto|scroll)$/u.test(getComputedStyle(scrollRegion).overflowY)) scrollRegion = parentElement(scrollRegion);
  if (scrollRegion === document.body) scrollRegion = null;
  const activeElement = () => { let node = document.activeElement; while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement; return node; };
  function rememberView() {
    if (!viewState.active || !hasRendered) return;
    for (const entry of projection.querySelectorAll('[data-topic-id]')) {
      if (entry.dataset.expanded === 'true') expandedTopics.add(entry.dataset.topicId); else expandedTopics.delete(entry.dataset.topicId);
    }
    viewState.nativeOpen = native.open;
    if (scrollRegion && !restoringScroll) viewState.scrollTop = scrollRegion.scrollTop;
    const focused = activeElement();
    viewState.focusKey = projection.contains(focused) ? focused?.getAttribute('data-topic-control-key') : null;
  }
  signal.addEventListener('abort', rememberView, { once: true });
  scrollRegion?.addEventListener('scroll', () => {
    if (hasRendered && !restoringScroll && viewState.active) viewState.scrollTop = scrollRegion.scrollTop;
  }, { signal });
  native.addEventListener('toggle', () => { if (!signal.aborted && viewState.active) viewState.nativeOpen = native.open; }, { signal });

  const current = generationId => !signal.aborted && presented && host.connection.connected && host.connection.canRead && generationId === generation;
  const button = (label, action) => { const value = document.createElement('button'); value.type = 'button'; value.textContent = label; value.addEventListener('click', action, { signal }); return value; };
  const unwrap = value => value?.result ?? value;
  const selectedSessionId = () => activeContext.props.sessions?.find(row => row.key === activeContext.props.sessionKey)?.sessionId;
  const allTopics = () => Object.values(destination?.activeGroups ?? {}).flat().filter(topic => topic?.usable === true && topic?.lifecycle === 'active');
  const visibleTopics = () => [...allTopics(), ...(destination?.recovery ?? []).filter(topic => topic?.lifecycle === 'active'), ...(destination?.archived ?? []).filter(topic => topic?.usable === true && topic?.lifecycle === 'archived')]
    .filter((topic, index, rows) => rows.findIndex(candidate => candidate.topicId === topic.topicId) === index);
  const eligibleSessions = () => (activeContext.props.sessions ?? []).filter(row => {
    const main = activeContext.props.mainSessionKey;
    return row && typeof row.key === 'string' && row.key !== main && row.archived !== true && row.createdVia !== 'cron' && row.createdVia !== 'run' && typeof row.sessionId === 'string' && row.updatedAt != null && (row.status === undefined || row.status === null || row.status === 'open');
  });
  const unavailableHistoryCatalog = error => /authoritative source capability is unavailable/i.test(String(error?.message ?? error));
  // Host props are structured-cloned between renders. Compare the values this
  // sidebar actually owns instead of object identity, so a no-op host update
  // cannot replace the focused native Conversation control.
  const contextRevision = value => JSON.stringify({
    presented: value.presented === true,
    sessionKey: value.props.sessionKey ?? null,
    mainSessionKey: value.props.mainSessionKey ?? null,
    nativeSessionsHaveMore: value.props.nativeSessionsHaveMore === true,
    canLoadMore: typeof value.props.loadMoreNativeSessions === 'function',
    sessions: (value.props.sessions ?? []).map(row => row && ({ key: row.key ?? null, sessionId: row.sessionId ?? null,
      updatedAt: row.updatedAt ?? null, status: row.status ?? null, archived: row.archived === true, createdVia: row.createdVia ?? null,
      displayName: row.displayName ?? null, title: row.title ?? null }))
  });

  async function browseTopic(topic, generationId) {
    const [conversationResponse, historyResponse] = await Promise.all([
      host.request('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: topic.topicId, includeClosed: false }),
      host.request('command-center.v1.histories.list', { schemaVersion: 1, topicId: topic.topicId }).catch(error => {
        // Histories are optional for an active Topic. Their unavailable source
        // must not hide its exact Primary and linked native Conversations, but
        // it must stay visible as unavailable rather than being misrepresented
        // as a Topic with no preserved history.
        if (unavailableHistoryCatalog(error)) return { result: { histories: [] }, unavailable: true };
        throw error;
      })
    ]);
    if (!current(generationId)) return null;
    const conversations = unwrap(conversationResponse);
    const histories = unwrap(historyResponse);
    if (conversations?.topicId !== topic.topicId || !Array.isArray(conversations?.conversations) || !Array.isArray(histories?.histories)) throw new Error(`The exact Conversation catalog for ${topic.name} is unavailable.`);
    const active = conversations.conversations.filter(row => row?.status === 'open' && typeof row.referenceId === 'string' && typeof row.sessionId === 'string');
    const primary = active.filter(row => row.isPrimary === true);
    if (primary.length !== 1) throw new Error(`The exact Primary Conversation for ${topic.name} is unavailable.`);
    const seen = new Set();
    for (const row of active) { const identity = `${row.referenceId}\u0000${row.sessionId}`; if (seen.has(identity)) throw new Error(`The exact Conversation catalog for ${topic.name} is unavailable.`); seen.add(identity); }
    return {
      topic,
      conversations: [...primary, ...active.filter(row => row.isPrimary !== true).sort((left, right) => String(left.displayName ?? '').localeCompare(String(right.displayName ?? '')) || left.referenceId.localeCompare(right.referenceId))],
      histories: histories.histories.filter(row => row?.topicId === topic.topicId && row?.readOnly === true && typeof row.historyId === 'string' && typeof row.title === 'string').sort((left, right) => left.title.localeCompare(right.title) || left.historyId.localeCompare(right.historyId)),
      historyUnavailable: historyResponse?.unavailable === true
    };
  }

  function renderAssignment(generationId) {
    const box = document.createElement('section'); const heading = document.createElement('h2');
    // Inbox is an admission result, not a list of candidates. A bound or
    // unknown Conversation stays out until its authoritative membership is known.
    const rows = eligibleSessions().filter(row => assignments.get(row.key)?.status === 'unbound');
    const body = document.createElement('div'); body.id = `${paraId}-inbox`; body.hidden = !viewState.inboxOpen;
    const disclosure = button(`Inbox / Unassigned (${rows.length})`, () => {
      viewState.inboxOpen = !viewState.inboxOpen;
      body.hidden = !viewState.inboxOpen; disclosure.setAttribute('aria-expanded', String(viewState.inboxOpen));
    });
    disclosure.setAttribute('aria-expanded', String(viewState.inboxOpen)); disclosure.setAttribute('aria-controls', body.id);
    disclosure.setAttribute('data-topic-control-key', 'inbox'); heading.append(disclosure); box.append(heading, body);
    if (!rows.length) { const empty = document.createElement('p'); empty.textContent = 'No unassigned conversations'; body.append(empty); return box; }
    const list = document.createElement('ul');
    for (const row of rows) {
      const item = document.createElement('li'); const name = row.displayName || row.title || row.key;
      const label = document.createElement('strong'); label.textContent = name; item.append(label, document.createElement('br'));
      item.append(button('Open Chat', () => host.sessions.openChat({ sessionKey: row.key })));
      const message = document.createElement('p'); message.textContent = 'No Topic assigned.';
      const targetLabel = document.createElement('label'); targetLabel.textContent = `Assign ${name} to Topic`;
      const select = document.createElement('select');
      for (const topic of allTopics()) { const option = document.createElement('option'); option.value = topic.topicId; option.textContent = topic.name; select.append(option); }
      targetLabel.append(select);
      const assign = button('Assign to Topic', () => void (async () => {
        const target = allTopics().find(topic => topic.topicId === select.value);
        if (!target || !current(generationId)) return;
        assign.disabled = true; status.textContent = 'Assigning exact Conversation…';
        const operationKey = `${target.topicId}\u0000${row.key}\u0000${row.sessionId}\u0000${row.updatedAt}`;
        const logicalOperationId = assignmentOperations.get(operationKey) ?? crypto.randomUUID();
        assignmentOperations.set(operationKey, logicalOperationId);
        try {
          const result = unwrap(await host.request('command-center.v1.sessions.assign-topic', { schemaVersion: 1, logicalOperationId, topicId: target.topicId, expectedTopicRevision: target.revision, sessionKey: row.key, expectedSessionId: row.sessionId, expectedSessionRevision: String(row.updatedAt), expectedMembership: 'unassigned' }));
          if (!current(generationId)) return;
          if (!['applied', 'replayed'].includes(result?.status ?? '') || result?.logicalOperationId !== logicalOperationId || result?.referenceId !== `conversation-assignment:${logicalOperationId}` || result?.topicId !== target.topicId || result?.sessionKey !== row.key || result?.sessionId !== row.sessionId) throw new Error('The exact Topic assignment did not return an authoritative receipt.');
          assignmentOperations.delete(operationKey);
          status.textContent = `Assigned to ${target.name}.`; await load();
        } catch (error) { if (current(generationId)) { status.textContent = host.redact(error?.message || 'Topic assignment was not applied.'); assign.disabled = false; } }
      })());
      assign.disabled = allTopics().length === 0;
      item.append(message, targetLabel, assign); list.append(item);
    }
    body.append(list); return box;
  }

  const publishNavigationError = error => { if (!signal.aborted && error?.name !== 'AbortError') status.textContent = host.redact(error.message); };
  async function openConversation(entry, conversation) {
    const opened = await navigation.open({ topicId: entry.topic.topicId, referenceId: conversation.referenceId, expectedSessionId: conversation.sessionId });
    lastConversations.set(entry.topic.topicId, opened);
  }
  async function openTopic(entry) {
    const currentId = selectedSessionId();
    const current = entry.conversations.find(row => row.sessionId === currentId);
    const opened = await navigation.openPreferred(entry.topic.topicId, current ?? lastConversations.get(entry.topic.topicId) ?? null);
    lastConversations.set(entry.topic.topicId, opened);
  }
  const collapseAllTopics = () => { for (const category of ['project', 'area', 'resource', 'archive']) collapsedCategories.add(category); expandedTopics.clear(); renderedSnapshot = ''; render({ preserveDomExpansion: false }); };
  const expandAllTopics = () => { for (const category of ['project', 'area', 'resource', 'archive']) collapsedCategories.delete(category); for (const entry of topicRows) expandedTopics.add(entry.topic.topicId); renderedSnapshot = ''; render({ preserveDomExpansion: false }); };
  const collapseAll = button('Collapse all Topics', collapseAllTopics); collapseAll.setAttribute('aria-label', 'Collapse all Topics');
  const expandAll = button('Expand all Topics', expandAllTopics); expandAll.setAttribute('aria-label', 'Expand all Topics');
  const headerActions = document.createElement('div'); headerActions.className = 'topic-sidebar-header-actions'; headerActions.append(collapseAll, expandAll, refresh); header.replaceChildren(title, headerActions);

  function render({ preserveDomExpansion = true } = {}) {
    const focusedKey = activeElement()?.getAttribute?.('data-topic-control-key') ?? (!hasRendered ? viewState.focusKey : null);
    const selectedKey = activeContext.props.sessionKey;
    const selectedSessionIdValue = selectedSessionId();
    const snapshot = JSON.stringify({ selectedKey, selectedSessionId: selectedSessionIdValue, expandedTopics: [...expandedTopics].sort(), collapsedCategories: [...collapsedCategories].sort(), main: activeContext.props.mainSessionKey, topics: topicRows.map(entry => ({ id: entry.topic.topicId, revision: entry.topic.revision, name: entry.topic.name, category: entry.topic.paraCategory, lifecycle: entry.topic.lifecycle, health: entry.topic.health ?? null, recoveries: entry.topic.recovery?.filter(row => row.state === 'required').map(row => [row.referenceId, row.sourceKind]), error: entry.error?.message ?? null, historyUnavailable: entry.historyUnavailable, conversations: entry.conversations?.map(row => [row.referenceId, row.sessionId, row.status, row.displayName, row.isPrimary]), histories: entry.histories?.map(row => [row.historyId, row.title]) })), assignments: [...assignments.entries()].map(([key, value]) => [key, value?.status, value?.topicId ?? null]), inbox: eligibleSessions().map(row => [row.key, row.sessionId, row.updatedAt, row.displayName ?? null, row.title ?? null]), more: activeContext.props.nativeSessionsHaveMore === true });
    if (snapshot === renderedSnapshot) return;
    const scrollTop = hasRendered ? scrollRegion?.scrollTop : viewState.scrollTop;
    renderedSnapshot = snapshot;
    const fragment = document.createDocumentFragment();
    if (preserveDomExpansion) for (const entry of projection.querySelectorAll('[data-topic-id]')) {
      if (entry.dataset.expanded === 'true') expandedTopics.add(entry.dataset.topicId); else expandedTopics.delete(entry.dataset.topicId);
    }
    const general = document.createElement('section');
    const main = activeContext.props.mainSessionKey;
    if (typeof main === 'string' && main.trim()) { const control = button('General', () => host.sessions.openChat({ sessionKey: main })); control.className = 'topic-general'; control.setAttribute('aria-label', 'Open General'); if (selectedKey === main) control.setAttribute('aria-current', 'page'); general.append(control); }
    fragment.append(general, renderAssignment(generation));
    for (const [category, label] of [['project', 'Projects'], ['area', 'Areas'], ['resource', 'Resources'], ['archive', 'Archives']]) {
      const section = document.createElement('section'); const heading = document.createElement('h2');
      const body = document.createElement('div'); body.className = 'topic-para-body'; body.id = `${paraId}-${category}`; body.hidden = collapsedCategories.has(category);
      const disclosure = button(label, () => {
        if (collapsedCategories.has(category)) collapsedCategories.delete(category); else collapsedCategories.add(category);
        body.hidden = collapsedCategories.has(category); disclosure.setAttribute('aria-expanded', String(!body.hidden));
      });
      disclosure.setAttribute('aria-label', label); disclosure.setAttribute('aria-expanded', String(!body.hidden)); disclosure.setAttribute('aria-controls', body.id); disclosure.setAttribute('data-topic-control-key', `para:${category}`);
      heading.append(disclosure); section.append(heading, body);
      const entries = topicRows.filter(row => category === 'archive' ? row.topic.paraCategory === 'archive' || row.topic.lifecycle === 'archived' : row.topic.paraCategory === category && row.topic.lifecycle === 'active');
      if (!entries.length) { const empty = document.createElement('p'); empty.className = 'topic-empty'; empty.textContent = `No ${label.toLocaleLowerCase()}`; body.append(empty); fragment.append(section); continue; }
      const list = document.createElement('ul');
      for (const entry of entries) {
        const item = document.createElement('li'); const details = document.createElement('section'); details.className = 'topic-entry'; details.dataset.topicId = entry.topic.topicId; const setOpen = (open) => { details.dataset.expanded = String(open); children.hidden = !open; if (open) expandedTopics.add(entry.topic.topicId); else expandedTopics.delete(entry.topic.topicId); summary.setAttribute('aria-expanded', String(open)); summary.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${entry.topic.name}`); }; const initialOpen = expandedTopics.has(entry.topic.topicId); const summary = button('', () => setOpen(details.dataset.expanded !== 'true')); summary.className = 'topic-toggle'; summary.setAttribute('data-topic-control-key', `toggle:${entry.topic.topicId}`); const required = entry.topic.recovery?.filter(row => row.state === 'required') ?? []; const notesRecovering = required.some(row => row.sourceKind === 'note_folder'); const sessionsRecovering = required.some(row => row.sourceKind === 'session'); const recoveryLabel = notesRecovering && sessionsRecovering ? 'Sources unavailable' : notesRecovering ? 'Notes unavailable' : sessionsRecovering ? 'Conversations unavailable' : entry.topic.health === 'source-recovery' ? 'Source Recovery required' : null; const topicName = button(entry.error ? `${entry.topic.name} · unavailable` : recoveryLabel ? `${entry.topic.name} · ${recoveryLabel}` : entry.topic.name, () => void openTopic(entry).catch(publishNavigationError)); topicName.className = 'topic-name'; topicName.setAttribute('data-topic-control-key', `topic:${entry.topic.topicId}`); const children = document.createElement('div'); children.className = 'topic-entry-children'; details.append(summary, topicName, children); setOpen(initialOpen);
        if (entry.error) { const notice = document.createElement('p'); notice.textContent = host.redact(entry.error.message || `The exact Topic catalog for ${entry.topic.name} is unavailable.`); children.append(notice); item.append(details); list.append(item); continue; }
        if (notesRecovering) { const notice = document.createElement('p'); notice.textContent = 'Notes require Source Recovery. Independently verified Conversations remain available.'; children.append(notice); }
        if (sessionsRecovering) { const notice = document.createElement('p'); notice.textContent = 'One or more Conversations require Source Recovery. Other independently verified Conversations remain available.'; children.append(notice); }
        const conversations = document.createElement('ul');
        for (const conversation of entry.conversations) {
          const label = conversation.isPrimary ? 'Primary Conversation' : (conversation.displayName || 'Linked Conversation');
          const child = document.createElement('li'); const control = button(label, () => void openConversation(entry, conversation).catch(publishNavigationError)); control.setAttribute('data-topic-control-key', `conversation:${entry.topic.topicId}:${conversation.referenceId}`); child.append(control); conversations.append(child);
          if (selectedSessionIdValue === conversation.sessionId) control.setAttribute('aria-current', 'page');
          control.title = label;
        }
        const openFiles = button('Open Topic Files', () => void navigation.openPrimaryFiles(entry.topic.topicId).catch(error => { if (!signal.aborted) status.textContent = host.redact(error.message); })); openFiles.setAttribute('data-topic-control-key', `files:${entry.topic.topicId}`);
        openFiles.textContent = 'Files'; openFiles.setAttribute('aria-label', 'Open Topic Files');
        const create = button('New Conversation', () => host.navigation.openPage({ id: 'topic', params: { topicId: entry.topic.topicId } })); create.setAttribute('aria-label', 'New Topic Conversation');
        const actions = document.createElement('div'); actions.className = 'topic-tools'; actions.append(openFiles, create); children.append(conversations, actions);
        if (entry.histories.length) {
          const historyLabel = document.createElement('p'); historyLabel.className = 'topic-history-label'; historyLabel.textContent = 'Imported History · read-only'; children.append(historyLabel);
          const histories = document.createElement('ul'); histories.setAttribute('aria-label', `${entry.topic.name} imported history`);
          for (const history of entry.histories) { const child = document.createElement('li'); const control = button(history.title, () => host.navigation.openPage({ id: 'histories', params: { topicId: entry.topic.topicId, historyId: history.historyId } })); control.title = history.title; control.setAttribute('aria-label', `${history.title} · Imported History (read-only)`); child.append(control); histories.append(child); }
          children.append(histories);
        }
        if (entry.historyUnavailable) {
          const notice = document.createElement('p');
          notice.textContent = 'Imported History is currently unavailable; existing preserved history remains unchanged.';
          children.append(notice);
        }
        item.append(details); list.append(item);
      }
      body.append(list); fragment.append(section);
    }
    projection.replaceChildren(fragment);
    hasRendered = true;
    const focused = activeElement();
    // Restore the originating control only if the user has not moved focus to
    // another live control (for example, the native Chat composer) while loading.
    if (focusedKey && (!focused || focused === document.body || focused === container || projection.contains(focused))) projection.querySelector(`[data-topic-control-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
    if (scrollRegion && scrollTop != null) {
      restoringScroll = true;
      scrollRegion.scrollTop = scrollTop;
      const renderedGeneration = generation;
      document.defaultView.requestAnimationFrame(() => {
        if (signal.aborted || !viewState.active || renderedGeneration !== generation) { restoringScroll = false; return; }
        scrollRegion.scrollTop = scrollTop; restoringScroll = false; viewState.scrollTop = scrollRegion.scrollTop;
      });
    }
    if (assignmentFailures) status.textContent = `${assignmentFailures} native Conversation membership check${assignmentFailures === 1 ? '' : 's'} is unavailable; only verified unassigned Conversations appear in Inbox.`;
  }

  async function load() {
    const generationId = ++generation; navigation.cancel(); assignments = new Map(); assignmentFailures = 0;
    if (!current(generationId)) { status.textContent = 'Connect with read access to view Topics.'; return; }
    status.textContent = 'Loading Topic workspace…';
    try {
      const listed = unwrap(await host.request('command-center.v1.topics.list', { schemaVersion: 1 }));
      if (!current(generationId) || !listed?.activeGroups) return;
      destination = listed;
      const candidates = eligibleSessions();
      const [rows, memberships] = await Promise.all([
        Promise.all(visibleTopics().map(async topic => { try { return await browseTopic(topic, generationId); } catch (error) { return { topic, conversations: [], histories: [], error }; } })),
        Promise.all(candidates.map(async row => { try { return [row.key, unwrap(await host.request('command-center.v1.sessions.topic-context', { schemaVersion: 1, sessionKey: row.key }))]; } catch { assignmentFailures += 1; return [row.key, { status: 'unavailable' }]; } }))
      ]);
      if (!current(generationId)) return;
      topicRows = rows.filter(Boolean); assignments = new Map(memberships); render();
      status.textContent = assignmentFailures ? String(assignmentFailures) + ' native Conversation membership check' + (assignmentFailures === 1 ? '' : 's') + ' is unavailable; only verified unassigned Conversations appear in Inbox.' : '';
    } catch (error) { if (current(generationId)) status.textContent = host.redact(error?.message || 'Topics are unavailable.'); }
  }
  refresh.addEventListener('click', () => void load(), { signal });
  defaultView = context.mountDefault(nativeMount);
  const loadMore = button('Load more native Conversations', () => void (async () => {
    if (!activeContext.props.nativeSessionsHaveMore || typeof activeContext.props.loadMoreNativeSessions !== 'function') return;
    loadMore.disabled = true; status.textContent = 'Loading more native Conversations…';
    try { await activeContext.props.loadMoreNativeSessions(); if (!signal.aborted) await load(); }
    catch (error) { if (!signal.aborted) { status.textContent = host.redact(error?.message || 'Additional native Conversations are unavailable.'); loadMore.disabled = false; } }
  })());
  native.append(loadMore); loadMore.hidden = !context.props.nativeSessionsHaveMore || typeof context.props.loadMoreNativeSessions !== 'function';
  void load();
  return { update(next) { const changed = contextRevision(activeContext) !== contextRevision(next); activeContext = next; presented = next.presented; loadMore.hidden = !next.props.nativeSessionsHaveMore || typeof next.props.loadMoreNativeSessions !== 'function'; if (changed) void load(); }, focus() { refresh.focus(); }, dispose() { lifetime.abort(); navigation.cancel(); defaultView?.(); container.replaceChildren(); } };
}
