import { attentionStyles } from './attention-styles.mjs';
import { validatedOutlookWebLink } from './outlook-web-link.mjs';

const text = (value) => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const nonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
const unwrap = (response) => response?.result ?? response;

/** One exact notification destination, using the existing authenticated Attention owner. */
export function mountAttentionPage(container, context, operations = new Map(), pageMode = 'dashboard') {
  const host = context.host;
  const document = container.ownerDocument;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  let presented = context.presented;
  let recordId = context.props.notificationRecord;
  let topicFilter = context.props.topicId;
  let generation = 0;
  let selected;
  const transientUiState = { disclosures: new Set(), focusKey: null, scrollTop: 0, windowScrollY: 0, laneScroll: new Map(), planner: { search: '', topic: topicFilter ?? '', state: '', importance: '', view: 'board' } };
  const quickCaptureKey = 'command-center.quick-capture.v1';
  const emptyQuickCaptureDraft = () => ({ kind: 'task', topicId: '', title: '' });
  const readQuickCaptureState = () => {
    try {
      const value = JSON.parse(localStorage.getItem(quickCaptureKey) ?? 'null');
      const draft = value?.draft;
      const operation = value?.operation;
      const validDraft = draft && ['task', 'idea', 'note'].includes(draft.kind) && typeof draft.topicId === 'string' && typeof draft.title === 'string' && draft.title.length <= 300;
      const params = operation?.params;
      const captureOperation = operation?.method === 'command-center.v1.open-loops.capture' && typeof params.captureId === 'string' && typeof params.capturedAt === 'string' && ['task', 'idea'].includes(params.captureKind) && typeof params.title === 'string';
      const noteOperation = operation?.method === 'command-center.v1.notes.create' && typeof params.referenceId === 'string' && typeof params.path === 'string' && typeof params.text === 'string';
      const validOperation = operation && typeof operation.draftKey === 'string' && params?.schemaVersion === 1 && typeof params.logicalOperationId === 'string' && typeof params.topicId === 'string' && (captureOperation || noteOperation);
      return { draft: validDraft ? draft : emptyQuickCaptureDraft(), operation: validOperation ? operation : undefined };
    } catch { return { draft: emptyQuickCaptureDraft(), operation: undefined }; }
  };
  const initialQuickCapture = readQuickCaptureState();
  let quickCaptureDraft = initialQuickCapture.draft;
  let quickCaptureOperation = initialQuickCapture.operation;
  const saveQuickCaptureState = () => {
    try { localStorage.setItem(quickCaptureKey, JSON.stringify({ draft: quickCaptureDraft, ...(quickCaptureOperation ? { operation: quickCaptureOperation } : {}) })); }
    catch { /* retry identity remains available for this mounted plugin lifetime */ }
  };
  const preferenceKey = 'command-center.dashboard.preferences.v1';
  const defaultSectionOrder = ['briefings', 'topic', 'coverage', 'upcoming', 'waiting', 'review', 'someday', 'activity'];
  const readDashboardPreferences = () => {
    try {
      const value = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null');
      const rightOrder = Array.isArray(value?.rightOrder) ? [...new Set(value.rightOrder.filter(key => defaultSectionOrder.includes(key))), ...defaultSectionOrder.filter(key => !value.rightOrder.includes(key))] : defaultSectionOrder;
      return { rightOrder, hidden: Array.isArray(value?.hidden) ? value.hidden.filter(key => defaultSectionOrder.includes(key)) : [], pinnedTopicId: nonBlank(value?.pinnedTopicId) ? value.pinnedTopicId : null };
    } catch { return { rightOrder: defaultSectionOrder, hidden: [], pinnedTopicId: null }; }
  };
  let dashboardPreferences = readDashboardPreferences();
  const saveDashboardPreferences = () => { try { localStorage.setItem(preferenceKey, JSON.stringify(dashboardPreferences)); } catch { /* browser storage may be unavailable */ } };
  const element = (tag, value) => { const node = document.createElement(tag); if (value) node.textContent = value; return node; };
  const heading = element('h1', pageMode === 'planner' ? 'Planner' : 'Command Center');
  const titleGroup = element('div'); titleGroup.className = 'cc-title-group';
  const eyebrow = element('p', pageMode === 'planner' ? 'Plan and review' : 'Your daily workspace'); eyebrow.className = 'cc-eyebrow';
  const subtitle = element('p', pageMode === 'planner' ? 'See every commitment without crowding today.' : 'Act on what matters now, then use your dashboards for context.'); subtitle.className = 'cc-subtitle';
  titleGroup.append(eyebrow, heading, subtitle);
  const status = element('p'); status.className = 'cc-status'; status.setAttribute('role', 'status'); status.tabIndex = -1;
  const refresh = element('button', pageMode === 'planner' ? 'Refresh Planner' : 'Refresh Dashboard'); refresh.type = 'button';
  const topics = element('button', 'All Topics'); topics.type = 'button';
  const switchView = element('button', pageMode === 'planner' ? 'Open Dashboard' : 'Open Planner'); switchView.type = 'button';
  const intake = element('details'); intake.dataset.selectedDocumentIntake = 'true'; intake.append(element('summary', 'Import one selected document'));
  const content = element('section'); content.setAttribute('aria-label', 'Attention items'); content.style.overflowWrap = 'anywhere';
  const style = element('style');
  style.textContent = attentionStyles;
  const toolbar = element('div'); toolbar.className = 'cc-toolbar'; toolbar.append(topics, switchView, intake, refresh);
  const pageHeader = element('header'); pageHeader.className = 'cc-page-head'; pageHeader.append(titleGroup, toolbar);
  container.classList.add('cc-command-center-page');
  container.replaceChildren(style, pageHeader, status, content);
  const readable = () => host.connection.connected && host.connection.canRead;
  const current = (pending) => !signal.aborted && presented && readable() && pending === generation;
  const writable = () => !signal.aborted && presented && readable() && host.connection.canWrite;
  const report = (message) => { status.textContent = host.redact(message); };
  const setBusy = (busy) => { content.setAttribute('aria-busy', String(busy)); refresh.disabled = busy; };
  const disclosureKey = node => {
    const owner = node.closest('[data-open-loop-id],[data-workspace-loop-id]');
    const identity = owner?.dataset.openLoopId ?? owner?.dataset.workspaceLoopId ?? '';
    const named = node.dataset.workspaceSection ?? node.dataset.openLoopGroup ?? node.dataset.dashboardSection ?? Object.keys(node.dataset).sort().find(key => node.dataset[key] === 'true') ?? '';
    return `${identity}|${named}|${node.querySelector(':scope > summary')?.textContent ?? ''}`;
  };
  const focusKey = node => {
    if (!node || !container.contains(node)) return null;
    const owner = node.closest('[data-open-loop-id],[data-workspace-loop-id]');
    const identity = owner?.dataset.openLoopId ?? owner?.dataset.workspaceLoopId ?? '';
    return `${identity}|${node.getAttribute('aria-label') ?? node.closest('label')?.firstChild?.textContent?.trim() ?? ''}|${node.name ?? ''}|${node.textContent?.trim() ?? ''}`;
  };
  const captureTransientUiState = () => {
    transientUiState.disclosures = new Set([...content.querySelectorAll('details[open]')].map(disclosureKey));
    transientUiState.scrollTop = container.scrollTop;
    transientUiState.windowScrollY = document.defaultView?.scrollY ?? 0;
    transientUiState.laneScroll = new Map([...content.querySelectorAll('[data-board-lane]')].map(node => [node.dataset.boardLane, node.scrollTop]));
    transientUiState.focusKey = focusKey(document.activeElement);
  };
  const restoreTransientUiState = () => {
    for (const node of content.querySelectorAll('details')) if (transientUiState.disclosures.has(disclosureKey(node))) node.open = true;
    for (const node of content.querySelectorAll('[data-board-lane]')) node.scrollTop = transientUiState.laneScroll.get(node.dataset.boardLane) ?? 0;
    container.scrollTop = transientUiState.scrollTop;
    document.defaultView?.scrollTo?.({ top: transientUiState.windowScrollY, behavior: 'auto' });
    if (transientUiState.focusKey) [...content.querySelectorAll('button,input,select,textarea,summary,a[href]')].find(node => focusKey(node) === transientUiState.focusKey)?.focus({ preventScroll: true });
  };

  const formatInstant = value => {
    if (!nonBlank(value) || Number.isNaN(Date.parse(value))) return value;
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  };
  const formatDue = value => nonBlank(value?.dueDate)
    ? `${value.dueDate} (${value.dueTimeZone}, calendar date)`
    : nonBlank(value?.dueAt) ? formatInstant(value.dueAt) : null;

  function renderEvidence(disclosure, detail) {
    disclosure.replaceChildren(element('summary', 'Source evidence'));
    const loop = detail?.loop;
    if (nonBlank(loop?.expectedEvent)) disclosure.append(element('p', `Expected next event: ${loop.expectedEvent}`));
    if (nonBlank(loop?.reviewAt)) disclosure.append(element('p', `Review after ${formatInstant(loop.reviewAt)}`));
    const evidence = Array.isArray(detail?.evidence) ? detail.evidence : [];
    if (evidence.length === 0) {
      disclosure.append(element('p', 'No readable source facts are currently available. The source may be unavailable or require a separately authorized reader.'));
      return;
    }
    for (const item of evidence) {
      const article = element('article');
      article.append(element('h5', nonBlank(item.summary) ? item.summary : `${item.type ?? 'Evidence'} from ${item.sourceKind ?? item.sourceSystem ?? 'source'}`));
      const source = [item.sourceSystem, item.sourceKind, item.sourceVersion].filter(nonBlank).join(' · ');
      if (source) article.append(element('p', `Source: ${source}`));
      const timing = [nonBlank(item.occurredAt) ? `Occurred ${formatInstant(item.occurredAt)}` : null, nonBlank(item.observedAt) ? `Observed ${formatInstant(item.observedAt)}` : null, item.historicalBaseline === true ? 'Historical baseline' : null].filter(Boolean);
      if (timing.length) article.append(element('p', timing.join(' · ')));
      const facts = [
        ['Payee', item.payee], ['Purpose', item.purpose], ['Invoice', item.invoiceId], ['Account', item.accountId],
        ['Amount', Number.isSafeInteger(item.amount) && nonBlank(item.currency) ? `${item.currency} ${(item.amount / 100).toFixed(2)}` : null],
        ['Due', formatDue(item)], ['Extraction', item.extractionStatus], ['Pages', Array.isArray(item.pageEvidence) && item.pageEvidence.length ? item.pageEvidence.join(', ') : null], ['Event', item.eventKind],
        ['Requirement', nonBlank(item.requirementKind) && nonBlank(item.requirementId) ? `${item.requirementKind}: ${item.requirementId}` : null],
        ['Stage', nonBlank(item.stageId) ? item.stageId : null], ['Choice', item.chosenOption],
        ['Recorded choice', item.recordedChoice], ['Observed choice', item.observedChoice], ['Rationale', item.rationale], ['Assumption', item.assumption],
        ['Assessment', item.assessment], ['Delivered items', Array.isArray(item.fulfilledItemIds) ? item.fulfilledItemIds.join(', ') : null], ['Outstanding items', Array.isArray(item.outstandingItemIds) ? item.outstandingItemIds.join(', ') : null], ['Expected update', item.expectedAt ? formatInstant(item.expectedAt) : null], ['Operator note', item.note], ['Status', item.status]
      ].filter(([, value]) => value !== undefined && value !== null && value !== '');
      if (facts.length) {
        const list = element('dl');
        for (const [label, value] of facts) list.append(element('dt', label), element('dd', String(value)));
        article.append(list);
      }
      if (item.extractionStatus === 'pdf-text-extracted') article.append(element('p', 'PDF text extraction is a suggestion. Verify the original before confirming or correcting the obligation.'));
      if (item.sourceAvailable === false) article.append(element('p', 'The original source is currently unavailable. This does not mean the open loop is complete.'));
      const exactNote = item.sourceKind === 'email' && nonBlank(item.sourceReferenceVersion);
      const evidenceRevision = exactNote ? item.sourceReferenceVersion : item.sourceVersion;
      const navigableSource = ((item.sourceKind === 'document' && item.sourceAvailable !== false) || exactNote) && nonBlank(item.topicId) && item.topicId === loop?.topicId && nonBlank(item.sourceReferenceId) && nonBlank(item.sourcePath) && nonBlank(evidenceRevision);
      if (navigableSource) {
        const open = element('button', exactNote ? 'Open supporting Note' : 'Open original'); open.type = 'button';
        open.addEventListener('click', async () => {
          if (!readable() || open.disabled) return;
          open.disabled = true;
          try {
            const response = await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId: item.topicId });
            if (!readable() || unwrap(response)?.topic?.topicId !== item.topicId) throw new Error('The exact source Topic is unavailable.');
            host.navigation.openPage({ id: 'topic', params: { topicId: item.topicId, sourceReferenceId: item.sourceReferenceId, sourcePath: item.sourcePath, evidenceSourceVersion: evidenceRevision } });
          } catch (error) { report(error?.message || 'The original source is unavailable.'); }
          finally { open.disabled = false; }
        }, { signal });
        article.append(open);
        if (exactNote) article.append(element('p', 'The Topic reader checks the retained Note revision and reports if the Note is missing or has changed.'));
      }
      if (item.sourceKind === 'email') {
        let outlookUrl;
        try { outlookUrl = validatedOutlookWebLink(item.originalEmailUrl); } catch { /* absent or unsafe reader destination */ }
        if (item.originalEmailStatus === 'unavailable') article.append(element('p', 'Original Outlook email was unavailable at the last exact lookup. The supporting Note can still be checked independently.'));
        else if (outlookUrl && item.originalEmailStatus === 'available') {
          const openEmail = element('a', 'Open original email in Outlook');
          openEmail.href = outlookUrl; openEmail.target = '_blank'; openEmail.rel = 'noopener noreferrer';
          article.append(openEmail, element('p', 'Outlook will verify your access. This link has not been checked for current availability.'));
        } else article.append(element('p', 'Original Outlook email link unavailable. The supporting Note remains available when its exact revision can be verified.'));
      }
      disclosure.append(article);
    }
    if (!evidence.some(item => ((item.sourceKind === 'document' && item.sourceAvailable !== false) || item.sourceKind === 'email') && item.topicId === loop?.topicId && nonBlank(item.sourceReferenceId) && nonBlank(item.sourcePath) && nonBlank(item.sourceKind === 'email' ? item.sourceReferenceVersion : item.sourceVersion))) {
      disclosure.append(element('p', 'This evidence has no currently authorized exact reader destination. Use the displayed source system, kind, and version to verify it in its source.'));
    }
  }

  async function submitOpenLoopOperation({ key, method, params, card, pending, success, includeLoopId = true }) {
    const operation = operations.get(key) ?? { method, params: { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), ...(includeLoopId ? { loopId: card.loopId } : {}), expectedRevision: card.revision, ...params } };
    operations.set(key, operation);
    const envelope = await host.request(operation.method, operation.params);
    const response = unwrap(envelope);
    if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || response?.loop?.loopId !== card.loopId) throw new Error('The action outcome is not confirmed. Retry to reconcile the same operation.');
    if (!current(pending)) return false;
    operations.delete(key);
    await load();
    if (!signal.aborted && presented && readable()) report(success);
    return true;
  }

  function renderQuickCapture(parent, dashboard, pending) {
    const module = element('section'); module.className = 'cc-module cc-quick-capture'; module.dataset.quickCapture = 'true';
    module.append(element('h3', 'Quick capture'), element('p', 'Capture an explicit task, park an idea, or save a quiet note in one Topic.'));
    const form = element('form');
    const kindLabel = element('label', 'Type '); const kind = element('select');
    for (const [value, label] of [['task', 'Task'], ['idea', 'Idea'], ['note', 'Note']]) { const option = element('option', label); option.value = value; kind.append(option); }
    kind.value = quickCaptureDraft.kind; kindLabel.append(kind);
    const topicLabel = element('label', ' Topic '); const topic = element('select');
    for (const item of dashboard.topics ?? []) { const option = element('option', item.name ?? item.topicId); option.value = item.topicId; topic.append(option); }
    if (!quickCaptureDraft.topicId && topic.options.length) quickCaptureDraft.topicId = topic.options[0].value;
    topic.value = quickCaptureDraft.topicId; topicLabel.append(topic);
    const titleLabel = element('label', ' What should be remembered? '); const title = element('input'); title.type = 'text'; title.required = true; title.maxLength = 300; title.value = quickCaptureDraft.title; titleLabel.append(title);
    const unchangedPending = () => quickCaptureOperation?.draftKey === JSON.stringify(quickCaptureDraft);
    const buttonLabel = () => unchangedPending() ? (quickCaptureDraft.kind === 'note' ? 'Retry note' : 'Retry capture') : quickCaptureDraft.kind === 'note' ? 'Save note' : 'Capture';
    const save = element('button', buttonLabel()); save.type = 'submit';
    const update = () => {
      quickCaptureDraft = { kind: kind.value, topicId: topic.value, title: title.value };
      save.textContent = buttonLabel();
      saveQuickCaptureState();
    };
    kind.addEventListener('change', update, { signal }); topic.addEventListener('change', update, { signal }); title.addEventListener('input', update, { signal });
    form.append(kindLabel, topicLabel, titleLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); update();
      if (!current(pending) || !writable() || save.disabled || !quickCaptureDraft.topicId || !quickCaptureDraft.title.trim()) return;
      save.disabled = true;
      try {
        const draftKey = JSON.stringify(quickCaptureDraft);
        if (!quickCaptureOperation || quickCaptureOperation.draftKey !== draftKey) {
          if (quickCaptureDraft.kind === 'note') {
            const topicResponse = unwrap(await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId: quickCaptureDraft.topicId }));
            const exactTopic = topicResponse?.topic;
            if (!current(pending) || exactTopic?.topicId !== quickCaptureDraft.topicId || !nonBlank(exactTopic.noteFolderReferenceId)) throw new Error('This Topic does not have an authorized Note Folder. The draft remains available.');
            const logicalOperationId = crypto.randomUUID();
            const day = new Date().toISOString().slice(0, 10);
            quickCaptureOperation = { draftKey, method: 'command-center.v1.notes.create', params: { schemaVersion: 1, logicalOperationId, topicId: quickCaptureDraft.topicId, referenceId: exactTopic.noteFolderReferenceId, path: `Inbox/${day}-${logicalOperationId.slice(0, 8)}.md`, text: `# ${quickCaptureDraft.title.trim()}\n` } };
          } else {
            quickCaptureOperation = { draftKey, method: 'command-center.v1.open-loops.capture', params: { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), captureId: crypto.randomUUID(), capturedAt: new Date().toISOString(), topicId: quickCaptureDraft.topicId, captureKind: quickCaptureDraft.kind, title: quickCaptureDraft.title.trim() } };
          }
          saveQuickCaptureState();
        }
        const response = await host.request(quickCaptureOperation.method, quickCaptureOperation.params);
        const result = unwrap(response);
        if (quickCaptureOperation.method === 'command-center.v1.notes.create') {
          const note = result?.value?.note ?? result?.note;
          if (note?.path !== quickCaptureOperation.params.path || note?.topicId !== undefined && note.topicId !== quickCaptureOperation.params.topicId) throw new Error('The note acknowledgement was incomplete. Retry the unchanged note.');
        } else if (!result?.loop?.loopId || result.loop.topicId !== quickCaptureOperation.params.topicId || !['confirmed', 'suggested'].includes(result.loop.state)) throw new Error('The quick-capture acknowledgement was incomplete. Retry the unchanged capture.');
        const completedKind = quickCaptureDraft.kind;
        quickCaptureOperation = undefined; quickCaptureDraft = { kind: quickCaptureDraft.kind, topicId: quickCaptureDraft.topicId, title: '' }; saveQuickCaptureState();
        await load(completedKind === 'note' ? 'Note saved quietly in the Topic. No obligation was created.' : completedKind === 'idea' ? 'Idea captured for bounded suggestion review.' : 'Task captured and acknowledged.');
      } catch (error) { if (current(pending)) report(error?.message || 'The capture outcome is unknown. Retry the unchanged capture.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    module.append(form); parent.append(module);
  }

  function configureSelectedDocumentIntake() {
    const form = element('form'); form.append(element('p', 'Choose one document already authorized for a Topic. Command Center reads its current bytes and revision; this form cannot supply document content.'));
    const topicLabel = element('label', 'Topic '); const topicChoice = element('select'); topicChoice.required = true; topicLabel.append(topicChoice);
    const loadDocuments = element('button', 'Load authorized documents'); loadDocuments.type = 'button';
    const documentLabel = element('label', ' Document '); const documentChoice = element('select'); documentChoice.required = true; documentLabel.append(documentChoice);
    const occurredLabel = element('label', ' Document date '); const occurredAt = element('input'); occurredAt.type = 'datetime-local'; occurredAt.required = true; occurredLabel.append(occurredAt);
    const baselineLabel = element('label', ' Historical baseline through '); const baselineThrough = element('input'); baselineThrough.type = 'datetime-local'; baselineThrough.required = true; baselineLabel.append(baselineThrough);
    const submit = element('button', 'Import selected document'); submit.type = 'submit';
    form.append(topicLabel, loadDocuments, documentLabel, occurredLabel, baselineLabel, submit); intake.append(form);
    let initialized = false; let documents = [];
    const setDocuments = notes => {
      documents = notes.filter(note => note?.sourceKind === 'document' && nonBlank(note.path) && nonBlank(note.sourceReference?.referenceId) && nonBlank(note.sourceReference?.sourceSystem) && note.sourceReference?.sourceKind === 'document');
      documentChoice.replaceChildren();
      for (const [index, note] of documents.entries()) { const option = element('option', note.path); option.value = String(index); documentChoice.append(option); }
      submit.disabled = documents.length === 0;
      if (!documents.length) report('No authorized persisted documents are available for this Topic.');
    };
    intake.addEventListener('toggle', async () => {
      if (!intake.open || initialized || !readable()) return; initialized = true; loadDocuments.disabled = true;
      try {
        const result = unwrap(await host.request('command-center.v1.topics.list', { schemaVersion: 1 }));
        const candidates = Object.values(result?.activeGroups ?? {}).flat().filter(topic => nonBlank(topic?.topicId));
        topicChoice.replaceChildren();
        for (const topic of candidates) { const option = element('option', nonBlank(topic.name) ? topic.name : topic.topicId); option.value = topic.topicId; topicChoice.append(option); }
        if (!candidates.length) { report('No active authorized Topic is available for document intake.'); return; }
        loadDocuments.disabled = false;
      } catch (error) { initialized = false; report(error?.message || 'Authorized Topics are unavailable.'); }
    }, { signal });
    loadDocuments.addEventListener('click', async () => {
      if (!readable() || !nonBlank(topicChoice.value) || loadDocuments.disabled) return; loadDocuments.disabled = true;
      try {
        const notes = []; let offset = 0; let cursor; let total; let snapshot;
        for (;;) {
          const result = unwrap(await host.request('command-center.v1.notes.browse', { schemaVersion: 1, topicId: topicChoice.value, offset, limit: 100, includeDocuments: true, ...(cursor ? { cursor } : {}) }));
          if (!Array.isArray(result?.notes) || result.offset !== offset || !Number.isSafeInteger(result.total) || result.total < 0 || typeof result.hasMore !== 'boolean') throw new Error('The authorized document catalog is unavailable.');
          if (total === undefined) { total = result.total; snapshot = result.cursor; }
          else if (result.total !== total || result.cursor !== snapshot) throw new Error('The authorized document catalog changed during retrieval. Retry.');
          notes.push(...result.notes);
          if (!result.hasMore) {
            if (notes.length !== total) throw new Error('The authorized document catalog is incomplete.');
            break;
          }
          if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset >= total || !nonBlank(result.cursor)) throw new Error('The authorized document catalog is incomplete.');
          offset = result.nextOffset; cursor = result.cursor;
        }
        setDocuments(notes);
      } catch (error) { setDocuments([]); report(error?.message || 'Authorized documents are unavailable.'); }
      finally { loadDocuments.disabled = false; }
    }, { signal });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const note = documents[Number(documentChoice.value)];
      if (!writable() || !note || !occurredAt.value || !baselineThrough.value || submit.disabled) return;
      submit.disabled = true;
      const key = `selected-document:${note.sourceReference.referenceId}:${note.path}`;
      try {
        let operation = operations.get(key);
        if (!operation) {
          operation = { method: 'command-center.v1.open-loops.intake-selected', params: { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), authorization: { sourceSystem: note.sourceReference.sourceSystem, sourceKind: 'document', resourceId: note.sourceReference.referenceId }, baselineThrough: new Date(baselineThrough.value).toISOString(), selections: [{ topicId: topicChoice.value, path: note.path, occurredAt: new Date(occurredAt.value).toISOString(), observedAt: new Date().toISOString() }] } };
          operations.set(key, operation);
        }
        const envelope = await host.request(operation.method, operation.params); const result = unwrap(envelope);
        if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || result?.schemaVersion !== 1 || !['available', 'unavailable'].includes(result?.freshness?.status)) throw new Error('The selected-document outcome is not confirmed. Retry to reconcile the same operation.');
        operations.delete(key); await load();
        report(result.freshness.status !== 'available'
          ? 'The source is unavailable; the obligation remains open with visible freshness evidence.'
          : result.results.some(item => item?.loop)
            ? 'The selected document was read and reconciled.'
            : 'The selected document was read, but no supported obligation was recognized. No Attention item was created.');
      } catch (error) { report(error?.message || 'The selected-document outcome is unknown. Retry the same operation.'); }
      finally { submit.disabled = documents.length === 0; }
    }, { signal });
  }
  configureSelectedDocumentIntake();

  function appendDecisionControls(row, card, pending) {
    if (!writable() || ['resolved', 'cancelled'].includes(card.state)) return;
    const disclosure = element('details'); disclosure.dataset.openLoopDecisions = 'true';
    disclosure.append(element('summary', card.state === 'suggested' ? 'Review suggestion' : 'Defer or resolve'));
    const form = element('form');
    const decisionLabel = element('label', 'Action '); const decision = element('select');
    const choices = card.state === 'suggested'
      ? [['confirm', 'Confirm this obligation'], ['dismiss', 'Dismiss this suggestion']]
      : [['defer', 'Defer until a review time'], ['correct-date', 'Correct the accepted due date'], ...(card.kind === 'payment' || card.kind === 'response' ? [] : [['resolve', 'Mark resolved']])];
    for (const [value, label] of choices) { const option = element('option', label); option.value = value; decision.append(option); }
    if (!choices.length) return;
    decisionLabel.append(decision);
    const reviewLabel = element('label', ' Review time '); const reviewAt = element('input'); reviewAt.type = 'datetime-local'; reviewLabel.append(reviewAt);
    const correctionLabel = element('label', ' Correct extracted fields '); const applyCorrections = element('input'); applyCorrections.type = 'checkbox'; correctionLabel.prepend(applyCorrections);
    const amountLabel = element('label', ' Corrected amount '); const amount = element('input'); amount.type = 'number'; amount.min = '0.01'; amount.step = '0.01'; if (Number.isSafeInteger(card.amount)) amount.value = (card.amount / 100).toFixed(2); amountLabel.append(amount);
    const currencyLabel = element('label', ' Corrected ISO code '); const currency = element('input'); currency.maxLength = 3; currency.value = nonBlank(card.currency) ? card.currency : 'AUD'; currencyLabel.append(currency);
    const correctDueLabel = element('label', ' Correct due date '); const correctDue = element('input'); correctDue.type = 'checkbox'; correctDueLabel.prepend(correctDue);
    const dateOnlyLabel = element('label', ' Calendar date only '); const dateOnly = element('input'); dateOnly.type = 'checkbox'; dateOnlyLabel.prepend(dateOnly);
    const dueLabel = element('label', ' Corrected due date and time '); const dueAt = element('input'); dueAt.type = 'datetime-local'; dueLabel.append(dueAt);
    const dueDateLabel = element('label', ' Corrected calendar date '); const dueDate = element('input'); dueDate.type = 'date'; dueDateLabel.append(dueDate);
    const rationaleLabel = element('label', ' Rationale '); const rationale = element('textarea'); rationale.required = true; rationale.maxLength = 1000; rationaleLabel.append(rationale);
    const update = () => {
      const deferred = decision.value === 'defer'; const suggestionCorrection = decision.value === 'confirm' && applyCorrections.checked; const correcting = decision.value === 'correct-date' || suggestionCorrection && correctDue.checked;
      reviewLabel.hidden = !deferred; reviewAt.required = deferred;
      correctionLabel.hidden = decision.value !== 'confirm';
      amountLabel.hidden = !suggestionCorrection; currencyLabel.hidden = !suggestionCorrection;
      correctDueLabel.hidden = !suggestionCorrection;
      amount.required = suggestionCorrection; currency.required = suggestionCorrection;
      dateOnlyLabel.hidden = !correcting;
      dueLabel.hidden = !correcting || dateOnly.checked; dueAt.required = correcting && !dateOnly.checked;
      dueDateLabel.hidden = !correcting || !dateOnly.checked; dueDate.required = correcting && dateOnly.checked;
    };
    decision.addEventListener('change', update, { signal }); applyCorrections.addEventListener('change', update, { signal }); correctDue.addEventListener('change', update, { signal }); dateOnly.addEventListener('change', update, { signal }); update();
    const save = element('button', 'Save action'); save.type = 'submit';
    form.append(decisionLabel, reviewLabel, correctionLabel, amountLabel, currencyLabel, correctDueLabel, dateOnlyLabel, dueLabel, dueDateLabel, rationaleLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!current(pending) || !writable() || save.disabled || !rationale.value.trim()) return;
      save.disabled = true;
      try {
        const review = decision.value === 'defer' ? new Date(reviewAt.value).toISOString() : undefined;
        const correcting = decision.value === 'correct-date' || decision.value === 'confirm' && applyCorrections.checked && correctDue.checked;
        const due = correcting && !dateOnly.checked ? new Date(dueAt.value).toISOString() : undefined;
        const calendarDue = correcting && dateOnly.checked ? dueDate.value : undefined;
        const dueTimeZone = calendarDue === undefined ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone;
        const correctedAmount = decision.value === 'confirm' && applyCorrections.checked ? Math.round(Number(amount.value) * 100) : undefined;
        const correctedCurrency = correctedAmount === undefined ? undefined : currency.value.trim().toUpperCase();
        if (correctedAmount !== undefined && (!Number.isSafeInteger(correctedAmount) || correctedAmount <= 0 || !/^[A-Z]{3}$/u.test(correctedCurrency))) throw new Error('Enter a positive corrected amount and three-letter currency.');
        await submitOpenLoopOperation({
          key: `open-loop-decision:${card.loopId}:${decision.value}`,
          method: 'command-center.v1.open-loops.decide',
          params: { decision: decision.value, ...(review === undefined ? {} : { reviewAt: review }), ...(due === undefined ? {} : { dueAt: due }), ...(calendarDue === undefined ? {} : { dueDate: calendarDue, dueTimeZone }), ...(correctedAmount === undefined ? {} : { amount: correctedAmount, currency: correctedCurrency }), rationale: rationale.value.trim() },
          card, pending,
          success: decision.value === 'defer' ? 'The item was deferred to the selected review time.' : decision.value === 'correct-date' ? 'The accepted due date was corrected.' : decision.value === 'confirm' ? 'The suggestion was confirmed.' : decision.value === 'dismiss' ? 'The suggestion was dismissed.' : 'The outcome was recorded.'
        });
      } catch (error) { if (current(pending)) report(error?.message || 'Action outcome is unknown. Retry to reconcile the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

  function renderActivity(records, pending, parent = content) {
    if (!records.length) return;
    const activity = element('section'); activity.className = 'cc-module'; activity.dataset.dashboardSection = 'activity'; activity.append(element('h2', 'Recent Activity'));
    for (const record of records) {
      const row = element('article'); row.className = 'cc-activity-card';
      const operation = nonBlank(record.operationKind) ? record.operationKind : nonBlank(record.actionId) ? record.actionId : 'Activity';
      row.append(element('h3', operation), element('p', `${nonBlank(record.outcome) ? record.outcome : 'recorded'}${nonBlank(record.occurredAt) ? ` · ${record.occurredAt}` : ''}`));
      const target = record.navigation;
      if (target?.verified === true && target.topicId === record.topicId && target.referenceId === record.sourceReferenceId) {
        const open = element('button', target.kind === 'session' ? 'Open Conversation' : 'Open Topic'); open.type = 'button';
        open.addEventListener('click', async () => {
          if (!current(pending) || !readable() || open.disabled) return;
          open.disabled = true;
          try {
            if (target.kind === 'session' && nonBlank(target.sessionId)) {
              const response = await host.request('command-center.v1.sessions.resolve-native', { schemaVersion: 1, topicId: target.topicId, referenceId: target.referenceId, expectedSessionId: target.sessionId });
              if (!current(pending) || !readable()) return;
              const resolved = unwrap(response);
              const agent = /^agent:([^:]+):.+$/.exec(resolved?.sessionKey ?? '');
              if (!agent || Object.keys(resolved ?? {}).some((key) => key !== 'sessionKey')) throw new Error('The exact Activity Conversation is unavailable.');
              host.sessions.openChat({ sessionKey: resolved.sessionKey, agentId: agent[1] });
            } else if (target.kind === 'source') {
              const response = await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId: target.topicId });
              if (!current(pending) || !readable()) return;
              if (unwrap(response)?.topic?.topicId !== target.topicId) throw new Error('The exact Activity Topic is unavailable.');
              host.navigation.openPage({ id: 'topic', params: { topicId: target.topicId } });
            }
          } catch (error) { if (current(pending)) report(error?.message || 'Activity navigation is unavailable.'); }
          finally { if (current(pending)) open.disabled = false; }
        }, { signal });
        row.append(open);
      }
      activity.append(row);
    }
    parent.append(activity);
  }

  function renderDashboardPreferences(parent, dashboard, pending) {
    const disclosure = element('details'); disclosure.className = 'cc-module'; disclosure.dataset.dashboardCustomize = 'true'; disclosure.append(element('summary', 'Customize dashboards'));
    const pinLabel = element('label', 'Pinned Topic '); const pin = element('select');
    const automatic = element('option', 'Automatic'); automatic.value = ''; pin.append(automatic);
    for (const topic of dashboard.topics ?? []) { const option = element('option', topic.name ?? topic.topicId); option.value = topic.topicId; pin.append(option); }
    pin.value = dashboardPreferences.pinnedTopicId ?? ''; pinLabel.append(pin); disclosure.append(pinLabel);
    pin.addEventListener('change', () => { dashboardPreferences = { ...dashboardPreferences, pinnedTopicId: pin.value || null }; saveDashboardPreferences(); void load('Dashboard preferences saved.'); }, { signal });
    const labels = { briefings: 'Briefings', topic: 'Pinned Topic', coverage: 'Intake coverage', upcoming: 'Upcoming', waiting: 'Waiting', review: 'Review', someday: 'Someday', activity: 'Recent activity' };
    for (const key of dashboardPreferences.rightOrder) {
      const row = element('div'); row.dataset.preferenceSection = key;
      const visibleLabel = element('label'); const visible = element('input'); visible.type = 'checkbox'; visible.checked = !dashboardPreferences.hidden.includes(key); visibleLabel.append(visible, ` ${labels[key]}`);
      const up = element('button', 'Move up'); up.type = 'button'; up.setAttribute('aria-label', `Move ${labels[key]} up`);
      const down = element('button', 'Move down'); down.type = 'button'; down.setAttribute('aria-label', `Move ${labels[key]} down`);
      visible.addEventListener('change', () => { dashboardPreferences = { ...dashboardPreferences, hidden: visible.checked ? dashboardPreferences.hidden.filter(item => item !== key) : [...new Set([...dashboardPreferences.hidden, key])] }; saveDashboardPreferences(); void load('Dashboard preferences saved.'); }, { signal });
      const move = delta => { const order = [...dashboardPreferences.rightOrder]; const index = order.indexOf(key); const destination = index + delta; if (destination < 0 || destination >= order.length) return; [order[index], order[destination]] = [order[destination], order[index]]; dashboardPreferences = { ...dashboardPreferences, rightOrder: order }; saveDashboardPreferences(); void load('Dashboard preferences saved.'); };
      up.addEventListener('click', () => move(-1), { signal }); down.addEventListener('click', () => move(1), { signal }); row.append(visibleLabel, up, down); disclosure.append(row);
    }
    parent.append(disclosure);
  }

  function renderBriefings(parent, dashboard, pending) {
    const module = element('section'); module.className = 'cc-module cc-briefings'; module.dataset.dashboardSection = 'briefings'; module.append(element('h3', 'Briefings'));
    const rows = Array.isArray(dashboard.briefings) ? dashboard.briefings : [];
    if (!rows.length) module.append(element('p', 'No unread briefings. Read editions remain available in history.'));
    for (const item of rows) {
      const card = element('article'); card.className = 'cc-briefing-card'; card.append(element('h4', item.title), element('p', item.summary));
      const meta = element('p', `${formatInstant(item.publishedAt)} · Priority ${item.priority}`); meta.className = 'cc-kicker'; card.append(meta);
      const actions = element('div'); actions.className = 'cc-widget-actions';
      const open = element('button', 'Open briefing'); open.type = 'button'; open.addEventListener('click', () => { if (current(pending)) host.sessions.openChat({ sessionKey: item.source.sessionKey }); }, { signal });
      const read = element('button', 'Mark read'); read.type = 'button'; read.disabled = !writable(); read.addEventListener('click', async () => { const key = `briefing-read:${item.editionId}`; const operation = operations.get(key) ?? { method: 'command-center.v1.briefings.set-read', params: { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), editionId: item.editionId, read: true } }; operations.set(key, operation); try { await host.request(operation.method, operation.params); operations.delete(key); if (current(pending)) await load('Briefing marked read. Use history to mark it unread again.'); } catch (error) { if (current(pending)) report(error?.message || 'Briefing was not changed. Retry to reconcile the same operation.'); } }, { signal });
      actions.append(open, read); card.append(actions); module.append(card);
    }
    const readRows = (Array.isArray(dashboard.briefingHistory) ? dashboard.briefingHistory : []).filter(item => item.read);
    const history = element('details'); history.append(element('summary', `Read history (${readRows.length})`));
    for (const item of readRows) {
      const row = element('article'); row.className = 'cc-briefing-history'; row.append(element('h4', item.title), element('p', formatInstant(item.publishedAt)));
      const open = element('button', 'Open'); open.type = 'button'; open.addEventListener('click', () => { if (current(pending)) host.sessions.openChat({ sessionKey: item.source.sessionKey }); }, { signal });
      const undo = element('button', 'Mark unread'); undo.type = 'button'; undo.disabled = !writable(); undo.addEventListener('click', async () => { const key = `briefing-unread:${item.editionId}`; const operation = operations.get(key) ?? { method: 'command-center.v1.briefings.set-read', params: { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), editionId: item.editionId, read: false } }; operations.set(key, operation); try { await host.request(operation.method, operation.params); operations.delete(key); if (current(pending)) await load('Briefing returned to the unread list.'); } catch (error) { if (current(pending)) report(error?.message || 'Briefing was not changed. Retry to reconcile the same operation.'); } }, { signal });
      const actions = element('div'); actions.className = 'cc-widget-actions'; actions.append(open, undo); row.append(actions); history.append(row);
    }
    module.append(history);
    parent.append(module);
  }

  function renderRoutineOccurrences(parent, dashboard, pending) {
    for (const item of Array.isArray(dashboard.routineOccurrences) ? dashboard.routineOccurrences : []) {
      const card = element('article'); card.className = 'cc-module cc-routine-card'; card.dataset.routineOccurrence = item.occurrenceDate; card.append(element('p', 'Household routine'), element('h3', item.title), element('p', `Due ${formatInstant(item.dueAt)}`)); card.firstChild.className = 'cc-kicker';
      const actions = element('div'); actions.className = 'cc-widget-actions';
      const act = async (action, until) => { const key = `routine:${item.routineId}:${item.occurrenceDate}:${action}`; const operation = operations.get(key) ?? { method: 'command-center.v1.routines.decide', params: { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), routineId: item.routineId, occurrenceDate: item.occurrenceDate, expectedRevision: item.revision, action, ...(until ? { until } : {}) } }; operations.set(key, operation); try { await host.request(operation.method, operation.params); operations.delete(key); if (current(pending)) await load(action === 'complete' ? 'Routine occurrence completed.' : 'Routine occurrence deferred.'); } catch (error) { if (current(pending)) report(error?.message || 'Routine occurrence was not changed. Retry to reconcile the same operation.'); } };
      const complete = element('button', 'Done'); complete.type = 'button'; complete.disabled = !writable(); complete.addEventListener('click', () => void act('complete'), { signal });
      const defer = element('button', 'Later today'); defer.type = 'button'; defer.disabled = !writable(); defer.addEventListener('click', () => void act('defer', new Date(Date.now() + 3 * 3600000).toISOString()), { signal });
      const source = element('button', 'Open source'); source.type = 'button'; source.addEventListener('click', () => { if (current(pending)) host.navigation.openPage({ id: 'topic', params: { topicId: item.topicId, sourceReferenceId: item.sourceReferenceId } }); }, { signal });
      actions.append(complete, defer, source); card.append(actions); parent.append(card);
    }
  }

  function applyDashboardPreferences(parent) {
    const sections = new Map([...parent.querySelectorAll('[data-dashboard-section]')].map(node => [node.dataset.dashboardSection, node]));
    for (const key of dashboardPreferences.rightOrder) {
      const node = sections.get(key); if (!node) continue; node.hidden = dashboardPreferences.hidden.includes(key); parent.append(node);
    }
  }

  function appendRenovationRelationshipControl(row, card, detail, pending) {
    if (!writable() || ['resolved', 'cancelled'].includes(card.state) || row.querySelector('details[data-renovation-purchase]')) return;
    const requirement = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && item.requirementKind === 'purchase' && nonBlank(item.requirementNamespace) && nonBlank(item.requirementId));
    if (!requirement) return;
    const disclosure = element('details'); disclosure.dataset.renovationPurchase = 'true'; disclosure.append(element('summary', 'Confirm exact purchased item'));
    const form = element('form'); form.append(element('p', `This resolves only requirement ${requirement.requirementId}. A name match alone is not accepted.`));
    const purchaseLabel = element('label', 'Purchase or receipt item ID '); const purchaseId = element('input'); purchaseId.required = true; purchaseId.maxLength = 300; purchaseLabel.append(purchaseId);
    const save = element('button', 'Link purchase to requirement'); save.type = 'submit'; form.append(purchaseLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!current(pending) || !writable() || save.disabled || !purchaseId.value.trim()) return;
      save.disabled = true;
      const key = `renovation-purchase:${card.loopId}`;
      try {
        let operation = operations.get(key);
        if (!operation) {
          const logicalOperationId = crypto.randomUUID(); const now = new Date().toISOString();
          operation = { method: 'command-center.v1.open-loops.renovation-purchase', params: { schemaVersion: 1, logicalOperationId, expectedRevision: card.revision, reconciliation: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-purchase-relationship', externalId: logicalOperationId, version: 'operator-v1' }, requirement: { kind: 'purchase', namespace: requirement.requirementNamespace, id: requirement.requirementId }, purchase: { kind: 'purchase', namespace: requirement.requirementNamespace, id: purchaseId.value.trim() }, occurredAt: now, observedAt: now, historicalBaseline: false, ...(card.topicId ? { topicId: card.topicId } : {}) } } };
          operations.set(key, operation);
        }
        const envelope = await host.request(operation.method, operation.params); const response = unwrap(envelope);
        if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || response?.loop?.loopId !== card.loopId || response.loop.state !== 'resolved') throw new Error('The purchase relationship outcome is not confirmed. Retry to reconcile the same operation.');
        if (!current(pending)) return;
        operations.delete(key); await load(); if (current(pending)) report('The exact purchase was linked. Other requirements and any return obligation remain separate.');
      } catch (error) { if (current(pending)) report(error?.message || 'The purchase relationship outcome is unknown. Retry to reconcile the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationRelationshipCorrectionControl(row, card, detail, pending) {
    if (!writable() || card.state !== 'resolved' || row.querySelector('details[data-renovation-purchase-correction]')) return;
    const requirement = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && item.requirementKind === 'purchase' && nonBlank(item.requirementNamespace) && nonBlank(item.requirementId));
    const activePurchases = new Map();
    const orderedEvidence = [...(detail?.evidence ?? [])].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || String(left.observationId).localeCompare(String(right.observationId)));
    for (const item of orderedEvidence) {
      if (!['item-purchased', 'purchase-relationship-corrected'].includes(item.eventKind) || !nonBlank(item.purchaseNamespace) || !nonBlank(item.purchaseId)) continue;
      const key = [item.requirementNamespace, item.requirementId, item.purchaseNamespace, item.purchaseId].join('\u0000');
      if (item.eventKind === 'item-purchased') activePurchases.set(key, item);
      else activePurchases.delete(key);
    }
    const purchase = [...activePurchases.values()].at(-1);
    if (!requirement || !purchase || requirement.requirementNamespace !== purchase.purchaseNamespace) return;
    const disclosure = element('details'); disclosure.dataset.renovationPurchaseCorrection = 'true'; disclosure.append(element('summary', 'Correct purchased item relationship'));
    const form = element('form'); form.append(element('p', `This unlinks purchase ${purchase.purchaseId} from requirement ${requirement.requirementId} and reopens only that requirement.`));
    const rationaleLabel = element('label', ' Rationale '); const rationale = element('textarea'); rationale.required = true; rationale.maxLength = 1000; rationaleLabel.append(rationale);
    const save = element('button', 'Unlink purchase and reopen requirement'); save.type = 'submit'; form.append(rationaleLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled || !rationale.value.trim()) return; save.disabled = true;
      try {
        const now = new Date().toISOString();
        await submitOpenLoopOperation({ key: `renovation-purchase-correction:${card.loopId}`, method: 'command-center.v1.open-loops.renovation-purchase-correction', params: { correction: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-purchase-relationship-correction', externalId: crypto.randomUUID(), version: 'operator-v1' }, requirement: { kind: 'purchase', namespace: requirement.requirementNamespace, id: requirement.requirementId }, purchase: { kind: 'purchase', namespace: purchase.purchaseNamespace, id: purchase.purchaseId }, occurredAt: now, observedAt: now, rationale: rationale.value.trim(), ...(card.topicId ? { topicId: card.topicId } : {}) } }, card, pending, includeLoopId: false, success: 'The incorrect purchase link was removed and the exact requirement was reopened.' });
      } catch (error) { if (current(pending)) report(error?.message || 'The relationship correction is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationFulfilmentControl(row, card, detail, pending) {
    if (!writable() || row.querySelector('details[data-renovation-fulfilment]')) return;
    const requirement = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && ['purchase', 'installation'].includes(item.requirementKind) && nonBlank(item.requirementNamespace) && nonBlank(item.requirementId));
    if (!requirement) return;
    const disclosure = element('details'); disclosure.dataset.renovationFulfilment = 'true'; disclosure.append(element('summary', 'Record delivery or installation'));
    const form = element('form'); form.append(element('p', `Record fulfilment only for exact requirement ${requirement.requirementId}. Delivery does not imply installation.`));
    const kindLabel = element('label', 'Outcome '); const kind = element('select');
    for (const [value, label] of [['delivered', 'Delivered'], ['installed', 'Installed']]) { const option = element('option', label); option.value = value; kind.append(option); } kindLabel.append(kind);
    const installationLabel = element('label', ' Installation still required '); const installationRequired = element('input'); installationRequired.type = 'checkbox'; installationRequired.checked = requirement.requirementKind === 'installation'; installationLabel.append(installationRequired);
    const fulfilledLabel = element('label', ' Delivered item IDs '); const fulfilled = element('input'); fulfilled.placeholder = 'tap-body, tap-hose'; fulfilledLabel.append(fulfilled);
    const outstandingLabel = element('label', ' Outstanding item IDs '); const outstanding = element('input'); outstanding.placeholder = 'tap-handle'; outstandingLabel.append(outstanding);
    const expectedLabel = element('label', ' Corrected expected time '); const expectedAt = element('input'); expectedAt.type = 'datetime-local'; expectedLabel.append(expectedAt);
    const noteLabel = element('label', ' Update note '); const note = element('textarea'); note.maxLength = 1000; noteLabel.append(note);
    const update = () => { const delivered = kind.value === 'delivered'; for (const field of [fulfilledLabel, outstandingLabel, expectedLabel, noteLabel]) field.hidden = !delivered; };
    kind.addEventListener('change', update, { signal }); update();
    const save = element('button', 'Record fulfilment'); save.type = 'submit'; form.append(kindLabel, installationLabel, fulfilledLabel, outstandingLabel, expectedLabel, noteLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled) return; save.disabled = true;
      try {
        const now = new Date().toISOString();
        const itemIds = value => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
        const fulfilledItemIds = kind.value === 'delivered' ? itemIds(fulfilled.value) : [];
        const outstandingItemIds = kind.value === 'delivered' ? itemIds(outstanding.value) : [];
        if (fulfilledItemIds.some(id => outstandingItemIds.includes(id))) throw new Error('An item cannot be both delivered and outstanding.');
        await submitOpenLoopOperation({ key: `renovation-fulfilment:${card.loopId}`, method: 'command-center.v1.open-loops.renovation-fulfilment', params: { fulfilment: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-fulfilment', externalId: crypto.randomUUID(), version: 'operator-v1' }, requirement: { kind: requirement.requirementKind, namespace: requirement.requirementNamespace, id: requirement.requirementId }, fulfilmentKind: kind.value, installationRequired: kind.value === 'installed' ? false : installationRequired.checked, ...(fulfilledItemIds.length ? { fulfilledItemIds } : {}), ...(outstandingItemIds.length ? { outstandingItemIds } : {}), ...(expectedAt.value ? { expectedAt: new Date(expectedAt.value).toISOString() } : {}), ...(note.value.trim() ? { note: note.value.trim() } : {}), occurredAt: now, observedAt: now, historicalBaseline: false, ...(card.topicId ? { topicId: card.topicId } : {}) } }, card, pending, includeLoopId: false, success: kind.value === 'installed' ? 'Installation recorded.' : outstandingItemIds.length ? 'Partial delivery recorded; outstanding items remain open.' : 'Delivery recorded; any required installation remains open.' });
      } catch (error) { if (current(pending)) report(error?.message || 'The fulfilment outcome is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationReplacementControl(row, card, detail, pending) {
    if (!writable() || row.querySelector('details[data-renovation-replacement]')) return;
    const requirement = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && item.requirementKind === 'purchase' && nonBlank(item.requirementNamespace));
    if (!requirement) return;
    const disclosure = element('details'); disclosure.dataset.renovationReplacement = 'true'; disclosure.append(element('summary', 'Record replacement follow-up'));
    const form = element('form'); form.append(element('p', 'A replacement purchase and its return, refund, or resale obligation remain separate records.'));
    const field = (labelText, required = true) => { const label = element('label', `${labelText} `); const input = element('input'); input.required = required; input.maxLength = 300; label.append(input); form.append(label); return input; };
    const replacementId = field('Replacement purchase ID'); const replacedItemId = field('Replaced item ID');
    const kindLabel = element('label', 'Follow-up '); const obligationKind = element('select'); for (const value of ['return', 'refund', 'resale']) { const option = element('option', value[0].toUpperCase() + value.slice(1)); option.value = value; obligationKind.append(option); } kindLabel.append(obligationKind); form.append(kindLabel);
    const obligationId = field('Follow-up ID'); const title = field('Follow-up title'); const dueLabel = element('label', 'Deadline '); const due = element('input'); due.type = 'datetime-local'; due.required = true; dueLabel.append(due); form.append(dueLabel);
    const save = element('button', 'Record replacement and follow-up'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled || !replacementId.value.trim() || !replacedItemId.value.trim() || !obligationId.value.trim() || !title.value.trim() || !due.value) return; save.disabled = true;
      const key = `renovation-replacement:${card.loopId}`;
      try {
        let operation = operations.get(key);
        if (!operation) {
          const logicalOperationId = crypto.randomUUID(); const now = new Date().toISOString();
          operation = { method: 'command-center.v1.open-loops.renovation-replacement', params: { schemaVersion: 1, logicalOperationId, expectedRevision: 0, replacement: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-replacement-follow-up', externalId: logicalOperationId, version: 'operator-v1' }, replacementPurchase: { kind: 'purchase', namespace: requirement.requirementNamespace, id: replacementId.value.trim() }, replacedItem: { kind: 'renovation-item', namespace: requirement.requirementNamespace, id: replacedItemId.value.trim() }, obligation: { kind: obligationKind.value, namespace: requirement.requirementNamespace, id: obligationId.value.trim() }, occurredAt: now, observedAt: now, historicalBaseline: false, title: title.value.trim(), dueAt: new Date(due.value).toISOString(), ...(card.topicId ? { topicId: card.topicId } : {}) } } };
          operations.set(key, operation);
        }
        const envelope = await host.request(operation.method, operation.params); const response = unwrap(envelope);
        if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || !nonBlank(response?.loop?.loopId) || response.loop.loopId === card.loopId) throw new Error('The separate replacement follow-up was not confirmed. Retry the same operation.');
        if (!current(pending)) return; operations.delete(key); await load(); if (current(pending)) report('Replacement recorded with a separate follow-up obligation.');
      } catch (error) { if (current(pending)) report(error?.message || 'The replacement outcome is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationStageControl(row, card, detail, pending) {
    if (!writable() || row.querySelector('details[data-renovation-stage]')) return;
    const prerequisite = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && item.requirementKind === 'prerequisite' && nonBlank(item.stageNamespace) && nonBlank(item.stageId));
    if (!prerequisite) return;
    const disclosure = element('details'); disclosure.dataset.renovationStage = 'true'; disclosure.append(element('summary', 'Set exact renovation stage'));
    const form = element('form'); form.append(element('p', `Only prerequisites for stage ${prerequisite.stageId} will surface together.`));
    const stateLabel = element('label', 'Stage state '); const active = element('select'); for (const [value, label] of [['true', 'Active'], ['false', 'Inactive']]) { const option = element('option', label); option.value = value; active.append(option); } stateLabel.append(active);
    const save = element('button', 'Save stage state'); save.type = 'submit'; form.append(stateLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled) return; save.disabled = true; const key = `renovation-stage:${prerequisite.stageNamespace}:${prerequisite.stageId}`;
      try {
        let operation = operations.get(key); if (!operation) { const logicalOperationId = crypto.randomUUID(); const now = new Date().toISOString(); operation = { method: 'command-center.v1.open-loops.renovation-stage', params: { schemaVersion: 1, logicalOperationId, expectedRevision: 0, activation: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-stage-state', externalId: logicalOperationId, version: 'operator-v1' }, stage: { kind: 'renovation-stage', namespace: prerequisite.stageNamespace, id: prerequisite.stageId }, active: active.value === 'true', occurredAt: now, observedAt: now, ...(card.topicId ? { topicId: card.topicId } : {}) } } }; operations.set(key, operation); }
        const envelope = await host.request(operation.method, operation.params); const response = unwrap(envelope); if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || !nonBlank(response?.observationId)) throw new Error('The stage state was not confirmed. Retry the same operation.');
        if (!current(pending)) return; operations.delete(key); await load(); if (current(pending)) report(active.value === 'true' ? 'The exact stage is active.' : 'The exact stage is inactive.');
      } catch (error) { if (current(pending)) report(error?.message || 'The stage outcome is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal }); disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationDecisionConflictControl(row, card, detail, pending) {
    if (!writable() || card.kind !== 'decision' || card.state === 'decision-needed' || row.querySelector('details[data-renovation-conflict]')) return;
    const decision = detail?.evidence?.filter(item => nonBlank(item.decisionId) && nonBlank(item.chosenOption)).at(-1);
    if (!decision) return;
    const disclosure = element('details'); disclosure.dataset.renovationConflict = 'true'; disclosure.append(element('summary', 'Record changed quote or purchase'));
    const form = element('form'); form.append(element('p', `The recorded choice remains ${decision.chosenOption} until you explicitly revise it.`));
    const kindLabel = element('label', 'Evidence kind '); const kind = element('select'); for (const [value, label] of [['revised-quote', 'Revised quote'], ['purchase-vs-choice', 'Purchase differs from choice']]) { const option = element('option', label); option.value = value; kind.append(option); } kindLabel.append(kind);
    const choiceLabel = element('label', 'Observed choice '); const observedChoice = element('input'); observedChoice.required = true; observedChoice.maxLength = 500; choiceLabel.append(observedChoice);
    const scopeLabel = element('label', ' Quote scope comparison '); const scopeComparison = element('select'); for (const [value, label] of [['like-for-like', 'Same scope'], ['different-scope', 'Different scope'], ['unknown', 'Not yet verified']]) { const option = element('option', label); option.value = value; scopeComparison.append(option); } scopeLabel.append(scopeComparison);
    const summaryLabel = element('label', 'Summary '); const summary = element('textarea'); summary.required = true; summary.maxLength = 1000; summaryLabel.append(summary); const save = element('button', 'Record evidence for review'); save.type = 'submit'; form.append(kindLabel, choiceLabel, scopeLabel, summaryLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled || !observedChoice.value.trim() || !summary.value.trim()) return; save.disabled = true;
      try { const now = new Date().toISOString(); await submitOpenLoopOperation({ key: `renovation-conflict:${card.loopId}`, method: 'command-center.v1.open-loops.renovation-decision-conflict', params: { conflict: { schemaVersion: 1, decisionId: decision.decisionId, source: { system: 'command-center', kind: kind.value, externalId: crypto.randomUUID(), version: 'operator-v1' }, conflictKind: kind.value, occurredAt: now, observedAt: now, historicalBaseline: false, summary: summary.value.trim(), recordedChoice: decision.chosenOption, observedChoice: observedChoice.value.trim(), scopeComparison: scopeComparison.value, evidenceSelectors: ['explicit-operator-evidence'] } }, card, pending, includeLoopId: false, success: observedChoice.value.trim() === decision.chosenOption ? 'Matching evidence recorded without changing Attention.' : scopeComparison.value === 'like-for-like' ? 'Changed evidence recorded for explicit decision review.' : 'Changed evidence recorded without claiming a like-for-like comparison.' }); }
      catch (error) { if (current(pending)) report(error?.message || 'The changed evidence outcome is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal }); disclosure.append(form); row.append(disclosure);
  }

  function renderOpenLoops(openLoops, pending, targets = {}) {
    if (!openLoops || typeof openLoops !== 'object' || !Number.isSafeInteger(openLoops.total)) return;
    if (nonBlank(targets.topicId)) {
      const onlyTopic = cards => openLoopsArray(cards).filter(card => card.topicId === targets.topicId);
      const original = openLoops; const source = original.workspace ?? {};
      const highlighted = onlyTopic(original.highlighted); const stageReviews = openLoopsArray(original.stageReviews).map(group => ({ ...group, items: onlyTopic(group.items) })).filter(group => group.items.length);
      const comingUp = onlyTopic(original.comingUp); const waiting = onlyTopic(original.waiting); const suggested = onlyTopic(original.suggested); const deferred = onlyTopic(original.deferred); const reconciliation = onlyTopic(original.reconciliation);
      const groups = Object.fromEntries(Object.entries(source.today?.groups ?? {}).map(([key, cards]) => [key, onlyTopic(cards)]));
      const workspace = { ...source, today: { ...(source.today ?? {}), mandatory: onlyTopic(source.today?.mandatory), planned: onlyTopic(source.today?.planned), groups }, upcoming: onlyTopic(source.upcoming), capacity: onlyTopic(source.capacity), capacityTotal: onlyTopic(source.capacity).length, waiting: onlyTopic(source.waiting), someday: onlyTopic(source.someday), review: { ...(source.review ?? {}), batch: onlyTopic(source.review?.batch), eligibleTotal: onlyTopic(source.review?.batch).length, remaining: 0 }, board: Object.fromEntries(Object.entries(source.board ?? {}).map(([key, cards]) => [key, onlyTopic(cards)])), agenda: openLoopsArray(source.agenda).filter(entry => entry.item?.topicId === targets.topicId) };
      openLoops = { ...original, total: new Set([...highlighted, ...comingUp, ...waiting, ...suggested, ...deferred, ...reconciliation, ...workspace.today.mandatory, ...workspace.today.planned, ...workspace.upcoming, ...workspace.capacity, ...workspace.waiting, ...workspace.someday].map(card => card.loopId)).size, attentionTotal: highlighted.length + stageReviews.length, highlighted, stageReviews, stageReviewTotal: stageReviews.length, comingUp, comingUpTotal: comingUp.length, waiting, waitingTotal: waiting.length, suggested, suggestedTotal: suggested.length, deferred, deferredTotal: deferred.length, reconciliation, reconciliationTotal: reconciliation.length, workspace };
    }
    const primary = targets.primary ?? content;
    const secondary = targets.secondary ?? primary;
    const planner = targets.planner === true;
    const afterAttention = [];
    const workspace = openLoops.workspace;
    if (workspace && typeof workspace === 'object') {
      const renderPlanningCard = (parent, card, reason, compactActions = false) => {
        if (!nonBlank(card?.loopId) || !nonBlank(card?.title)) return;
        const row = element('article'); row.className = 'cc-work-card'; row.dataset.workspaceLoopId = card.loopId;
        row.dataset.loopKind = card.kind ?? 'general'; row.dataset.cardTitle = card.title.toLocaleLowerCase();
        row.dataset.cardTopic = card.topicId ?? ''; row.dataset.cardState = card.state ?? ''; row.dataset.cardPriority = card.planning?.importance ?? 'normal';
        row.append(element('h3', card.title));
        const planning = card.planning ?? {};
        row.append(element('p', [reason, planning.importance ? `${planning.importance} importance` : null, planning.effortMinutes ? `${planning.effortMinutes} min` : null, planning.contexts?.length ? planning.contexts.join(', ') : null].filter(Boolean).join(' · ')));
        if (!writable() || ['resolved', 'cancelled'].includes(card.state)) { parent.append(row); return; }
        const form = element('form'); const actionLabel = element('label', 'Action '); const action = element('select');
        const choices = [['plan', 'Plan time'], ['set-priority', 'Set priority'], ['start', 'Start'], ['wait', 'Waiting / blocked'], ['review-later', 'Review later'], ['someday', 'Move to Someday'], ['keep', 'Keep available'], ['drop', 'Drop']];
        if (card.kind === 'general') choices.splice(3, 0, ['complete', 'Complete']);
        for (const [value, label] of choices) { const option = element('option', label); option.value = value; action.append(option); }
        actionLabel.append(action);
        const timeLabel = element('label', ' Date and time '); const when = element('input'); when.type = 'datetime-local'; timeLabel.append(when);
        const priorityLabel = element('label', ' Priority '); const priority = element('select'); for (const value of ['critical', 'high', 'normal', 'low']) { const option = element('option', value[0].toUpperCase() + value.slice(1)); option.value = value; priority.append(option); } priority.value = planning.importance ?? 'normal'; priorityLabel.append(priority);
        const update = () => { timeLabel.hidden = !['plan', 'review-later'].includes(action.value); when.required = !timeLabel.hidden; priorityLabel.hidden = action.value !== 'set-priority'; };
        action.addEventListener('change', update, { signal }); update();
        const save = element('button', 'Save'); save.type = 'submit'; form.append(actionLabel, timeLabel, priorityLabel, save);
        form.addEventListener('submit', async event => {
          event.preventDefault(); if (!current(pending) || save.disabled) return; save.disabled = true;
          try {
            const params = { action: action.value, ...(action.value === 'plan' ? { plannedAt: new Date(when.value).toISOString() } : {}), ...(action.value === 'review-later' ? { reviewAt: new Date(when.value).toISOString() } : {}), ...(action.value === 'set-priority' ? { importance: priority.value } : {}) };
            await submitOpenLoopOperation({ key: `organize:${card.loopId}:${action.value}`, method: 'command-center.v1.open-loops.organize', params, card, pending, success: 'The item was updated across Today, board and agenda.' });
          } catch (error) { if (current(pending)) report(error?.message || 'The planning outcome is unknown. Retry the same action.'); }
          finally { if (current(pending)) save.disabled = false; }
        }, { signal });
        if (compactActions) { const actions = element('details'); actions.className = 'cc-card-actions'; actions.append(element('summary', 'Actions'), form); row.append(actions); }
        else row.append(form);
        parent.append(row);
      };
      const todayMandatory = Array.isArray(workspace.today?.mandatory) ? workspace.today.mandatory : [];
      const todayPlanned = Array.isArray(workspace.today?.planned) ? workspace.today.planned : [];
      if (planner || todayMandatory.length || todayPlanned.length || openLoops.attentionTotal === 0) primary.append(element('h2', 'Today / Needs you'));
      if (!todayMandatory.length && !todayPlanned.length && openLoops.attentionTotal === 0) { const empty = element('p', 'Nothing needs you today. Choose optional work from When I have capacity.'); empty.className = 'cc-empty'; primary.append(empty); }
      const grouped = workspace.today?.groups ?? {};
      const renderedMandatory = new Set();
      for (const [key, label, reason] of [
        ['overdue', 'Overdue', card => `Overdue since ${formatDue(card) ?? 'an earlier accepted date'}`],
        ['dueToday', 'Due today', card => formatDue(card) ? `Due today · ${formatDue(card)}` : 'Due today'],
        ['decisions', 'Decisions and changes', card => card.whyNow ?? (card.reason ? `Needs consideration: ${card.reason}` : 'Needs a decision without an invented deadline')],
        ['reviews', 'Accepted reviews', card => card.reviewAt ? `Review due ${formatInstant(card.reviewAt)}` : 'Accepted review is due']
      ]) {
        const cards = openLoopsArray(grouped[key]); if (!cards.length) continue;
        primary.append(element('h3', `${label} (${cards.length})`));
        for (const card of cards) { renderedMandatory.add(card.loopId); renderPlanningCard(primary, card, reason(card)); }
      }
      for (const card of todayMandatory) if (!renderedMandatory.has(card.loopId)) renderPlanningCard(primary, card, card.reason ? `Required: ${card.reason}` : 'Required today');
      for (const card of todayPlanned) renderPlanningCard(primary, card, 'Optional planned work');
      const sections = [
        ['Planned / Upcoming', workspace.upcoming, card => formatDue(card) ? `Deadline ${formatDue(card)}` : card.planning?.plannedAt ? `Planned ${formatInstant(card.planning.plannedAt)}` : `Review ${formatInstant(card.reviewAt)}`],
        [`When I have capacity (${workspace.capacityTotal ?? workspace.capacity?.length ?? 0} total)`, workspace.capacity, () => 'Ready when capacity allows'],
        ['Waiting', workspace.waiting, () => 'Waiting or blocked'],
        [`Review (${workspace.review?.eligibleTotal ?? 0}; ${workspace.review?.remaining ?? 0} after this batch)`, workspace.review?.batch, () => 'Backlog review'],
        ['Someday', workspace.someday, () => 'Parked without urgency']
      ];
      for (const [label, cards, reason] of sections) {
        const disclosure = element('details'); disclosure.dataset.workspaceSection = label; disclosure.append(element('summary', `${label} (${Array.isArray(cards) ? cards.length : 0} shown)`));
        const dashboardSection = label.startsWith('Planned / Upcoming') ? 'upcoming' : label.startsWith('Waiting') ? 'waiting' : label.startsWith('Review') ? 'review' : label.startsWith('Someday') ? 'someday' : null;
        if (dashboardSection) disclosure.dataset.dashboardSection = dashboardSection;
        for (const card of Array.isArray(cards) ? cards : []) renderPlanningCard(disclosure, card, reason(card));
        const capacity = label.startsWith('When I have capacity');
        const destination = planner || capacity ? primary : secondary;
        if (!planner && capacity) afterAttention.push(disclosure); else destination.append(disclosure);
      }
      if (planner) {
        const controls = element('section'); controls.className = 'cc-planner-controls'; controls.setAttribute('aria-label', 'Planner controls');
        const searchLabel = element('label', 'Search'); const search = element('input'); search.type = 'search'; search.placeholder = 'Search work'; search.value = transientUiState.planner.search; searchLabel.append(search);
        const topicLabel = element('label', 'Topic'); const topic = element('select'); const allTopics = element('option', 'All Topics'); allTopics.value = ''; topic.append(allTopics);
        const completeBoard = Object.values(workspace.board ?? {}).flatMap(openLoopsArray);
        for (const topicId of [...new Set(completeBoard.map(card => card.topicId).filter(nonBlank))].sort()) { const option = element('option', topicId); option.value = topicId; topic.append(option); }
        topic.value = targets.topicId ?? transientUiState.planner.topic ?? ''; topicLabel.append(topic);
        const stateLabel = element('label', 'Status'); const state = element('select');
        for (const [value, label] of [['', 'All statuses'], ['confirmed', 'Confirmed'], ['monitoring', 'Monitoring'], ['waiting', 'Waiting'], ['decision-needed', 'Decision needed'], ['suggested', 'Suggestions'], ['resolved', 'Resolved']]) { const option = element('option', label); option.value = value; state.append(option); } stateLabel.append(state);
        state.value = transientUiState.planner.state;
        const priorityLabel = element('label', 'Priority'); const importance = element('select');
        for (const [value, label] of [['', 'All priorities'], ['critical', 'Critical'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']]) { const option = element('option', label); option.value = value; importance.append(option); } priorityLabel.append(importance);
        importance.value = transientUiState.planner.importance;
        const views = element('div'); views.className = 'cc-view-switcher'; views.setAttribute('aria-label', 'Planner view');
        const boardView = element('button', 'Board'); boardView.type = 'button'; boardView.setAttribute('aria-pressed', 'true');
        const listView = element('button', 'List'); listView.type = 'button'; listView.setAttribute('aria-pressed', 'false');
        const agendaView = element('button', 'Agenda'); agendaView.type = 'button'; agendaView.setAttribute('aria-pressed', 'false');
        views.append(boardView, listView, agendaView); controls.append(searchLabel, topicLabel, stateLabel, priorityLabel, views); primary.append(controls);
        const board = element('details'); board.open = true; board.dataset.topicBoard = 'true'; board.append(element('summary', 'Kanban board'));
        const lanes = element('div'); lanes.className = 'cc-planner-board'; lanes.setAttribute('aria-label', 'Kanban lanes');
        for (const [key, label] of [['ready', 'Ready'], ['doing', 'Doing'], ['waiting', 'Waiting'], ['done', 'Done'], ['suggestions', 'Suggestions']]) {
          const cards = workspace.board?.[key] ?? [];
          const lane = element('section'); lane.className = 'cc-planner-lane'; lane.dataset.boardLane = key; lane.append(element('h3', `${label} (${cards.length})`));
          if (!cards.length) lane.append(element('p', `No ${label.toLowerCase()} items.`));
          for (const card of cards) renderPlanningCard(lane, card, label, true);
          lanes.append(lane);
        }
        board.append(lanes);
        primary.append(board);
        const list = element('section'); list.className = 'cc-planner-list'; list.hidden = true; list.setAttribute('aria-label', 'Planner list');
        const uniqueCards = [...new Map(completeBoard.map(card => [card.loopId, card])).values()];
        for (const card of uniqueCards) renderPlanningCard(list, card, 'Planner list', true);
        primary.append(list);
        const agenda = element('details'); agenda.className = 'cc-planner-agenda'; agenda.hidden = true; agenda.open = true; agenda.dataset.agenda = 'true'; agenda.append(element('summary', `Agenda (${workspace.agenda?.length ?? 0})`));
        for (const entry of workspace.agenda ?? []) agenda.append(element('p', `${formatInstant(entry.at)} · ${entry.kind} · ${entry.item?.title ?? 'Item'}`));
        primary.append(agenda);
        const applyFilters = () => {
          transientUiState.planner = { ...transientUiState.planner, search: search.value, topic: topic.value, state: state.value, importance: importance.value };
          const query = search.value.trim().toLocaleLowerCase();
          for (const card of [...board.querySelectorAll('[data-workspace-loop-id]'), ...list.querySelectorAll('[data-workspace-loop-id]')]) {
            card.hidden = Boolean((query && !card.dataset.cardTitle.includes(query)) || (topic.value && card.dataset.cardTopic !== topic.value) || (state.value && card.dataset.cardState !== state.value) || (importance.value && card.dataset.cardPriority !== importance.value));
          }
        };
        for (const input of [search, topic, state, importance]) input.addEventListener(input === search ? 'input' : 'change', applyFilters, { signal });
        const showView = selectedView => {
          transientUiState.planner.view = selectedView;
          board.hidden = selectedView !== 'board'; list.hidden = selectedView !== 'list'; agenda.hidden = selectedView !== 'agenda';
          for (const [button, value] of [[boardView, 'board'], [listView, 'list'], [agendaView, 'agenda']]) button.setAttribute('aria-pressed', String(value === selectedView));
        };
        boardView.addEventListener('click', () => showView('board'), { signal }); listView.addEventListener('click', () => showView('list'), { signal }); agendaView.addEventListener('click', () => showView('agenda'), { signal });
        showView(transientUiState.planner.view); applyFilters();
      }
    }
    if (planner) {
      primary.append(element('h2', 'Open loops'));
      primary.append(element('p', `${openLoops.attentionTotal} need attention · ${openLoops.comingUpTotal} coming up · ${openLoops.waitingTotal} waiting · ${openLoops.suggestedTotal} suggestions · ${openLoops.deferredTotal} deferred`));
    }
    const stageGroups = Array.isArray(openLoops.stageReviews) ? openLoops.stageReviews.map(group => [`Active renovation stage: ${group.stage?.id ?? 'stage'}`, group.items]) : [];
    const groups = [['Needs attention', openLoops.highlighted], ...stageGroups, ['Coming up', openLoops.comingUp], ['Waiting', openLoops.waiting], ['Suggestions', openLoops.suggested], ['Deferred', openLoops.deferred], ['Needs reconciliation', openLoops.reconciliation]];
    for (const [label, cards] of groups) {
      if (!Array.isArray(cards) || cards.length === 0) continue;
      const quiet = ['Waiting', 'Suggestions', 'Deferred', 'Needs reconciliation'].includes(label);
      const destination = planner || ['Needs attention'].includes(label) || label.startsWith('Active renovation') ? primary : secondary;
      const group = quiet ? element('details') : destination;
      if (quiet) { group.dataset.openLoopGroup = label; group.append(element('summary', `${label} (${cards.length} shown)`)); destination.append(group); }
      else destination.append(element('h3', label));
      for (const card of cards) {
        if (!nonBlank(card.loopId) || !nonBlank(card.title)) continue;
        const row = element('article'); row.className = 'cc-open-loop-card'; row.dataset.openLoopId = card.loopId; row.dataset.loopKind = card.kind ?? 'general';
        row.append(element('h4', card.title));
        const topicName = targets.topics?.find(topic => topic.topicId === card.topicId)?.name ?? card.topicId;
        const facts = [nonBlank(topicName) ? `Topic: ${topicName}` : null, nonBlank(card.sourceLabel) ? `Source: ${card.sourceLabel}` : null, card.paymentState ?? card.state, Number.isSafeInteger(card.amount) && nonBlank(card.currency) ? `${card.currency} ${(card.amount / 100).toFixed(2)}` : null, formatDue(card) ? `Due ${formatDue(card)}` : null].filter(Boolean);
        if (facts.length) row.append(element('p', facts.join(' · ')));
        if (nonBlank(card.whyNow)) row.append(element('p', card.whyNow));
        row.append(element('p', `${Number.isSafeInteger(card.evidenceCount) ? card.evidenceCount : 0} linked source ${card.evidenceCount === 1 ? 'item' : 'items'}.`));
        const evidence = element('button', 'Review evidence'); evidence.type = 'button';
        evidence.addEventListener('click', async () => {
          if (!current(pending) || evidence.disabled) return;
          evidence.disabled = true;
          try {
            const detail = unwrap(await host.request('command-center.v1.open-loops.get', { schemaVersion: 1, loopId: card.loopId }));
            if (!current(pending) || detail?.loop?.loopId !== card.loopId) return;
            let disclosure = row.querySelector('details[data-open-loop-evidence]');
            if (!disclosure) { disclosure = element('details'); disclosure.dataset.openLoopEvidence = 'true'; disclosure.append(element('summary', 'Source evidence')); row.append(disclosure); }
            renderEvidence(disclosure, detail);
            appendRenovationRelationshipControl(row, card, detail, pending);
            appendRenovationRelationshipCorrectionControl(row, card, detail, pending);
            appendRenovationFulfilmentControl(row, card, detail, pending);
            appendRenovationReplacementControl(row, card, detail, pending);
            appendRenovationStageControl(row, card, detail, pending);
            appendRenovationDecisionConflictControl(row, card, detail, pending);
            disclosure.open = true;
          } catch (error) { if (current(pending)) report(error?.message || 'Open-loop evidence is unavailable.'); }
          finally { if (current(pending)) evidence.disabled = false; }
        }, { signal });
        row.append(evidence);
        if (writable() && card.kind === 'payment' && card.state !== 'suggested' && !['resolved', 'cancelled'].includes(card.state) && !['paid', 'cancelled'].includes(card.paymentState)) {
          const form = element('form');
          const actionDisclosure = element('details'); actionDisclosure.append(element('summary', 'Record payment status'));
          form.append(element('p', 'This records your status assertion. It does not pay the bill or contact the sender.'));
          const statusLabel = element('label', 'Status '); const choice = element('select'); choice.name = 'paymentState';
          for (const [value, label] of [['payment-pending', 'Payment initiated; settlement pending'], ['partially-paid', 'Partially paid'], ['paid', 'Paid and verified by me'], ['disputed', 'Disputed'], ['cancelled', 'Cancelled by the authority'], ['uncertain', 'Needs reconciliation']]) { const option = element('option', label); option.value = value; choice.append(option); }
          statusLabel.append(choice);
          const amountLabel = element('label', ' Amount paid '); const paidAmount = element('input'); paidAmount.name = 'paidAmount'; paidAmount.type = 'number'; paidAmount.min = '0.01'; paidAmount.step = '0.01'; amountLabel.append(paidAmount);
          const currencyLabel = element('label', ' Currency '); const currency = element('input'); currency.name = 'currency'; currency.maxLength = 3; currency.value = card.currency ?? ''; currencyLabel.append(currency);
          const updatePartialInputs = () => { const partial = choice.value === 'partially-paid'; paidAmount.disabled = !partial; currency.disabled = !partial; paidAmount.required = partial; currency.required = partial; };
          choice.addEventListener('change', updatePartialInputs, { signal }); updatePartialInputs();
          const rationaleLabel = element('label', ' Evidence or rationale '); const rationale = element('textarea'); rationale.name = 'rationale'; rationale.required = true; rationale.maxLength = 1000; rationaleLabel.append(rationale);
          const save = element('button', 'Save payment status'); save.type = 'submit';
          form.append(statusLabel, amountLabel, currencyLabel, rationaleLabel, save);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!current(pending) || !writable() || save.disabled || !rationale.value.trim()) return;
            save.disabled = true;
            try {
              const partial = choice.value === 'partially-paid';
              const amountMinor = partial ? Math.round(Number(paidAmount.value) * 100) : undefined;
              if (partial && (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !/^[A-Za-z]{3}$/u.test(currency.value.trim()))) throw new Error('Enter a positive partial amount and three-letter currency.');
              await submitOpenLoopOperation({ key: `open-loop-payment:${card.loopId}`, method: 'command-center.v1.open-loops.payment-status', params: { paymentState: choice.value, ...(partial ? { paidAmount: amountMinor, currency: currency.value.trim().toUpperCase() } : {}), rationale: rationale.value.trim() }, card, pending, success: 'Payment status recorded. No payment was submitted.' });
            } catch (error) { if (current(pending)) report(error?.message || 'Payment outcome is unknown. Retry to reconcile the same operation.'); }
            finally { if (current(pending)) save.disabled = false; }
          }, { signal });
          actionDisclosure.append(form); row.append(actionDisclosure);
        } else if (writable() && card.kind === 'response' && !['resolved', 'cancelled'].includes(card.state)) {
          const form = element('form');
          const actionDisclosure = element('details'); actionDisclosure.append(element('summary', 'Record response outcome'));
          form.append(element('p', 'This records that the request was addressed. It does not send a message.'));
          const rationaleLabel = element('label', ' Evidence or rationale '); const rationale = element('textarea'); rationale.required = true; rationale.maxLength = 1000; rationaleLabel.append(rationale);
          const save = element('button', 'Mark response addressed'); save.type = 'submit'; form.append(rationaleLabel, save);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!current(pending) || !writable() || save.disabled || !rationale.value.trim()) return;
            save.disabled = true;
            try {
              await submitOpenLoopOperation({ key: `open-loop-response:${card.loopId}`, method: 'command-center.v1.open-loops.decide', params: { decision: 'resolve', rationale: rationale.value.trim() }, card, pending, success: 'Response outcome recorded. No message was sent.' });
            } catch (error) { if (current(pending)) report(error?.message || 'Response outcome is unknown. Retry to reconcile the same operation.'); }
            finally { if (current(pending)) save.disabled = false; }
          }, { signal });
          actionDisclosure.append(form); row.append(actionDisclosure);
        } else if (writable() && card.kind === 'decision' && card.state === 'decision-needed') {
          const form = element('form');
          const actionDisclosure = element('details'); actionDisclosure.append(element('summary', 'Revise recorded decision'));
          form.append(element('p', 'Record the choice you now want to keep. The prior choice and source evidence remain in history.'));
          const choiceLabel = element('label', 'Chosen option '); const chosenOption = element('input'); chosenOption.required = true; chosenOption.maxLength = 500; choiceLabel.append(chosenOption);
          const rationaleLabel = element('label', ' Rationale '); const rationale = element('textarea'); rationale.required = true; rationale.maxLength = 2000; rationaleLabel.append(rationale);
          const save = element('button', 'Record revised decision'); save.type = 'submit'; form.append(choiceLabel, rationaleLabel, save);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!current(pending) || !writable() || save.disabled || !chosenOption.value.trim() || !rationale.value.trim()) return;
            save.disabled = true;
            try {
              await submitOpenLoopOperation({ key: `renovation-decision:${card.loopId}`, method: 'command-center.v1.open-loops.renovation-decision-revise', params: { chosenOption: chosenOption.value.trim(), rationale: rationale.value.trim(), decidedAt: new Date().toISOString() }, card, pending, success: 'The revised decision was recorded; earlier evidence remains available.' });
            } catch (error) { if (current(pending)) report(error?.message || 'The decision outcome is unknown. Retry to reconcile the same operation.'); }
            finally { if (current(pending)) save.disabled = false; }
          }, { signal });
          actionDisclosure.append(form); row.append(actionDisclosure);
        }
        appendDecisionControls(row, card, pending);
        group.append(row);
      }
    }
    for (const section of afterAttention) primary.append(section);
    const inventory = element('details'); inventory.dataset.openLoopInventory = 'true'; inventory.append(element('summary', `Review all open loops (${openLoops.total})`));
    const inventoryRows = element('section'); inventoryRows.setAttribute('aria-label', 'All open loops');
    const more = element('button', 'Load open loops'); more.type = 'button'; let offset = 0; let cursor;
    more.addEventListener('click', async () => {
      if (!current(pending) || more.disabled) return;
      more.disabled = true;
      try {
        const page = unwrap(await host.request('command-center.v1.open-loops.list', { schemaVersion: 1, offset, limit: 20, ...(cursor === undefined ? {} : { cursor }) }));
        if (!current(pending) || !Array.isArray(page?.loops) || page.offset !== offset) throw new Error('The open-loop inventory changed. Refresh before continuing.');
        for (const loop of page.loops) {
          if (!nonBlank(loop.loopId) || !nonBlank(loop.title) || inventoryRows.querySelector(`[data-open-loop-id="${CSS.escape(loop.loopId)}"]`)) continue;
          const row = element('article'); row.className = 'cc-open-loop-card'; row.dataset.openLoopId = loop.loopId; row.dataset.loopKind = loop.kind ?? 'general';
          row.append(element('h4', loop.title), element('p', [loop.paymentState ?? loop.state, formatDue(loop) ? `Due ${formatDue(loop)}` : null].filter(Boolean).join(' · ')));
          const evidence = element('button', 'Review evidence'); evidence.type = 'button';
          evidence.addEventListener('click', async () => {
            if (!current(pending) || evidence.disabled) return; evidence.disabled = true;
            try {
              const detail = unwrap(await host.request('command-center.v1.open-loops.get', { schemaVersion: 1, loopId: loop.loopId }));
              if (!current(pending) || detail?.loop?.loopId !== loop.loopId) return;
              let disclosure = row.querySelector('details[data-open-loop-evidence]');
              if (!disclosure) { disclosure = element('details'); disclosure.dataset.openLoopEvidence = 'true'; row.append(disclosure); }
              renderEvidence(disclosure, detail); appendRenovationRelationshipCorrectionControl(row, loop, detail, pending); disclosure.open = true;
            } catch (error) { if (current(pending)) report(error?.message || 'Open-loop evidence is unavailable.'); }
            finally { if (current(pending)) evidence.disabled = false; }
          }, { signal });
          row.append(evidence);
          appendDecisionControls(row, loop, pending);
          inventoryRows.append(row);
        }
        offset = page.nextOffset ?? offset + page.loops.length;
        cursor = page.nextCursor ?? cursor;
        if (page.hasMore && nonBlank(page.nextCursor)) { more.textContent = 'Load more open loops'; more.disabled = false; }
        else more.remove();
      } catch (error) { if (current(pending)) { more.disabled = false; report(error?.message || 'The open-loop inventory is unavailable.'); } }
    }, { signal });
    inventory.append(inventoryRows, more); content.append(inventory);
  }

  function render(episode) {
    intake.hidden = true;
    content.replaceChildren();
    const card = element('article'); card.dataset.episodeId = episode.episodeId;
    card.append(element('h2', episode.context || 'Attention item'), element('p', `${episode.severity} · ${episode.state}`));
    const evidence = element('details'); evidence.append(element('summary', 'Evidence'));
    const evidenceText = element('pre', text({ diagnosis: episode.diagnosis, evidence: episode.evidenceFacts }));
    evidenceText.style.whiteSpace = 'pre-wrap'; evidence.append(evidenceText); card.append(evidence);
    content.append(card);
    if (episode.sourceCapabilityId === 'topic-review') {
      card.append(element('p', 'Topic Review decisions are not yet available on this native page. No Topic action has been submitted.'));
      return;
    }
    if (!nonBlank(episode.topicId) || !nonBlank(episode.sourceReferenceId) || !nonBlank(episode.sourceRevision)) {
      card.append(element('p', 'The exact Topic source and revision are unavailable. Source Recovery is required before taking an action.'));
      return;
    }
    if (!writable()) card.append(element('p', 'Connect with write access to take an action.'));
    const operation = operations.get(episode.episodeId);
    if (operation) {
      card.append(element('p', `${operation.pending ? 'Action pending' : 'Action outcome not confirmed'} · ${operation.params.logicalOperationId}. Refreshing or reopening this page does not submit another action.`));
      const reconcile = element('button', 'Reconcile same action'); reconcile.type = 'button'; reconcile.disabled = operation.pending || !writable();
      reconcile.addEventListener('click', () => void run(episode, operation), { signal }); card.append(reconcile);
      return;
    }
    if (episode.state !== 'Active') { card.append(element('p', 'This item has no action available in its current state.')); return; }
    for (const action of episode.actions ?? []) {
      if (!nonBlank(action.actionId) || !nonBlank(action.label) || !['mutation', 'navigation'].includes(action.kind)) continue;
      const form = element('form');
      form.append(element('h3', action.label));
      for (const [label, value] of Object.entries(action.target?.disclosure ?? {})) form.append(element('p', `${label}: ${text(value)}`));
      if (action.sideEffects?.length) form.append(element('p', `Side effects: ${action.sideEffects.join(' ')}`));
      let inputValue = () => ({});
      const snooze = ['attention.snooze', 'reminder.snooze'].includes(action.actionId);
      if (snooze) {
        const choices = episode.eligibleSnoozeChoices ?? [];
        if (!choices.length) continue;
        const label = element('label', 'Snooze duration'); const select = element('select');
        for (const choice of choices) { const option = element('option', ({ PT1H: 'One hour', P1D: 'One day', NEXT_0700: 'Tomorrow morning', PT72H: 'Three days', PT168H: 'One week', custom: 'Custom time' })[choice] ?? choice); option.value = choice; select.append(option); }
        label.append(select); form.append(label);
        const timeLabel = element('label', 'Custom snooze time'); const time = element('input'); time.type = 'datetime-local'; timeLabel.append(time); timeLabel.hidden = true; form.append(timeLabel);
        select.addEventListener('change', () => { timeLabel.hidden = select.value !== 'custom'; time.required = !timeLabel.hidden; }, { signal });
        inputValue = () => select.value === 'custom' ? { until: new Date(time.value).toISOString() } : { preset: select.value };
      } else if (Object.keys(action.parameterSchema?.properties ?? {}).some((key) => key !== 'expectedConfigRevision')) {
        const label = element('label', `Parameters for ${action.label} (JSON)`); const input = element('textarea'); input.value = '{}'; input.rows = 4; label.append(input); form.append(label);
        inputValue = () => { const value = JSON.parse(input.value); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Action parameters must be a JSON object.'); return value; };
      }
      const button = element('button', action.label); button.type = 'submit'; button.disabled = !writable(); form.append(button);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!writable() || selected !== episode || operations.has(episode.episodeId)) return;
        try {
          const input = inputValue();
          if (['reminder.complete', 'reminder.snooze'].includes(action.actionId)) input.expectedConfigRevision = episode.sourceRevision;
          const approvalId = action.target?.approvalId;
          if (['approval.approve', 'approval.reject'].includes(action.actionId) && !nonBlank(approvalId)) throw new Error('The exact approval is unavailable. Refresh Attention.');
          const params = { schemaVersion: 1, topicId: episode.topicId, sourceReferenceId: episode.sourceReferenceId,
            episodeId: episode.episodeId, expectedEpisodeRevision: episode.revision, expectedSourceRevision: episode.sourceRevision,
            actionId: action.actionId, input, ...(approvalId ? { approvalId } : {}), logicalOperationId: crypto.randomUUID() };
          if (new TextEncoder().encode(JSON.stringify(params)).length > 8192) throw new Error('Action parameters exceed the supported size.');
          const operation = { params, kind: action.kind, pending: false }; operations.set(episode.episodeId, operation);
          void run(episode, operation);
        } catch (error) { report(error.message || 'Check the action parameters.'); }
      }, { signal });
      card.append(form);
    }
  }

  async function run(episode, operation) {
    if (!writable() || operation.pending || selected !== episode) return;
    const pending = ++generation; operation.pending = true; render(episode); report('Submitting the exact action…'); status.focus();
    try {
      const response = await host.request('command-center.v1.attention.act', operation.params);
      const result = unwrap(response);
      if (response?.schemaVersion !== 1 || response.logicalOperationId !== operation.params.logicalOperationId ||
          !['applied', 'approval-required'].includes(result?.status) || result?.episode?.episodeId !== episode.episodeId) throw new Error('The action outcome is not confirmed. Reconcile the same action before choosing another.');
      operations.delete(episode.episodeId);
      if (!current(pending) || !writable()) return;
      if (result.navigation) {
        const target = result.navigation;
        if (operation.kind !== 'navigation' || target.actionId !== operation.params.actionId || target.kind !== 'navigation' || target.target?.topicId !== episode.topicId) throw new Error('The returned destination is not supported on this native page.');
        const response = await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId: episode.topicId });
        if (!current(pending) || !writable()) return;
        if (unwrap(response)?.topic?.topicId !== episode.topicId) throw new Error('The exact Topic is unavailable.');
        host.navigation.openPage({ id: 'topic', params: { topicId: episode.topicId } }); return;
      }
      await load(result.status === 'approval-required' ? 'Approval is required. Review the exact disclosure below.' : 'Action applied.');
    } catch (error) {
      if (current(pending)) report(error?.message || 'The action outcome is unknown. Reconcile the same action.');
    } finally {
      operation.pending = false;
      if (current(pending) && selected === episode) render(episode);
    }
  }

  async function load(message = '') {
    if (content.childElementCount) captureTransientUiState();
    const pending = ++generation; selected = undefined; content.replaceChildren(); setBusy(false); container.inert = !presented || signal.aborted;
    intake.hidden = Boolean(recordId) || pageMode === 'planner';
    if (signal.aborted || !presented) return;
    if (!readable()) {
      const disconnected = element('section'); disconnected.className = 'cc-disconnected';
      disconnected.append(element('h2', 'Command Center is not connected'), element('p', 'Email, Chat and Note processing coverage cannot be checked yet. Connect with read access before treating this inbox as complete.'));
      content.append(disconnected); report('Connect with read access to view Attention.'); return;
    }
    setBusy(true); report('Loading Attention…');
    try {
      const response = await host.request('command-center.v1.dashboard.get', { schemaVersion: 1, activityOffset: 0, activityLimit: 20 });
      if (!current(pending)) return;
      const dashboard = unwrap(response);
      if (!Array.isArray(dashboard?.attention) || !Array.isArray(dashboard?.inProgress)) throw new Error('The Attention destination is unavailable.');
      const cards = [...dashboard.attention, ...dashboard.inProgress];
      if (!recordId) {
        const workspace = element('div'); workspace.className = 'cc-workspace'; workspace.dataset.pageMode = pageMode;
        const focus = element('section'); focus.className = 'cc-focus'; focus.setAttribute('aria-label', pageMode === 'planner' ? 'Planner workspace' : 'Focus');
        const dashboards = element('aside'); dashboards.className = 'cc-dashboards'; dashboards.id = 'command-center-dashboards'; dashboards.setAttribute('aria-label', 'Dashboards');
        if (pageMode === 'dashboard') {
          const focusTitle = element('div'); focusTitle.className = 'cc-zone-head'; focusTitle.append(element('h2', 'What needs you now'), element('p', 'Focused and time-sensitive'));
          const jump = element('a', 'Jump to dashboards'); jump.href = '#command-center-dashboards'; jump.className = 'cc-dashboard-jump'; focusTitle.append(jump); focus.append(focusTitle);
          const dashboardsTitle = element('div'); dashboardsTitle.className = 'cc-zone-head'; dashboardsTitle.append(element('h2', 'Context at a glance'), element('p', 'Topics, intake and what is coming')); dashboards.append(dashboardsTitle);
          renderDashboardPreferences(dashboards, dashboard, pending);
          renderBriefings(dashboards, dashboard, pending);
          const topic = dashboard.topics?.find(item => item.topicId === dashboardPreferences.pinnedTopicId) ?? dashboard.topics?.find(item => /renovat/i.test(item.name)) ?? dashboard.topics?.[0];
          if (topic) {
            const topicCard = element('section'); topicCard.className = 'cc-module cc-topic-widget'; topicCard.dataset.dashboardSection = 'topic'; topicCard.append(element('p', 'Pinned Topic'), element('h3', topic.name)); topicCard.firstChild.className = 'cc-kicker';
            const openLoops = dashboard.openLoops ?? {};
            const projected = openLoops.workspace ?? {};
            const completeBoard = Object.values(projected.board ?? {}).flatMap(openLoopsArray);
            const topicLoops = (completeBoard.length ? completeBoard : [
              ...openLoopsArray(projected.today?.mandatory), ...openLoopsArray(projected.today?.planned), ...openLoopsArray(projected.upcoming), ...openLoopsArray(projected.capacity), ...openLoopsArray(projected.waiting),
              ...openLoopsArray(openLoops.highlighted), ...openLoopsArray(openLoops.comingUp), ...openLoopsArray(openLoops.waiting), ...openLoopsArray(openLoops.suggested), ...openLoopsArray(openLoops.reconciliation)
            ]).filter(item => item.topicId === topic.topicId);
            const topicTotal = new Set(topicLoops.map(item => item.loopId)).size;
            topicCard.append(element('p', `${topicTotal} current item${topicTotal === 1 ? '' : 's'} across the complete workspace board.`));
            const widgetActions = element('div'); widgetActions.className = 'cc-widget-actions';
            const openTopicWork = element('button', `View ${topicTotal} matching item${topicTotal === 1 ? '' : 's'} in Planner`); openTopicWork.type = 'button'; openTopicWork.addEventListener('click', () => { if (current(pending)) host.navigation.openPage({ id: 'planner', params: { topicId: topic.topicId } }); }, { signal }); widgetActions.append(openTopicWork);
            const openTopic = element('button', `Open ${topic.name}`); openTopic.type = 'button'; openTopic.addEventListener('click', () => { if (current(pending)) host.navigation.openPage({ id: 'topic', params: { topicId: topic.topicId } }); }, { signal }); widgetActions.append(openTopic); topicCard.append(widgetActions); dashboards.append(topicCard);
          }
          const coverage = element('section'); coverage.className = 'cc-module'; coverage.dataset.dashboardSection = 'coverage'; coverage.append(element('h3', 'Intake coverage'));
          const coverageRows = Array.isArray(dashboard.intakeCoverage) ? dashboard.intakeCoverage : [];
          if (!coverageRows.length) coverage.append(element('p', 'Coverage is unknown because this response contains no maintained processing receipts.'));
          for (const row of coverageRows) {
            const article = element('article'); article.className = 'cc-coverage-card'; article.append(element('h4', row.source ?? row.sourceKind ?? 'Source'), element('p', `${row.status ?? 'unknown'}${row.lastObservedAt ? ` · Last attempt ${formatInstant(row.lastObservedAt)} (${row.receiptStatus ?? 'unknown'})` : ''}${row.lastSuccessfulAt ? ` · Last successful ${formatInstant(row.lastSuccessfulAt)}` : ''}`));
            if (row.nextExpectedAt) article.append(element('p', `Next expected checkpoint ${formatInstant(row.nextExpectedAt)}.`));
            if (row.lastAdmittedRetry) article.append(element('p', `Admitted-work retry ${row.lastAdmittedRetry.status} at ${formatInstant(row.lastAdmittedRetry.observedAt)} · ${row.lastAdmittedRetry.processedCount} source${row.lastAdmittedRetry.processedCount === 1 ? '' : 's'} recorded in the retry receipt${row.lastAdmittedRetry.unadmittedSourceCount ? `; ${row.lastAdmittedRetry.unadmittedSourceCount} source${row.lastAdmittedRetry.unadmittedSourceCount === 1 ? ' was not admitted and remains' : 's were not admitted and remain'} for producer recovery` : ''}. This did not scan new mail; source and outcome accounting remains separate.`));
            if (row.readerLocations) article.append(element('p', `Original-email reader links: ${row.readerLocations.status} · ${row.readerLocations.available} location${row.readerLocations.available === 1 ? '' : 's'} recorded · ${row.readerLocations.unavailable} explicitly unavailable · ${row.readerLocations.missing} without a reader receipt${row.readerLocations.lookupFailed ? ` · ${row.readerLocations.lookupFailed} lookup${row.readerLocations.lookupFailed === 1 ? '' : 's'} failed` : ''} across ${row.readerLocations.total} latest admitted source${row.readerLocations.total === 1 ? '' : 's'}${row.readerLocations.lastObservedAt ? ` · Last reader observation ${formatInstant(row.readerLocations.lastObservedAt)}` : ''}. Capture can succeed while reader refresh is unconfirmed; a recorded link is not proof it opens.`));
            if (row.readerRefresh) article.append(element('p', row.readerRefresh.status === 'unknown' ? `Reader refresh run status is unknown for this accepted capture${row.readerRefresh.lastSuccessfulAt ? ` · Previous completed refresh ${formatInstant(row.readerRefresh.lastSuccessfulAt)}` : ''}.` : `Reader refresh run: ${row.readerRefresh.status} at ${formatInstant(row.readerRefresh.observedAt)}${row.readerRefresh.failureCode ? ` (${row.readerRefresh.failureCode})` : ''} · ${row.readerRefresh.linkedCount} confirmed linked · ${row.readerRefresh.unavailableCount} confirmed unavailable of ${row.readerRefresh.selectedCount} selected${row.readerRefresh.lastSuccessfulAt ? ` · Last completed ${formatInstant(row.readerRefresh.lastSuccessfulAt)}` : ''}. This status is separate from accepted email capture; pending or failed effects may still need verification.`));
            const scopeText = scope => `${scope.folders.join(', ')} · ${formatInstant(scope.sinceUtc)} to ${formatInstant(scope.beforeUtc)} · at most ${scope.maxMessages} scanned messages per ${scope.batchKind} batch`;
            if (row.attemptScope) article.append(element('p', `Latest attempt scope: ${scopeText(row.attemptScope)}.`));
            if (row.lastSuccessfulAt && (!row.lastSuccessfulScope || JSON.stringify(row.lastSuccessfulScope) !== JSON.stringify(row.attemptScope))) article.append(element('p', row.lastSuccessfulScope ? `Last successful scope: ${scopeText(row.lastSuccessfulScope)}.` : 'Last successful scope is unknown for an older receipt.'));
            if (row.sourceKind === 'email') article.append(element('p', !row.discovery || row.discovery.scope === 'unknown' ? 'Upstream discovery scope is unknown for this receipt; accounted sources do not establish whole-mailbox coverage.' : `Upstream discovery in the recorded scope: ${row.discovery.scannedCount} scanned · ${row.discovery.remainingCount} remaining · ${row.discovery.failedReadCount} failed reads${row.discovery.scanCapReached ? ' · scan cap reached' : ''}${row.discovery.canResume ? ' · continuation retained' : ''}.`));
            if (row.explanation) article.append(element('p', row.explanation));
            if (row.sourceCounts || row.outcomeCounts) {
              const summary = element('p', `${row.sourceCounts?.accounted ?? 0} of ${row.sourceCounts?.observed ?? 0} admitted sources accounted for · ${row.sourceCounts?.resolved ?? 0} resolved · ${row.outcomeCounts?.accounted ?? 0} of ${row.outcomeCounts?.expected ?? 0} outcomes accounted for · ${row.outcomeCounts?.pendingDecisions ?? 0} decisions pending · ${row.outcomeCounts?.failed ?? 0} failed outcomes`);
              summary.className = 'cc-coverage-note'; article.append(summary);
            }
            const recentSources = Array.isArray(row.recentSources) ? row.recentSources : [];
            if (recentSources.length) {
              const details = element('details'); details.append(element('summary', `Inspect ${recentSources.length} recent source${recentSources.length === 1 ? '' : 's'}`));
              for (const [index, source] of recentSources.entries()) {
                const sourceRow = element('div'); sourceRow.className = 'cc-coverage-source';
                sourceRow.append(element('strong', `Source ${index + 1}${source.observedAt ? ` · observed ${formatInstant(source.observedAt)}` : ''}`), element('p', `${source.accounted ? 'Accounted for' : 'Partially accounted for'} · ${source.resolved ? 'Resolved' : 'Still open'} · ${source.counts?.accounted ?? 0} of ${source.counts?.expected ?? 0} outcomes`));
                if (nonBlank(source.checkpoint)) { const technical = element('details'); technical.append(element('summary', 'Technical source checkpoint'), element('code', source.checkpoint)); sourceRow.append(technical); }
                if (source.enumeration?.failedReadCount || source.enumeration?.remainingCount || source.enumeration?.scanCapReached) sourceRow.append(element('p', `${source.enumeration.failedReadCount ?? 0} failed reads · ${source.enumeration.remainingCount ?? 0} remaining${source.enumeration.scanCapReached ? ' · scan cap reached' : ''}`));
                const outcomes = element('ul');
                for (const outcome of source.outcomes ?? []) {
                  const item = element('li'); item.append(element('span', `${outcome.summary ?? 'Recorded outcome'}: ${outcome.status}`));
                  if (outcome.target?.kind === 'open-loop' && nonBlank(outcome.target.loopId)) {
                    const review = element('button', 'Review item'); review.type = 'button';
                    review.addEventListener('click', async () => {
                      if (!current(pending) || review.disabled) return; review.disabled = true;
                      try {
                        const detail = unwrap(await host.request('command-center.v1.open-loops.get', { schemaVersion: 1, loopId: outcome.target.loopId }));
                        if (!current(pending) || detail?.loop?.loopId !== outcome.target.loopId) return;
                        let disclosure = item.querySelector('details[data-intake-outcome-evidence]');
                        if (!disclosure) { disclosure = element('details'); disclosure.dataset.intakeOutcomeEvidence = 'true'; disclosure.append(element('summary', 'Source evidence')); item.append(disclosure); }
                        renderEvidence(disclosure, detail); disclosure.open = true;
                      } catch (error) { if (current(pending)) report(error?.message || 'The recorded item is unavailable.'); }
                      finally { if (current(pending)) review.disabled = false; }
                    }, { signal }); item.append(review);
                  } else if (outcome.target?.kind === 'topic-note' && [outcome.target.topicId, outcome.target.sourceReferenceId, outcome.target.sourcePath, outcome.target.sourceVersion].every(nonBlank)) {
                    const open = element('button', 'Open retained Note'); open.type = 'button';
                    open.addEventListener('click', () => { if (current(pending)) host.navigation.openPage({ id: 'topic', params: { topicId: outcome.target.topicId, sourceReferenceId: outcome.target.sourceReferenceId, sourcePath: outcome.target.sourcePath, evidenceSourceVersion: outcome.target.sourceVersion } }); }, { signal }); item.append(open);
                  }
                  outcomes.append(item);
                }
                sourceRow.append(outcomes); details.append(sourceRow);
              }
              article.append(details);
            }
            coverage.append(article);
          }
          const coverageNote = element('p', 'Gateway availability is not treated as proof that email or Notes were processed.'); coverageNote.className = 'cc-coverage-note'; coverage.append(coverageNote); dashboards.append(coverage);
        } else if (nonBlank(topicFilter)) {
          const filteredTopic = dashboard.topics?.find(item => item.topicId === topicFilter);
          const filter = element('section'); filter.className = 'cc-module'; filter.append(element('h2', `Planner for ${filteredTopic?.name ?? topicFilter}`), element('p', 'Showing this Topic across the complete board, agenda and open-loop views.'));
          const clear = element('button', 'Show all Topics'); clear.type = 'button'; clear.addEventListener('click', () => { if (current(pending)) host.navigation.openPage({ id: 'planner' }); }, { signal }); filter.append(clear); focus.append(filter);
        }
        workspace.append(focus); if (pageMode === 'dashboard') workspace.append(dashboards); content.append(workspace);
        if (pageMode === 'dashboard') renderRoutineOccurrences(focus, dashboard, pending);
        if (cards.length) focus.append(element('h2', 'Needs Attention'));
        for (const card of cards) {
          if (!nonBlank(card.notificationRecordId)) continue;
          const button = element('button', `Review ${card.context || 'Attention item'}`); button.type = 'button';
          button.addEventListener('click', () => { if (current(pending)) host.navigation.openPage({ id: 'attention', params: { notificationRecord: card.notificationRecordId } }); }, { signal }); focus.append(button);
        }
        renderOpenLoops(dashboard.openLoops, pending, { primary: focus, secondary: pageMode === 'planner' ? focus : dashboards, planner: pageMode === 'planner', topicId: pageMode === 'planner' ? topicFilter : undefined, topics: dashboard.topics });
        if (pageMode === 'dashboard') renderQuickCapture(focus, dashboard, pending);
        if (pageMode === 'dashboard') { renderActivity(Array.isArray(dashboard?.activity?.records) ? dashboard.activity.records : [], pending, dashboards); applyDashboardPreferences(dashboards); }
        const coverageKnown = Array.isArray(dashboard.intakeCoverage) && dashboard.intakeCoverage.length > 0;
        restoreTransientUiState();
        report(message || (cards.length || dashboard.openLoops?.attentionTotal ? 'Review the current Attention items and open loops.' : coverageKnown ? 'No current Attention items. Intake coverage is shown in Dashboards.' : 'No items are shown, but intake coverage is unknown. Do not treat this as a complete inbox.')); return;
      }
      const matches = cards.filter((card) => card.notificationRecordId === recordId);
      if (matches.length !== 1) { report(`${message ? `${message} ` : ''}The exact Attention item is no longer available in the current inbox. Refresh to check again.`); return; }
      const card = matches[0];
      const detail = unwrap(await host.request('command-center.v1.attention.get', { schemaVersion: 1, episodeId: card.episodeId }))?.episode;
      if (!current(pending)) return;
      if (detail?.episodeId !== card.episodeId || detail.topicId !== card.topicId || detail.sourceReferenceId !== card.sourceReferenceId || !Number.isSafeInteger(detail.revision)) throw new Error('The exact Attention source changed. Refresh before taking an action.');
      selected = { ...detail, context: card.context }; render(selected); report(message || 'Attention item ready.');
    } catch (error) { if (current(pending)) report(error?.message || 'Attention is unavailable.'); }
    finally { if (current(pending)) setBusy(false); }
  }
  refresh.addEventListener('click', () => void load(), { signal });
  topics.addEventListener('click', () => { if (!signal.aborted && presented) { generation++; host.navigation.openPage({ id: 'topics' }); } }, { signal });
  switchView.addEventListener('click', () => { if (!signal.aborted && presented) { generation++; host.navigation.openPage({ id: pageMode === 'planner' ? 'attention' : 'planner' }); } }, { signal });
  let access = `${readable()}:${host.connection.canWrite}`;
  const unsubscribe = host.subscribe(() => { const next = `${readable()}:${host.connection.canWrite}`; if (next !== access) { access = next; void load(); } });
  let disposed = false;
  const cleanup = () => { if (disposed) return; disposed = true; generation++; unsubscribe(); container.inert = false; container.classList.remove('cc-command-center-page'); container.replaceChildren(); };
  signal.addEventListener('abort', cleanup, { once: true });
  void load();
  if (signal.aborted) cleanup();
  return {
    update(next) { if (recordId === next.props.notificationRecord && topicFilter === next.props.topicId && presented === next.presented) return; recordId = next.props.notificationRecord; topicFilter = next.props.topicId; presented = next.presented; void load(); },
    focus() { refresh.focus(); },
    dispose() { lifetime.abort(); cleanup(); }
  };
}

const openLoopsArray = value => Array.isArray(value) ? value : [];

export function mountPlannerPage(container, context, operations = new Map()) {
  return mountAttentionPage(container, context, operations, 'planner');
}
