const HTTP_ROUTE = '/plugins/command-center/api/topics/actions';
const SHELL_ROUTE = '/plugins/command-center';
const topicCreateForm = document.querySelector('#topic-create');
const topicCreateSubmit = document.querySelector('#topic-create-submit');
const topicNameInput = topicCreateForm?.elements.name;
const statusNode = document.querySelector('#topic-status');
const hasTopicsDestination = Boolean(topicCreateForm && statusNode);
const PAGE_ACTION_ROUTE = '/plugins/command-center/api/topic/actions';
const SEARCH_REBUILD_ROUTE = '/plugins/command-center/api/search/rebuild';
const markdownModuleUrl = /^https?:/u.test(document.baseURI) ? new URL('/plugins/command-center/markdown.js', document.baseURI).href : '/plugins/command-center/markdown.js';
let markdownModule;
function loadMarkdownModule() { return markdownModule ??= import(markdownModuleUrl); }
const SCRIPTED_FORM_IDS = new Set(['topic-analysis-schedule', 'notification-settings-form', 'topic-create', 'topic-search-form', 'chat-form', 'conversation-create', 'note-action-form', 'command-dialog-form', 'workspace-search-form']);
document.addEventListener('click', (event) => {
  const submitter = event.target?.closest?.('button[type="submit"],input[type="submit"]');
  const form = submitter?.form;
  if (!form || !SCRIPTED_FORM_IDS.has(form.id) || event.defaultPrevented) return;
  event.preventDefault();
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
});
const requestedTopicId = new URLSearchParams(window.location.search).get('topicId');
// Native prompts are blocked by the host's scripts-only sandbox.
let pendingCommandDialog = null;
function askUser(message, { value, details = '' } = {}) {
  const dialog = document.querySelector('#command-dialog');
  if (!dialog || pendingCommandDialog) return Promise.resolve(null);
  const invoker = document.activeElement;
  document.querySelector('#command-dialog-message').textContent = message;
  const input = document.querySelector('#command-dialog-input');
  input.value = value ?? ''; input.required = value !== undefined;
  document.querySelector('#command-dialog-input-label').hidden = value === undefined;
  const disclosure = document.querySelector('#command-dialog-details');
  disclosure.textContent = details; disclosure.hidden = !details;
  return new Promise((resolve) => {
    pendingCommandDialog = { resolve, invoker, expectsInput: value !== undefined };
    dialog.showModal();
    (value === undefined ? document.querySelector('#command-dialog-cancel') : input).focus();
  });
}
function finishCommandDialog(accepted) {
  const pending = pendingCommandDialog;
  if (!pending) return;
  const input = document.querySelector('#command-dialog-input');
  if (accepted && pending.expectsInput && !input.reportValidity()) return;
  const result = accepted ? (pending.expectsInput ? input.value : true) : null;
  pendingCommandDialog = null;
  document.querySelector('#command-dialog').close();
  if (pending.invoker?.isConnected) pending.invoker.focus();
  pending.resolve(result);
}
document.querySelector('#command-dialog-form')?.addEventListener('submit', (event) => { event.preventDefault(); finishCommandDialog(true); });
document.querySelector('#command-dialog-cancel')?.addEventListener('click', () => finishCommandDialog(false));
document.querySelector('#command-dialog')?.addEventListener('cancel', (event) => { event.preventDefault(); finishCommandDialog(false); });
const promptUser = (message, value = '') => askUser(message, { value });
const confirmUser = (message, details = '') => askUser(message, { details });
let currentDestination = { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [] };
let topicCreatePending = false;
let topicCreateOperation = null;
const DASHBOARD_ACTIONS_ROUTE = '/plugins/command-center/api/dashboard/actions';
const TOPIC_ANALYSIS_ROUTE = '/plugins/command-center/api/topic-analysis';
const TOPIC_ANALYSIS_ACTIONS_ROUTE = '/plugins/command-center/api/topic-analysis/actions';
const hasDashboardDestination = Boolean(document.querySelector('#dashboard'));
let dashboardState = null;
let evidenceReturnFocus = null;
let activityRecords = [];
let notificationSettingsRevision = null;
let topicAnalysisScheduleRevision = null;
let topicReviewState = null;
let operatingState = Object.freeze({ mode: 'recovery-only', unavailableCapabilities: ['operating-mode-unverified'] });

async function dashboardRead(offset = 0) {
  return unwrap(await bridgeRequest('command-center.v1.dashboard.get', { schemaVersion: 1, activityOffset: offset, activityLimit: 50 }));
}
function dashboardButton(label, action, { mutation = true } = {}) { const node = mutation ? mutationButton(label, action) : button(label, action); node.className = 'dashboard-action'; return node; }
function displayEvidence(value) {
  const target = document.querySelector('#evidence-content');
  target.replaceChildren();
  const entries = Object.entries(value ?? {});
  if (!entries.length) { target.append(Object.assign(document.createElement('p'), { textContent: 'No additional evidence was recorded.' })); return; }
  for (const [key, item] of entries) {
    const row = document.createElement('p'); const label = document.createElement('strong'); label.textContent = `${key}: `; const text = document.createElement('span'); text.textContent = typeof item === 'string' ? item : JSON.stringify(item); row.append(label, text); target.append(row);
  }
}
function showEvidence(episode, trigger) {
  const dialog = document.querySelector('#evidence-dialog');
  evidenceReturnFocus = trigger;
  document.querySelector('#evidence-heading').textContent = `${episode.context || 'Attention item'} evidence`;
  displayEvidence(episode.evidence ?? episode.evidenceFacts);
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  document.querySelector('.evidence-scroll')?.focus();
}
document.querySelector('#evidence-dialog')?.addEventListener('close', () => { evidenceReturnFocus?.focus?.(); evidenceReturnFocus = null; });
document.querySelector('#evidence-close')?.addEventListener('click', () => document.querySelector('#evidence-dialog')?.close?.());
function renderNotificationSettings(settings) {
  if (!settings) return;
  notificationSettingsRevision = settings.revision;
  for (const [id, value] of [['settings-due-reminders', settings.dueReminders], ['settings-important-items', settings.importantItems], ['settings-critical-realerts', settings.criticalRealerts], ['settings-quiet-enabled', settings.quietHoursEnabled], ['settings-generic-preview', settings.genericPreview]]) {
    const control = document.querySelector(`#${id}`); if (control) control.checked = value === true;
  }
  for (const [id, value] of [['settings-quiet-start', settings.quietHoursStart], ['settings-quiet-end', settings.quietHoursEnd], ['settings-time-zone', settings.timeZone]]) {
    const control = document.querySelector(`#${id}`); if (control && document.activeElement !== control) control.value = value ?? '';
  }
}
async function topicAnalysisRead() {
  const response = await fetch(TOPIC_ANALYSIS_ROUTE, { credentials: 'omit', headers: { accept: 'application/json' } });
  const value = await response.json(); if (!response.ok || value.status === 'error') throw new Error(value.message || 'Topic Analysis is unavailable.'); return value.result ?? value;
}
function renderTopicReview(review) {
  topicReviewState = review; const target = document.querySelector('#topic-review-groups'); const checkpoint = document.querySelector('#topic-review-checkpoint'); if (!target) return;
  const active = document.activeElement;
  const focusIntent = target.contains(active) ? { proposalId: active.closest('[data-proposal-id]')?.dataset.proposalId, label: active.textContent } : null;
  target.replaceChildren();
  for (const group of review?.groups ?? []) {
    const section = document.createElement('section'); section.className = 'topic-review-group'; const heading = document.createElement('h5'); heading.textContent = `${group.topicId} · ${group.operation}`; section.append(heading);
    for (const proposal of group.proposals ?? []) {
      const card = document.createElement('article'); card.className = 'topic-review-proposal'; card.dataset.proposalId = proposal.proposalId; const summary = document.createElement('p'); summary.textContent = `${proposal.operation} · ${proposal.evidenceFacts?.length ?? 0} inspectable facts · ${proposal.state}`; const evidence = document.createElement('ul'); for (const fact of proposal.evidenceFacts ?? []) { const item = document.createElement('li'); item.textContent = `${fact.sourceId} @ ${fact.sourceRevision}: ${fact.fact}`; evidence.append(item); }
      const disclosures = [
        ['Rationale', proposal.rationale],
        ['Exact before state', proposal.before],
        ['Exact after state', proposal.after],
        ['Affected Topic identities', proposal.affectedTopicIds],
        ['Affected Source identities', proposal.affectedSourceIds],
        ['Planned Source identities', proposal.plannedSourceIds],
        ['Provenance', proposal.provenance],
        ['Search and retrieval consequences', proposal.searchRetrievalConsequences],
        ['Blocked outcomes', proposal.blockers],
        ['Reversibility and irreversible outcomes', proposal.reversibility]
      ];
      card.append(summary, evidence);
      for (const [label, value] of disclosures) { const row = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = `${label}: `; const content = document.createElement('span'); content.textContent = typeof value === 'string' ? value : JSON.stringify(value ?? null); row.append(strong, content); card.append(row); }
      const inspectable = typeof proposal.rationale === 'string' && proposal.rationale.trim() && proposal.before && proposal.after && Array.isArray(proposal.affectedTopicIds) && Array.isArray(proposal.affectedSourceIds) && proposal.provenance && proposal.searchRetrievalConsequences && Array.isArray(proposal.blockers) && proposal.reversibility;
      const actions = document.createElement('div'); const approve = dashboardButton('Approve', () => topicReviewDecision('proposal.approve', proposal)); const adjust = dashboardButton('Adjust', () => topicReviewAdjust(proposal)); const keep = dashboardButton('Keep as-is', () => topicReviewDecision('proposal.keep-as-is', proposal)); for (const control of [approve, adjust, keep]) control.disabled = !inspectable || proposal.state !== 'pending'; if (proposal.operation === 'archive') adjust.disabled = true; actions.append(approve, adjust, keep); card.append(actions); section.append(card);
    }
    target.append(section);
  }
  if (!target.childElementCount) target.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No Topic Review proposals.' }));
  if (checkpoint) { const proposals = review?.proposals ?? []; checkpoint.hidden = proposals.length === 0 || !proposals.some((proposal) => proposal.state === 'approved') || proposals.some((proposal) => proposal.state !== 'approved'); }
  const snooze = document.querySelector('#topic-review-snooze'); if (snooze) snooze.hidden = !review || review.state === 'Resolved';
  if (focusIntent) {
    const available = [...target.querySelectorAll('button')].filter((control) => !control.disabled && !control.hidden);
    const retained = available.find((control) => control.closest('[data-proposal-id]')?.dataset.proposalId === focusIntent.proposalId && control.textContent === focusIntent.label);
    const next = retained ?? available[0] ?? (checkpoint && !checkpoint.hidden && !checkpoint.disabled ? checkpoint : null);
    if (next) next.focus();
    else { const heading = document.querySelector('#topic-review-heading'); if (heading) { heading.tabIndex = -1; heading.focus(); } }
  }
}
async function topicAnalysisAction(action, input = {}) { requireReadyMutation(); const response = await fetch(TOPIC_ANALYSIS_ACTIONS_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action, logicalOperationId: operationId(), ...input }) }); const value = await response.json(); if (!response.ok || value.status === 'error') throw new Error(value.message || 'Topic Analysis action was refused.'); return value.result ?? value; }
async function topicReviewDecision(action, proposal) { const feedback = document.querySelector('#analysis-feedback'); try { await topicAnalysisAction(action, { proposalId: proposal.proposalId, expectedProposalRevision: proposal.revision }); feedback.textContent = 'Proposal decision saved.'; await loadTopicAnalysis(); } catch (error) { feedback.textContent = error.message; } }
async function topicReviewAdjust(proposal) { const feedback = document.querySelector('#analysis-feedback'); if (proposal.operation === 'archive') { feedback.textContent = 'Archive proposals support Approve or Keep as-is.'; return; } const target = proposal.after?.topic ?? proposal.after ?? {}; const initial = proposal.operation === 'create' ? { name: target.name, paraCategory: target.paraCategory } : { paraCategory: target.paraCategory }; const adjustmentJson = await promptUser('Enter the adjusted name/category fields as JSON.', JSON.stringify(initial)); if (!adjustmentJson) return; try { await topicAnalysisAction('proposal.adjust', { proposalId: proposal.proposalId, expectedProposalRevision: proposal.revision, adjustment: JSON.parse(adjustmentJson) }); feedback.textContent = 'Proposal adjustment approved.'; await loadTopicAnalysis(); } catch (error) { feedback.textContent = error.message; } }
async function loadTopicAnalysis() { try { const value = await topicAnalysisRead(); const settings = value.schedule; if (settings) { topicAnalysisScheduleRevision = settings.revision; for (const [id, item] of [['analysis-enabled', settings.enabled], ['analysis-weekday', String(settings.weekday)]]) { const control = document.querySelector(`#${id}`); if (control) id === 'analysis-enabled' ? control.checked = item : control.value = item; } for (const [id, item] of [['analysis-local-time', settings.localTime], ['analysis-time-zone', settings.timeZone]]) { const control = document.querySelector(`#${id}`); if (control && document.activeElement !== control) control.value = item; } } renderTopicReview(value.review); } catch (error) { const feedback = document.querySelector('#analysis-feedback'); if (feedback) feedback.textContent = error.message || 'Topic Analysis is unavailable.'; } }
document.querySelector('#topic-analysis-schedule')?.addEventListener('submit', async (event) => { event.preventDefault(); try { await topicAnalysisAction('schedule.update', { expectedRevision: topicAnalysisScheduleRevision, settings: { enabled: document.querySelector('#analysis-enabled').checked, weekday: Number(document.querySelector('#analysis-weekday').value), localTime: document.querySelector('#analysis-local-time').value, timeZone: document.querySelector('#analysis-time-zone').value.trim() } }); document.querySelector('#analysis-feedback').textContent = 'Analysis schedule saved.'; await loadTopicAnalysis(); } catch (error) { document.querySelector('#analysis-feedback').textContent = error.message; } });
document.querySelector('#analysis-run')?.addEventListener('click', async () => { try { await topicAnalysisAction('analysis.run', { trigger: 'manual' }); document.querySelector('#analysis-feedback').textContent = 'Analysis completed.'; await loadTopicAnalysis(); } catch (error) { document.querySelector('#analysis-feedback').textContent = error.message; } });
document.querySelector('#topic-review-checkpoint')?.addEventListener('click', async () => { const feedback = document.querySelector('#topic-review-plan'); try { const proposals = topicReviewState?.proposals ?? []; const plan = await topicAnalysisAction('review.apply', { reviewId: 'topic-review:global', expectedReviewRevision: topicReviewState?.episodeRevision, approvedProposalRevisions: proposals.filter((proposal) => proposal.state === 'approved').map((proposal) => ({ proposalId: proposal.proposalId, revision: proposal.revision })), applicationId: operationId(), confirm: false }); const checkpoint = plan?.result ?? plan; if (!checkpoint) throw new Error('The final checkpoint was unavailable.'); const visiblePlan = { planRevision: checkpoint.planRevision, reviewRevision: checkpoint.reviewRevision, proposalRevisions: checkpoint.currentProposalRevisions, dependencies: checkpoint.dependencies, exactEffects: checkpoint.effects, preconditions: checkpoint.steps?.map((step) => ({ proposalId: step.proposalId, preconditions: step.preconditions })), compensationDisclosures: checkpoint.steps?.map((step) => ({ proposalId: step.proposalId, compensation: step.compensation })), blockedAndIrreversibleOutcomes: { blockers: checkpoint.blockers, reversibility: checkpoint.steps?.map((step) => ({ proposalId: step.proposalId, reversibility: step.intent?.authoritativePreview?.reversibility ?? step.compensation })) } }; feedback.textContent = `Frozen application plan (inspect before confirming):\n${JSON.stringify(visiblePlan, null, 2)}`; if (!await confirmUser(`Apply only frozen plan ${checkpoint.planRevision}?`, feedback.textContent)) return; const applied = await topicAnalysisAction('review.apply', { reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true }); const outcomes = Object.values(applied?.outcomes ?? {}).map((item) => item?.status).filter(Boolean); feedback.textContent = outcomes.length ? `Application outcomes: ${outcomes.join(', ')}.` : 'Approved changes applied.'; await loadTopicAnalysis(); } catch (error) { feedback.textContent = error.message; } });
document.querySelector('#topic-review-snooze')?.addEventListener('click', async () => { const feedback = document.querySelector('#analysis-feedback'); const until = await promptUser('Snooze Topic Review until (RFC3339).', new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()); if (!until || !topicReviewState) return; try { await topicAnalysisAction('review.snooze', { reviewId: 'topic-review:global', expectedReviewRevision: topicReviewState.episodeRevision, snoozedUntil: until }); feedback.textContent = 'Topic Review snoozed.'; await loadTopicAnalysis(); } catch (error) { feedback.textContent = error.message; } });
async function saveNotificationSettings(event) {
  event.preventDefault();
  const feedback = document.querySelector('#settings-feedback');
  const settings = {
    dueReminders: document.querySelector('#settings-due-reminders').checked,
    importantItems: document.querySelector('#settings-important-items').checked,
    criticalRealerts: document.querySelector('#settings-critical-realerts').checked,
    quietHoursEnabled: document.querySelector('#settings-quiet-enabled').checked,
    quietHoursStart: document.querySelector('#settings-quiet-start').value,
    quietHoursEnd: document.querySelector('#settings-quiet-end').value,
    timeZone: document.querySelector('#settings-time-zone').value.trim(),
    genericPreview: document.querySelector('#settings-generic-preview').checked
  };
  if (!event.currentTarget.reportValidity()) return;
  try {
    const response = await fetch(DASHBOARD_ACTIONS_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action: 'settings.update', logicalOperationId: operationId(), expectedRevision: notificationSettingsRevision, settings }) });
    const value = await response.json();
    if (!response.ok || value.status === 'error') throw new Error(value.message || 'Notification settings were refused.');
    feedback.textContent = 'Notification settings saved.';
    await loadDashboard();
  } catch (error) { feedback.textContent = error.message || 'Notification settings were refused.'; }
}
document.querySelector('#notification-settings-form')?.addEventListener('submit', saveNotificationSettings);
const dashboardOperations = new Map();
function renderDashboardProgress() {
  const progress = document.querySelector('#in-progress');
  if (!progress) return;
  const authoritative = dashboardState?.inProgress ?? [];
  const items = authoritative.map((episode) => Object.assign(document.createElement('p'), { textContent: episode.context || 'Action in progress' }));
  for (const [episodeId, operation] of dashboardOperations) {
    if (authoritative.some((episode) => episode.episodeId === episodeId)) continue;
    const item = document.createElement('p'); item.dataset.pendingOperation = operation.params.logicalOperationId;
    item.textContent = `${operation.pending ? 'Awaiting source confirmation' : 'Outcome unconfirmed'}: ${operation.context || 'Action'}`; items.push(item);
  }
  progress.replaceChildren(...items);
  if (!items.length) progress.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Nothing in progress.' }));
}
async function dashboardMutate(episode, action, input = {}) {
  requireReadyMutation();
  const approvalId = episode.actions?.find((item) => item.actionId === action)?.target?.approvalId;
  const intent = JSON.stringify({ action, input, approvalId });
  let operation = dashboardOperations.get(episode.episodeId);
  if (operation && operation.intent !== intent) throw new Error('The previous action is not yet confirmed. Reconcile that action before choosing another.');
  operation ??= { intent, context: episode.context, params: {
    schemaVersion: 1, logicalOperationId: operationId(), sourceCapabilityId: episode.sourceCapabilityId, stableSubjectId: episode.stableSubjectId, episodeId: episode.episodeId,
    expectedEpisodeRevision: episode.revision, expectedSourceRevision: episode.sourceRevision ?? undefined, topicId: episode.topicId, sourceReferenceId: episode.sourceReferenceId, actionId: action, input: structuredClone(input), ...(approvalId ? { approvalId } : {})
  } };
  dashboardOperations.set(episode.episodeId, operation);
  if (operation.pending) return operation.pending;
  operation.pending = (async () => {
    try {
      const value = await bridgeRequest('command-center.v1.attention.act', operation.params);
      if (!['applied', 'approval-required'].includes(value?.status)) {
        throw new Error(`Action outcome: ${value?.status ?? 'unavailable'}. Inspect Activity and the source before taking another action.`);
      }
      dashboardOperations.delete(episode.episodeId);
      return value;
    } catch (error) {
      if (error.terminal !== false) dashboardOperations.delete(episode.episodeId);
      throw error;
    } finally { operation.pending = null; renderDashboardProgress(); }
  })();
  renderDashboardProgress();
  return operation.pending;
}
async function openTopic(topicId) {
  const feedback = document.querySelector('#dashboard-feedback') ?? statusNode;
  try {
    const value = unwrap(await bridgeRequest('command-center.v1.topics.get', { schemaVersion: 1, topicId }));
    const topic = value?.topic;
    if (!topic || topic.topicId !== topicId) throw new Error('The authoritative Topic changed before it could be opened.');
    const searchSelect = document.querySelector('#topic-search-topic-id');
    if (searchSelect) searchSelect.value = topicId;
    if (hasTopicsDestination) await loadTopics();
    const target = document.querySelector(`[data-topic-id="${CSS.escape(topicId)}"]`) ?? document.querySelector('#topics-heading');
    if (!target) throw new Error('The selected Topic is unavailable in this view.');
    target.setAttribute('tabindex', '-1'); target.scrollIntoView?.({ block: 'start' }); target.focus?.();
    if (feedback) feedback.textContent = `${topic.name || 'Topic'} opened.`;
    return topic;
  } catch (error) { if (feedback) feedback.textContent = error.message || 'The authoritative Topic could not be opened.'; throw error; }
}
async function runDashboardAction(episode, action, input, label) {
  const feedback = document.querySelector('#dashboard-feedback');
  try {
    delete feedback.dataset.activityReceipt;
    const result = await dashboardMutate(episode, action, input);
    const activity = result?.result?.activity ?? result?.activity;
    if (activity?.activityId) {
      const keys = ['activityId', 'episodeId', 'logicalOperationId', 'attemptId', 'topicId', 'sourceReferenceId', 'actorMode', 'actionId', 'operationKind', 'outcome', 'verificationRevision', 'occurredAt'];
      const receipt = Object.fromEntries(keys.filter((key) => activity[key] !== undefined).map((key) => [key, activity[key]]));
      const serialized = JSON.stringify(receipt);
      if (serialized.length <= 4096) feedback.dataset.activityReceipt = serialized;
    }
    const navigation = result?.result?.navigation ?? result?.navigation;
    if (navigation?.topicId) { await openTopic(navigation.topicId); return; }
    feedback.textContent = label;
    await loadDashboard();
  }
  catch (error) {
    feedback.textContent = error.terminal === false ? 'Action is not yet confirmed. Reconcile the same action to check its outcome.' : error.message || 'Action was refused by the authoritative source.';
    const operation = dashboardOperations.get(episode.episodeId);
    if (operation) feedback.append(dashboardButton('Reconcile action', () => runDashboardAction(episode, operation.params.actionId, operation.params.input, 'Action reconciled.')));
  }
}
function snoozeControl(episode) {
  // Global Topic Review has its own revisioned owner; it is not a Topic-bound source action.
  if (episode.sourceCapabilityId === 'topic-review') return null;
  const choices = Array.isArray(episode.eligibleSnoozeChoices) ? episode.eligibleSnoozeChoices : [];
  if (!choices.length) return null;
  const wrapper = document.createElement('div'); wrapper.className = 'snooze-control';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Snooze duration');
  const labels = { NEXT_0700: 'Tomorrow morning', PT72H: 'Three days', PT168H: 'One week', custom: 'Custom time' };
  for (const choice of choices) { const option = document.createElement('option'); option.value = choice; option.textContent = labels[choice] ?? choice; select.append(option); }
  const custom = document.createElement('input'); custom.type = 'datetime-local'; custom.setAttribute('aria-label', 'Custom snooze time'); custom.hidden = true;
  select.addEventListener('change', () => { custom.hidden = select.value !== 'custom'; if (!custom.hidden) custom.focus(); });
  wrapper.append(select, custom, dashboardButton('Snooze', () => {
    const value = select.value;
    if (value === 'custom' && !custom.value) { document.querySelector('#dashboard-feedback').textContent = 'Choose a future custom time.'; custom.focus(); return; }
    let input;
    try { input = value === 'custom' ? { until: new Date(custom.value).toISOString() } : { preset: value }; }
    catch { document.querySelector('#dashboard-feedback').textContent = 'Choose a valid future custom time.'; custom.focus(); return; }
    if (episode.sourceCapabilityId === 'reminders') input.expectedConfigRevision = episode.sourceRevision;
    return runDashboardAction(episode, episode.sourceCapabilityId === 'reminders' ? 'reminder.snooze' : 'attention.snooze', input, 'Item snoozed.');
  }));
  return wrapper;
}
function renderAttentionCard(episode) {
  const card = document.createElement('article'); card.className = 'attention-card'; card.dataset.notificationRecord = episode.notificationRecordId ?? '';
  card.dataset.episodeId = episode.episodeId;
  card.dataset.sourceCapabilityId = episode.sourceCapabilityId;
  const heading = document.createElement('h4'); heading.textContent = episode.context || 'Attention item';
  const meta = document.createElement('p'); meta.className = 'card-meta'; meta.textContent = `${episode.severity || 'Attention'} · ${episode.sourceKind || 'Source'}`;
  card.append(heading, meta);
  const actions = document.createElement('div'); actions.className = 'card-actions';
  if (episode.sourceCapabilityId === 'topic-review') actions.append(dashboardButton('Open Topic Review', () => { const heading = document.querySelector('#topic-review-heading'); heading.setAttribute('tabindex', '-1'); heading.scrollIntoView?.({ block: 'start' }); heading.focus(); }, { mutation: false }));
  const disclosure = episode.actions?.find((action) => action.actionId === 'approval.approve')?.target?.disclosure;
  if (disclosure) {
    for (const [label, value] of [['Pending approval', disclosure.actionId], ['Target', disclosure.target], ['Parameters', disclosure.parameters], ['Side effects', disclosure.sideEffects], ['Expires', disclosure.expiresAt]]) {
      const details = document.createElement('p'); details.textContent = `${label}: ${typeof value === 'string' ? value : JSON.stringify(value ?? null)}`; card.append(details);
    }
  }
  for (const action of (episode.actions ?? []).filter((item) => !['attention.snooze', 'reminder.snooze'].includes(item.actionId)).slice(0, 3)) actions.append(dashboardButton(action.label || 'Open', () => runDashboardAction(episode, action.actionId, action.actionId === 'reminder.complete' ? { expectedConfigRevision: episode.sourceRevision } : {}, `${action.label || 'Action'} accepted.`)));
  const snooze = snoozeControl(episode); if (snooze) actions.append(snooze);
  const evidence = dashboardButton('View evidence', () => showEvidence(episode, evidence), { mutation: false }); actions.append(evidence);
  card.append(actions); return card;
}
function fillTopicLaunchers(topics) {
  for (const id of ['header-topic-selector', 'flow-topic-launcher']) {
    const select = document.querySelector(`#${id}`); if (!select) continue;
    const first = select.firstElementChild; select.replaceChildren(first);
    for (const topic of topics ?? []) { const option = document.createElement('option'); option.value = topic.topicId; option.textContent = topic.name; select.append(option); }
    select.onchange = () => { const value = select.value; if (value) void openTopic(value).catch(() => {}); };
  }
}
function renderActivity(records, append = false) {
  const target = document.querySelector('#activity'); if (!append) activityRecords = [];
  activityRecords = [...activityRecords, ...(records ?? [])]; target.replaceChildren(...activityRecords.map((record) => {
    const row = document.createElement('article'); row.className = 'activity-row'; row.dataset.activityId = record.activityId; const text = document.createElement('span'); text.textContent = `${record.operationKind || 'Activity'} · ${record.outcome || 'recorded'}`; row.append(text);
    if (record.navigation?.verified === true && ['session', 'note'].includes(record.navigation.kind)) row.append(dashboardButton('Open source', () => openActivity(record), { mutation: false }));
    return row;
  }));
  if (!activityRecords.length) target.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No routine history.' }));
}
async function openActivity(record) {
  const feedback = document.querySelector('#dashboard-feedback');
  try {
    if (record.navigation.kind === 'note') {
      const note = unwrap(await bridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: record.navigation.topicId, referenceId: record.navigation.referenceId, path: record.navigation.path, observedRevision: record.navigation.observedRevision, offset: 0 }));
      if (note?.path !== record.navigation.path || note?.revision !== record.navigation.observedRevision || note?.sourceReference?.referenceId !== record.navigation.referenceId || note?.sourceReference?.topicId !== record.navigation.topicId) throw new Error('The authoritative Note changed after this Activity was recorded.');
      document.querySelector('#topic-search-detail').textContent = decodeText(note.contentBase64);
      feedback.textContent = 'Activity source opened.';
      return;
    }
    const target = unwrap(await bridgeRequest('command-center.v1.sessions.navigate', { schemaVersion: 1, topicId: record.navigation.topicId, referenceId: record.navigation.referenceId }));
    if (!target?.sessionKey || target.sessionKey !== record.navigation.sessionKey || target.sessionId !== record.navigation.sessionId || target.sourceReference?.referenceId !== record.navigation.referenceId || target.sourceReference?.topicId !== record.navigation.topicId) throw new Error('The authoritative Conversation changed after this Activity was recorded.');
    await bridgeRequest('ui.session.navigate', { sessionKey: target.sessionKey });
    feedback.textContent = 'Activity source opened.';
  } catch (error) { feedback.textContent = error.message || 'Authoritative navigation was refused.'; }
}
function focusNotificationTarget() {
  const params = new URLSearchParams(window.location.search);
  const record = params.get('record');
  const notification = params.get('openclawNotification') ?? params.get('notification');
  const hasNotificationRequest = ['record', 'destination', 'notification', 'openclawNotification'].some((name) => params.has(name));
  if (!hasNotificationRequest) return;
  if (notification !== 'plugin-detail' || params.get('destination') !== 'attention-card' || !/^record-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record ?? '')) { document.querySelector('#dashboard-feedback').textContent = 'This notification link is unavailable.'; return; }
  const card = document.querySelector(`[data-notification-record="${CSS.escape(record)}"]`);
  if (card) { card.setAttribute('tabindex', '-1'); card.focus(); document.querySelector('#dashboard-feedback').textContent = 'Notification opened. No changes were made.'; }
  else document.querySelector('#dashboard-feedback').textContent = 'This notification is no longer available.';
}
async function loadDashboard() {
  try {
    dashboardState = await dashboardRead(0); renderNotificationSettings(dashboardState.notificationSettings); const attention = document.querySelector('#attention-cards');
    attention.replaceChildren(...(dashboardState.attention ?? []).map(renderAttentionCard));
    if (!attention.childElementCount) attention.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Nothing needs attention.' }));
    document.querySelector('#attention-badge').textContent = String(dashboardState.attentionBadgeCount ?? 0);
    renderDashboardProgress();
    const coming = document.querySelector('#coming-up'); coming.replaceChildren(...(dashboardState.comingUp ?? []).map((item) => { const row = document.createElement('p'); row.textContent = `${item.day} · ${item.time} · ${item.context} · ${item.label}`; return row; })); if (!coming.childElementCount) coming.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No future Reminders.' }));
    fillTopicLaunchers(dashboardState.topics); renderActivity(dashboardState.activity?.records); const more = document.querySelector('#activity-load-more'); more.textContent = 'Load more Activity'; more.hidden = dashboardState.activity?.hasMore !== true; more.onclick = async () => { const next = await dashboardRead(dashboardState.activity.nextOffset); dashboardState.activity = next.activity; renderActivity(next.activity.records, true); more.hidden = next.activity.hasMore !== true; }; if (statusNode) statusNode.textContent = 'Dashboard is current.';
    focusNotificationTarget();
    await loadTopicAnalysis();
  } catch (error) { document.querySelector('#dashboard-feedback').textContent = error.message || 'Dashboard is unavailable.'; }
}

function operationId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function unwrap(value) { while (value?.result !== undefined || value?.value !== undefined) value = value.result ?? value.value; return value; }
const pendingBridgeRequests = new Map();
const BRIDGE_OPERATION_BUDGET_MS = 180_000;
const bridgeLimits = { maxConcurrentRequests: 8, maxRequestsPerMinute: 60, maxMutationsPerMinute: 12 };
const bridgeQueue = []; const bridgeRequestTimes = []; const bridgeMutationTimes = new Map();
let bridgeActive = 0; let bridgeCooldownUntil = 0; let bridgeQueueTimer;
function drainBridgeQueue() {
  clearTimeout(bridgeQueueTimer);
  const now = Date.now();
  for (let index = bridgeQueue.length - 1; index >= 0; index -= 1) {
    if (bridgeQueue[index].deadline <= now) {
      const [expired] = bridgeQueue.splice(index, 1);
      expired.reject(Object.assign(new Error('Host capacity wait expired. Retry the unchanged action.'), { code: 'RATE_LIMITED', terminal: false }));
    }
  }
  while (bridgeRequestTimes[0] <= now - 60_000) bridgeRequestTimes.shift();
  for (const [id, at] of bridgeMutationTimes) if (at <= now - 60_000) bridgeMutationTimes.delete(id);
  while (bridgeQueue.length) {
    const job = bridgeQueue[0];
    let until = bridgeCooldownUntil;
    if (bridgeRequestTimes.length >= bridgeLimits.maxRequestsPerMinute) until = Math.max(until, bridgeRequestTimes[0] + 60_001);
    if (job.operationId && !bridgeMutationTimes.has(job.operationId) && bridgeMutationTimes.size >= bridgeLimits.maxMutationsPerMinute) until = Math.max(until, Math.min(...bridgeMutationTimes.values()) + 60_001);
    if (until > now || bridgeActive >= bridgeLimits.maxConcurrentRequests) {
      const earliestDeadline = Math.min(...bridgeQueue.map((queued) => queued.deadline));
      bridgeQueueTimer = setTimeout(drainBridgeQueue, Math.max(1, Math.min(earliestDeadline, until > now ? until : earliestDeadline) - now)); break;
    }
    bridgeQueue.shift(); bridgeRequestTimes.push(now); bridgeActive += 1;
    if (job.operationId && !bridgeMutationTimes.has(job.operationId)) bridgeMutationTimes.set(job.operationId, now);
    void sendBridgeRequest(job).then(job.resolve, (error) => {
      const rateRefusal = error.code === 'RATE_LIMITED' && error.retryable === true && Number.isInteger(error.retryAfterMs) && error.retryAfterMs > 0 && error.retryAfterMs <= 60_000;
      if (rateRefusal) bridgeCooldownUntil = Math.max(bridgeCooldownUntil, Date.now() + error.retryAfterMs);
      if (rateRefusal && job.retries < 2 && Date.now() + error.retryAfterMs < job.deadline) {
        job.retries += 1; bridgeQueue.unshift(job);
      } else job.reject(error);
    }).finally(() => { bridgeActive -= 1; drainBridgeQueue(); });
  }
  const feedback = document.querySelector('#bridge-queue-status');
  if (feedback) feedback.textContent = bridgeQueue.length ? 'Waiting for host capacity. Your action is retained; no need to submit again.' : '';
}
let advertisedBridgeMethods = new Set();
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
    const methods = new Set(Array.isArray(message.methods) ? message.methods : []); advertisedBridgeMethods = methods;
    for (const key of Object.keys(bridgeLimits)) if (Number.isInteger(message.limits?.[key]) && message.limits[key] > 0) bridgeLimits[key] = Math.min(bridgeLimits[key], message.limits[key]);
    const required = [...(hasTopicsDestination ? ['command-center.v1.topics.list'] : []), 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.notes.browse', 'command-center.v1.search.query', 'command-center.v1.notes.read', 'command-center.v1.sessions.navigate', 'command-center.v1.sessions.send', 'ui.session.navigate'];
    if (message.upgradeRequired === true || !required.every((method) => methods.has(method))) rejectBridgeReady(new Error('Command Center requires unavailable host capabilities.'));
    else resolveBridgeReady();
    return;
  }
  if (message?.type !== 'openclaw:capability-bridge-response') return;
  const pending = pendingBridgeRequests.get(message.requestId);
  if (!pending) return;
  pendingBridgeRequests.delete(message.requestId);
  if (message.error) pending.reject(Object.assign(new Error(message.error.code === 'MUTATION_RECONCILIATION_REQUIRED' ? 'The host no longer retains this action outcome. Inspect Activity and the source before taking another action.' : message.error.message || 'Capability bridge request failed.'), { code: message.error.code, retryable: message.error.retryable, retryAfterMs: message.error.retryAfterMs, terminal: !['MUTATION_OUTCOME_UNKNOWN', 'TIMEOUT', 'RATE_LIMITED'].includes(message.error.code) }));
  else pending.resolve(message.result);
});
async function bridgeRequest(method, params, mutationOperationId = params?.logicalOperationId) {
  const capturedParams = structuredClone(params);
  await bridgeReady;
  if (bridgeQueue.length >= 128) throw Object.assign(new Error('Host request queue is full. Retry the unchanged action.'), { code: 'RATE_LIMITED', terminal: false });
  return new Promise((resolve, reject) => { bridgeQueue.push({ method, params: capturedParams, operationId: mutationOperationId, deadline: Date.now() + BRIDGE_OPERATION_BUDGET_MS, retries: 0, resolve, reject }); drainBridgeQueue(); });
}
async function sendBridgeRequest(job) {
  const { method, params, operationId: mutationOperationId } = job;
  const requestId = operationId();
  const timeoutMs = Math.min(job.deadline - Date.now(), method === 'command-center.v1.notes.browse' ? 120_000 : 30_000);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingBridgeRequests.delete(requestId); reject(Object.assign(new Error(`Capability bridge request exceeded ${timeoutMs / 1_000} seconds.`), { code: 'TIMEOUT', terminal: false })); }, timeoutMs);
    pendingBridgeRequests.set(requestId, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    sendBridge({ type: 'openclaw:capability-bridge-request', requestId, method, params, ...(typeof mutationOperationId === 'string' ? { operationId: mutationOperationId } : {}) });
  });
}
const STATIC_MUTATION_SELECTORS = Object.freeze(['#topic-create', '#notification-settings-form', '#topic-analysis-schedule', '#topic-review-snooze', '#topic-review-checkpoint', '#topic-search-rebuild', '#conversation-create', '#chat-form', '#note-new', '#note-save', '#note-rename', '#note-move', '#note-action-submit', '#workspace-search-rebuild']);
function mutationsAvailable() { return operatingState.mode === 'ready'; }
function applyOperatingState(value) {
  const mode = ['ready', 'degraded', 'recovery-only'].includes(value?.mode) ? value.mode : 'recovery-only';
  operatingState = Object.freeze({ mode, unavailableCapabilities: Object.freeze(Array.isArray(value?.unavailableCapabilities) ? [...value.unavailableCapabilities] : []) });
  if (document.documentElement) document.documentElement.dataset.operatingMode = mode;
  const queryAll = (selector) => document.querySelectorAll?.(selector) ?? [];
  for (const selector of STATIC_MUTATION_SELECTORS) for (const node of queryAll(selector)) { node.hidden = mode !== 'ready'; for (const control of node.matches?.('button,input,select,textarea') ? [node] : node.querySelectorAll?.('button,input,select,textarea') ?? []) control.disabled = mode !== 'ready'; }
  for (const node of queryAll('[data-command-center-mutation]')) { node.hidden = mode !== 'ready'; node.disabled = mode !== 'ready'; }
  const status = document.querySelector('#operating-mode-status'); if (status) status.textContent = mode === 'ready' ? 'Ready' : mode === 'degraded' ? 'Degraded · safe reads only' : 'Recovery-only · diagnostics and safe reads only';
}
async function loadOperatingState() {
  if (!advertisedBridgeMethods.has('command-center.v1.sources.status')) { applyOperatingState({ mode: 'recovery-only', unavailableCapabilities: ['command-center.v1.sources.status'] }); return operatingState; }
  try { const value = unwrap(await bridgeRequest('command-center.v1.sources.status', { schemaVersion: 1 })); applyOperatingState(value); }
  catch { applyOperatingState({ mode: 'recovery-only', unavailableCapabilities: ['command-center.v1.sources.status'] }); }
  return operatingState;
}
function requireReadyMutation() { if (!mutationsAvailable()) throw new Error(`Mutations are unavailable in ${operatingState.mode} mode.`); }
async function rebuildTopicSearchProjection(topicId) {
  requireReadyMutation();
  const logicalOperationId = operationId();
  await bridgeRequest('command-center.v1.search.prepare-rebuild', { schemaVersion: 1, topicId, logicalOperationId });
  const response = await fetch(SEARCH_REBUILD_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, topicId, logicalOperationId }) });
  const value = await response.json();
  if (!response.ok || value.status === 'error') throw new Error(value.message || 'Topic Search rebuild was refused.');
  return value;
}
function searchProjectionUnavailable(error) {
  return error?.code === 'capability-unavailable' || (error?.code === 'INVALID_PARAMS' && error?.message === 'Gateway rejected bridge request');
}
async function queryTopicSearch(params) {
  try { return unwrap(await bridgeRequest('command-center.v1.search.query', params)); }
  catch (error) {
    if (!searchProjectionUnavailable(error)) throw error;
    await rebuildTopicSearchProjection(params.topicId);
    return unwrap(await bridgeRequest('command-center.v1.search.query', params));
  }
}
async function read(view = 'destination') {
  if (view === 'destination') return unwrap(await bridgeRequest('command-center.v1.topics.list', { schemaVersion: 1 }));
  throw new Error('Unsupported read view.');
}
async function mutate(action, input) {
  requireReadyMutation();
  const logicalOperationId = input.logicalOperationId ?? operationId();
  const request = action === 'create'
    ? { ...input, topicId: input.topicId, authoritativeSession: await createAuthoritativeSession(input.name, logicalOperationId) }
    : input;
  let response; let value;
  try {
    response = await fetch(HTTP_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action, logicalOperationId, ...request }) });
    value = await response.json();
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('The Topic action response was unavailable.'), { terminal: false }); }
  if (!response.ok || value.status === 'error') throw Object.assign(new Error(value.message || 'Topic action failed.'), { code: value.code, terminal: !['unknown', 'unavailable'].includes(value.code), destination: value.result?.destination });
  return value;
}
function validateTopicNameInput() {
  const normalized = topicNameInput.value.trim().normalize('NFC');
  const valid = normalized && new TextEncoder().encode(normalized).length <= 255 && !/[\\/\u0000-\u001f\u007f]/u.test(normalized) && normalized !== '.' && normalized !== '..';
  topicNameInput.setCustomValidity(valid ? '' : 'Use one safe Topic name of at most 255 UTF-8 bytes.');
  return valid;
}
function button(label, action) { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', action); return node; }
function mutationButton(label, action) { const node = button(label, action); node.dataset.commandCenterMutation = 'true'; node.hidden = !mutationsAvailable(); node.disabled = !mutationsAvailable(); return node; }
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
  const row = document.createElement('div'); row.className = 'topic-row'; row.dataset.topicId = topic.topicId; const name = document.createElement('strong'); name.textContent = topic.name; row.append(name);
  if (kind === 'provisioning') {
    row.append(mutationButton('Retry', () => runAction('provisioning.retry', { topicId: topic.topicId, expectedRevision: topic.revision, logicalOperationId: topic.provisioningOperationId }, 'Provisioning record retried.')));
    row.append(mutationButton('Roll back', () => runAction('provisioning.rollback', { topicId: topic.topicId, expectedRevision: topic.revision, logicalOperationId: topic.provisioningOperationId }, 'Provisioning record rolled back.')));
  } else if (kind === 'archived') {
    row.append(mutationButton('Restore to project', () => runAction('restore', { topicId: topic.topicId, paraCategory: 'project', expectedRevision: topic.revision }, 'Topic restored.')));
    row.append(button('Search archive', () => { document.querySelector('#topic-search-topic-id').value = topic.topicId; document.querySelector('#topic-search-query').focus(); }));
  } else if (kind === 'recovery') {
    const recovery = topic.recovery.find((item) => item.state === 'required'); row.append(diagnostic(topic));
    row.append(mutationButton('Verify exact source', () => runAction('recovery.verify', { topicId: topic.topicId, referenceId: recovery.referenceId, expectedRevision: topic.revision, expectedSourceRevision: recovery.expectedRevision }, 'Source verified.')));
    if (recovery.sourceKind === 'session') {
      const exactSession = async () => { const sessionKey = await promptUser('Session key'); if (sessionKey === null) return null; const sessionId = await promptUser('Session ID'); return sessionId === null ? null : { sessionKey, sessionId }; };
      row.append(mutationButton('Relink Session', async () => { const session = await exactSession(); if (session) await runAction('recovery.relink', { topicId: topic.topicId, referenceId: recovery.referenceId, ...session, expectedRevision: topic.revision, expectedSourceRevision: recovery.expectedRevision }, 'Session relinked.'); }));
      row.append(mutationButton('Replace Primary Session', async () => { const session = await exactSession(); if (session) await runAction('recovery.replace-session', { topicId: topic.topicId, referenceId: recovery.referenceId, ...session, expectedRevision: topic.revision, expectedSourceRevision: recovery.expectedRevision }, 'Primary Session replaced.'); }));
    } else {
      row.append(mutationButton('Relink Note Folder', async () => { const replacementLocator = await promptUser('Exact Note Folder path'); if (replacementLocator !== null) await runAction('recovery.verify', { topicId: topic.topicId, referenceId: recovery.referenceId, replacementLocator, expectedRevision: topic.revision, expectedSourceRevision: recovery.expectedRevision }, 'Note Folder relinked.'); }));
    }
  } else {
    row.append(button('Open Topic', () => openTopicWorkspace(topic, AUTHORITATIVE_LIST_TOPIC)));
    row.append(mutationButton('Rename', async () => { const name = await promptUser('New Topic name', topic.name); if (name !== null) await runAction('rename', { topicId: topic.topicId, name, expectedRevision: topic.revision }, 'Topic renamed.'); }));
    const target = topic.paraCategory === 'project' ? 'area' : 'project'; row.append(mutationButton(`Move to ${target}`, async () => { const preview = await mutate('recategorize.preview', { topicId: topic.topicId, paraCategory: target, expectedRevision: topic.revision }); if (await confirmUser(`Category: ${topic.paraCategory} → ${target}\n${preview.result.preview.changes?.length ? 'Move managed Note Folder' : 'Note Folder location: unchanged (customized)'}`)) await runAction('recategorize.apply', { topicId: topic.topicId, paraCategory: target, expectedRevision: topic.revision, structuralChangeId: preview.result.preview.structuralChangeId, previewDigest: preview.result.preview.digest, expectedRevisions: preview.result.preview.expectedRevisions }, 'Topic moved.'); }));
    row.append(mutationButton('Archive', async () => { const preview = await mutate('archive.preview', { topicId: topic.topicId, expectedRevision: topic.revision }); if (await confirmUser(`Disable and retain every active Reminder and scheduled operation (${preview.result.preview.commitments?.filter((item) => item.enabled).length ?? 0} active of ${preview.result.preview.commitments?.length ?? 0} commitment(s))`)) await runAction('archive.apply', { topicId: topic.topicId, expectedRevision: topic.revision, structuralChangeId: preview.result.preview.structuralChangeId, previewDigest: preview.result.preview.digest, expectedRevisions: preview.result.preview.expectedRevisions }, 'Topic archived.'); }));
  }
  return row;
}
function renderList(id, topics, kind) { const target = document.querySelector(`#${id}`); target.replaceChildren(...(topics ?? []).map((topic) => topicRow(topic, kind))); if (!target.childElementCount) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'None'; target.append(empty); } }
function renderDestination(value) {
  const active = document.activeElement;
  const focusedTopicId = active?.closest?.('.topic-row')?.dataset.topicId;
  const focusedLabel = focusedTopicId && active instanceof HTMLButtonElement ? active.textContent : null;
  currentDestination = value; const groups = value.activeGroups ?? value.groups; for (const category of ['project', 'area', 'resource']) renderList(`topics-${category}`, groups?.[category], 'active');
  renderList('topics-provisioning', value.provisioning, 'provisioning'); renderList('topics-recovery', value.recovery, 'recovery'); renderList('topics-archived', value.archived, 'archived');
  const select = document.querySelector('#topic-search-topic-id'); const selected = select.value; select.replaceChildren(...[...(groups?.project ?? []), ...(groups?.area ?? []), ...(groups?.resource ?? []), ...(value.archived ?? [])].map((topic) => { const option = document.createElement('option'); option.value = topic.topicId; option.textContent = topic.name; return option; })); if ([...select.options].some((item) => item.value === selected)) select.value = selected;
  if (focusedTopicId) {
    const row = [...document.querySelectorAll('.topic-row')].find((item) => item.dataset.topicId === focusedTopicId);
    const controls = [...(row?.querySelectorAll('button:not(:disabled)') ?? [])].filter((item) => !item.closest('[hidden], [inert]') && item.getClientRects().length > 0);
    (controls.find((item) => item.textContent === focusedLabel) ?? controls[0] ?? document.querySelector('#topics-heading'))?.focus();
  }
}
async function loadTopics(message = '') { if (!hasTopicsDestination) return; try { renderDestination(await read('destination')); statusNode.textContent = message || 'Topics are current.'; } catch (error) { statusNode.textContent = error.message; } }
async function createTopic(event) { event.preventDefault(); if (topicCreatePending) return; validateTopicNameInput(); if (!topicCreateForm.reportValidity()) return; const intent = { name: topicNameInput.value.trim().normalize('NFC'), paraCategory: topicCreateForm.elements.paraCategory.value }; if (topicCreateOperation && (topicCreateOperation.name !== intent.name || topicCreateOperation.paraCategory !== intent.paraCategory)) { statusNode.textContent = 'The previous Topic creation is not yet confirmed. Retry its unchanged name and category first.'; return; } topicCreateOperation ??= { ...intent, topicId: crypto.randomUUID(), logicalOperationId: operationId() }; const restoreSubmitFocus = document.activeElement === topicCreateSubmit; topicCreatePending = true; topicCreateSubmit.disabled = true; statusNode.textContent = 'Creating Topic…'; try { const result = await mutate('create', { ...intent, topicId: topicCreateOperation.topicId, logicalOperationId: topicCreateOperation.logicalOperationId }); currentDestination = result.result?.value?.destination ?? result.result?.destination ?? currentDestination; renderDestination(currentDestination); statusNode.textContent = 'Topic created and verified.'; topicCreateOperation = null; topicCreateForm.reset(); } catch (error) { if (error.destination) currentDestination = error.destination; renderDestination(currentDestination); if (error.terminal !== false) topicCreateOperation = null; statusNode.textContent = error.terminal === false ? 'Topic creation is not yet confirmed. Retry the unchanged name and category to reconcile it.' : `Topic action failed: ${error.message}`; } finally { topicCreatePending = false; topicCreateSubmit.disabled = false; if (restoreSubmitFocus) topicCreateSubmit.focus(); } }
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
    const value = unwrap(await bridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: result.navigation.topicId, referenceId: result.navigation.referenceId, path: result.navigation.path, observedRevision: result.navigation.observedRevision, offset: 0 }));
    if (value?.path !== result.navigation.path || value?.revision !== result.navigation.observedRevision || value?.sourceReference?.referenceId !== result.navigation.referenceId || typeof value.contentBase64 !== 'string') throw new Error('The authoritative Note changed after this search result was created.');
    detail.textContent = decodeText(value.contentBase64);
  } catch (error) { detail.textContent = error.message || 'Authoritative navigation was refused.'; }
}
let topicSearchGeneration = 0;
document.querySelector('#topic-search-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const generation = ++topicSearchGeneration;
  const status = document.querySelector('#topic-search-status');
  status.textContent = 'Searching…';
  try {
    const value = await queryTopicSearch({ schemaVersion: 1, topicId: document.querySelector('#topic-search-topic-id').value, query: document.querySelector('#topic-search-query').value.trim(), limit: 50 });
    if (generation !== topicSearchGeneration) return;
    renderSearch('notes-results', value.notes?.results);
    renderSearch('conversations-results', value.conversations?.results);
    status.textContent = `${value.notes?.results?.length ?? 0} Notes · ${value.conversations?.results?.length ?? 0} Conversations`;
  } catch (error) {
    if (generation !== topicSearchGeneration) return;
    status.textContent = `Topic Search failed (${error?.code || 'unknown'}): ${error?.message || 'The search request was rejected.'}`;
  }
});
document.querySelector('#topic-search-rebuild')?.addEventListener('click', async () => { const status = document.querySelector('#topic-search-status'); status.textContent = 'Rebuilding Topic Search…'; try { await rebuildTopicSearchProjection(document.querySelector('#topic-search-topic-id').value); status.textContent = 'Topic Search index rebuilt from authoritative sources.'; } catch (error) { status.textContent = error.message || 'Topic Search rebuild failed.'; } });

const workspace = {
  topic: null, generation: 0, conversations: [], selected: null, selectionGeneration: 0, historyGeneration: 0, chatSendGeneration: 0, chatSendOperations: new Map(),
  conversationsLoadGeneration: 0, conversationCreateOperations: new Map(), conversationPage: 0, notes: [], notesTotal: 0, notesCursor: null, notesServerPaged: false, notesLoadGeneration: 0, notePage: 0, note: null, noteGeneration: 0, searchGeneration: 0, drafts: new Map(), panes: { conversations: true, notes: true }, mobileSection: 'chat'
};
const AUTHORITATIVE_LIST_TOPIC = Symbol('authoritative-list-topic');
const CONVERSATION_PAGE_SIZE = 50;
const NOTE_PAGE_SIZE = 100;
const HISTORY_RENDER_BATCH_SIZE = 50;
const workspaceNode = document.querySelector('#topic-workspace');
const workspaceStatus = document.querySelector('#workspace-status');
const notesStatus = document.querySelector('#notes-status');
const chatStatus = document.querySelector('#chat-status');
const conversationStatus = document.querySelector('#conversation-status');
const workspaceSearchStatus = document.querySelector('#workspace-search-status');
const selectAll = (selector) => typeof document.querySelectorAll === 'function' ? document.querySelectorAll(selector) : [];

function setWorkspaceVisible(visible) {
  if (workspaceNode) workspaceNode.hidden = !visible;
  for (const section of selectAll('main > section:not(#topic-workspace)')) section.hidden = visible;
}
function exactTopicReference(topic, kind, referenceId) {
  return (topic?.sourceReferences ?? []).find((item) => item.sourceKind === kind && (!referenceId || item.referenceId === referenceId));
}
async function pageAction(action, input) {
  requireReadyMutation();
  let response; let value;
  try {
    response = await fetch(PAGE_ACTION_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action, logicalOperationId: input.logicalOperationId ?? operationId(), ...input }) });
    value = await response.json();
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('The Topic Page action response was unavailable.'), { terminal: false }); }
  if (!response.ok || value.status === 'error') throw Object.assign(new Error(value.message || 'The Topic Page action was refused.'), { code: value.code, terminal: !['unknown', 'unavailable'].includes(value.code) });
  return value.result ?? value;
}
function resetWorkspacePresentation() {
  workspace.topic = null; workspace.conversations = []; workspace.selected = null; workspace.conversationPage = 0; workspace.notes = []; workspace.notesTotal = 0; workspace.notesCursor = null; workspace.notesServerPaged = false; workspace.notePage = 0; workspace.note = null; workspace.drafts = new Map();
  workspace.conversationsLoadGeneration += 1; workspace.selectionGeneration += 1; workspace.historyGeneration += 1; workspace.notesLoadGeneration += 1; workspace.noteGeneration += 1; workspace.searchGeneration += 1;
  document.querySelector('#conversation-list')?.replaceChildren(); document.querySelector('#chat-messages')?.replaceChildren(); document.querySelector('#notes-tree')?.replaceChildren();
  document.querySelector('#workspace-notes-results')?.replaceChildren(); document.querySelector('#workspace-conversations-results')?.replaceChildren();
  document.querySelector('#note-editor').hidden = true; document.querySelector('#note-preview')?.replaceChildren(); document.querySelector('#chat-conversation-name').textContent = 'Loading…';
  const chatMessage = document.querySelector('#chat-message'); chatMessage.value = ''; chatMessage.disabled = true; document.querySelector('#chat-send').disabled = true;
  const searchForm = document.querySelector('#workspace-search-form'); const searchQuery = document.querySelector('#workspace-search-query'); searchQuery.value = ''; searchQuery.disabled = true; searchForm.querySelector('button[type="submit"]').disabled = true;
  if (noteDialog?.open) { noteDialogReturnFocus = null; noteDialogAction = null; noteDialog.close(); }
  chatStatus.textContent = ''; conversationStatus.textContent = ''; notesStatus.textContent = ''; workspaceSearchStatus.textContent = '';
}
async function openTopicWorkspace(topicOrId, authority) {
  const topicId = typeof topicOrId === 'string' ? topicOrId : topicOrId?.topicId;
  if (!topicId) throw new Error('A Topic identity is required.');
  const generation = ++workspace.generation;
  setWorkspaceVisible(true); resetWorkspacePresentation(); workspaceStatus.textContent = 'Loading workspace…';
  // Rendered rows originate from the authenticated, sanitized Topics list and
  // already carry the authoritative identity. Direct URL/programmatic opens
  // still require an exact topics.get read before any workspace is exposed.
  const value = authority === AUTHORITATIVE_LIST_TOPIC && typeof topicOrId === 'object'
    ? { topic: topicOrId }
    : unwrap(await bridgeRequest('command-center.v1.topics.get', { schemaVersion: 1, topicId }));
  if (generation !== workspace.generation) return null;
  const topic = value?.topic;
  if (!topic || topic.topicId !== topicId || topic.lifecycle !== 'active' || topic.usable === false) throw new Error('The authoritative Topic is not available as a workspace.');
  workspace.topic = topic; document.querySelector('#topic-workspace-heading').textContent = topic.name; document.querySelector('#topic-search-topic-id').value = topicId; document.querySelector('#workspace-search-query').disabled = false; document.querySelector('#workspace-search-form button[type="submit"]').disabled = false;
  conversationStatus.textContent = 'Loading Conversations…'; notesStatus.textContent = 'Loading Notes…';
  // Notes can be large, so hydrate them independently. Readiness waits only
  // for the bounded Conversation catalog and Primary selection required to
  // make the default Chat pane usable.
  const notesHydration = loadNotes({ generation }).catch((error) => { if (generation === workspace.generation) notesStatus.textContent = error.message || 'Notes are unavailable.'; });
  await loadConversations({ selectPrimary: true, generation }).catch((error) => { if (generation === workspace.generation) conversationStatus.textContent = error.message || 'Conversations are unavailable.'; });
  if (generation !== workspace.generation) return null;
  workspaceStatus.textContent = 'Topic workspace ready.'; focusPane('chat', false);
  await notesHydration;
  return generation === workspace.generation ? topic : null;
}
async function loadConversations({ selectPrimary = false, generation = workspace.generation } = {}) {
  const loadGeneration = ++workspace.conversationsLoadGeneration;
  const view = document.querySelector('#conversation-view').value;
  const value = unwrap(await bridgeRequest('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: workspace.topic.topicId, includeClosed: view !== 'open' }));
  if (generation !== workspace.generation || loadGeneration !== workspace.conversationsLoadGeneration || document.querySelector('#conversation-view').value !== view) return;
  const nextConversations = (value?.conversations ?? []).filter((item) => view === 'all' || item.status === view);
  const listChanged = nextConversations.length !== workspace.conversations.length || nextConversations.some((item, index) => {
    const current = workspace.conversations[index];
    return !current || ['referenceId', 'topicId', 'sessionKey', 'sessionId', 'displayName', 'status', 'isPrimary', 'wasPrimary', 'availability'].some((field) => current[field] !== item[field]);
  });
  workspace.conversations = nextConversations;
  const selectedReadback = nextConversations.find((item) => item.referenceId === workspace.selected?.referenceId);
  if (selectedReadback?.availability === 'replaced-unavailable') {
    if (workspace.selected?.availability !== 'replaced-unavailable') { workspace.selectionGeneration += 1; workspace.historyGeneration += 1; }
    workspace.selected = selectedReadback;
    syncSelectedConversationControls();
    document.querySelector('#chat-messages').replaceChildren();
    chatStatus.textContent = 'This Session was replaced. Its source is unavailable; the history reference is retained.';
  }
  workspace.conversationPage = Math.min(workspace.conversationPage, Math.max(0, Math.ceil(workspace.conversations.length / CONVERSATION_PAGE_SIZE) - 1));
  if (listChanged) renderConversations(); conversationStatus.textContent = `${workspace.conversations.length} ${view === 'closed' ? 'closed ' : ''}Conversations.`;
  if (selectPrimary || !workspace.selected) {
    const primary = (value?.conversations ?? []).find((item) => item.isPrimary);
    if (!primary) throw new Error('The Topic Primary Session is unavailable.');
    // Catalog and Note readiness make the workspace usable. Primary history
    // is independent content and may be large or temporarily unavailable, so
    // let its generation-safe renderer settle without blocking the shell.
    void selectConversation(primary);
  }
}
function renderConversations() {
  const target = document.querySelector('#conversation-list');
  const active = document.activeElement;
  const focusedRow = active?.closest?.('.conversation-item');
  const focusedReferenceId = focusedRow?.dataset.referenceId;
  const focusedLabel = focusedReferenceId && active instanceof HTMLButtonElement ? active.textContent : null;
  target.replaceChildren();
  const pageCount = Math.max(1, Math.ceil(workspace.conversations.length / CONVERSATION_PAGE_SIZE));
  workspace.conversationPage = Math.min(workspace.conversationPage, pageCount - 1);
  const start = workspace.conversationPage * CONVERSATION_PAGE_SIZE;
  for (const item of workspace.conversations.slice(start, start + CONVERSATION_PAGE_SIZE)) {
    const row = document.createElement('div'); row.className = 'conversation-item'; row.dataset.referenceId = item.referenceId; row.dataset.sessionId = item.sessionId;
    const unavailable = item.availability === 'replaced-unavailable';
    const choose = button(item.displayName, () => selectConversation(item)); choose.disabled = unavailable; if (workspace.selected?.referenceId === item.referenceId) choose.setAttribute('aria-current', 'true'); row.append(choose);
    const state = document.createElement('span'); state.textContent = unavailable ? 'Replaced — source unavailable; history reference retained' : item.status === 'closed' ? 'Closed' : item.isPrimary ? 'Primary' : 'Open'; row.append(state);
    if (!item.isPrimary && !unavailable) row.append(mutationButton(item.status === 'closed' ? 'Reopen' : 'Close', () => changeConversationStatus(item)));
    target.append(row);
  }
  const previous = document.querySelector('#conversation-previous'); const next = document.querySelector('#conversation-next');
  previous.disabled = workspace.conversationPage === 0; next.disabled = workspace.conversationPage >= pageCount - 1;
  document.querySelector('#conversation-page-status').textContent = `Page ${workspace.conversationPage + 1} of ${pageCount}`;
  if (focusedReferenceId) {
    const replacementRow = [...target.querySelectorAll('.conversation-item')].find((row) => row.dataset.referenceId === focusedReferenceId);
    const controls = [...(replacementRow?.querySelectorAll('button:not(:disabled)') ?? [])];
    const replacement = controls.find((control) => control.textContent === focusedLabel) ?? controls.find((control) => control.textContent === (focusedLabel === 'Close' ? 'Reopen' : focusedLabel === 'Reopen' ? 'Close' : null)) ?? controls[0];
    (replacement ?? document.querySelector('#conversation-view'))?.focus();
  }
}
function sameConversation(left, right) { return left?.topicId === right?.topicId && left?.referenceId === right?.referenceId && left?.sessionId === right?.sessionId; }
function syncSelectedConversationControls() { const readOnly = workspace.selected?.status === 'closed' || workspace.selected?.availability === 'replaced-unavailable'; document.querySelector('#chat-send').disabled = readOnly; document.querySelector('#chat-message').disabled = readOnly; }
async function changeConversationStatus(item) {
  const generation = workspace.generation; const topic = workspace.topic; const action = item.status === 'closed' ? 'conversations.reopen' : 'conversations.close'; const status = item.status === 'closed' ? 'open' : 'closed';
  try {
    await pageAction(action, { topicId: topic.topicId, referenceId: item.referenceId, expectedRevision: topic.revision });
    if (generation !== workspace.generation || workspace.topic?.topicId !== topic.topicId) return;
    if (sameConversation(workspace.selected, item)) { workspace.selected = { ...workspace.selected, status }; syncSelectedConversationControls(); }
    await loadConversations({ generation });
  } catch (error) { if (generation === workspace.generation && workspace.topic?.topicId === topic.topicId) conversationStatus.textContent = error.message || 'The Conversation action was refused.'; }
}
async function selectConversation(item) {
  if (item.availability === 'replaced-unavailable') return;
  const topicGeneration = workspace.generation; const selectionGeneration = sameConversation(workspace.selected, item) ? workspace.selectionGeneration : ++workspace.selectionGeneration; const historyGeneration = ++workspace.historyGeneration; const chatSendGeneration = workspace.chatSendGeneration;
  const restoreConversationFocus = document.activeElement?.closest?.('.conversation-item')?.dataset.referenceId === item.referenceId;
  workspace.selected = item; document.querySelector('#chat-conversation-name').textContent = item.displayName; document.querySelector('#chat-messages').replaceChildren();
  chatStatus.textContent = '';
  syncSelectedConversationControls(); renderConversations();
  if (restoreConversationFocus) [...document.querySelectorAll('.conversation-item')].find((row) => row.dataset.referenceId === item.referenceId)?.querySelector('button')?.focus();
  try {
    const value = unwrap(await bridgeRequest('command-center.v1.sessions.history', { schemaVersion: 1, topicId: workspace.topic.topicId, referenceId: item.referenceId, limit: 100 }));
    if (topicGeneration !== workspace.generation || selectionGeneration !== workspace.selectionGeneration || historyGeneration !== workspace.historyGeneration || workspace.selected?.referenceId !== item.referenceId || workspace.selected?.sessionId !== item.sessionId) return;
    await renderHistory(value?.messages ?? [], { topicGeneration, selectionGeneration, historyGeneration, referenceId: item.referenceId, sessionId: item.sessionId });
  } catch (error) {
    if (topicGeneration === workspace.generation && selectionGeneration === workspace.selectionGeneration && historyGeneration === workspace.historyGeneration && chatSendGeneration === workspace.chatSendGeneration && workspace.selected?.referenceId === item.referenceId && workspace.selected?.sessionId === item.sessionId) chatStatus.textContent = error.message;
  }
}
function yieldToUserInput() { return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))); }
async function renderHistory(messages, identity) {
  const target = document.querySelector('#chat-messages'); target.replaceChildren(); target.dataset.totalMessages = String(messages.length);
  for (let offset = 0; offset < messages.length; offset += HISTORY_RENDER_BATCH_SIZE) {
    if (identity.topicGeneration !== workspace.generation || identity.selectionGeneration !== workspace.selectionGeneration || identity.historyGeneration !== workspace.historyGeneration || workspace.selected?.referenceId !== identity.referenceId || workspace.selected?.sessionId !== identity.sessionId) return false;
    const fragment = document.createDocumentFragment();
    for (const message of messages.slice(offset, offset + HISTORY_RENDER_BATCH_SIZE)) {
      const row = document.createElement('article'); row.className = 'chat-message'; const role = document.createElement('strong'); role.textContent = `${message.role ?? 'message'}: `; const content = document.createElement('span'); content.textContent = message.content ?? ''; row.append(role, content);
      if (message.details?.kind === 'note') row.append(button('Open referenced Note', () => openAuthoritativeNote(message.details, { referenceError: true })));
      fragment.append(row);
    }
    target.append(fragment);
    if (offset + HISTORY_RENDER_BATCH_SIZE < messages.length) await yieldToUserInput();
  }
  return true;
}
function chatSendIntent(selected, message) { return { topicId: workspace.topic?.topicId, referenceId: selected?.referenceId, sessionId: selected?.sessionId, message }; }
function sameChatSendIntent(left, right) { return left?.topicId === right?.topicId && left?.referenceId === right?.referenceId && left?.sessionId === right?.sessionId && left?.message === right?.message; }
function sameChatSendTarget(left, right) { return left?.topicId === right?.topicId && left?.referenceId === right?.referenceId && left?.sessionId === right?.sessionId; }
function chatSendOperationKey(topicGeneration, selectionGeneration, intent) { return JSON.stringify([topicGeneration, selectionGeneration, intent.topicId, intent.referenceId, intent.sessionId]); }
document.querySelector('#chat-form')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const selected = workspace.selected; const generation = workspace.generation; const selectionGeneration = workspace.selectionGeneration; const input = document.querySelector('#chat-message'); const message = input.value.trim(); if (!message || !selected || selected.status === 'closed' || selected.availability === 'replaced-unavailable') return;
  const intent = chatSendIntent(selected, message); const operationKey = chatSendOperationKey(generation, selectionGeneration, intent); let operation = workspace.chatSendOperations.get(operationKey) ?? [...workspace.chatSendOperations.values()].find((candidate) => candidate.generation === generation && sameChatSendTarget(candidate.intent, intent));
  if (operation && !sameChatSendIntent(operation.intent, intent)) { chatStatus.textContent = 'A different Chat send is already settling and was not sent.'; return; }
  if (operation?.pending) { chatStatus.textContent = 'Sending message…'; return; }
  if (operation && operation.entryId !== operationKey) { if (workspace.chatSendOperations.get(operation.entryId) === operation) workspace.chatSendOperations.delete(operation.entryId); operation.entryId = operationKey; operation.selectionGeneration = selectionGeneration; workspace.chatSendOperations.set(operationKey, operation); }
  if (!operation) { operation = { entryId: operationKey, generation, selectionGeneration, logicalOperationId: operationId(), intent, pending: false }; workspace.chatSendOperations.set(operationKey, operation); }
  const { topicId, referenceId, sessionId } = operation.intent; const sendGeneration = ++workspace.chatSendGeneration; operation.pending = true;
  const sendButton = document.querySelector('#chat-send'); const restoreSendFocus = document.activeElement === sendButton;
  sendButton.disabled = true; chatStatus.textContent = 'Sending message…';
  const isCurrent = () => generation === workspace.generation && selectionGeneration === workspace.selectionGeneration && workspace.chatSendGeneration === sendGeneration && workspace.topic?.topicId === topicId && workspace.selected?.referenceId === referenceId && workspace.selected?.sessionId === sessionId;
  try { const exact = unwrap(await bridgeRequest('command-center.v1.sessions.navigate', { schemaVersion: 1, topicId, referenceId })); const source = exact?.sourceReference; if (!exact?.sessionKey || exact.sessionId !== sessionId || source?.referenceId !== referenceId || source?.topicId !== topicId || source?.sourceSystem !== 'openclaw' || source?.sourceKind !== 'session' || source?.externalSourceId !== exact.sessionKey) throw new Error('The authoritative Conversation changed before Chat send.'); await bridgeRequest('command-center.v1.sessions.send', { schemaVersion: 1, topicId, referenceId, message: operation.intent.message, logicalOperationId: operation.logicalOperationId }, operation.logicalOperationId); if (workspace.chatSendOperations.get(operation.entryId) === operation) workspace.chatSendOperations.delete(operation.entryId); if (!isCurrent()) return; const retainedDraft = input.value.trim() !== operation.intent.message; if (!retainedDraft) input.value = ''; await selectConversation(workspace.selected); if (isCurrent()) { syncSelectedConversationControls(); if (restoreSendFocus && !sendButton.disabled) sendButton.focus(); chatStatus.textContent = retainedDraft ? 'Message sent; the current draft was retained.' : 'Message sent.'; } }
  catch (error) { operation.pending = false; if (error.terminal !== false && workspace.chatSendOperations.get(operation.entryId) === operation) workspace.chatSendOperations.delete(operation.entryId); if (isCurrent()) { syncSelectedConversationControls(); if (restoreSendFocus && !sendButton.disabled) sendButton.focus(); chatStatus.textContent = error.terminal === false ? 'Message delivery is not yet confirmed. Retry the unchanged message to reconcile it.' : error.message; } }
  finally { if (isCurrent()) syncSelectedConversationControls(); }
});
async function createAuthoritativeSession(label, logicalOperationId) { const created = unwrap(await bridgeRequest('sessions.create', { agentId: 'main', label }, logicalOperationId)); const key = created?.key ?? created?.sessionKey; const sessionId = created?.sessionId ?? created?.entry?.sessionId; const revision = created?.revision ?? created?.updatedAt ?? created?.entry?.updatedAt; if (typeof key !== 'string' || typeof sessionId !== 'string' || revision === undefined || revision === null) throw new Error('The authoritative Session creation response was incomplete.'); return { key, sessionId, revision: String(revision), idempotencyKey: logicalOperationId, label }; }
document.querySelector('#conversation-create')?.addEventListener('submit', async (event) => { event.preventDefault(); const input = event.currentTarget.elements.label; const label = input.value.trim(); const generation = workspace.generation; const topic = workspace.topic; const intentKey = `${topic.topicId}:${label}`; let operation = workspace.conversationCreateOperations.get(intentKey); if (operation?.pending) return; if (!operation) { operation = { logicalOperationId: operationId(), authoritativeSession: null, pending: false }; workspace.conversationCreateOperations.set(intentKey, operation); } operation.pending = true; try { operation.authoritativeSession ??= await createAuthoritativeSession(label, operation.logicalOperationId); await pageAction('conversations.create', { topicId: topic.topicId, label, expectedRevision: topic.revision, logicalOperationId: operation.logicalOperationId, authoritativeSession: operation.authoritativeSession }); workspace.conversationCreateOperations.delete(intentKey); if (generation !== workspace.generation || workspace.topic?.topicId !== topic.topicId) return; if (input.value.trim() === label) input.value = ''; await loadConversations({ generation }); } catch (error) { operation.pending = false; if (error.terminal !== false) workspace.conversationCreateOperations.delete(intentKey); if (generation === workspace.generation && workspace.topic?.topicId === topic.topicId) conversationStatus.textContent = error.terminal === false ? 'Conversation creation is not yet confirmed. Retry the unchanged label to reconcile it.' : error.message || 'Conversation creation was refused.'; } });
document.querySelector('#conversation-refresh')?.addEventListener('click', () => loadConversations());
document.querySelector('#conversation-view')?.addEventListener('change', () => { workspace.conversationPage = 0; void loadConversations(); });
document.querySelector('#conversation-previous')?.addEventListener('click', () => { if (workspace.conversationPage > 0) { workspace.conversationPage -= 1; renderConversations(); } });
document.querySelector('#conversation-next')?.addEventListener('click', () => { if ((workspace.conversationPage + 1) * CONVERSATION_PAGE_SIZE < workspace.conversations.length) { workspace.conversationPage += 1; renderConversations(); } });

async function loadNotes({ generation = workspace.generation, preserveSnapshot = false } = {}) {
  const notesLoadGeneration = ++workspace.notesLoadGeneration;
  const value = unwrap(await bridgeRequest('command-center.v1.notes.browse', { schemaVersion: 1, topicId: workspace.topic.topicId, limit: NOTE_PAGE_SIZE, offset: workspace.notePage * NOTE_PAGE_SIZE, ...(preserveSnapshot && workspace.notesCursor ? { cursor: workspace.notesCursor } : {}) }));
  if (generation !== workspace.generation || notesLoadGeneration !== workspace.notesLoadGeneration) return;
  workspace.notesServerPaged = !Array.isArray(value);
  workspace.notes = Array.isArray(value) ? value : value?.notes ?? [];
  workspace.notesTotal = Array.isArray(value) ? value.length : value?.total ?? workspace.notes.length;
  workspace.notesCursor = Array.isArray(value) ? null : value?.cursor ?? null;
  workspace.notePage = Array.isArray(value) ? Math.min(workspace.notePage, Math.max(0, Math.ceil(workspace.notes.length / NOTE_PAGE_SIZE) - 1)) : Math.floor((value?.offset ?? 0) / NOTE_PAGE_SIZE);
  renderNotes(); notesStatus.textContent = `${workspace.notesTotal} Notes.`;
}
function renderNotes() {
  const target = document.querySelector('#notes-tree'); target.replaceChildren();
  const total = workspace.notesServerPaged ? workspace.notesTotal : workspace.notes.length; const pageCount = Math.max(1, Math.ceil(total / NOTE_PAGE_SIZE)); workspace.notePage = Math.min(workspace.notePage, pageCount - 1); const start = workspace.notePage * NOTE_PAGE_SIZE;
  const visibleNotes = workspace.notesServerPaged ? workspace.notes : workspace.notes.slice(start, start + NOTE_PAGE_SIZE);
  for (const note of visibleNotes) { const source = note.sourceReference ?? exactTopicReference(workspace.topic, 'note', note.referenceId); const open = button(note.path, () => openAuthoritativeNote({ kind: 'note', topicId: workspace.topic.topicId, referenceId: source?.referenceId, path: note.path, observedRevision: note.revision ?? source?.observedRevision })); open.className = 'note-tree-item'; target.append(open); }
  document.querySelector('#note-previous').disabled = workspace.notePage === 0; document.querySelector('#note-next').disabled = workspace.notePage >= pageCount - 1; document.querySelector('#note-last').disabled = workspace.notePage >= pageCount - 1; document.querySelector('#note-page-status').textContent = `${total} Notes · Page ${workspace.notePage + 1} of ${pageCount}`;
}
function loadNotesPage() { loadNotes({ preserveSnapshot: true }).catch((error) => { notesStatus.textContent = error.message || 'The requested Notes page is unavailable.'; }); }
document.querySelector('#note-previous')?.addEventListener('click', () => { if (workspace.notePage > 0) { workspace.notePage -= 1; if (workspace.notesServerPaged) loadNotesPage(); else renderNotes(); } });
document.querySelector('#note-next')?.addEventListener('click', () => { const total = workspace.notesServerPaged ? workspace.notesTotal : workspace.notes.length; if ((workspace.notePage + 1) * NOTE_PAGE_SIZE < total) { workspace.notePage += 1; if (workspace.notesServerPaged) loadNotesPage(); else renderNotes(); } });
document.querySelector('#note-last')?.addEventListener('click', () => { const total = workspace.notesServerPaged ? workspace.notesTotal : workspace.notes.length; const lastPage = Math.max(0, Math.ceil(total / NOTE_PAGE_SIZE) - 1); if (workspace.notePage < lastPage) { workspace.notePage = lastPage; if (workspace.notesServerPaged) loadNotesPage(); else renderNotes(); } });
function encodeText(text) { const bytes = new TextEncoder().encode(text); let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }
function decodeBase64Bytes(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function decodeText(value) { return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Bytes(value)); }
async function decodeNoteChunkBytes(value) {
  const bytes = decodeBase64Bytes(value.contentBase64);
  if (value.contentEncoding !== 'gzip') return bytes;
  if (typeof DecompressionStream !== 'function') throw new Error('Compressed authoritative Note retrieval is unavailable in this browser.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readNoteChunks(descriptor) {
  let offset = 0; let text = ''; let revision = descriptor.observedRevision; let sourceReference; const decoder = new TextDecoder('utf-8', { fatal: true });
  for (;;) {
    const value = unwrap(await bridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: descriptor.topicId, referenceId: descriptor.referenceId, path: descriptor.path, observedRevision: descriptor.observedRevision, offset }));
    if (!value || value.path !== descriptor.path || value.revision !== revision || value.sourceReference?.referenceId !== descriptor.referenceId || value.sourceReference?.topicId !== descriptor.topicId) throw new Error(offset === 0 && value?.revision === descriptor.observedRevision ? 'The authoritative Note changed after this reference was created.' : 'The authoritative Note changed during retrieval.');
    if (!Number.isInteger(value.nextOffset) || value.nextOffset <= offset || !Number.isInteger(value.totalBytes) || value.nextOffset > value.totalBytes) throw new Error('The authoritative Note changed during retrieval.');
    const chunk = await decodeNoteChunkBytes(value);
    if (chunk.byteLength !== value.nextOffset - offset) throw new Error('The authoritative Note chunk length was invalid.');
    sourceReference = value.sourceReference; text += decoder.decode(chunk, { stream: !value.complete }); if (value.complete) return { text, revision, sourceReference }; offset = value.nextOffset;
  }
}
async function openAuthoritativeNote(descriptor, { referenceError = false, moveFocus = true } = {}) {
  const topicGeneration = workspace.generation; const noteGeneration = ++workspace.noteGeneration; const previous = workspace.note;
  notesStatus.textContent = 'Opening authoritative Note…';
  if (moveFocus) revealWorkspaceTarget('notes');
  try {
    const read = await readNoteChunks(descriptor);
    if (topicGeneration !== workspace.generation || noteGeneration !== workspace.noteGeneration) return;
    const draftId = `${descriptor.topicId}:${descriptor.referenceId}`; const existing = workspace.drafts.get(draftId);
    workspace.note = { ...descriptor, revision: read.revision, sourceReference: read.sourceReference, draftId }; workspace.drafts.set(draftId, existing ?? { text: read.text, dirty: false }); showNote(); notesStatus.textContent = 'Authoritative Note opened.';
  } catch (error) { if (topicGeneration !== workspace.generation || noteGeneration !== workspace.noteGeneration) return; workspace.note = previous; notesStatus.textContent = referenceError ? 'The authoritative Note changed after this reference was created.' : error.message; }
}
function showNote() {
  const draft = workspace.drafts.get(workspace.note.draftId); document.querySelector('#note-editor').hidden = false; document.querySelector('#note-title').textContent = workspace.note.path; document.querySelector('#note-content').value = draft.text; document.querySelector('#note-revision').textContent = draft.dirty ? `${workspace.note.revision} · unsaved draft` : workspace.note.revision; if (document.querySelector('#note-preview-mode').getAttribute('aria-pressed') === 'true') void renderNotePreview(draft.text);
}
document.querySelector('#note-content')?.addEventListener('input', (event) => { if (!workspace.note) return; const draft = workspace.drafts.get(workspace.note.draftId); draft.text = event.target.value; draft.dirty = true; document.querySelector('#note-revision').textContent = `${workspace.note.revision} · unsaved draft`; });
async function saveNote() {
  if (!workspace.note) return; const saving = workspace.note; const generation = workspace.generation; const topicId = workspace.topic.topicId; const draft = workspace.drafts.get(saving.draftId); const text = draft.text;
  try { const result = await pageAction('notes.edit', { topicId, referenceId: saving.referenceId, path: saving.path, contentBase64: encodeText(text), expectedRevision: saving.revision, expectedTopicRevision: workspace.topic.revision }); const revision = result?.revision ?? result?.note?.revision; if (typeof revision !== 'string' || revision === '') throw new Error('The authoritative Note save revision was unavailable.'); saving.revision = revision; saving.observedRevision = revision; draft.dirty = draft.text !== text; if (generation !== workspace.generation || workspace.topic?.topicId !== topicId) return; const listed = workspace.notes.find((item) => (item.sourceReference?.referenceId ?? item.referenceId) === saving.referenceId); if (listed) { listed.revision = revision; if (listed.sourceReference) listed.sourceReference = { ...listed.sourceReference, observedRevision: revision }; renderNotes(); } if (workspace.note?.draftId !== saving.draftId) { notesStatus.textContent = 'Note saved; the current Note draft was retained.'; return; } showNote(); notesStatus.textContent = 'Note saved.'; }
  catch (error) { if (generation === workspace.generation && workspace.topic?.topicId === topicId) notesStatus.textContent = error.message; }
}
document.querySelector('#note-save')?.addEventListener('click', saveNote);
async function renderNotePreview(text) { const target = document.querySelector('#note-preview'); const generation = workspace.generation; const noteGeneration = workspace.noteGeneration; const draftId = workspace.note?.draftId; target.textContent = 'Rendering preview…'; try { const markdown = await loadMarkdownModule(); if (generation === workspace.generation && noteGeneration === workspace.noteGeneration && workspace.note?.draftId === draftId && !target.hidden) markdown.renderMarkdownInto(target, text, { headingOffset: 4 }); } catch { if (generation === workspace.generation && noteGeneration === workspace.noteGeneration && workspace.note?.draftId === draftId && !target.hidden) { target.replaceChildren(); notesStatus.textContent = 'Markdown preview is unavailable.'; } } }
async function setNoteMode(preview) { const editor = document.querySelector('#note-content'); const target = document.querySelector('#note-preview'); editor.hidden = preview; target.hidden = !preview; document.querySelector('#note-edit-mode').setAttribute('aria-pressed', String(!preview)); document.querySelector('#note-preview-mode').setAttribute('aria-pressed', String(preview)); if (!preview) { target.replaceChildren(); return; } await renderNotePreview(editor.value); }
document.querySelector('#note-edit-mode')?.addEventListener('click', () => setNoteMode(false)); document.querySelector('#note-preview-mode')?.addEventListener('click', () => setNoteMode(true));

const noteDialog = document.querySelector('#note-action-dialog'); let noteDialogAction = null; let noteDialogReturnFocus = null; let noteDialogPending = false;
function setNoteDialogPending(pending) { noteDialogPending = pending; for (const control of noteDialog.querySelectorAll('input, textarea, button')) control.disabled = pending; }
function openNoteDialog(action, trigger) { noteDialogAction = action; noteDialogReturnFocus = trigger; noteDialog.inert = false; setNoteDialogPending(false); document.querySelector('#note-action-status').textContent = ''; document.querySelector('#note-action-heading').textContent = action === 'notes.create' ? 'Create Note' : action === 'notes.rename' ? 'Rename Note' : 'Move Note'; document.querySelector('#note-action-path').value = action === 'notes.create' ? '' : workspace.note?.path ?? ''; document.querySelector('#note-action-text').value = ''; document.querySelector('#note-action-text-label').hidden = action !== 'notes.create'; noteDialog.showModal(); document.querySelector('#note-action-path').focus(); }
function closeNoteDialog() { if (noteDialogPending) return; const returnFocus = noteDialogReturnFocus; noteDialogReturnFocus = null; noteDialogAction = null; noteDialog.inert = true; noteDialog.close(); if (returnFocus?.isConnected) returnFocus.focus(); }
document.querySelector('#note-new')?.addEventListener('click', (event) => openNoteDialog('notes.create', event.currentTarget)); document.querySelector('#note-rename')?.addEventListener('click', (event) => openNoteDialog('notes.rename', event.currentTarget)); document.querySelector('#note-move')?.addEventListener('click', (event) => openNoteDialog('notes.move', event.currentTarget));
document.querySelector('#note-action-cancel')?.addEventListener('click', closeNoteDialog); noteDialog?.addEventListener('cancel', (event) => { event.preventDefault(); closeNoteDialog(); });
document.querySelector('#note-action-form')?.addEventListener('submit', async (event) => { event.preventDefault(); if (noteDialogPending) return; const path = document.querySelector('#note-action-path').value.trim(); const current = workspace.note; const generation = workspace.generation; const topic = workspace.topic; const action = noteDialogAction; const returnFocus = noteDialogReturnFocus; setNoteDialogPending(true); document.querySelector('#note-action-status').textContent = 'Applying authoritative Note change…'; try { if (action === 'notes.create') await pageAction(action, { topicId: topic.topicId, referenceId: topic.noteFolderReferenceId ?? exactTopicReference(topic, 'note_folder')?.referenceId, path, contentBase64: encodeText(document.querySelector('#note-action-text').value), expectedTopicRevision: topic.revision }); else await pageAction(action, { topicId: topic.topicId, referenceId: current.referenceId, path: current.path, destinationPath: path, expectedRevision: current.revision, expectedTopicRevision: topic.revision }); if (generation !== workspace.generation || workspace.topic?.topicId !== topic.topicId) return; await loadNotes({ generation }); if (generation !== workspace.generation || workspace.topic?.topicId !== topic.topicId) return; const next = workspace.notes.find((item) => item.path === path); if (next) { const oldDraft = current && workspace.drafts.get(current.draftId); const source = next.sourceReference; if (oldDraft && current.path !== path) workspace.drafts.set(`${topic.topicId}:${source.referenceId}`, oldDraft); await openAuthoritativeNote({ kind: 'note', topicId: topic.topicId, referenceId: source.referenceId, path, observedRevision: next.revision }, { moveFocus: false }); } setNoteDialogPending(false); closeNoteDialog(); if (returnFocus?.isConnected) returnFocus.focus(); } catch (error) { setNoteDialogPending(false); if (generation === workspace.generation && workspace.topic?.topicId === topic.topicId) document.querySelector('#note-action-status').textContent = error.message; } });
document.querySelector('#notes-refresh')?.addEventListener('click', () => loadNotes());

async function searchWorkspace(event) { event.preventDefault(); if (!workspace.topic) return; const generation = workspace.generation; const searchGeneration = ++workspace.searchGeneration; const topicId = workspace.topic.topicId; workspaceSearchStatus.textContent = 'Searching…'; try { const value = await queryTopicSearch({ schemaVersion: 1, topicId, query: document.querySelector('#workspace-search-query').value.trim(), limit: 50 }); if (generation !== workspace.generation || searchGeneration !== workspace.searchGeneration || workspace.topic?.topicId !== topicId) return; renderWorkspaceSearch('workspace-notes-results', value.notes?.results ?? []); renderWorkspaceSearch('workspace-conversations-results', value.conversations?.results ?? []); workspaceSearchStatus.textContent = `${value.notes?.results?.length ?? 0} Notes · ${value.conversations?.results?.length ?? 0} Conversations`; } catch (error) { if (generation === workspace.generation && searchGeneration === workspace.searchGeneration && workspace.topic?.topicId === topicId) workspaceSearchStatus.textContent = error.message || 'Topic Search is unavailable.'; } }
async function rebuildWorkspaceSearch() { if (!workspace.topic) return; const topicId = workspace.topic.topicId; const generation = workspace.generation; workspaceSearchStatus.textContent = 'Rebuilding Topic Search…'; try { await rebuildTopicSearchProjection(topicId); if (generation === workspace.generation && workspace.topic?.topicId === topicId) workspaceSearchStatus.textContent = 'Topic Search index rebuilt from authoritative sources.'; } catch (error) { if (generation === workspace.generation && workspace.topic?.topicId === topicId) workspaceSearchStatus.textContent = error.message || 'Topic Search rebuild failed.'; } }
function renderWorkspaceSearch(id, results) { const target = document.querySelector(`#${id}`); target.replaceChildren(...results.map((result) => { const row = document.createElement('article'); const title = document.createElement('strong'); title.textContent = result.heading || result.conversationName || result.path; const snippet = document.createElement('p'); snippet.textContent = result.snippet ?? ''; row.append(title, snippet); if (result.provenance?.status === 'closed') row.append(Object.assign(document.createElement('span'), { textContent: 'Closed' })); row.append(button(result.navigation.kind === 'note' ? 'Open Note' : 'Open Conversation', () => openWorkspaceResult(result))); return row; })); }
async function openWorkspaceResult(result) { if (result.navigation.kind === 'note') return openAuthoritativeNote(result.navigation); const navigation = result.navigation; const generation = workspace.generation; const searchGeneration = workspace.searchGeneration; const selectionGeneration = workspace.selectionGeneration; const topicId = workspace.topic?.topicId; try { if (navigation.topicId !== topicId) throw new Error('The authoritative Conversation belongs to another Topic.'); const target = unwrap(await bridgeRequest('command-center.v1.sessions.navigate', { schemaVersion: 1, topicId: navigation.topicId, referenceId: navigation.referenceId })); if (generation !== workspace.generation || searchGeneration !== workspace.searchGeneration || selectionGeneration !== workspace.selectionGeneration || workspace.topic?.topicId !== topicId) return; const source = target?.sourceReference; if (target?.sessionKey !== navigation.sessionKey || target?.sessionId !== navigation.sessionId || source?.referenceId !== navigation.referenceId || source?.topicId !== topicId || source?.sourceSystem !== 'openclaw' || source?.sourceKind !== 'session' || source?.externalSourceId !== target.sessionKey) throw new Error('The authoritative Conversation changed after this result was created.'); const item = { referenceId: navigation.referenceId, topicId: navigation.topicId, sessionKey: target.sessionKey, sessionId: target.sessionId, displayName: result.conversationName, status: result.provenance?.status ?? 'open', isPrimary: false }; await selectConversation(item); if (generation === workspace.generation && workspace.topic?.topicId === topicId) revealWorkspaceTarget('chat'); } catch (error) { if (generation === workspace.generation && searchGeneration === workspace.searchGeneration && workspace.topic?.topicId === topicId) workspaceSearchStatus.textContent = error.message || 'Authoritative Conversation navigation was refused.'; } }
document.querySelector('#workspace-search-form')?.addEventListener('submit', searchWorkspace);
document.querySelector('#workspace-search-rebuild')?.addEventListener('click', rebuildWorkspaceSearch);

function focusPane(name, moveFocus = true) { for (const pane of selectAll('.workspace-layout > [data-pane]')) pane.dataset.focused = String(pane.dataset.pane === name); const pane = document.querySelector(`[data-pane="${name}"]`); if (moveFocus) (pane?.querySelector('h3,[tabindex]') ?? pane)?.focus?.(); }
for (const pane of selectAll('.workspace-layout > [data-pane]')) pane.addEventListener('focusin', () => focusPane(pane.dataset.pane, false));
function setPaneOpen(name, open) { workspace.panes[name] = open; const pane = document.querySelector(`#${name}-pane`); const wasHidden = pane.hidden; pane.hidden = !open; if (!open) { focusPane('chat', false); document.querySelector('#chat-heading').focus(); } else if (wasHidden) { focusPane(name); } }
document.querySelector('#conversations-close')?.addEventListener('click', () => setPaneOpen('conversations', false)); document.querySelector('#notes-close')?.addEventListener('click', () => setPaneOpen('notes', false)); document.querySelector('#conversations-open')?.addEventListener('click', () => setPaneOpen('conversations', true)); document.querySelector('#notes-open')?.addEventListener('click', () => setPaneOpen('notes', true));
function selectMobileSection(name) { workspace.mobileSection = name; if (name === 'conversations') setPaneOpen('conversations', true); if (name === 'notes') setPaneOpen('notes', true); for (const control of selectAll('.workspace-sections button')) control.setAttribute('aria-selected', String(control.dataset.section === name)); updateResponsivePanes(); }
function updateResponsivePanes() { const mobile = typeof matchMedia === 'function' && matchMedia('(max-width: 47.99rem)').matches; for (const pane of selectAll('.workspace-layout > [data-pane]')) { const visible = mobile ? pane.dataset.pane === workspace.mobileSection : !['conversations', 'notes'].includes(pane.dataset.pane) || workspace.panes[pane.dataset.pane]; pane.style.display = visible ? '' : 'none'; pane.inert = !visible; } }
function revealWorkspaceTarget(name) { if (typeof matchMedia === 'function' && matchMedia('(max-width: 47.99rem)').matches) { if (workspace.mobileSection !== name) { selectMobileSection(name); focusPane(name); } } else if (name === 'notes' || name === 'conversations') setPaneOpen(name, true); else focusPane(name, false); }
for (const control of selectAll('.workspace-sections button')) control.addEventListener('click', () => selectMobileSection(control.dataset.section)); if (typeof matchMedia === 'function') matchMedia('(max-width: 47.99rem)').addEventListener?.('change', updateResponsivePanes); updateResponsivePanes();
document.querySelector('#workspace-back')?.addEventListener('click', async () => { ++workspace.generation; if (hasTopicsDestination) await loadTopics(); setWorkspaceVisible(false); document.querySelector('#topics-heading')?.focus(); if (hasDashboardDestination) void loadDashboard(); });

window.CommandCenterTopics = Object.freeze({ loadTopics, renderDestination, mutate, read, openResult, openTopic: openTopicWorkspace, routes: { HTTP_ROUTE, PAGE_ACTION_ROUTE, SHELL_ROUTE }, view: 'destination', searchView: 'search', get ready() { return bridgeReady; } });
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
applyOperatingState(operatingState);
sendBridge({ type: 'openclaw:capability-bridge-hello', protocolVersion: 1 });
bridgeReady.then(loadOperatingState).then(() => {
  if (hasDashboardDestination) void loadDashboard();
  if (requestedTopicId === null) void loadTopics();
  else if (workspaceNode) void openTopicWorkspace(requestedTopicId).catch((error) => { workspaceStatus.textContent = error.message; });
}).catch((error) => { applyOperatingState({ mode: 'recovery-only', unavailableCapabilities: ['capability-bridge'] }); if (workspaceStatus) workspaceStatus.textContent = error.message; });
