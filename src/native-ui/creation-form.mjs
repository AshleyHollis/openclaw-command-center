import { nativeMutation, nativeCreationRecovery, publishNativeState, subscribeNativeState, encodeNoteText, beginNativeNoteOperation, settleNativeNoteOperation } from './mutations.mjs';
import { FIRST_LIVE_FEATURES } from './release-scope.mjs';

function unavailableCreation(document, message) {
  const form = document.createElement('p'); form.textContent = message;
  return { form, sync() {}, dispose() {} };
}

/** Note creation shares the activation-owned Note draft and attempt owner. */
export function createNativeNoteCreationForm({ host, state, document, signal, presented, getTopic }) {
  if (!FIRST_LIVE_FEATURES.noteWrite) return unavailableCreation(document, 'Note authoring is not available in this release.');
  const topic = getTopic();
  const folders = topic.sourceReferences?.filter((reference) => reference.topicId === topic.topicId && reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
  const folder = folders?.length === 1 && typeof folders[0].referenceId === 'string' && folders[0].referenceId ? folders[0] : null;
  const key = JSON.stringify(['create', topic.topicId, folder?.referenceId]);
  let draft = state.drafts.get(key);
  if (!draft) { draft = { path: '', text: '', baseText: '', baseRevision: '', version: 0, operation: null }; state.drafts.set(key, draft); }
  let request = new AbortController(); let disposed = false;
  const element = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const form = element('form');
  const pathLabel = element('label', 'New Note path (required)');
  const path = element('input'); path.type = 'text'; path.required = true; path.value = draft.path; pathLabel.append(path);
  const textLabel = element('label', 'New Note content');
  const text = element('textarea'); text.rows = 8; text.style.inlineSize = '100%'; text.style.boxSizing = 'border-box'; text.value = draft.text; textLabel.append(text);
  const status = element('p'); status.dataset.noteCreationState = ''; status.setAttribute('role', 'status'); status.id = `native-note-create-${crypto.randomUUID()}`; status.tabIndex = -1;
  path.setAttribute('aria-describedby', status.id); text.setAttribute('aria-describedby', status.id);
  const submit = element('button', 'Create Note'); submit.type = 'submit';
  const check = element('button', 'Check creation outcome'); check.type = 'button';
  form.append(element('h2', 'New Note'), pathLabel, textLabel, submit, check, status,
    element('p', 'Use a relative Markdown path, such as nested/brief.md. Creation drafts and uncertain inputs last only during this plugin activation; reloading or reconnecting loses them. Check an uncertain outcome before another creation.'));
  const readable = () => !disposed && !signal.aborted && presented() && state.active && host.connection.connected && host.connection.canRead;
  const checkable = () => readable() && host.connection.canWrite && typeof host.httpRequest === 'function';
  const writable = () => checkable() && folder && getTopic()?.topicId === topic.topicId && getTopic()?.usable === true && getTopic()?.lifecycle === 'active';
  function sync() {
    if (!checkable()) { request.abort(); request = new AbortController(); }
    submit.disabled = !writable() || !!draft.operation || !!draft.created;
    path.readOnly = !writable() || !!draft.operation; text.readOnly = !readable();
    check.hidden = !draft.operation?.unknown; check.disabled = !checkable() || !!draft.operation?.attempt;
    status.textContent = draft.operation ? draft.operation.checking ? 'Checking Note creation outcome…' : draft.operation.unknown ? `Note creation outcome is unknown (${draft.operation.input.logicalOperationId}). Check creation outcome before another creation.` : 'Creating Note…'
      : draft.created ? `Note created and verified: ${draft.created.path}. Your current text is retained; refresh Notes to open it, or change the path to create another Note.`
        : !writable() ? 'An exact Note Folder and active Topic with write access are required to create a Note.' : '';
    if (draft.error) status.textContent += ` ${draft.error}`;
  }
  async function submitNote(reconcileOnly = false) {
    if (reconcileOnly ? !checkable() || !draft.operation?.unknown || draft.operation.attempt : !writable() || draft.operation || draft.created) return;
    path.setCustomValidity(!draft.path || draft.path.startsWith('/') || draft.path.split('/').some((part) => !part || part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/u.test(draft.path) || !draft.path.endsWith('.md') ? 'Use a relative .md path without empty segments, traversal or control characters.' : '');
    if (!reconcileOnly && !form.reportValidity()) return;
    const focusControl = reconcileOnly ? check : submit; const restoreFocus = document.activeElement === focusControl;
    try {
      const operation = reconcileOnly ? draft.operation : beginNativeNoteOperation(state, key, draft, { schemaVersion: 1, action: 'notes.create', topicId: topic.topicId, referenceId: folder.referenceId, path: draft.path, contentBase64: encodeNoteText(draft.text), expectedTopicRevision: getTopic().revision, logicalOperationId: crypto.randomUUID() });
      if (restoreFocus) status.focus();
      const pending = settleNativeNoteOperation({ state, key, draft, operation, host, signal: AbortSignal.any([signal, request.signal]), reconcile: reconcileOnly });
      sync(); await pending;
    } catch (error) { if (readable()) { draft.error = host.redact(error.message); sync(); } }
    finally { if (readable() && restoreFocus && document.activeElement === status) { const target = !check.hidden && !check.disabled ? check : submit; if (!target.disabled) target.focus(); } }
  }
  path.addEventListener('input', () => { if (draft.operation) return; draft.path = path.value; draft.created = null; draft.error = ''; path.setCustomValidity(''); sync(); }, { signal });
  text.addEventListener('input', () => { draft.text = text.value; draft.version++; }, { signal });
  form.addEventListener('submit', (event) => { event.preventDefault(); void submitNote(); }, { signal });
  check.addEventListener('click', () => void submitNote(true), { signal });
  const unsubscribe = subscribeNativeState(state, () => { if (!disposed && !signal.aborted) sync(); });
  sync();
  return { form, sync, dispose() { disposed = true; unsubscribe(); request.abort(); } };
}

/** Domain creation stays behind authenticated HTTP; only the host owns Chat. */
export function createNativeCreationForm({ host, state, document, signal, presented, getTopic, onCreated, beginNavigation = () => () => true }) {
  const conversation = typeof getTopic === 'function';
  if (!conversation && !FIRST_LIVE_FEATURES.topicProvisioning) return unavailableCreation(document, 'New Topic creation is not available in this release.');
  if (conversation && !FIRST_LIVE_FEATURES.conversations) return unavailableCreation(document, 'Conversation creation is not available in this release.');
  const kind = conversation ? 'Conversation' : 'Topic';
  const key = conversation ? `conversation:${getTopic().topicId}` : 'topic';
  const topicId = conversation ? getTopic().topicId : null;
  const operations = state.creations;
  let request = new AbortController();
  let disposed = false;
  let inspection = conversation ? 'unchecked' : 'clear';
  let inspectionFailure = false;
  let recoveryAttempt = null;
  let recoveryError = '';
  let writeAuthority = new AbortController();
  let writeAuthorityAvailable = host.connection.canWrite !== false;
  const form = document.createElement('form');
  const title = document.createElement('h2'); title.textContent = `New ${kind}`;
  const label = document.createElement('label'); label.textContent = conversation ? 'Conversation label' : 'Topic name (required)';
  const name = document.createElement('input'); name.type = 'text'; name.required = !conversation; label.append(name);
  const categoryLabel = document.createElement('label'); categoryLabel.textContent = 'PARA Category';
  const category = document.createElement('select');
  for (const [value, text] of [['project', 'Project'], ['area', 'Area'], ['resource', 'Resource']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; category.append(option);
  }
  categoryLabel.append(category);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.id = `native-create-${crypto.randomUUID()}`; status.tabIndex = -1;
  name.setAttribute('aria-describedby', status.id);
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = `Create ${kind}`;
  const recoveryButton = (text) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; return node; };
  const inspect = recoveryButton('Refresh creation status');
  const check = recoveryButton('Check creation outcome');
  const open = recoveryButton('Open created Conversation');
  const acknowledge = recoveryButton('Acknowledge created Conversation');
  form.append(title, label, ...(conversation ? [] : [categoryLabel]), submit, ...(conversation ? [inspect, check, open, acknowledge] : []), status);
  const existing = operations.get(key);
  if (existing) { name.value = existing.input.label ?? existing.input.name ?? ''; category.value = existing.input.paraCategory ?? 'project'; }
  // Frame grants are asset authority, not mutation authority. Retained writes
  // are authenticated again by the declared HTTP route and the Session bridge
  // owner, so the UI must not infer route write access from host frame flags.
  const allowed = () => state.active && !disposed && !signal.aborted && !host.signal?.aborted && presented() && host.connection.connected && host.connection.canRead && host.connection.canWrite !== false && typeof host.httpRequest === 'function' && (!conversation || getTopic()?.topicId === topicId && getTopic()?.usable === true && getTopic()?.lifecycle === 'active');
  const restoreActionFocus = () => {
    if (!allowed() || !status.matches(':focus')) return;
    const target = (conversation ? [check, open, submit, inspect] : [submit]).find(button => !button.hidden && !button.disabled);
    target?.focus();
  };
  function sync() {
    if (!allowed()) {
      if (conversation) { inspection = 'unavailable'; inspectionFailure = false; }
      request.abort(); request = new AbortController();
    }
    const currentlyWritable = host.connection.canWrite !== false;
    if (writeAuthorityAvailable && !currentlyWritable) { writeAuthority.abort(); writeAuthority = new AbortController(); }
    writeAuthorityAvailable = currentlyWritable;
    const operation = operations.get(key);
    submit.disabled = !allowed() || !!operation || inspection !== 'clear' || !!recoveryAttempt;
    if (conversation) {
      name.readOnly = !!operation || !allowed();
      inspect.disabled = !allowed() || !!recoveryAttempt || !!operation?.attempt;
      check.hidden = !operation?.unknown || inspection === 'blocked'; check.disabled = !allowed() || !!recoveryAttempt || !!operation?.attempt;
      open.hidden = !operation?.result || inspection === 'blocked'; open.disabled = !allowed() || !!recoveryAttempt;
      acknowledge.hidden = open.hidden; acknowledge.disabled = open.disabled || !!operation?.attempt;
    }
    if (conversation && inspection === 'blocked') status.textContent = 'Conversation creation is blocked by another operator’s unresolved creation. That operator must resolve it before a new creation.';
    else if (conversation && recoveryAttempt) status.textContent = recoveryAttempt.action.endsWith('.inspect') ? 'Inspecting server creation status…' : recoveryAttempt.action.endsWith('.acknowledge') ? 'Acknowledging created Conversation…' : 'Checking Conversation creation outcome…';
    else if (operation?.result) status.textContent = `Conversation created and verified (${operation.input.logicalOperationId}). Open the created Conversation or acknowledge it before creating another.`;
    else if (operation) status.textContent = operation.unknown ? `${kind} creation outcome is unknown (${operation.input.logicalOperationId}). Check creation outcome before another creation.` : `Creating ${kind}…`;
    else if (!allowed()) status.textContent = `Connect with authenticated access and an available ${conversation ? 'Topic' : 'native HTTP connection'} to create a ${kind}.`;
    else if (conversation && inspection !== 'clear') status.textContent = 'Creation status is unavailable. Refresh creation status before starting another Conversation.';
    else if (conversation) status.textContent = '';
    else if (status.textContent.startsWith(`Creating ${kind}`) || status.textContent.includes('creation outcome is unknown')) status.textContent = '';
    if (conversation && recoveryError) status.textContent += ` ${recoveryError}`;
  }
  async function recover(action) {
    const operation = operations.get(key);
    if (!allowed() || recoveryAttempt || operation?.attempt) return;
    const inspecting = action.endsWith('.inspect');
    if (!inspecting && (inspection === 'blocked' || !operation || action.endsWith('.reconcile') && !operation.unknown || action.endsWith('.acknowledge') && !operation.result)) return;
    const control = inspecting ? inspect : action.endsWith('.reconcile') ? check : acknowledge;
    const restoreFocus = control.matches(':focus');
    if (restoreFocus) status.focus();
    const attempt = { action }; recoveryAttempt = attempt; recoveryError = '';
    const pendingSignal = AbortSignal.any([signal, request.signal, writeAuthority.signal, ...(host.signal ? [host.signal] : [])]);
    const owns = () => state.active && recoveryAttempt === attempt && operations.get(key) === operation;
    const interrupted = () => {
      if (recoveryAttempt !== attempt) return;
      recoveryAttempt = null; inspection = 'unavailable'; inspectionFailure = false;
      if (state.active && !disposed && !signal.aborted) sync();
    };
    pendingSignal.addEventListener('abort', interrupted, { once: true });
    sync();
    try {
      const input = { schemaVersion: 1, action, topicId, ...(!inspecting ? { logicalOperationId: operation.input.logicalOperationId } : {}), ...(action.endsWith('.acknowledge') ? { referenceId: operation.result.referenceId } : {}) };
      const receipt = await nativeCreationRecovery(host, input, pendingSignal);
      if (!owns() || pendingSignal.aborted || !allowed()) return;
      if (receipt.status === 'clear' || receipt.status === 'blocked') {
        // A clear inspection is not proof that a local interrupted dispatch
        // cannot still claim the server fence. Keep its original intent.
        inspection = receipt.status; inspectionFailure = false;
      } else if (receipt.status === 'acknowledged') {
        operations.delete(key); inspection = 'clear'; inspectionFailure = false; form.reset();
      } else {
        if (operation && receipt.logicalOperationId !== operation.input.logicalOperationId) throw new Error('Server creation identity differs from the retained operation. Refresh the Topic; no new creation is allowed.');
        const recoveredInput = operation?.input ?? Object.freeze({ schemaVersion: 1, action: 'conversations.create', topicId, logicalOperationId: receipt.logicalOperationId, expectedRevision: receipt.result.expectedTopicRevision, ...(receipt.result.label ? { label: receipt.result.label } : {}) });
        if (inspecting && operation && (receipt.result.expectedTopicRevision !== operation.input.expectedRevision || operation.input.label !== undefined && receipt.result.label !== operation.input.label)) throw new Error('Server creation intent differs from the retained operation.');
        const retained = operation ?? { input: recoveredInput };
        retained.unknown = receipt.status === 'unknown';
        if (receipt.status === 'applied') retained.result = { ...receipt.result, action: 'conversations.create' };
        operations.set(key, retained); name.value = recoveredInput.label ?? receipt.result.label ?? ''; inspection = 'clear'; inspectionFailure = false;
      }
    } catch (error) {
      if (!owns() || pendingSignal.aborted || !allowed()) return;
      inspection = 'unavailable'; inspectionFailure = true; recoveryError = host.redact(error.message);
    } finally {
      pendingSignal.removeEventListener('abort', interrupted);
      const currentAttempt = recoveryAttempt === attempt && !pendingSignal.aborted;
      if (recoveryAttempt === attempt) recoveryAttempt = null;
      if (state.active && !disposed && !signal.aborted) { publishNativeState(state); sync(); }
      if (currentAttempt && restoreFocus) restoreActionFocus();
    }
  }
  inspect.addEventListener('click', () => void recover('conversations.creation.inspect'), { signal });
  check.addEventListener('click', () => void recover('conversations.creation.reconcile'), { signal });
  acknowledge.addEventListener('click', () => void recover('conversations.creation.acknowledge'), { signal });
  open.addEventListener('click', async () => {
    const operation = operations.get(key);
    if (!allowed() || recoveryAttempt || inspection === 'blocked' || !operation?.result) return;
    const currentNavigation = beginNavigation();
    if (!currentNavigation()) return;
    try { await onCreated(operation.result, operation.input); }
    catch (error) { if (allowed() && operations.get(key) === operation && currentNavigation()) { recoveryError = host.redact(error.message); sync(); } }
  }, { signal });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!allowed() || operations.has(key) || inspection !== 'clear' || recoveryAttempt) return;
    const text = name.value.trim().normalize('NFC');
    name.setCustomValidity(!conversation && (!text || ['.', '..'].includes(text) || /[\\/\u0000-\u001f\u007f]/u.test(text) || new TextEncoder().encode(text).length > 255) ? 'Use a Topic name of at most 255 UTF-8 bytes without path separators or control characters.' : '');
    if (!form.reportValidity()) return;
    const input = { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), ...(conversation
      ? { action: 'conversations.create', topicId: getTopic().topicId, expectedRevision: getTopic().revision, ...(text ? { label: text } : {}) }
      : { action: 'create', topicId: crypto.randomUUID(), name: text, paraCategory: category.value }) };
    const restoreSubmitFocus = submit.matches(':focus');
    const attempt = {};
    const operation = { input: Object.freeze(input), attempt }; operations.set(key, operation); recoveryError = ''; sync();
    if (restoreSubmitFocus) status.focus();
    const submissionSignal = AbortSignal.any([signal, writeAuthority.signal, ...(host.signal ? [host.signal] : [])]);
    const navigationCurrent = beginNavigation();
    const owns = () => state.active && operations.get(key) === operation && operation.attempt === attempt;
    const interrupted = () => {
      if (!owns()) return;
      operation.unknown = true;
      operation.attempt = null;
      publishNativeState(state);
    };
    submissionSignal.addEventListener('abort', interrupted, { once: true });
    try {
      let result;
      if (conversation) {
        await host.request('command-center.v1.sessions.create', {
          schemaVersion: 1,
          logicalOperationId: input.logicalOperationId,
          topicId: input.topicId,
          expectedRevision: input.expectedRevision,
          ...(input.label === undefined ? {} : { label: input.label }),
          isPrimary: false
        });
        // Publish the completed native receipt through the declared POST
        // boundary. The durable owner replays the exact operation here and
        // therefore cannot redispatch a native Session creation.
        result = await nativeMutation(host, '/plugins/command-center/api/topic/actions', input, submissionSignal);
      } else {
        result = await nativeMutation(host, '/plugins/command-center/api/topics/actions', input, submissionSignal);
      }
      // A retiring view cannot settle a replacement view's operation, even if
      // the transport ignores cancellation and eventually supplies a receipt.
      if (!owns()) return;
      if (submissionSignal.aborted || !allowed()) { interrupted(); return; }
      const responseBody = result?.value ?? result;
      const rawCreationReceipt = responseBody?.result ?? responseBody;
      const creationReceipt = conversation ? { ...rawCreationReceipt,
        referenceId: rawCreationReceipt?.referenceId ?? rawCreationReceipt?.sourceReference?.referenceId } : rawCreationReceipt;
      if (conversation ? creationReceipt?.action !== input.action || creationReceipt?.topicId !== input.topicId || typeof creationReceipt?.referenceId !== 'string' || !creationReceipt.referenceId : creationReceipt?.topicId !== input.topicId || creationReceipt?.status !== 'applied') {
        throw Object.assign(new Error('The creation receipt is incomplete. Source Recovery is required.'), { unknownOutcome: true });
      }
      if (conversation) { operation.result = creationReceipt; operation.unknown = false; operation.attempt = null; }
      else operations.delete(key);
      if (!allowed() || submissionSignal.aborted) return;
      form.reset(); status.textContent = `${kind} created and verified.`;
      if (!navigationCurrent()) return;
      try { await onCreated(creationReceipt, input); }
      catch (error) { if (allowed() && error?.name !== 'AbortError') status.textContent = `${kind} created. ${host.redact(error.message || 'Its destination could not be opened.')}`; }
    } catch (error) {
      if (!owns()) return;
      // Once an authenticated Conversation dispatch starts, any transport
      // rejection can follow a committed native effect. Retain the original
      // operation and base revision until explicit server reconciliation.
      if (conversation || error.unknownOutcome || submissionSignal.aborted) { operation.unknown = true; operation.attempt = null; }
      else { operations.delete(key); if (conversation) inspection = 'unavailable'; }
      if (!disposed && !signal.aborted && presented()) status.textContent = host.redact(error.message);
    } finally {
      submissionSignal.removeEventListener('abort', interrupted);
      publishNativeState(state);
      if (restoreSubmitFocus && navigationCurrent() && (operations.get(key) === operation || !operations.has(key))) restoreActionFocus();
    }
  }, { signal });
  name.addEventListener('input', () => name.setCustomValidity(''), { signal });
  const unsubscribe = subscribeNativeState(state, sync);
  sync();
  if (conversation && allowed()) void recover('conversations.creation.inspect');
  return { form, sync, dispose() { disposed = true; unsubscribe(); request.abort(); } };
}
