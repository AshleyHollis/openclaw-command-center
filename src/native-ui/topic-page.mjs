import { createNativeTopicNavigation } from './topic-navigation.mjs';
import { readNativeNote } from './note-read.mjs';
import { encodeNoteText, beginNativeNoteOperation, settleNativeNoteOperation, createNativeState, subscribeNativeState } from './mutations.mjs';
import { createNativeCreationForm, createNativeNoteCreationForm } from './creation-form.mjs';
import { FIRST_LIVE_FEATURES } from '../release-scope.mjs';

/** Topic policy stays in the backend; OpenClaw owns routing and Chat. */
export function mountTopicPage(container, context, state = createNativeState()) {
  const host = context.host;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  let topicId = context.props.topicId;
  let presented = context.presented;
  let generation = 0;
  let catalogGeneration = 0;
  let offset = 0;
  let cursor;
  let nextOffset = null;
  let reading = new AbortController();
  let writing = new AbortController();
  let topic;
  let selected;
  let catalogNotes = [];
  const drafts = state.drafts;
  let creation;
  let noteCreation;
  const navigation = createNativeTopicNavigation({ signal, get connection() { return host.connection; },
    request: (method, params) => host.request(method, params), sessions: host.sessions });
  const document = container.ownerDocument;
  const element = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const heading = element('h1', 'Topic');
  const status = element('p'); status.setAttribute('role', 'status');
  const back = element('button', 'All Topics'); back.type = 'button';
  const chat = element('button', 'Open Topic in Chat'); chat.type = 'button'; chat.disabled = true;
  const history = element('button', 'View Imported History'); history.type = 'button';
  const refresh = element('button', 'Refresh Notes'); refresh.type = 'button';
  const list = element('ul');
  const previous = element('button', 'Previous Notes'); previous.type = 'button'; previous.disabled = true;
  const next = element('button', 'Next Notes'); next.type = 'button'; next.disabled = true;
  const noteTitle = element('h2', 'Select a Note');
  const content = element('pre'); content.setAttribute('role', 'region'); content.setAttribute('aria-label', 'Note content');
  content.style.whiteSpace = 'pre-wrap'; content.style.overflowWrap = 'anywhere'; content.tabIndex = 0;
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
  container.replaceChildren(heading, back, chat, history, refresh, status, element('h2', 'Notes'), list, previous, next, noteTitle, content,
    ...(FIRST_LIVE_FEATURES.noteWrite ? [editing] : [element('p', 'Notes are read-only in this release. Edit them in your external Note application.')]));
  const readable = () => host.connection.connected && host.connection.canRead;
  const current = (pending) => !signal.aborted && presented && readable() && pending === generation;
  const currentCatalog = (pending) => !signal.aborted && presented && readable() && pending === catalogGeneration;
  const report = (error) => { if (!signal.aborted && presented && error?.name !== 'AbortError') status.textContent = host.redact(error?.message || 'Topic is unavailable.'); };
  function cancel() { generation += 1; catalogGeneration += 1; reading.abort(); writing.abort(); writing = new AbortController(); navigation.cancel(); }
  const draftKey = (descriptor) => JSON.stringify([descriptor.topicId, descriptor.referenceId]);
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
  async function openNote(note, { discardDraft = false } = {}) {
    if (!presented || !readable() || signal.aborted) return;
    navigation.cancel();
    reading.abort(); reading = new AbortController();
    const readSignal = AbortSignal.any([signal, reading.signal]);
    const pending = ++generation;
    const descriptor = { topicId, referenceId: note.sourceReference.referenceId, path: note.path, observedRevision: note.revision };
    const key = draftKey(descriptor);
    const existing = drafts.get(key); const version = existing?.version;
    selected = descriptor; content.textContent = ''; noteTitle.textContent = note.path; showDraft();
    status.textContent = 'Opening authoritative Note…';
    try {
      const result = await readNativeNote({ signal: readSignal, request: (method, params) => host.request(method, params) }, {
        ...descriptor
      });
      if (readSignal.aborted || !current(pending)) return;
      content.textContent = result.text;
      // Read-only browsing must not create a local authoring/operation owner.
      if (!FIRST_LIVE_FEATURES.noteWrite) {
        status.textContent = `Note opened · ${result.revision}`;
        content.focus();
        return;
      }
      let draft = drafts.get(key);
      if (!draft || (!draft.operation && draft.version === version && (discardDraft || draft.text === draft.baseText))) {
        draft = { text: result.text, baseText: result.text, baseRevision: result.revision, path: descriptor.path, version: (draft?.version ?? 0) + 1, operation: null };
        drafts.set(key, draft);
      }
      showDraft();
      status.textContent = `Note opened · ${result.revision}`;
      content.focus();
    } catch (error) { if (!readSignal.aborted && current(pending)) report(error); }
  }
  async function load({ retainSnapshot = false } = {}) {
    if (!retainSnapshot) { offset = 0; cursor = undefined; }
    cancel(); const pending = catalogGeneration;
    creation?.dispose(); creation?.form.remove(); creation = undefined;
    noteCreation?.dispose(); noteCreation?.form.remove(); noteCreation = undefined;
    list.replaceChildren(); content.textContent = ''; selected = undefined; editing.hidden = true; topic = undefined; chat.disabled = true; previous.disabled = true; next.disabled = true;
    if (signal.aborted || !presented) return;
    if (!readable()) { status.textContent = 'Connect with read access to view Notes.'; return; }
    if (typeof topicId !== 'string' || !topicId.trim()) { status.textContent = 'Select a Topic from All Topics.'; return; }
    status.textContent = 'Loading Topic Notes…';
    try {
      const topicResponse = await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId });
      if (!currentCatalog(pending)) return;
      const verifiedTopic = (topicResponse?.result ?? topicResponse)?.topic;
      if (verifiedTopic?.topicId !== topicId) throw new Error('The exact Topic is unavailable.');
      topic = verifiedTopic;
      heading.textContent = topic.name;
      chat.disabled = topic.usable !== true || topic.lifecycle !== 'active';
      creation = createNativeCreationForm({ host, state, document, signal, presented: () => presented, getTopic: () => topic,
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
      container.append(creation.form);
      if (FIRST_LIVE_FEATURES.noteWrite) {
        noteCreation = createNativeNoteCreationForm({ host, state, document, signal, presented: () => presented, getTopic: () => topic });
        container.append(noteCreation.form);
      }
      // Topic membership owns Session controls; an unavailable Note source must
      // not disable healthy native Chat or Conversation creation.
      const notesResponse = await host.request('command-center.v1.notes.browse', { schemaVersion: 1, topicId, offset, limit: 50, ...(cursor ? { cursor } : {}) });
      if (!currentCatalog(pending)) return;
      const catalog = notesResponse?.result ?? notesResponse;
      if (!Array.isArray(catalog?.notes)) throw new Error('The exact Topic Notes are unavailable.');
      if (catalog.offset !== offset || !Number.isSafeInteger(catalog.total) || catalog.total < 0 ||
          typeof catalog.hasMore !== 'boolean' || (catalog.hasMore && (!Number.isSafeInteger(catalog.nextOffset) || catalog.nextOffset <= offset || typeof catalog.cursor !== 'string'))) throw new Error('The Note page is unavailable; refresh Notes.');
      const fragment = document.createDocumentFragment();
      for (const note of catalog.notes) {
        if (note.sourceReference?.topicId !== topicId || typeof note.sourceReference?.referenceId !== 'string' || typeof note.path !== 'string' || typeof note.revision !== 'string') throw new Error('The exact Note reference is unavailable.');
        const row = element('li'); const button = element('button', `Read ${note.path}`); button.type = 'button';
        button.addEventListener('click', () => void openNote(note), { signal }); row.append(button); fragment.append(row);
      }
      cursor = catalog.cursor; nextOffset = catalog.hasMore ? catalog.nextOffset : null;
      catalogNotes = catalog.notes;
      previous.disabled = offset === 0; next.disabled = nextOffset === null;
      list.replaceChildren(fragment);
      status.textContent = catalog.notes.length ? `Notes ${offset + 1}–${offset + catalog.notes.length} of ${catalog.total}.` : 'No Notes in this Topic.';
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
      if (receipt.status === 'applied') content.textContent = receipt.text;
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
        const response = await host.request('command-center.v1.notes.browse', { schemaVersion: 1, topicId: descriptor.topicId, offset: pageOffset, limit: 50, ...(pageCursor ? { cursor: pageCursor } : {}) });
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
  back.addEventListener('click', () => { cancel(); host.navigation.openPage({ id: 'topics' }); }, { signal });
  history.addEventListener('click', () => { if (presented && readable() && topic?.topicId === topicId) { cancel(); host.navigation.openPage({ id: 'histories', params: { topicId } }); } }, { signal });
  refresh.addEventListener('click', () => void load(), { signal });
  previous.addEventListener('click', () => { offset = Math.max(0, offset - 50); void load({ retainSnapshot: true }); }, { signal });
  next.addEventListener('click', () => { if (nextOffset !== null) { offset = nextOffset; void load({ retainSnapshot: true }); } }, { signal });
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
      if (topicId === next.props.topicId && presented === next.presented) return;
      topicId = next.props.topicId; presented = next.presented; void load();
    },
    focus() { back.focus(); },
    dispose() { cancel(); creation?.dispose(); noteCreation?.dispose(); lifetime.abort(); unsubscribe(); unsubscribeDraft(); container.replaceChildren(); }
  };
}
