import { createNativeTopicNavigation } from './topic-navigation.mjs';
import { readNativeNote, readNativeDocument } from './note-read.mjs';
import { encodeNoteText, beginNativeNoteOperation, settleNativeNoteOperation, createNativeState, subscribeNativeState } from './mutations.mjs';
import { createNativeCreationForm, createNativeNoteCreationForm } from './creation-form.mjs';
import { FIRST_LIVE_FEATURES } from './release-scope.mjs';
import { readerStyles } from './reader-layout.mjs';

/** Topic policy stays in the backend; OpenClaw owns routing and Chat. */
export function mountTopicPage(container, context, state = createNativeState(), { panel = false, verifyContext } = {}) {
  const host = context.host;
  let activeContext = context;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  let topicId = context.props.topicId;
  let presented = context.presented;
  let generation = 0;
  let catalogGeneration = 0;
  let reading = new AbortController();
  let writing = new AbortController();
  let topic;
  let selected;
  let catalogNotes = [];
  let catalogOffset = 0;
  let catalogTotal = 0;
  let catalogNextOffset = null;
  let catalogCursor;
  let catalogConversations = [];
  let catalogHistories = [];
  let noteText = '';
  let noteView = 'reading';
  let renderGeneration = 0;
  const documentUrls = new Set();
  let preview;
  const drafts = state.drafts;
  const views = state.readerViews ??= new Map();
  let viewState;
  let compact = false;
  let creation;
  let noteCreation;
  let nativeExplorer;
  // The native layout is authoritative after its first activation. A later
  // file selection must never undo an explicit user pane swap.
  let panelPromotionRequested = false;
  const canUseNativeExplorer = panel && typeof host.components?.mountFileExplorer === 'function';
  const navigation = createNativeTopicNavigation({ signal, get connection() { return host.connection; },
    request: (method, params) => host.request(method, params), sessions: host.sessions });
  const document = container.ownerDocument;
  const element = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; if (tag === 'button') node.className = 'btn btn--sm'; return node; };
  const heading = element('h1', 'Topic');
  const status = element('p'); status.setAttribute('role', 'status');
  const announcement = element('p'); announcement.className = 'reader-announcement'; announcement.setAttribute('role', 'status');
  const announce = (text) => { status.textContent = ''; announcement.textContent = text; };
  const back = element('button', 'All Topics'); back.type = 'button';
  const chat = element('button', 'Open Topic in Chat'); chat.type = 'button'; chat.disabled = true;
  const history = element('button', 'View Imported History'); history.type = 'button';
  const refresh = element('button', 'Refresh Notes'); refresh.type = 'button';
  const creationActions = element('section'); creationActions.setAttribute('aria-label', 'Topic Conversation actions');
  const conversationsLabel = element('h2', 'Conversations'); conversationsLabel.id = `native-topic-conversations-${crypto.randomUUID()}`;
  const conversationStatus = element('p'); conversationStatus.setAttribute('role', 'status');
  const conversations = element('ul'); conversations.id = `native-topic-conversations-${crypto.randomUUID()}`; conversations.dataset.topicConversations = ''; conversations.setAttribute('aria-labelledby', conversationsLabel.id);
  conversations.style.listStyle = 'none'; conversations.style.paddingInlineStart = '0';
  const historiesLabel = element('h2', 'Imported History'); historiesLabel.id = `native-topic-histories-${crypto.randomUUID()}`;
  const historyStatus = element('p'); historyStatus.setAttribute('role', 'status');
  const histories = element('ul'); histories.id = `native-topic-histories-list-${crypto.randomUUID()}`; histories.setAttribute('aria-labelledby', historiesLabel.id);
  histories.style.listStyle = 'none'; histories.style.paddingInlineStart = '0';
  const notesLabel = element('h2', 'Notes'); notesLabel.id = `native-topic-notes-${crypto.randomUUID()}`;
  const filterLabel = element('label', 'Filter filenames'); filterLabel.htmlFor = `native-note-filter-${crypto.randomUUID()}`;
  const filter = element('input'); filter.type = 'search'; filter.id = filterLabel.htmlFor; filter.placeholder = 'Filter filenames'; filter.autocomplete = 'off';
  const filterStatus = element('p'); filterStatus.setAttribute('role', 'status'); filterStatus.id = `native-note-filter-status-${crypto.randomUUID()}`;
  filter.setAttribute('aria-describedby', filterStatus.id);
  const tree = element('section'); tree.id = `native-topic-notes-tree-${crypto.randomUUID()}`; tree.dataset.topicNotes = ''; tree.setAttribute('aria-labelledby', notesLabel.id);
  tree.style.maxInlineSize = '100%';
  const notePageStatus = element('p'); notePageStatus.setAttribute('role', 'status');
  const previousNotes = element('button', 'Previous Notes'); previousNotes.type = 'button'; previousNotes.disabled = true;
  const nextNotes = element('button', 'Next Notes'); nextNotes.type = 'button'; nextNotes.disabled = true;
  const notePagination = element('nav'); notePagination.setAttribute('aria-label', 'Note pages'); notePagination.append(previousNotes, nextNotes);
  const noteTitle = element('h2', 'Select a Note');
  const breadcrumb = element('nav'); breadcrumb.className = 'reader-breadcrumb'; breadcrumb.setAttribute('aria-label', 'File path');
  const noteModes = element('div'); noteModes.setAttribute('role', 'group'); noteModes.setAttribute('aria-label', 'Note view');
  const readingMode = element('button', 'Reading'); readingMode.type = 'button';
  const sourceMode = element('button', 'Source'); sourceMode.type = 'button';
  const content = element('article'); content.setAttribute('role', 'region'); content.setAttribute('aria-label', 'Note content'); content.tabIndex = 0;
  content.style.overflowWrap = 'anywhere'; content.style.lineHeight = '1.65'; content.style.maxInlineSize = '80ch'; content.style.paddingBlock = '0.5rem';
  const source = element('pre'); source.setAttribute('role', 'region'); source.setAttribute('aria-label', 'Note source'); source.tabIndex = 0;
  source.style.whiteSpace = 'pre-wrap'; source.style.overflowWrap = 'anywhere'; source.style.lineHeight = '1.65'; source.style.maxInlineSize = '80ch'; source.hidden = true;
  const documentAction = element('button', 'Download'); documentAction.setAttribute('aria-label', 'Download original attachment'); documentAction.type = 'button'; documentAction.hidden = true;
  noteModes.append(readingMode, sourceMode);
  const notesWorkspace = element('section'); notesWorkspace.dataset.topicNotesWorkspace = ''; notesWorkspace.setAttribute('aria-labelledby', notesLabel.id);
  notesWorkspace.style.minInlineSize = '0';
  const files = element('section'); files.className = 'reader-files'; files.setAttribute('aria-label', 'Files');
  const nativeExplorerHost = element('section'); nativeExplorerHost.dataset.nativeTopicFiles = '';
  tree.removeAttribute('aria-labelledby'); tree.setAttribute('aria-label', 'Topic files');
  notesWorkspace.removeAttribute('aria-labelledby'); notesWorkspace.setAttribute('aria-label', 'Topic Notes workspace');
  files.append(nativeExplorerHost, filterLabel, filter, filterStatus, tree, notePageStatus, notePagination);
  if (canUseNativeExplorer) {
    // The selected replacement is still an ordinary native Files panel. The
    // host rail supplies its own search and keyboard semantics, so avoid
    // rendering a second, visually competing browser beside it.
    filterLabel.hidden = true;
    filter.hidden = true;
    filterStatus.hidden = true;
    tree.hidden = true;
    notePageStatus.hidden = true;
    notePagination.hidden = true;
    refresh.hidden = true;
  }
  const reader = element('section'); reader.className = 'reader-document'; reader.setAttribute('aria-label', 'Reader');
  const readerBody = element('div'); readerBody.className = 'reader-body'; readerBody.append(content, source);
  const documentHeader = element('div'); documentHeader.className = 'reader-document-header'; documentHeader.append(noteTitle, noteModes, documentAction);
  reader.append(breadcrumb, documentHeader, readerBody);
  notesWorkspace.append(files, reader);
  const toggleFiles = element('button', 'Hide Files'); toggleFiles.type = 'button'; toggleFiles.setAttribute('aria-expanded', 'true'); toggleFiles.setAttribute('aria-controls', tree.id);
  const focusReader = element('button', 'Go to reader'); focusReader.type = 'button';
  const focusFiles = element('button', 'Go to Files'); focusFiles.type = 'button'; noteModes.append(focusFiles);
  focusReader.classList.add('reader-skip'); focusFiles.classList.add('reader-skip');
  const toolbar = element('div'); toolbar.className = 'reader-toolbar'; toolbar.append(heading, refresh, toggleFiles, focusReader);
  status.className = 'reader-status';
  const paneHelp = element('details'); paneHelp.append(element('summary', 'Workspace help'), element('p', 'Use the native pane controls alongside Chat to return Chat to the centre or change its docking. Hide or Show Files keeps this browser available. Session files are separate from Topic Notes; uploads are not automatically filed or incorporated into Notes.'));
  paneHelp.className = 'reader-pane-help'; paneHelp.hidden = !panel;
  const editorLabel = element('label', 'Note draft');
  const editor = element('textarea'); editor.rows = 18; editor.style.inlineSize = '100%'; editor.style.boxSizing = 'border-box'; editorLabel.append(editor);
  const noteState = element('p'); noteState.dataset.noteState = ''; noteState.setAttribute('role', 'status'); noteState.id = `native-note-state-${crypto.randomUUID()}`; noteState.tabIndex = -1;
  editor.setAttribute('aria-describedby', noteState.id);
  const save = element('button', 'Save Note'); save.type = 'button';
  const reconcile = element('button', 'Check save outcome'); reconcile.type = 'button'; reconcile.hidden = true;
  const reload = element('button', 'Reload authoritative Note'); reload.type = 'button';
  const discard = element('button', 'Discard draft and use authoritative Note'); discard.type = 'button'; discard.hidden = true;
  const editing = element('section'); editing.hidden = true;
  editing.append(editorLabel, noteState, save, reconcile, reload, discard, element('p', 'Drafts and uncertain save inputs are retained only during this plugin activation. Reloading or reconnecting loses these local drafts; reopening a Note reads authoritative content, not the lost draft. Ctrl+S or Cmd+S saves this Note.'));
  const footer = element('p', 'Read-only · Edit Notes in your external Note application.'); footer.className = 'reader-footer';
  // A native host may mount a page into a ShadowRoot. Keep the view marker on
  // its host in that case without assuming the supplied mount is an element.
  const pageMarker = container instanceof HTMLElement ? container : container.host;
  if (pageMarker?.dataset) pageMarker.dataset.topicReaderPage = panel ? 'panel' : 'page';
  container.replaceChildren(readerStyles(document), toolbar, ...(panel ? [] : [back, chat, history]), status, announcement, paneHelp, ...(panel ? [] : [creationActions, conversationsLabel, conversationStatus, conversations, historiesLabel, historyStatus, histories]), notesWorkspace,
    ...(FIRST_LIVE_FEATURES.noteWrite ? [editing] : [footer]));
  const readable = () => host.connection.connected && host.connection.canRead;
  function showPanelInMain() {
    if (!panel) return true;
    if (typeof activeContext.panel?.showInMain !== 'function') {
      status.textContent = 'This OpenClaw host cannot show Topic Notes in the centre pane.';
      return false;
    }
    if (!panelPromotionRequested) {
      activeContext.panel.showInMain();
      panelPromotionRequested = true;
    }
    return true;
  }
  const current = (pending) => !signal.aborted && presented && readable() && pending === generation;
  const currentCatalog = (pending) => !signal.aborted && presented && readable() && pending === catalogGeneration;
  const report = (error) => { if (!signal.aborted && presented && error?.name !== 'AbortError') { status.textContent = host.redact(error?.message || 'Topic is unavailable.'); renderNativeExplorer(); } };
  function cancel() { generation += 1; catalogGeneration += 1; reading.abort(); preview?.dispose(); preview = undefined; writing.abort(); writing = new AbortController(); navigation.cancel(); }
  function clearDocumentUrls() { for (const url of documentUrls) URL.revokeObjectURL(url); documentUrls.clear(); }
  const draftKey = (descriptor) => JSON.stringify([descriptor.topicId, descriptor.referenceId]);
  const sameDocumentSelection = (candidate, descriptor) => candidate?.sourceKind === 'document' && candidate.topicId === descriptor.topicId && candidate.referenceId === descriptor.referenceId && candidate.path === descriptor.path && candidate.observedRevision === descriptor.observedRevision;
  const fileName = (path) => path.split('/').filter(Boolean).at(-1) || path;
  function showReaderPath(path = '') {
    const parts = path.split('/').filter(Boolean);
    noteTitle.textContent = parts.length ? parts.at(-1) : 'Select a Note';
    noteTitle.title = path; breadcrumb.hidden = parts.length < 2;
    const items = document.createDocumentFragment();
    for (const part of parts.slice(0, -1)) items.append(element('li', part));
    const list = element('ol'); list.append(items); breadcrumb.replaceChildren(list);
  }
  function rememberSelection() {
    if (viewState) viewState.selected = selected && { ...selected };
    for (const button of tree.querySelectorAll('button[data-path]')) {
      if (button.dataset.path === selected?.path && button.dataset.referenceId === selected?.referenceId) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
    readerBody.scrollTop = 0;
    renderNativeExplorer();
    if (compact) { setFilesVisible(false); toggleFiles.focus({ preventScroll: true }); }
  }
  async function renderNoteView() {
    const pending = ++renderGeneration;
    const reading = noteView === 'reading';
    readingMode.setAttribute('aria-pressed', String(reading)); sourceMode.setAttribute('aria-pressed', String(!reading));
    content.hidden = !reading; source.hidden = reading;
    if (!noteText) { content.replaceChildren(); source.textContent = ''; return; }
    if (!reading) { source.textContent = noteText; return; }
    content.textContent = 'Rendering Note…';
    try {
      const { renderReadOnlyMarkdown } = await import('./note-render.mjs');
      if (signal.aborted || !presented || noteView !== 'reading' || pending !== renderGeneration) return;
      renderReadOnlyMarkdown(content, noteText);
    } catch (error) { if (!signal.aborted && presented && noteView === 'reading' && pending === renderGeneration) report(error); }
  }
  const sourceKindFor = (item) => item.sourceKind ?? item.sourceReference?.sourceKind ?? (item.path.toLocaleLowerCase().endsWith('.md') ? 'note' : 'document');
  function buildNoteTree(notes) {
    const root = { folders: new Map(), notes: [] };
    for (const note of notes) {
      const parts = note.path.split('/').filter(Boolean);
      let branch = root;
      for (const part of parts.slice(0, -1)) {
        if (!branch.folders.has(part)) branch.folders.set(part, { folders: new Map(), notes: [] });
        branch = branch.folders.get(part);
      }
      branch.notes.push(note);
    }
    return root;
  }
  function renderNoteTree() {
    const query = filter.value.trim().toLocaleLowerCase();
    const visibleNotes = catalogNotes.filter((note) => note.path.toLocaleLowerCase().includes(query));
    const root = buildNoteTree(visibleNotes);
    const renderBranch = (branch, depth = 0, parent = '') => {
      const list = element('ul'); list.style.listStyle = 'none'; list.style.paddingInlineStart = depth ? '1rem' : '0'; list.style.marginBlock = '0';
      for (const [name, folder] of [...branch.folders].sort(([left], [right]) => left.localeCompare(right))) {
        const row = element('li');
        const path = parent ? `${parent}/${name}` : name;
        const details = element('details'); details.open = query.length > 0 || (viewState?.folders.get(path) ?? false);
        const summary = element('summary', name); summary.title = path;
        details.addEventListener('toggle', () => { if (!filter.value.trim() && details.isConnected && viewState) viewState.folders.set(path, details.open); }, { signal });
        details.append(summary, renderBranch(folder, depth + 1, path)); row.append(details); list.append(row);
      }
      for (const note of [...branch.notes].sort((left, right) => left.path.localeCompare(right.path))) {
        const row = element('li'); row.style.marginBlock = '2px'; const sourceKind = sourceKindFor(note);
        const button = element('button', `${fileName(note.path)}${sourceKind === 'document' ? ' · original attachment' : ''}`); button.type = 'button'; button.classList.add('note-tree-item'); button.dataset.path = note.path;
        button.dataset.referenceId = note.sourceReference.referenceId;
        button.setAttribute('aria-label', `${sourceKind === 'document' ? 'View attachment information for' : 'Read'} ${note.path}`); button.title = note.path;
        if (selected?.referenceId === note.sourceReference.referenceId && selected?.path === note.path) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => sourceKind === 'document' ? void openDocument(note) : void openNote(note), { signal }); row.append(button); list.append(row);
      }
      return list;
    };
    tree.replaceChildren(renderBranch(root));
    tree.scrollTop = query ? 0 : (viewState?.scroll ?? 0);
    filterStatus.textContent = query ? `${visibleNotes.length} of ${catalogNotes.length} Topic files match “${filter.value.trim()}”.` : `${catalogNotes.length} Topic files available.`;
    renderNativeExplorer();
  }
  function nativeEntries() {
    const query = filter.value.trim().toLocaleLowerCase();
    const path = viewState?.browserPath ?? '';
    const prefix = path ? `${path}/` : '';
    const entries = new Map();
    const notes = catalogNotes.filter((note) => note.path.toLocaleLowerCase().includes(query));
    for (const note of notes) {
      if (query) {
        entries.set(`file:${note.path}`, { path: note.path, name: note.path, kind: 'file' });
        continue;
      }
      if (!note.path.startsWith(prefix)) continue;
      const remainder = note.path.slice(prefix.length);
      if (!remainder) continue;
      const [name, ...rest] = remainder.split('/');
      if (rest.length) entries.set(`directory:${prefix}${name}`, { path: `${prefix}${name}`, name, kind: 'directory' });
      else entries.set(`file:${note.path}`, { path: note.path, name, kind: 'file' });
    }
    return [...entries.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  }
  function nativeTreeEntries() {
    const query = filter.value.trim().toLocaleLowerCase();
    return catalogNotes
      .filter((note) => note.path.toLocaleLowerCase().includes(query))
      .map((note) => ({ path: note.path, name: fileName(note.path), kind: 'file' }));
  }
  function renderNativeExplorer() {
    if (!canUseNativeExplorer || !viewState) return;
    const entries = nativeTreeEntries();
    const persistedExpandedPaths = [...(viewState.folders ?? new Map()).entries()].filter(([, open]) => open).map(([path]) => path);
    // A quick filename/path filter must reveal its nested matches. Keep this
    // derived expansion separate from the user's persistent tree preference,
    // so clearing the filter restores the exact prior browsing layout.
    const expandedPaths = filter.value.trim()
      ? [...new Set(entries.flatMap(({ path }) => path.split('/').filter(Boolean).slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))))]
      : persistedExpandedPaths;
    const props = {
      rootLabel: topic?.name ?? 'Topic files',
      currentPath: viewState.browserPath ?? '',
      query: filter.value,
      // Passing an expanded-path model selects the host's persistent tree
      // presentation. It deliberately receives only the already-authorized
      // catalog, never a filesystem root or a fetch capability.
      entries,
      selectedPath: selected?.path ?? null,
      expandedPaths,
      loading: !topic || !catalogNotes.length && status.textContent === 'Loading Topic Notes…',
      // Do not leave a prior catalog actionable while its identity is unknown.
      // An empty native catalog is the only presentation allowed during a
      // disconnect, rebinding, or failed catalog read.
      error: !catalogNotes.length && /^(Connect with read access|Select a Topic|The (?:exact )?Note catalogue)/u.test(status.textContent) ? status.textContent : null,
      onBrowsePath: (path) => {
        if (!viewState || !catalogNotes.some((note) => note.path === path || note.path.startsWith(`${path}/`))) return;
        viewState.browserPath = path;
        renderNoteTree();
      },
      onExpandedPathsChange: (paths) => {
        if (!viewState) return;
        // Filter expansion is derived solely to reveal matching descendants.
        // Do not let disclosure changes while that derived view is active
        // replace the user's pre-filter layout preference.
        if (filter.value.trim()) return;
        const next = [...new Set(paths)].sort();
        const previous = [...(viewState.folders ?? new Map()).entries()]
          .filter(([, open]) => open)
          .map(([path]) => path)
          .sort();
        // The host component computes its next disclosure set from its current
        // props. Update it after a real change so a second nested disclosure
        // extends the persisted branch rather than replacing its ancestor.
        if (next.length === previous.length && next.every((path, index) => path === previous[index])) return;
        for (const path of [...viewState.folders.keys()]) viewState.folders.delete(path);
        for (const path of next) viewState.folders.set(path, true);
        // `update` preserves the host renderer's own scroll position; it is
        // not a remount. Keeping props current is necessary for the next
        // nested disclosure to retain earlier ancestors.
        renderNativeExplorer();
      },
      onSelect: (path) => {
        const note = catalogNotes.find((candidate) => candidate.path === path);
        if (note) void (sourceKindFor(note) === 'document' ? openDocument(note) : openNote(note));
      },
      onQueryChange: (query) => {
        filter.value = query;
        if (viewState) viewState.filter = query;
        renderNoteTree();
      },
      onRefresh: () => void load()
    };
    if (nativeExplorer) nativeExplorer.update(props);
    else nativeExplorer = host.components.mountFileExplorer(nativeExplorerHost, props);
  }
  function validateCatalogNote(note) {
    if (note.sourceReference?.topicId !== topicId || typeof note.sourceReference?.referenceId !== 'string' || typeof note.path !== 'string' || typeof note.revision !== 'string' || !['note', 'document'].includes(sourceKindFor(note))) {
      throw new Error('The exact Note reference is unavailable.');
    }
  }
  function renderConversations() {
    const fragment = document.createDocumentFragment();
    for (const conversation of catalogConversations) {
      const row = element('li'); row.dataset.referenceId = conversation.referenceId; row.dataset.sessionId = conversation.sessionId; row.style.marginBlock = '2px';
      const button = element('button', conversation.displayName); button.type = 'button'; button.style.minBlockSize = '2.75rem'; button.style.maxInlineSize = '100%'; button.style.whiteSpace = 'normal'; button.style.overflowWrap = 'anywhere'; button.style.textAlign = 'start';
      button.addEventListener('click', () => {
        if (!presented || !readable()) return;
        reading.abort(); const pending = ++generation;
        void navigation.open({ topicId, referenceId: conversation.referenceId, expectedSessionId: conversation.sessionId }).catch((error) => { if (current(pending)) report(error); });
      }, { signal });
      row.append(button, element('span', conversation.isPrimary ? ' · Primary' : ' · Linked'));
      fragment.append(row);
    }
    conversations.replaceChildren(fragment);
    conversationStatus.textContent = catalogConversations.length ? `${catalogConversations.length} active Conversations available.` : 'No active Conversations in this Topic.';
  }
  function renderHistories() {
    const fragment = document.createDocumentFragment();
    for (const historyDescriptor of catalogHistories) {
      const row = element('li'); row.dataset.historyId = historyDescriptor.historyId; row.style.marginBlock = '2px';
      const button = element('button', historyDescriptor.title); button.type = 'button'; button.style.minBlockSize = '2.75rem'; button.style.maxInlineSize = '100%'; button.style.whiteSpace = 'normal'; button.style.overflowWrap = 'anywhere'; button.style.textAlign = 'start';
      button.addEventListener('click', () => { if (presented && readable()) host.navigation.openPage({ id: 'histories', params: { topicId, historyId: historyDescriptor.historyId } }); }, { signal });
      row.append(button, element('span', ` · ${historyDescriptor.totalMessages} messages · Read-only`)); fragment.append(row);
    }
    histories.replaceChildren(fragment);
    historyStatus.textContent = catalogHistories.length ? `${catalogHistories.length} read-only preserved histories available.` : 'No preserved histories in this Topic.';
  }
  async function loadConversations(pending) {
    const response = await host.request('command-center.v1.sessions.browse', { schemaVersion: 1, topicId, includeClosed: false });
    if (!currentCatalog(pending)) return null;
    const catalog = response?.result ?? response;
    if (catalog?.topicId !== topicId || !Array.isArray(catalog?.conversations)) throw new Error('The exact Topic Conversations are unavailable.');
    const identities = new Set();
    const active = [];
    for (const row of catalog.conversations) {
      if (typeof row?.referenceId !== 'string' || !row.referenceId.trim() || typeof row.sessionId !== 'string' || !row.sessionId.trim() ||
          typeof row.status !== 'string' || typeof row.isPrimary !== 'boolean') throw new Error('The exact Topic Conversation is unavailable.');
      const identity = JSON.stringify([row.referenceId, row.sessionId]);
      if (identities.has(identity)) throw new Error('The exact Topic Conversation is unavailable.');
      identities.add(identity);
      if (row.status !== 'open') continue;
      active.push({ referenceId: row.referenceId, sessionId: row.sessionId, isPrimary: row.isPrimary,
        displayName: typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName : row.isPrimary ? 'Primary Conversation' : 'Linked Conversation' });
    }
    const primary = active.filter((row) => row.isPrimary);
    if (primary.length !== 1) throw new Error('The exact Primary Conversation is unavailable.');
    return [...primary, ...active.filter((row) => !row.isPrimary).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.referenceId.localeCompare(right.referenceId))];
  }
  async function loadHistories(pending) {
    const response = await host.request('command-center.v1.histories.list', { schemaVersion: 1, topicId });
    if (!currentCatalog(pending)) return null;
    const result = response?.result ?? response;
    if (!Array.isArray(result?.histories)) throw new Error('The preserved history catalog is unavailable.');
    const identities = new Set(); const values = [];
    for (const row of result.histories) {
      if (typeof row?.historyId !== 'string' || !/^[a-f0-9]{64}$/u.test(row.historyId) || identities.has(row.historyId) || row.topicId !== topicId || row.readOnly !== true ||
          typeof row.title !== 'string' || !row.title.trim() || !Number.isSafeInteger(row.totalMessages) || row.totalMessages < 0) throw new Error('The exact history association is unavailable.');
      identities.add(row.historyId); values.push({ historyId: row.historyId, title: row.title, totalMessages: row.totalMessages });
    }
    return values.sort((left, right) => left.title.localeCompare(right.title) || left.historyId.localeCompare(right.historyId));
  }
  async function loadCatalog(pending, pageOffset = 0, pageCursor = undefined) {
    const notes = [];
    const identities = new Set();
    const paths = new Set();
    const notesResponse = await host.request('command-center.v1.notes.browse', { schemaVersion: 1, topicId, offset: pageOffset, limit: 50, includeDocuments: true, ...(pageCursor ? { cursor: pageCursor } : {}) });
    if (!currentCatalog(pending)) return null;
    const catalog = notesResponse?.result ?? notesResponse;
    if (!Array.isArray(catalog?.notes) || catalog.offset !== pageOffset || !Number.isSafeInteger(catalog.total) || catalog.total < 0 ||
        typeof catalog.hasMore !== 'boolean' || typeof catalog.cursor !== 'string' ||
        (catalog.hasMore && (!Number.isSafeInteger(catalog.nextOffset) || catalog.nextOffset <= pageOffset || catalog.nextOffset >= catalog.total))) {
      throw new Error('The Note catalogue is unavailable; refresh Notes.');
    }
    for (const note of catalog.notes) {
      validateCatalogNote(note);
      const identity = JSON.stringify([note.sourceReference.referenceId, note.path]);
      if (identities.has(identity) || paths.has(note.path)) throw new Error('The exact Note catalogue is unavailable.');
      identities.add(identity); notes.push(note); paths.add(note.path);
    }
    if (notes.length > 50 || pageOffset + notes.length > catalog.total || (catalog.hasMore && notes.length === 0)) throw new Error('The exact Note catalogue is unavailable.');
    return { notes, total: catalog.total, offset: catalog.offset, nextOffset: catalog.hasMore ? catalog.nextOffset : null, cursor: catalog.cursor };
  }
  function presentCatalogPage(catalog) {
    catalogNotes = catalog.notes;
    catalogOffset = catalog.offset;
    catalogTotal = catalog.total;
    catalogNextOffset = catalog.nextOffset;
    catalogCursor = catalog.cursor;
    renderNoteTree();
    const first = catalogTotal === 0 ? 0 : catalogOffset + 1;
    notePageStatus.textContent = catalogTotal === 0 ? 'No Notes.' : `Notes ${first}–${catalogOffset + catalogNotes.length} of ${catalogTotal}.`;
    previousNotes.disabled = catalogOffset === 0;
    nextNotes.disabled = catalogNextOffset === null;
  }
  async function loadCatalogPage(offset) {
    if (!presented || !readable() || !catalogCursor || offset < 0 || offset >= catalogTotal) return;
    const pending = ++catalogGeneration;
    previousNotes.disabled = true; nextNotes.disabled = true;
    notePageStatus.textContent = 'Loading Note page…';
    try {
      const catalog = await loadCatalog(pending, offset, catalogCursor);
      if (!catalog || catalog.total !== catalogTotal || catalog.cursor !== catalogCursor) throw new Error('The Note catalogue changed during retrieval; refresh Notes.');
      presentCatalogPage(catalog);
    } catch (error) { if (currentCatalog(pending)) report(error); }
  }
  function showDraft() {
    if (!FIRST_LIVE_FEATURES.noteWrite) return;
    const draft = selected && drafts.get(draftKey(selected));
    editing.hidden = !draft;
    if (!draft) return;
    editor.value = draft.text;
    editor.readOnly = topic?.lifecycle !== 'active' || topic?.usable !== true || !readable();
    save.disabled = editor.readOnly || !host.connection.canWrite || typeof host.httpRequest !== 'function' || !!draft.operation;
    reconcile.hidden = !draft.operation?.unknown;
    reconcile.disabled = !readable() || !host.connection.canWrite || typeof host.httpRequest !== 'function' || !!draft.operation?.attempt;
    discard.hidden = !!draft.operation || draft.text === draft.baseText;
    noteState.textContent = `${draft.baseRevision} · ${draft.text === draft.baseText ? 'saved' : 'unsaved draft'}${draft.operation ? draft.operation.checking ? ' · checking save outcome…' : draft.operation.unknown ? ` · outcome unknown (${draft.operation.input.logicalOperationId}); check save outcome` : ' · saving…' : ''}${save.disabled && !draft.operation ? ' · writing unavailable' : ''}${draft.error ? ` · ${draft.error}` : ''}`;
  }
  async function openDocument(documentEntry) {
    if (!presented || !readable() || signal.aborted) return;
    navigation.cancel(); reading.abort(); preview?.dispose(); preview = undefined; reading = new AbortController(); const pending = ++generation;
    const readSignal = AbortSignal.any([signal, reading.signal]);
    const descriptor = { topicId, referenceId: documentEntry.sourceReference.referenceId, path: documentEntry.path, observedRevision: documentEntry.revision, sourceKind: 'document' };
    selected = descriptor; rememberSelection();
    noteText = ''; renderGeneration += 1; showReaderPath(documentEntry.path);
    content.hidden = false; source.hidden = true; source.textContent = ''; documentAction.hidden = false; documentAction.disabled = false;
    readingMode.hidden = true; sourceMode.hidden = true;
    content.textContent = 'Loading original attachment preview…'; status.textContent = 'Verifying original attachment…';
    try {
      await verifyContext?.();
      if (readSignal.aborted || !current(pending)) return;
      if (!showPanelInMain()) return;
      const result = await readNativeDocument({ signal: readSignal, request: (method, params) => host.request(method, params) }, descriptor, { maxBytes: 20 * 1024 * 1024 });
      if (readSignal.aborted || !current(pending)) return;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await result.bytes.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      await verifyContext?.();
      if (readSignal.aborted || !current(pending)) return;
      if (digest !== descriptor.observedRevision.replace(/^sha256:/u, '')) throw new Error('The original attachment verification failed. Refresh Files.');
      const { mountDocumentPreview } = await import('./document-preview.mjs');
      if (readSignal.aborted || !current(pending)) return;
      const mounted = await mountDocumentPreview(content, { bytes: result.bytes, path: descriptor.path, signal: readSignal,
        beforePublish: async () => { await verifyContext?.(); readSignal.throwIfAborted(); if (!current(pending)) throw new DOMException('Selection changed', 'AbortError'); }
      });
      if (readSignal.aborted || !current(pending)) { mounted.dispose(); return; }
      preview = mounted; announce('Original attachment verified.'); status.title = result.revision;
    } catch (error) {
      if (!readSignal.aborted && current(pending)) {
        content.textContent = `Preview unavailable: ${host.redact(error.message)} Use Download original attachment to retrieve verified bytes.`;
        report(error);
      }
    }
  }
  documentAction.addEventListener('click', () => void (async () => {
    if (!selected || selected.sourceKind !== 'document' || !readable()) return;
    const documentSignal = AbortSignal.any([signal, reading.signal]);
    const pending = generation; const descriptor = { ...selected }; documentAction.disabled = true; status.textContent = `Verifying ${fileName(descriptor.path)}…`;
    try {
      await verifyContext?.();
      if (documentSignal.aborted || !current(pending) || !sameDocumentSelection(selected, descriptor)) return;
      const result = await readNativeDocument({ signal: documentSignal, request: (method, params) => host.request(method, params) }, selected);
      if (documentSignal.aborted || !current(pending) || !sameDocumentSelection(selected, descriptor)) return;
      await verifyContext?.();
      if (documentSignal.aborted || !current(pending) || !sameDocumentSelection(selected, descriptor)) return;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await result.bytes.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!current(pending) || !sameDocumentSelection(selected, descriptor) || digest !== descriptor.observedRevision.replace(/^sha256:/u, '')) throw new Error('The original attachment verification failed; no download was offered.');
      const url = URL.createObjectURL(result.bytes); documentUrls.add(url);
      const link = element('a'); link.href = url; link.download = fileName(selected.path).replace(/[\\/\x00-\x1f]/g, '_') || 'attachment'; link.hidden = true;
      container.append(link); link.click(); link.remove(); status.textContent = 'Verified original attachment downloaded.';
    } catch (error) { if (!documentSignal.aborted && current(pending)) report(error); }
    finally { if (!documentSignal.aborted && current(pending)) documentAction.disabled = false; }
  })(), { signal });
  async function openNote(note, { discardDraft = false } = {}) {
    if (!presented || !readable() || signal.aborted) return;
    navigation.cancel();
    reading.abort(); reading = new AbortController();
    preview?.dispose(); preview = undefined;
    const readSignal = AbortSignal.any([signal, reading.signal]);
    const pending = ++generation;
    const descriptor = { topicId, referenceId: note.sourceReference.referenceId, path: note.path, observedRevision: note.revision, sourceKind: 'note' };
    const key = draftKey(descriptor);
    const existing = drafts.get(key); const version = existing?.version;
    selected = descriptor; noteText = ''; documentAction.hidden = true; content.replaceChildren(); source.textContent = ''; showReaderPath(note.path); showDraft();
    readingMode.hidden = false; sourceMode.hidden = false;
    rememberSelection();
    status.textContent = 'Opening authoritative Note…';
    try {
      await verifyContext?.();
      if (readSignal.aborted || !current(pending)) return;
      const result = await readNativeNote({ signal: readSignal, request: (method, params) => host.request(method, params) }, {
        ...descriptor
      });
      if (readSignal.aborted || !current(pending)) return;
      await verifyContext?.();
      if (readSignal.aborted || !current(pending)) return;
      noteText = result.text; await renderNoteView();
      if (readSignal.aborted || !current(pending)) return;
      // Read-only browsing must not create a local authoring/operation owner.
      if (!FIRST_LIVE_FEATURES.noteWrite) {
        announce(`Note opened · ${result.revision}`); status.title = result.revision;
        if (panel && !showPanelInMain()) return;
        (noteView === 'reading' ? content : source).focus();
        return;
      }
      let draft = drafts.get(key);
      if (!draft || (!draft.operation && draft.version === version && (discardDraft || draft.text === draft.baseText))) {
        draft = { text: result.text, baseText: result.text, baseRevision: result.revision, path: descriptor.path, version: (draft?.version ?? 0) + 1, operation: null };
        drafts.set(key, draft);
      }
      showDraft();
      announce(`Note opened · ${result.revision}`);
      (noteView === 'reading' ? content : source).focus();
    } catch (error) { if (!readSignal.aborted && current(pending)) report(error); }
  }
  async function load() {
    cancel(); const pending = catalogGeneration;
    showReaderPath(); status.title = '';
    creation?.dispose(); creation?.form.remove(); creation = undefined;
    noteCreation?.dispose(); noteCreation?.form.remove(); noteCreation = undefined;
    tree.replaceChildren(); conversations.replaceChildren(); histories.replaceChildren(); noteText = ''; renderGeneration += 1; content.replaceChildren(); source.textContent = ''; selected = undefined; editing.hidden = true; topic = undefined; chat.disabled = true; catalogNotes = []; catalogConversations = []; catalogHistories = [];
    if (signal.aborted || !presented) return;
    if (!readable()) { status.textContent = 'Connect with read access to view Notes.'; renderNativeExplorer(); return; }
    if (typeof topicId !== 'string' || !topicId.trim()) { status.textContent = 'Select a Topic from All Topics.'; renderNativeExplorer(); return; }
    status.textContent = 'Loading Topic Notes…'; filterStatus.textContent = ''; renderNativeExplorer();
    try {
      const topicResponse = await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId });
      if (!currentCatalog(pending)) return;
      const verifiedTopic = (topicResponse?.result ?? topicResponse)?.topic;
      if (verifiedTopic?.topicId !== topicId) throw new Error('The exact Topic is unavailable.');
      topic = verifiedTopic;
      // View preferences grant no authority. Every restored selection must also
      // match the newly read catalogue before the ordinary exact reader runs.
      const viewKey = JSON.stringify([topicId, topic.noteFolderReferenceId ?? null]);
      if (!views.has(viewKey)) views.set(viewKey, { folders: new Map(), filter: '', scroll: 0, selected: undefined, browserPath: '' });
      viewState = views.get(viewKey);
      viewState.browserPath ??= '';
      filter.value = viewState.filter;
      heading.textContent = topic.name;
      chat.disabled = topic.usable !== true || topic.lifecycle !== 'active';
      if (!panel) creation = createNativeCreationForm({ host, state, document, signal, presented: () => presented, getTopic: () => topic,
        beginNavigation: () => { reading.abort(); navigation.cancel(); const selection = ++generation; return () => current(selection); },
        onCreated: async (result, input) => {
          const selection = generation;
          const response = await host.request('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: input.topicId, includeClosed: false });
          if (!current(selection)) return;
          const catalog = response?.result ?? response;
          const matches = catalog?.conversations?.filter((row) => row.referenceId === result.referenceId && row.status === 'open');
          if (catalog?.topicId !== input.topicId || matches?.length !== 1) throw new Error('The exact created Conversation is unavailable; refresh the Topic.');
          await navigation.open({ topicId: input.topicId, referenceId: result.referenceId, expectedSessionId: matches[0].sessionId });
        } });
      if (!panel) creationActions.append(creation.form);
      if (!panel && FIRST_LIVE_FEATURES.noteWrite) {
        noteCreation = createNativeNoteCreationForm({ host, state, document, signal, presented: () => presented, getTopic: () => topic });
        creationActions.append(noteCreation.form);
      }
      // Topic membership owns Session controls; an unavailable Note source must
      // not disable healthy native Chat or Conversation creation.
      // Conversations and Notes have independent authoritative owners. A slow
      // Note Folder must never hide already-resolved native Chat navigation.
      if (!panel) void loadConversations(pending).then((value) => {
        if (!currentCatalog(pending) || !value) return;
        catalogConversations = value;
        renderConversations();
      }).catch((error) => {
        if (currentCatalog(pending)) conversationStatus.textContent = host.redact(error?.message || 'Topic Conversations are unavailable.');
      });
      if (!panel) void loadHistories(pending).then((value) => {
        if (!currentCatalog(pending) || !value) return;
        catalogHistories = value;
        renderHistories();
      }).catch((error) => {
        if (currentCatalog(pending)) historyStatus.textContent = host.redact(error?.message || 'Preserved history is unavailable.');
      });
      const catalog = await loadCatalog(pending);
      if (!currentCatalog(pending)) return;
      if (!catalog) return;
      presentCatalogPage(catalog);
      // The folder tree begins collapsed. Direct selection and filtering may
      // temporarily reveal only the ancestors needed for that exact result.
      status.textContent = catalogTotal ? '' : 'No Notes or filed attachments in this Topic.';
      const prior = viewState.selected;
      const restore = prior && catalogNotes.find(note => note.path === prior.path && note.sourceReference.referenceId === prior.referenceId);
      if (restore) {
        if (sourceKindFor(restore) === 'note') await openNote(restore);
        else await openDocument(restore);
      } else if (prior) { viewState.selected = undefined; }
    } catch (error) { if (currentCatalog(pending)) report(error); }
  }
  async function saveNote({ reconcileOnly = false } = {}) {
    if (!FIRST_LIVE_FEATURES.noteWrite) return;
    if (!selected || !presented || !readable() || !host.connection.canWrite || (!reconcileOnly && (topic?.lifecycle !== 'active' || topic?.usable !== true))) return;
    const descriptor = { ...selected }; const key = draftKey(descriptor); const draft = drafts.get(key);
    if (!draft || (reconcileOnly ? !draft.operation?.unknown || draft.operation.attempt : draft.operation)) return;
    if (draft.path !== descriptor.path) { noteState.textContent = 'The Note moved while this draft was open. Source Recovery is required before saving.'; return; }
    const pending = generation;
    const focusControl = reconcileOnly ? reconcile : save;
    const restoreSaveFocus = document.activeElement === focusControl;
    try {
      const operation = reconcileOnly ? draft.operation : beginNativeNoteOperation(state, key, draft, { schemaVersion: 1, action: 'notes.edit', topicId, referenceId: descriptor.referenceId, path: draft.path, contentBase64: encodeNoteText(draft.text), expectedRevision: draft.baseRevision, expectedTopicRevision: topic.revision, logicalOperationId: crypto.randomUUID() });
      if (restoreSaveFocus) noteState.focus();
      const settlement = settleNativeNoteOperation({ state, key, draft, operation, host, signal: AbortSignal.any([signal, writing.signal]), reconcile: reconcileOnly });
      showDraft();
      const receipt = await settlement;
      if (!receipt || !current(pending) || !selected || draftKey(selected) !== key) return;
      const { result } = receipt; const input = operation.input;
      for (const note of catalogNotes) {
        if (receipt.status === 'applied' && note.sourceReference?.topicId === input.topicId && note.sourceReference?.referenceId === input.referenceId && note.path === input.path) note.revision = result.revision;
      }
      if (receipt.status === 'applied') { noteText = receipt.text; renderNoteView(); }
      showDraft(); status.textContent = receipt.status === 'applied' ? 'Note saved.' : 'Save was not applied; no write was retried.';
    } catch (error) {
      draft.error = host.redact(error.message);
      if (current(pending) && selected && draftKey(selected) === key) showDraft();
    } finally {
      const target = !focusControl.hidden && !focusControl.disabled ? focusControl : save;
      if (current(pending) && selected && draftKey(selected) === key && restoreSaveFocus && document.activeElement === noteState && !target.disabled) target.focus();
    }
  }
  async function reloadNote(discardDraft = false) {
    if (!selected || !presented || !readable()) return;
    navigation.cancel(); reading.abort();
    const descriptor = { ...selected }; const pending = ++generation; const key = draftKey(descriptor);
    status.textContent = 'Finding the exact authoritative Note…';
    try {
      let pageOffset = 0; let pageCursor;
      for (;;) {
        const response = await host.request('command-center.v1.notes.browse', { schemaVersion: 1, topicId: descriptor.topicId, offset: pageOffset, limit: 100, includeDocuments: true, ...(pageCursor ? { cursor: pageCursor } : {}) });
        if (!current(pending) || !selected || draftKey(selected) !== key) return;
        const catalog = response?.result ?? response;
        if (!Array.isArray(catalog?.notes) || catalog.offset !== pageOffset) throw new Error('The authoritative Note catalog is unavailable.');
        const matches = catalog.notes.filter((note) => note.sourceReference?.topicId === descriptor.topicId && note.sourceReference?.referenceId === descriptor.referenceId);
        if (matches.length === 1) { await openNote(matches[0], { discardDraft }); return; }
        if (matches.length > 1 || !catalog.hasMore) throw new Error('The exact Note is unavailable. Your draft is retained.');
        if (!Number.isSafeInteger(catalog.nextOffset) || catalog.nextOffset <= pageOffset || typeof catalog.cursor !== 'string') throw new Error('The authoritative Note catalog is incomplete.');
        pageOffset = catalog.nextOffset; pageCursor = catalog.cursor;
      }
    } catch (error) { if (current(pending) && selected && draftKey(selected) === key) report(error); }
  }
  editor.addEventListener('input', () => {
    const draft = selected && drafts.get(draftKey(selected)); if (!draft) return;
    draft.text = editor.value; draft.version++; showDraft();
  }, { signal });
  editor.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveNote(); } }, { signal });
  save.addEventListener('click', () => void saveNote(), { signal });
  reconcile.addEventListener('click', () => void saveNote({ reconcileOnly: true }), { signal });
  reload.addEventListener('click', () => void reloadNote(), { signal });
  discard.addEventListener('click', () => void reloadNote(true), { signal });
  filter.addEventListener('input', () => { if (viewState) viewState.filter = filter.value; renderNoteTree(); }, { signal });
  previousNotes.addEventListener('click', () => void loadCatalogPage(Math.max(0, catalogOffset - 50)), { signal });
  nextNotes.addEventListener('click', () => { if (catalogNextOffset !== null) void loadCatalogPage(catalogNextOffset); }, { signal });
  tree.addEventListener('scroll', () => { if (viewState && tree.childNodes.length && !filter.value.trim()) viewState.scroll = tree.scrollTop; }, { signal });
  function setFilesVisible(visible) {
    files.hidden = !visible; notesWorkspace.toggleAttribute('data-files-hidden', !visible);
    reader.hidden = compact && visible;
    toggleFiles.textContent = visible ? 'Hide Files' : 'Show Files'; toggleFiles.setAttribute('aria-expanded', String(visible));
  }
  const resize = new ResizeObserver(entries => {
    // Native Files is a retained host pane: its default width is narrower
    // than the legacy page breakpoint, but it must remain available beside
    // the selected document. Compact swapping is only for the legacy tree.
    const next = !canUseNativeExplorer && entries[0].contentRect.width < 480;
    if (next === compact) return;
    compact = next; notesWorkspace.toggleAttribute('data-compact', compact);
    const movingFocus = files.contains(document.activeElement) || reader.contains(document.activeElement);
    setFilesVisible(!compact);
    if (movingFocus) toggleFiles.focus({ preventScroll: true });
  });
  resize.observe(notesWorkspace);
  toggleFiles.addEventListener('click', () => setFilesVisible(files.hidden), { signal });
  focusFiles.addEventListener('click', () => {
    setFilesVisible(true);
    const nativeSearch = nativeExplorerHost.querySelector('input[type="search"]');
    (nativeSearch ?? filter).focus({ preventScroll: true });
  }, { signal });
  focusReader.addEventListener('click', () => (noteView === 'reading' ? content : source).focus({ preventScroll: true }), { signal });
  readingMode.addEventListener('click', () => { noteView = 'reading'; renderNoteView(); }, { signal });
  sourceMode.addEventListener('click', () => { noteView = 'source'; renderNoteView(); }, { signal });
  back.addEventListener('click', () => { cancel(); host.navigation.openPage({ id: 'topics' }); }, { signal });
  history.addEventListener('click', () => { if (presented && readable() && topic?.topicId === topicId) { cancel(); host.navigation.openPage({ id: 'histories', params: { topicId } }); } }, { signal });
  refresh.addEventListener('click', () => void load(), { signal });
  chat.addEventListener('click', () => { if (presented) { generation++; reading.abort(); void navigation.openPrimary(topicId).catch(report); } }, { signal });
  let connected = readable();
  const unsubscribeDraft = subscribeNativeState(state, () => { if (!signal.aborted && presented && selected) showDraft(); });
  const unsubscribe = host.subscribe(() => {
    creation?.sync();
    noteCreation?.sync();
    if (!host.connection.canWrite) { writing.abort(); writing = new AbortController(); }
    if (connected !== readable()) { connected = readable(); void load(); } else showDraft();
  });
  void load();
  return {
    update(next) {
      activeContext = next;
      if (topicId === next.props.topicId && presented === next.presented) return;
      topicId = next.props.topicId; presented = next.presented; void load();
    },
    focus() { (panel ? refresh : back).focus(); },
    dispose() { resize.disconnect(); cancel(); clearDocumentUrls(); nativeExplorer?.dispose(); creation?.dispose(); noteCreation?.dispose(); lifetime.abort(); unsubscribe(); unsubscribeDraft(); container.replaceChildren(); }
  };
}
