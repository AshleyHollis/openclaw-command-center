const HTTP_ROUTE = '/plugins/command-center/api/topics/actions';
const SHELL_ROUTE = '/plugins/command-center';
const topicCreateForm = document.querySelector('#topic-create');
const topicCreateSubmit = document.querySelector('#topic-create-submit');
const topicNameInput = topicCreateForm?.elements.name;
const statusNode = document.querySelector('#topic-status');
const hasTopicsDestination = Boolean(topicCreateForm && statusNode);
const PAGE_ACTION_ROUTE = '/plugins/command-center/api/topic/actions';
const markdownModule = import('./markdown.js');
const requestedTopicId = new URLSearchParams(window.location.search).get('topicId');
let currentDestination = { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [] };
let topicCreatePending = false;
const DASHBOARD_ROUTE = '/plugins/command-center/api/dashboard';
const ATTENTION_ROUTE = '/plugins/command-center/api/attention/actions';
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

async function dashboardRead(offset = 0) {
  const response = await fetch(`${DASHBOARD_ROUTE}?activityOffset=${encodeURIComponent(offset)}&activityLimit=50`, { credentials: 'omit', headers: { accept: 'application/json' } });
  const value = await response.json();
  if (!response.ok || value.status === 'error') throw new Error(value.message || 'Dashboard is unavailable.');
  return value.result ?? value;
}
function dashboardButton(label, action) { const node = button(label, action); node.className = 'dashboard-action'; return node; }
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
  target.replaceChildren();
  for (const group of review?.groups ?? []) {
    const section = document.createElement('section'); section.className = 'topic-review-group'; const heading = document.createElement('h5'); heading.textContent = `${group.topicId} · ${group.operation}`; section.append(heading);
    for (const proposal of group.proposals ?? []) {
      const card = document.createElement('article'); card.className = 'topic-review-proposal'; const summary = document.createElement('p'); summary.textContent = `${proposal.operation} · ${proposal.evidenceFacts?.length ?? 0} inspectable facts · ${proposal.state}`; const evidence = document.createElement('ul'); for (const fact of proposal.evidenceFacts ?? []) { const item = document.createElement('li'); item.textContent = `${fact.sourceId} @ ${fact.sourceRevision}: ${fact.fact}`; evidence.append(item); }
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
}
async function topicAnalysisAction(action, input = {}) { const response = await fetch(TOPIC_ANALYSIS_ACTIONS_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action, logicalOperationId: operationId(), ...input }) }); const value = await response.json(); if (!response.ok || value.status === 'error') throw new Error(value.message || 'Topic Analysis action was refused.'); return value.result ?? value; }
async function topicReviewDecision(action, proposal) { const feedback = document.querySelector('#analysis-feedback'); try { await topicAnalysisAction(action, { proposalId: proposal.proposalId, expectedProposalRevision: proposal.revision }); feedback.textContent = 'Proposal decision saved.'; await loadTopicAnalysis(); } catch (error) { feedback.textContent = error.message; } }
async function topicReviewAdjust(proposal) { const feedback = document.querySelector('#analysis-feedback'); if (proposal.operation === 'archive') { feedback.textContent = 'Archive proposals support Approve or Keep as-is.'; return; } const target = proposal.after?.topic ?? proposal.after ?? {}; const initial = proposal.operation === 'create' ? { name: target.name, paraCategory: target.paraCategory } : { paraCategory: target.paraCategory }; const adjustmentJson = window.prompt('Enter the adjusted name/category fields as JSON.', JSON.stringify(initial)); if (!adjustmentJson) return; try { await topicAnalysisAction('proposal.adjust', { proposalId: proposal.proposalId, expectedProposalRevision: proposal.revision, adjustment: JSON.parse(adjustmentJson) }); feedback.textContent = 'Proposal adjustment approved.'; await loadTopicAnalysis(); } catch (error) { feedback.textContent = error.message; } }
async function loadTopicAnalysis() { try { const value = await topicAnalysisRead(); const settings = value.schedule; if (settings) { topicAnalysisScheduleRevision = settings.revision; for (const [id, item] of [['analysis-enabled', settings.enabled], ['analysis-weekday', String(settings.weekday)]]) { const control = document.querySelector(`#${id}`); if (control) id === 'analysis-enabled' ? control.checked = item : control.value = item; } for (const [id, item] of [['analysis-local-time', settings.localTime], ['analysis-time-zone', settings.timeZone]]) { const control = document.querySelector(`#${id}`); if (control && document.activeElement !== control) control.value = item; } } renderTopicReview(value.review); } catch (error) { const feedback = document.querySelector('#analysis-feedback'); if (feedback) feedback.textContent = error.message || 'Topic Analysis is unavailable.'; } }
document.querySelector('#topic-analysis-schedule')?.addEventListener('submit', async (event) => { event.preventDefault(); try { await topicAnalysisAction('schedule.update', { expectedRevision: topicAnalysisScheduleRevision, settings: { enabled: document.querySelector('#analysis-enabled').checked, weekday: Number(document.querySelector('#analysis-weekday').value), localTime: document.querySelector('#analysis-local-time').value, timeZone: document.querySelector('#analysis-time-zone').value.trim() } }); document.querySelector('#analysis-feedback').textContent = 'Analysis schedule saved.'; await loadTopicAnalysis(); } catch (error) { document.querySelector('#analysis-feedback').textContent = error.message; } });
document.querySelector('#analysis-run')?.addEventListener('click', async () => { try { await topicAnalysisAction('analysis.run', { trigger: 'manual' }); document.querySelector('#analysis-feedback').textContent = 'Analysis completed.'; await loadTopicAnalysis(); } catch (error) { document.querySelector('#analysis-feedback').textContent = error.message; } });
document.querySelector('#topic-review-checkpoint')?.addEventListener('click', async () => { const feedback = document.querySelector('#topic-review-plan'); try { const proposals = topicReviewState?.proposals ?? []; const plan = await topicAnalysisAction('review.apply', { reviewId: 'topic-review:global', expectedReviewRevision: topicReviewState?.episodeRevision, approvedProposalRevisions: proposals.filter((proposal) => proposal.state === 'approved').map((proposal) => ({ proposalId: proposal.proposalId, revision: proposal.revision })), applicationId: operationId(), confirm: false }); const checkpoint = plan?.result ?? plan; if (!checkpoint) throw new Error('The final checkpoint was unavailable.'); const visiblePlan = { planRevision: checkpoint.planRevision, reviewRevision: checkpoint.reviewRevision, proposalRevisions: checkpoint.currentProposalRevisions, dependencies: checkpoint.dependencies, exactEffects: checkpoint.effects, preconditions: checkpoint.steps?.map((step) => ({ proposalId: step.proposalId, preconditions: step.preconditions })), compensationDisclosures: checkpoint.steps?.map((step) => ({ proposalId: step.proposalId, compensation: step.compensation })), blockedAndIrreversibleOutcomes: { blockers: checkpoint.blockers, reversibility: checkpoint.steps?.map((step) => ({ proposalId: step.proposalId, reversibility: step.intent?.authoritativePreview?.reversibility ?? step.compensation })) } }; feedback.textContent = `Frozen application plan (inspect before confirming):\n${JSON.stringify(visiblePlan, null, 2)}`; if (!confirm(`Apply only frozen plan ${checkpoint.planRevision}?`)) return; const applied = await topicAnalysisAction('review.apply', { reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true }); const outcomes = Object.values(applied?.outcomes ?? {}).map((item) => item?.status).filter(Boolean); feedback.textContent = outcomes.length ? `Application outcomes: ${outcomes.join(', ')}.` : 'Approved changes applied.'; await loadTopicAnalysis(); } catch (error) { feedback.textContent = error.message; } });
document.querySelector('#topic-review-snooze')?.addEventListener('click', async () => { const feedback = document.querySelector('#analysis-feedback'); const until = window.prompt('Snooze Topic Review until (RFC3339).', new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()); if (!until || !topicReviewState) return; try { await topicAnalysisAction('review.snooze', { reviewId: 'topic-review:global', expectedReviewRevision: topicReviewState.episodeRevision, snoozedUntil: until }); feedback.textContent = 'Topic Review snoozed.'; await loadTopicAnalysis(); } catch (error) { feedback.textContent = error.message; } });
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
async function dashboardMutate(episode, action, input = {}) {
  const response = await fetch(ATTENTION_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    schemaVersion: 1, logicalOperationId: operationId(), sourceCapabilityId: episode.sourceCapabilityId, stableSubjectId: episode.stableSubjectId, episodeId: episode.episodeId,
    expectedEpisodeRevision: episode.revision, expectedSourceRevision: episode.sourceRevision ?? undefined, topicId: episode.topicId, sourceReferenceId: episode.sourceReferenceId, actionId: action, input
  }) });
  const value = await response.json();
  if (!response.ok || value.status === 'unavailable' || value.status === 'error') throw new Error(value.message || 'Action was refused.');
  return value;
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
    const result = await dashboardMutate(episode, action, input);
    const navigation = result?.result?.navigation ?? result?.navigation;
    if (navigation?.topicId) { await openTopic(navigation.topicId); return; }
    feedback.textContent = label;
    await loadDashboard();
  }
  catch (error) { feedback.textContent = error.message || 'Action was refused by the authoritative source.'; }
}
function snoozeControl(episode) {
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
  const heading = document.createElement('h4'); heading.textContent = episode.context || 'Attention item';
  const meta = document.createElement('p'); meta.className = 'card-meta'; meta.textContent = `${episode.severity || 'Attention'} · ${episode.sourceKind || 'Source'}`;
  const actions = document.createElement('div'); actions.className = 'card-actions';
  for (const action of (episode.actions ?? []).filter((item) => !['attention.snooze', 'reminder.snooze'].includes(item.actionId)).slice(0, 3)) actions.append(dashboardButton(action.label || 'Open', () => runDashboardAction(episode, action.actionId, action.actionId === 'reminder.complete' ? { expectedConfigRevision: episode.sourceRevision } : {}, `${action.label || 'Action'} accepted.`)));
  const snooze = snoozeControl(episode); if (snooze) actions.append(snooze);
  const evidence = dashboardButton('View evidence', () => showEvidence(episode, evidence)); actions.append(evidence);
  card.append(heading, meta, actions); return card;
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
    const row = document.createElement('article'); row.className = 'activity-row'; const text = document.createElement('span'); text.textContent = `${record.operationKind || 'Activity'} · ${record.outcome || 'recorded'}`; row.append(text);
    if (record.navigation?.verified === true && record.navigation.kind === 'session') row.append(dashboardButton('Open source', () => openActivity(record)));
    return row;
  }));
  if (!activityRecords.length) target.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No routine history.' }));
}
async function openActivity(record) {
  const feedback = document.querySelector('#dashboard-feedback');
  try {
    const target = unwrap(await bridgeRequest('command-center.v1.sessions.navigate', { schemaVersion: 1, topicId: record.navigation.topicId, referenceId: record.navigation.referenceId }));
    if (!target?.sessionKey || target.sessionKey !== record.navigation.sessionKey || target.sessionId !== record.navigation.sessionId) throw new Error('The authoritative source changed after this record was created.');
    await bridgeRequest('ui.session.navigate', { sessionKey: target.sessionKey });
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
    const progress = document.querySelector('#in-progress'); progress.replaceChildren(...(dashboardState.inProgress ?? []).map((episode) => { const item = document.createElement('p'); item.textContent = episode.context || 'Action in progress'; return item; })); if (!progress.childElementCount) progress.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Nothing in progress.' }));
    const coming = document.querySelector('#coming-up'); coming.replaceChildren(...(dashboardState.comingUp ?? []).map((item) => { const row = document.createElement('p'); row.textContent = `${item.day} · ${item.time} · ${item.context} · ${item.label}`; return row; })); if (!coming.childElementCount) coming.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No future Reminders.' }));
    fillTopicLaunchers(dashboardState.topics); renderActivity(dashboardState.activity?.records); const more = document.querySelector('#activity-load-more'); more.textContent = 'Load more Activity'; more.hidden = dashboardState.activity?.hasMore !== true; more.onclick = async () => { const next = await dashboardRead(dashboardState.activity.nextOffset); dashboardState.activity = next.activity; renderActivity(next.activity.records, true); more.hidden = next.activity.hasMore !== true; }; if (statusNode) statusNode.textContent = 'Dashboard is current.';
    focusNotificationTarget();
    await loadTopicAnalysis();
  } catch (error) { document.querySelector('#dashboard-feedback').textContent = error.message || 'Dashboard is unavailable.'; }
}

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
    const required = [...(hasTopicsDestination ? ['command-center.v1.topics.list'] : []), 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.notes.browse', 'command-center.v1.search.query', 'command-center.v1.notes.read', 'command-center.v1.sessions.navigate', 'ui.session.navigate'];
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
  const response = await fetch(HTTP_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action, logicalOperationId: input.logicalOperationId ?? operationId(), ...input }) });
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
  const row = document.createElement('div'); row.className = 'topic-row'; row.dataset.topicId = topic.topicId; const name = document.createElement('strong'); name.textContent = topic.name; row.append(name);
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
    row.append(button('Open Topic', () => openTopicWorkspace(topic)));
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
async function loadTopics(message = '') { if (!hasTopicsDestination) return; try { renderDestination(await read('destination')); statusNode.textContent = message || 'Topics are current.'; } catch (error) { statusNode.textContent = error.message; } }
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
    const value = unwrap(await bridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: result.navigation.topicId, referenceId: result.navigation.referenceId, path: result.navigation.path, observedRevision: result.navigation.observedRevision, offset: 0 }));
    if (value?.path !== result.navigation.path || value?.revision !== result.navigation.observedRevision || value?.sourceReference?.referenceId !== result.navigation.referenceId || typeof value.contentBase64 !== 'string') throw new Error('The authoritative Note changed after this search result was created.');
    detail.textContent = decodeText(value.contentBase64);
  } catch (error) { detail.textContent = error.message || 'Authoritative navigation was refused.'; }
}
document.querySelector('#topic-search-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const value = unwrap(await bridgeRequest('command-center.v1.search.query', { schemaVersion: 1, topicId: document.querySelector('#topic-search-topic-id').value, query: document.querySelector('#topic-search-query').value.trim(), limit: 50 })); renderSearch('notes-results', value.notes?.results); renderSearch('conversations-results', value.conversations?.results); document.querySelector('#topic-search-status').textContent = `${value.notes?.results?.length ?? 0} Notes · ${value.conversations?.results?.length ?? 0} Conversations`; });

const workspace = {
  topic: null, generation: 0, conversations: [], selected: null, selectionGeneration: 0, historyGeneration: 0, chatSendGeneration: 0, chatSendOperations: new Map(),
  notes: [], note: null, noteGeneration: 0, searchGeneration: 0, drafts: new Map(), panes: { conversations: true, notes: true }, mobileSection: 'chat'
};
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
  let response; let value;
  try {
    response = await fetch(PAGE_ACTION_ROUTE, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action, logicalOperationId: input.logicalOperationId ?? operationId(), ...input }) });
    value = await response.json();
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('The Topic Page action response was unavailable.'), { terminal: false }); }
  if (!response.ok || value.status === 'error') throw Object.assign(new Error(value.message || 'The Topic Page action was refused.'), { code: value.code, terminal: !['unknown', 'unavailable'].includes(value.code) });
  return value.result ?? value;
}
function resetWorkspacePresentation() {
  workspace.topic = null; workspace.conversations = []; workspace.selected = null; workspace.notes = []; workspace.note = null; workspace.drafts = new Map();
  workspace.selectionGeneration += 1; workspace.historyGeneration += 1; workspace.noteGeneration += 1; workspace.searchGeneration += 1;
  document.querySelector('#conversation-list')?.replaceChildren(); document.querySelector('#chat-messages')?.replaceChildren(); document.querySelector('#notes-tree')?.replaceChildren();
  document.querySelector('#workspace-notes-results')?.replaceChildren(); document.querySelector('#workspace-conversations-results')?.replaceChildren();
  document.querySelector('#note-editor').hidden = true; document.querySelector('#note-preview')?.replaceChildren(); document.querySelector('#chat-conversation-name').textContent = 'Loading…';
  const chatMessage = document.querySelector('#chat-message'); chatMessage.value = ''; chatMessage.disabled = true; document.querySelector('#chat-send').disabled = true;
  const searchForm = document.querySelector('#workspace-search-form'); const searchQuery = document.querySelector('#workspace-search-query'); searchQuery.value = ''; searchQuery.disabled = true; searchForm.querySelector('button[type="submit"]').disabled = true;
  if (noteDialog?.open) { noteDialogReturnFocus = null; noteDialogAction = null; noteDialog.close(); }
  chatStatus.textContent = ''; conversationStatus.textContent = ''; notesStatus.textContent = ''; workspaceSearchStatus.textContent = '';
}
async function openTopicWorkspace(topicOrId) {
  const topicId = typeof topicOrId === 'string' ? topicOrId : topicOrId?.topicId;
  if (!topicId) throw new Error('A Topic identity is required.');
  const generation = ++workspace.generation;
  setWorkspaceVisible(true); resetWorkspacePresentation(); workspaceStatus.textContent = 'Loading workspace…';
  const value = unwrap(await bridgeRequest('command-center.v1.topics.get', { schemaVersion: 1, topicId }));
  if (generation !== workspace.generation) return null;
  const topic = value?.topic;
  if (!topic || topic.topicId !== topicId || topic.lifecycle !== 'active' || topic.usable === false) throw new Error('The authoritative Topic is not available as a workspace.');
  workspace.topic = topic; document.querySelector('#topic-workspace-heading').textContent = topic.name; document.querySelector('#topic-search-topic-id').value = topicId; document.querySelector('#workspace-search-query').disabled = false; document.querySelector('#workspace-search-form button[type="submit"]').disabled = false;
  await Promise.all([loadConversations({ selectPrimary: true, generation }), loadNotes({ generation })]);
  if (generation !== workspace.generation) return null;
  workspaceStatus.textContent = 'Topic workspace ready.'; focusPane('chat', false); return topic;
}
async function loadConversations({ selectPrimary = false, generation = workspace.generation } = {}) {
  const view = document.querySelector('#conversation-view').value;
  const value = unwrap(await bridgeRequest('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: workspace.topic.topicId, includeClosed: view !== 'open' }));
  if (generation !== workspace.generation) return;
  workspace.conversations = (value?.conversations ?? []).filter((item) => view === 'all' || item.status === view);
  renderConversations(); conversationStatus.textContent = `${workspace.conversations.length} ${view === 'closed' ? 'closed ' : ''}Conversations.`;
  if (selectPrimary) {
    const primary = (value?.conversations ?? []).find((item) => item.isPrimary);
    if (!primary) throw new Error('The Topic Primary Session is unavailable.');
    await selectConversation(primary);
  }
}
function renderConversations() {
  const target = document.querySelector('#conversation-list'); target.replaceChildren();
  for (const item of workspace.conversations) {
    const row = document.createElement('div'); row.className = 'conversation-item';
    const choose = button(item.displayName, () => selectConversation(item)); if (workspace.selected?.referenceId === item.referenceId) choose.setAttribute('aria-current', 'true'); row.append(choose);
    const state = document.createElement('span'); state.textContent = item.status === 'closed' ? 'Closed' : item.isPrimary ? 'Primary' : 'Open'; row.append(state);
    if (!item.isPrimary) row.append(button(item.status === 'closed' ? 'Reopen' : 'Close', () => changeConversationStatus(item)));
    target.append(row);
  }
}
function sameConversation(left, right) { return left?.topicId === right?.topicId && left?.referenceId === right?.referenceId && left?.sessionId === right?.sessionId; }
function syncSelectedConversationControls() { const closed = workspace.selected?.status === 'closed'; document.querySelector('#chat-send').disabled = closed; document.querySelector('#chat-message').disabled = closed; }
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
  const topicGeneration = workspace.generation; const selectionGeneration = sameConversation(workspace.selected, item) ? workspace.selectionGeneration : ++workspace.selectionGeneration; const historyGeneration = ++workspace.historyGeneration; const chatSendGeneration = workspace.chatSendGeneration;
  workspace.selected = item; document.querySelector('#chat-conversation-name').textContent = item.displayName; document.querySelector('#chat-messages').replaceChildren();
  chatStatus.textContent = '';
  syncSelectedConversationControls(); renderConversations();
  try {
    const value = unwrap(await bridgeRequest('command-center.v1.sessions.history', { schemaVersion: 1, topicId: workspace.topic.topicId, referenceId: item.referenceId, limit: 100 }));
    if (topicGeneration !== workspace.generation || selectionGeneration !== workspace.selectionGeneration || historyGeneration !== workspace.historyGeneration || workspace.selected?.referenceId !== item.referenceId || workspace.selected?.sessionId !== item.sessionId) return;
    renderHistory(value?.messages ?? []);
  } catch (error) {
    if (topicGeneration === workspace.generation && selectionGeneration === workspace.selectionGeneration && historyGeneration === workspace.historyGeneration && chatSendGeneration === workspace.chatSendGeneration && workspace.selected?.referenceId === item.referenceId && workspace.selected?.sessionId === item.sessionId) chatStatus.textContent = error.message;
  }
}
function renderHistory(messages) {
  const target = document.querySelector('#chat-messages'); target.replaceChildren();
  for (const message of messages) {
    const row = document.createElement('article'); row.className = 'chat-message'; const role = document.createElement('strong'); role.textContent = `${message.role ?? 'message'}: `; const content = document.createElement('span'); content.textContent = message.content ?? ''; row.append(role, content);
    if (message.details?.kind === 'note') row.append(button('Open referenced Note', () => openAuthoritativeNote(message.details, { referenceError: true })));
    target.append(row);
  }
}
function chatSendIntent(selected, message) { return { topicId: workspace.topic?.topicId, referenceId: selected?.referenceId, sessionId: selected?.sessionId, message }; }
function sameChatSendIntent(left, right) { return left?.topicId === right?.topicId && left?.referenceId === right?.referenceId && left?.sessionId === right?.sessionId && left?.message === right?.message; }
function sameChatSendTarget(left, right) { return left?.topicId === right?.topicId && left?.referenceId === right?.referenceId && left?.sessionId === right?.sessionId; }
function chatSendOperationKey(topicGeneration, selectionGeneration, intent) { return JSON.stringify([topicGeneration, selectionGeneration, intent.topicId, intent.referenceId, intent.sessionId]); }
document.querySelector('#chat-form')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const selected = workspace.selected; const generation = workspace.generation; const selectionGeneration = workspace.selectionGeneration; const input = document.querySelector('#chat-message'); const message = input.value.trim(); if (!message || !selected || selected.status === 'closed') return;
  const intent = chatSendIntent(selected, message); const operationKey = chatSendOperationKey(generation, selectionGeneration, intent); let operation = workspace.chatSendOperations.get(operationKey) ?? [...workspace.chatSendOperations.values()].find((candidate) => candidate.generation === generation && sameChatSendTarget(candidate.intent, intent));
  if (operation && !sameChatSendIntent(operation.intent, intent)) { chatStatus.textContent = 'A different Chat send is already settling and was not sent.'; return; }
  if (operation?.pending) { chatStatus.textContent = 'Sending message…'; return; }
  if (operation && operation.entryId !== operationKey) { if (workspace.chatSendOperations.get(operation.entryId) === operation) workspace.chatSendOperations.delete(operation.entryId); operation.entryId = operationKey; operation.selectionGeneration = selectionGeneration; workspace.chatSendOperations.set(operationKey, operation); }
  if (!operation) { operation = { entryId: operationKey, generation, selectionGeneration, logicalOperationId: operationId(), intent, pending: false }; workspace.chatSendOperations.set(operationKey, operation); }
  const { topicId, referenceId, sessionId } = operation.intent; const sendGeneration = ++workspace.chatSendGeneration; operation.pending = true;
  document.querySelector('#chat-send').disabled = true; chatStatus.textContent = 'Sending message…';
  const isCurrent = () => generation === workspace.generation && selectionGeneration === workspace.selectionGeneration && workspace.chatSendGeneration === sendGeneration && workspace.topic?.topicId === topicId && workspace.selected?.referenceId === referenceId && workspace.selected?.sessionId === sessionId;
  try { await pageAction('chat.send', { topicId, referenceId, message: operation.intent.message, logicalOperationId: operation.logicalOperationId }); if (workspace.chatSendOperations.get(operation.entryId) === operation) workspace.chatSendOperations.delete(operation.entryId); if (!isCurrent()) return; const retainedDraft = input.value.trim() !== operation.intent.message; if (!retainedDraft) input.value = ''; await selectConversation(workspace.selected); if (isCurrent()) chatStatus.textContent = retainedDraft ? 'Message sent; the current draft was retained.' : 'Message sent.'; }
  catch (error) { operation.pending = false; if (error.terminal !== false && workspace.chatSendOperations.get(operation.entryId) === operation) workspace.chatSendOperations.delete(operation.entryId); if (isCurrent()) chatStatus.textContent = error.terminal === false ? 'Message delivery is not yet confirmed. Retry the unchanged message to reconcile it.' : error.message; }
  finally { if (isCurrent()) syncSelectedConversationControls(); }
});
document.querySelector('#conversation-create')?.addEventListener('submit', async (event) => { event.preventDefault(); const input = event.currentTarget.elements.label; const label = input.value.trim(); const generation = workspace.generation; const topic = workspace.topic; try { await pageAction('conversations.create', { topicId: topic.topicId, label, expectedRevision: topic.revision }); if (generation !== workspace.generation || workspace.topic?.topicId !== topic.topicId) return; if (input.value.trim() === label) input.value = ''; await loadConversations({ generation }); } catch (error) { if (generation === workspace.generation && workspace.topic?.topicId === topic.topicId) conversationStatus.textContent = error.message || 'Conversation creation was refused.'; } });
document.querySelector('#conversation-refresh')?.addEventListener('click', () => loadConversations());
document.querySelector('#conversation-view')?.addEventListener('change', () => loadConversations());

async function loadNotes({ generation = workspace.generation } = {}) {
  const value = unwrap(await bridgeRequest('command-center.v1.notes.browse', { schemaVersion: 1, topicId: workspace.topic.topicId }));
  if (generation !== workspace.generation) return; workspace.notes = Array.isArray(value) ? value : value?.notes ?? []; renderNotes();
}
function renderNotes() {
  const target = document.querySelector('#notes-tree'); target.replaceChildren();
  for (const note of workspace.notes) { const source = note.sourceReference ?? exactTopicReference(workspace.topic, 'note', note.referenceId); const open = button(note.path, () => openAuthoritativeNote({ kind: 'note', topicId: workspace.topic.topicId, referenceId: source?.referenceId, path: note.path, observedRevision: note.revision ?? source?.observedRevision })); open.className = 'note-tree-item'; target.append(open); }
}
function encodeText(text) { const bytes = new TextEncoder().encode(text); let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }
function decodeBase64Bytes(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function decodeText(value) { return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Bytes(value)); }
async function readNoteChunks(descriptor) {
  let offset = 0; let text = ''; let revision = descriptor.observedRevision; let sourceReference; const decoder = new TextDecoder('utf-8', { fatal: true });
  for (;;) {
    const value = unwrap(await bridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: descriptor.topicId, referenceId: descriptor.referenceId, path: descriptor.path, observedRevision: descriptor.observedRevision, offset }));
    if (!value || value.path !== descriptor.path || value.revision !== revision || value.sourceReference?.referenceId !== descriptor.referenceId || value.sourceReference?.topicId !== descriptor.topicId) throw new Error(offset === 0 && value?.revision === descriptor.observedRevision ? 'The authoritative Note changed after this reference was created.' : 'The authoritative Note changed during retrieval.');
    sourceReference = value.sourceReference; text += decoder.decode(decodeBase64Bytes(value.contentBase64), { stream: !value.complete }); if (value.complete) return { text, revision, sourceReference }; if (!Number.isInteger(value.nextOffset) || value.nextOffset <= offset) throw new Error('The authoritative Note changed during retrieval.'); offset = value.nextOffset;
  }
}
async function openAuthoritativeNote(descriptor, { referenceError = false } = {}) {
  const topicGeneration = workspace.generation; const noteGeneration = ++workspace.noteGeneration; const previous = workspace.note;
  try {
    const read = await readNoteChunks(descriptor);
    if (topicGeneration !== workspace.generation || noteGeneration !== workspace.noteGeneration) return;
    const draftId = `${descriptor.topicId}:${descriptor.referenceId}`; const existing = workspace.drafts.get(draftId);
    workspace.note = { ...descriptor, revision: read.revision, sourceReference: read.sourceReference, draftId }; workspace.drafts.set(draftId, existing ?? { text: read.text, dirty: false }); showNote(); notesStatus.textContent = 'Authoritative Note opened.'; revealWorkspaceTarget('notes');
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
async function renderNotePreview(text) { const target = document.querySelector('#note-preview'); const generation = workspace.generation; const noteGeneration = workspace.noteGeneration; const draftId = workspace.note?.draftId; target.textContent = 'Rendering preview…'; try { const markdown = await markdownModule; if (generation === workspace.generation && noteGeneration === workspace.noteGeneration && workspace.note?.draftId === draftId && !target.hidden) markdown.renderMarkdownInto(target, text); } catch { if (generation === workspace.generation && noteGeneration === workspace.noteGeneration && workspace.note?.draftId === draftId && !target.hidden) { target.replaceChildren(); notesStatus.textContent = 'Markdown preview is unavailable.'; } } }
async function setNoteMode(preview) { const editor = document.querySelector('#note-content'); const target = document.querySelector('#note-preview'); editor.hidden = preview; target.hidden = !preview; document.querySelector('#note-edit-mode').setAttribute('aria-pressed', String(!preview)); document.querySelector('#note-preview-mode').setAttribute('aria-pressed', String(preview)); if (!preview) { target.replaceChildren(); return; } await renderNotePreview(editor.value); }
document.querySelector('#note-edit-mode')?.addEventListener('click', () => setNoteMode(false)); document.querySelector('#note-preview-mode')?.addEventListener('click', () => setNoteMode(true));

const noteDialog = document.querySelector('#note-action-dialog'); let noteDialogAction = null; let noteDialogReturnFocus = null;
function openNoteDialog(action, trigger) { noteDialogAction = action; noteDialogReturnFocus = trigger; document.querySelector('#note-action-heading').textContent = action === 'notes.create' ? 'Create Note' : action === 'notes.rename' ? 'Rename Note' : 'Move Note'; document.querySelector('#note-action-path').value = action === 'notes.create' ? '' : workspace.note?.path ?? ''; document.querySelector('#note-action-text').value = ''; document.querySelector('#note-action-text-label').hidden = action !== 'notes.create'; noteDialog.showModal(); document.querySelector('#note-action-path').focus(); }
document.querySelector('#note-new')?.addEventListener('click', (event) => openNoteDialog('notes.create', event.currentTarget)); document.querySelector('#note-rename')?.addEventListener('click', (event) => openNoteDialog('notes.rename', event.currentTarget)); document.querySelector('#note-move')?.addEventListener('click', (event) => openNoteDialog('notes.move', event.currentTarget));
document.querySelector('#note-action-cancel')?.addEventListener('click', () => noteDialog.close()); noteDialog?.addEventListener('close', () => noteDialogReturnFocus?.focus());
document.querySelector('#note-action-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const path = document.querySelector('#note-action-path').value.trim(); const current = workspace.note; const generation = workspace.generation; const topic = workspace.topic; const action = noteDialogAction; try { if (action === 'notes.create') await pageAction(action, { topicId: topic.topicId, referenceId: exactTopicReference(topic, 'note_folder')?.referenceId, path, contentBase64: encodeText(document.querySelector('#note-action-text').value), expectedTopicRevision: topic.revision }); else await pageAction(action, { topicId: topic.topicId, referenceId: current.referenceId, path: current.path, destinationPath: path, expectedRevision: current.revision, expectedTopicRevision: topic.revision }); if (generation !== workspace.generation || workspace.topic?.topicId !== topic.topicId) return; noteDialog.close(); await loadNotes({ generation }); if (generation !== workspace.generation || workspace.topic?.topicId !== topic.topicId) return; const next = workspace.notes.find((item) => item.path === path); if (next) { const oldDraft = current && workspace.drafts.get(current.draftId); const source = next.sourceReference; if (oldDraft && current.path !== path) workspace.drafts.set(`${topic.topicId}:${source.referenceId}`, oldDraft); await openAuthoritativeNote({ kind: 'note', topicId: topic.topicId, referenceId: source.referenceId, path, observedRevision: next.revision }); } } catch (error) { if (generation === workspace.generation && workspace.topic?.topicId === topic.topicId) document.querySelector('#note-action-status').textContent = error.message; } });
document.querySelector('#notes-refresh')?.addEventListener('click', () => loadNotes());

async function searchWorkspace(event) { event.preventDefault(); if (!workspace.topic) return; const generation = workspace.generation; const searchGeneration = ++workspace.searchGeneration; const topicId = workspace.topic.topicId; workspaceSearchStatus.textContent = 'Searching…'; try { const value = unwrap(await bridgeRequest('command-center.v1.search.query', { schemaVersion: 1, topicId, query: document.querySelector('#workspace-search-query').value.trim(), limit: 50 })); if (generation !== workspace.generation || searchGeneration !== workspace.searchGeneration || workspace.topic?.topicId !== topicId) return; renderWorkspaceSearch('workspace-notes-results', value.notes?.results ?? []); renderWorkspaceSearch('workspace-conversations-results', value.conversations?.results ?? []); workspaceSearchStatus.textContent = `${value.notes?.results?.length ?? 0} Notes · ${value.conversations?.results?.length ?? 0} Conversations`; } catch (error) { if (generation === workspace.generation && searchGeneration === workspace.searchGeneration && workspace.topic?.topicId === topicId) workspaceSearchStatus.textContent = error.message || 'Topic Search is unavailable.'; } }
function renderWorkspaceSearch(id, results) { const target = document.querySelector(`#${id}`); target.replaceChildren(...results.map((result) => { const row = document.createElement('article'); const title = document.createElement('strong'); title.textContent = result.heading || result.conversationName || result.path; const snippet = document.createElement('p'); snippet.textContent = result.snippet ?? ''; row.append(title, snippet); if (result.provenance?.status === 'closed') row.append(Object.assign(document.createElement('span'), { textContent: 'Closed' })); row.append(button(result.navigation.kind === 'note' ? 'Open Note' : 'Open Conversation', () => openWorkspaceResult(result))); return row; })); }
async function openWorkspaceResult(result) { if (result.navigation.kind === 'note') return openAuthoritativeNote(result.navigation); const navigation = result.navigation; const generation = workspace.generation; const searchGeneration = workspace.searchGeneration; const selectionGeneration = workspace.selectionGeneration; const topicId = workspace.topic?.topicId; try { if (navigation.topicId !== topicId) throw new Error('The authoritative Conversation belongs to another Topic.'); const target = unwrap(await bridgeRequest('command-center.v1.sessions.navigate', { schemaVersion: 1, topicId: navigation.topicId, referenceId: navigation.referenceId })); if (generation !== workspace.generation || searchGeneration !== workspace.searchGeneration || selectionGeneration !== workspace.selectionGeneration || workspace.topic?.topicId !== topicId) return; const source = target?.sourceReference; if (target?.sessionKey !== navigation.sessionKey || target?.sessionId !== navigation.sessionId || source?.referenceId !== navigation.referenceId || source?.topicId !== topicId || source?.sourceSystem !== 'openclaw' || source?.sourceKind !== 'session' || source?.externalSourceId !== target.sessionKey) throw new Error('The authoritative Conversation changed after this result was created.'); const item = { referenceId: navigation.referenceId, topicId: navigation.topicId, sessionKey: target.sessionKey, sessionId: target.sessionId, displayName: result.conversationName, status: result.provenance?.status ?? 'open', isPrimary: false }; await selectConversation(item); if (generation === workspace.generation && workspace.topic?.topicId === topicId) revealWorkspaceTarget('chat'); } catch (error) { if (generation === workspace.generation && searchGeneration === workspace.searchGeneration && workspace.topic?.topicId === topicId) workspaceSearchStatus.textContent = error.message || 'Authoritative Conversation navigation was refused.'; } }
document.querySelector('#workspace-search-form')?.addEventListener('submit', searchWorkspace);

function focusPane(name, moveFocus = true) { for (const pane of selectAll('.workspace-layout > [data-pane]')) pane.dataset.focused = String(pane.dataset.pane === name); const pane = document.querySelector(`[data-pane="${name}"]`); if (moveFocus) (pane?.querySelector('h3,[tabindex]') ?? pane)?.focus?.(); }
for (const pane of selectAll('.workspace-layout > [data-pane]')) pane.addEventListener('focusin', () => focusPane(pane.dataset.pane, false));
function setPaneOpen(name, open) { workspace.panes[name] = open; const pane = document.querySelector(`#${name}-pane`); pane.hidden = !open; if (!open) { focusPane('chat', false); document.querySelector('#chat-heading').focus(); } else { focusPane(name); } }
document.querySelector('#conversations-close')?.addEventListener('click', () => setPaneOpen('conversations', false)); document.querySelector('#notes-close')?.addEventListener('click', () => setPaneOpen('notes', false)); document.querySelector('#conversations-open')?.addEventListener('click', () => setPaneOpen('conversations', true)); document.querySelector('#notes-open')?.addEventListener('click', () => setPaneOpen('notes', true));
function selectMobileSection(name) { workspace.mobileSection = name; if (name === 'conversations') setPaneOpen('conversations', true); if (name === 'notes') setPaneOpen('notes', true); for (const control of selectAll('.workspace-sections button')) control.setAttribute('aria-selected', String(control.dataset.section === name)); updateResponsivePanes(); }
function updateResponsivePanes() { const mobile = typeof matchMedia === 'function' && matchMedia('(max-width: 47.99rem)').matches; for (const pane of selectAll('.workspace-layout > [data-pane]')) { const visible = mobile ? pane.dataset.pane === workspace.mobileSection : !['conversations', 'notes'].includes(pane.dataset.pane) || workspace.panes[pane.dataset.pane]; pane.style.display = visible ? '' : 'none'; pane.inert = !visible; } }
function revealWorkspaceTarget(name) { if (typeof matchMedia === 'function' && matchMedia('(max-width: 47.99rem)').matches) { selectMobileSection(name); focusPane(name); } else if (name === 'notes' || name === 'conversations') setPaneOpen(name, true); else focusPane(name, false); }
for (const control of selectAll('.workspace-sections button')) control.addEventListener('click', () => selectMobileSection(control.dataset.section)); if (typeof matchMedia === 'function') matchMedia('(max-width: 47.99rem)').addEventListener?.('change', updateResponsivePanes); updateResponsivePanes();
document.querySelector('#workspace-back')?.addEventListener('click', () => { ++workspace.generation; setWorkspaceVisible(false); document.querySelector('#topics-heading')?.focus(); if (hasDashboardDestination) void loadDashboard(); });

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
sendBridge({ type: 'openclaw:capability-bridge-hello', protocolVersion: 1 });
if (hasDashboardDestination) loadDashboard();
if (requestedTopicId === null) loadTopics();
else if (workspaceNode) bridgeReady.then(() => openTopicWorkspace(requestedTopicId)).catch((error) => { workspaceStatus.textContent = error.message; });
