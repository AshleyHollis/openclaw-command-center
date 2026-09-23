import { sourceError } from '../sources/errors.mjs';
import { opaqueNotificationId } from '../notifications/preview.mjs';
import { openLoopReminderReferenceId, zonedDateAtNine } from '../open-loops/reminder-coordinator.mjs';
import { projectCapacityWorkspace } from '../open-loops/capacity-workspace.mjs';
import { projectIntakeAccounts } from '../open-loops/intake-accounting.mjs';

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 50;
const HIGHLIGHTED_OPEN_LOOP_LIMIT = 3;
const OPEN_LOOP_GROUP_LIMIT = 20;
const CAPACITY_PREVIEW_LIMIT = 20;

function asArray(value) { return Array.isArray(value) ? value : []; }
function dateMs(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return null;
}
function topicName(topic) { return typeof topic?.name === 'string' && topic.name.trim() ? topic.name.trim().slice(0, 120) : 'Topic'; }

function reminderDueAt(row) {
  const job = row?.job ?? row;
  if (job?.schedule?.kind === 'at') return dateMs(job.schedule.at);
  return dateMs(job?.state?.nextRunAtMs);
}

function publicReminder(row, topic, dueAtMs, timeZone = 'UTC') {
  const job = row?.job ?? row;
  const sourceKind = row?.sourceReference?.sourceKind ?? 'reminder_schedule';
  return Object.freeze({
    kind: 'Reminder',
    dueAt: new Date(dueAtMs).toISOString(),
    day: new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone }).format(new Date(dueAtMs)),
    time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(dueAtMs)),
    context: topicName(topic),
    topic: topicName(topic),
    sourceKind,
    // The UI receives no scheduler or Source Reference identity from this projection.
    label: typeof job?.displayName === 'string' && job.displayName.trim() ? job.displayName.trim().slice(0, 80) : 'Reminder'
  });
}

async function listTopics(metadata) {
  const values = metadata?.listUsableTopics?.() ?? metadata?.listTopics?.() ?? [];
  return asArray(values).filter((topic) => topic?.lifecycle === undefined || topic.lifecycle === 'active');
}

async function listReminderRows({ sourceService, metadata, topics }) {
  if (typeof sourceService?.listReminderOccurrences === 'function') return asArray(await sourceService.listReminderOccurrences());
  const rows = [];
  for (const topic of topics) {
    try {
      const service = sourceService?.forTopic?.(topic.topicId);
      const values = service?.reminders?.list ? await service.reminders.list({ schemaVersion: 1 }) : [];
      rows.push(...values.map((row) => ({ ...row, topicId: topic.topicId })));
    } catch {
      // A missing authoritative scheduler read is not a reason to invent a future card.
    }
  }
  return rows;
}

function compactEpisode(episode) {
  const evidence = episode?.evidenceFacts ?? {};
  const dueReminder = episode?.sourceCapabilityId === 'reminders' && evidence.reminderDue === true;
  return Object.freeze({
    ...episode,
    ...(dueReminder ? { severity: 'Reminder' } : {}),
    actions: Object.freeze(Array.isArray(episode?.actions) ? episode.actions.slice(0, 3) : []),
    notificationRecordId: opaqueNotificationId({ version: 1, episodeId: episode?.episodeId }, 'record'),
    context: typeof evidence.context === 'string' ? evidence.context.slice(0, 120) : episode?.sourceKind === 'reminder' ? 'Reminder' : 'Attention item',
    evidenceFacts: undefined,
    evidence: Object.freeze({ ...evidence })
  });
}

function compactOpenLoop(projected, metadata) {
  const loop = projected.loop;
  const sourceKinds = [...new Set(loop.evidenceObservationIds.map(id => metadata?.getOpenLoopObservation?.(id)?.source?.kind).filter(value => ['email', 'message', 'note', 'document', 'reminder', 'chat'].includes(value)))];
  return Object.freeze({
    loopId: loop.loopId,
    kind: loop.kind,
    title: loop.title.slice(0, 300),
    state: loop.state,
    ...(loop.topicId === undefined ? {} : { topicId: loop.topicId }),
    ...(loop.paymentState === undefined ? {} : { paymentState: loop.paymentState }),
    ...(loop.amount === undefined ? {} : { amount: loop.amount, currency: loop.currency }),
    ...(loop.dueAt === undefined ? {} : { dueAt: loop.dueAt }),
    ...(loop.dueDate === undefined ? {} : { dueDate: loop.dueDate, dueTimeZone: loop.dueTimeZone }),
    ...(loop.reviewAt === undefined ? {} : { reviewAt: loop.reviewAt }),
    ...(projected.reason === undefined ? {} : { reason: projected.reason }),
    ...(projected.whyNow === undefined ? {} : { whyNow: projected.whyNow.slice(0, 500) }),
    ...(loop.attention === undefined ? {} : { planning: Object.freeze({
      importance: loop.attention.importance ?? 'normal',
      importanceOrigin: loop.attention.importanceOrigin ?? 'processing',
      ...(loop.attention.plannedAt ? { plannedAt: loop.attention.plannedAt } : {}),
      ...(loop.attention.effortMinutes ? { effortMinutes: loop.attention.effortMinutes } : {}),
      contexts: Object.freeze(asArray(loop.attention.contexts)),
      dependencies: Object.freeze(asArray(loop.attention.dependencies)),
      ...(loop.attention.provenance ? { provenance: loop.attention.provenance } : {}),
      ...(loop.attention.confidence === undefined ? {} : { confidence: loop.attention.confidence }),
      ...(loop.attention.lastConsideredAt ? { lastConsideredAt: loop.attention.lastConsideredAt } : {}),
      someday: loop.attention.someday === true
    }) }),
    actions: Object.freeze(asArray(projected.actions).slice(0, 4)),
    ...(sourceKinds.length ? { sourceLabel: sourceKinds.map(value => value === 'message' ? 'Email or message' : value[0].toUpperCase() + value.slice(1)).join(', ') } : {}),
    evidenceCount: loop.evidenceObservationIds.length,
    revision: loop.revision
  });
}

function openLoopProjection(metadata, serverTime) {
  if (typeof metadata?.getQuietAttentionInbox !== 'function') return Object.freeze({ total: 0, attentionTotal: 0, highlighted: Object.freeze([]), stageReviewTotal: 0, stageReviews: Object.freeze([]), comingUpTotal: 0, comingUp: Object.freeze([]), waitingTotal: 0, waiting: Object.freeze([]), suggestedTotal: 0, suggested: Object.freeze([]), deferredTotal: 0, deferred: Object.freeze([]), reconciliationTotal: 0, reconciliation: Object.freeze([]) });
  const inbox = metadata.getQuietAttentionInbox({ now: serverTime });
  const rawStageReviews = typeof metadata.projectActiveRenovationStagePrerequisites === 'function' ? metadata.projectActiveRenovationStagePrerequisites() : [];
  const activeStageIds = new Set(rawStageReviews.flatMap(group => group.items.map(item => item.loop.loopId)));
  const stageReviews = rawStageReviews.map(group => Object.freeze({ stage: group.stage, activationObservationId: group.activationObservationId, items: Object.freeze(group.items.map(item => compactOpenLoop(item, metadata))) }));
  const attention = inbox.attention.filter(item => !activeStageIds.has(item.loop.loopId));
  const conflicts = attention.filter(item => item.reason === 'evidence-conflict');
  const ordinary = attention.filter(item => item.reason !== 'evidence-conflict').slice(0, HIGHLIGHTED_OPEN_LOOP_LIMIT);
  const highlighted = [...conflicts, ...ordinary].filter((item, index, values) => values.findIndex(candidate => candidate.loop.loopId === item.loop.loopId) === index).map(item => compactOpenLoop(item, metadata));
  const total = Object.values(inbox).reduce((sum, values) => sum + values.length, 0);
  const workspace = projectCapacityWorkspace(metadata.listOpenLoops(), { now: serverTime });
  const compactList = values => Object.freeze(values.map(loop => compactOpenLoop({ loop }, metadata)));
  const capacityWorkspace = Object.freeze({
    today: Object.freeze({
      mandatory: compactList(workspace.today.mandatory),
      mandatoryTotal: workspace.today.mandatoryTotal,
      groups: Object.freeze(Object.fromEntries(Object.entries(workspace.today.groups).map(([key, values]) => [key, compactList(values)]))),
      planned: compactList(workspace.today.planned)
    }),
    upcoming: compactList(workspace.upcoming), capacity: compactList(workspace.capacity.slice(0, CAPACITY_PREVIEW_LIMIT)), capacityTotal: workspace.capacity.length, waiting: compactList(workspace.waiting), someday: compactList(workspace.someday),
    review: Object.freeze({ batch: compactList(workspace.review.batch), remaining: workspace.review.remaining, eligibleTotal: workspace.review.eligibleTotal }),
    board: Object.freeze({ ready: compactList(workspace.board.ready), doing: compactList(workspace.board.doing), waiting: compactList(workspace.board.waiting), done: compactList(workspace.board.done), suggestions: compactList(workspace.board.suggestions) }),
    agenda: Object.freeze(workspace.agenda.map(entry => Object.freeze({ kind: entry.kind, at: entry.at, item: compactOpenLoop({ loop: entry.loop }, metadata) })))
  });
  return Object.freeze({
    total,
    attentionTotal: attention.length + activeStageIds.size,
    highlighted: Object.freeze(highlighted),
    stageReviewTotal: stageReviews.length,
    stageReviews: Object.freeze(stageReviews),
    comingUpTotal: inbox.comingUp.length,
    comingUp: Object.freeze(inbox.comingUp.slice(0, OPEN_LOOP_GROUP_LIMIT).map(item => compactOpenLoop(item, metadata))),
    waitingTotal: inbox.waiting.filter(item => !activeStageIds.has(item.loop.loopId)).length,
    waiting: Object.freeze(inbox.waiting.filter(item => !activeStageIds.has(item.loop.loopId)).slice(0, OPEN_LOOP_GROUP_LIMIT).map(item => compactOpenLoop(item, metadata))),
    suggestedTotal: inbox.suggested.length,
    suggested: Object.freeze(inbox.suggested.slice(0, OPEN_LOOP_GROUP_LIMIT).map(item => compactOpenLoop(item, metadata))),
    deferredTotal: inbox.deferred.length,
    deferred: Object.freeze(inbox.deferred.slice(0, OPEN_LOOP_GROUP_LIMIT).map(item => compactOpenLoop(item, metadata))),
    reconciliationTotal: inbox.reconciliation.length,
    reconciliation: Object.freeze(inbox.reconciliation.slice(0, OPEN_LOOP_GROUP_LIMIT).map(item => compactOpenLoop(item, metadata))),
    workspace: capacityWorkspace
  });
}

async function activityPage({ sourceService, attentionService, metadata, offset, limit, navigationResolver }) {
  let result;
  if (typeof sourceService?.activityList === 'function') result = await sourceService.activityList({ schemaVersion: 1, offset, limit });
  else if (typeof attentionService?.listActivity === 'function') result = attentionService.listActivity({ schemaVersion: 1, offset, limit });
  else result = { schemaVersion: 1, records: metadata?.listActivity?.() ?? [], nextOffset: null, hasMore: false };
  const records = asArray(result?.records ?? result).map((record) => ({ ...record }));
  const navigable = [];
  for (const record of records) {
    let navigation;
    try { navigation = typeof navigationResolver === 'function' ? await navigationResolver(record) : record.navigation?.verified === true ? record.navigation : undefined; }
    catch { navigation = undefined; }
    navigable.push(Object.freeze({ ...record, ...(navigation ? { navigation } : {}) }));
  }
  return Object.freeze({ schemaVersion: 1, records: Object.freeze(navigable), nextOffset: result?.nextOffset ?? null, hasMore: result?.hasMore === true });
}

function intakeReceiptCoverage(metadata, sourceKind, serverTime) {
  const allReceipts = typeof metadata?.listOperations === 'function'
    ? metadata.listOperations().filter(item => item.operationKind === `intake-receipt.${sourceKind}.v1` && item.resultStatus !== 'superseded')
    : [];
  const operations = allReceipts.filter(item => {
    try { return JSON.parse(item.resultIdentity ?? 'null')?.purpose !== 'admitted-retry'; } catch { return true; }
  });
  const latest = operations.at(-1);
  if (!latest) return null;
  let receipt;
  try { receipt = JSON.parse(latest.resultIdentity ?? 'null'); } catch { receipt = null; }
  if (!receipt || receipt.sourceKind !== sourceKind) return null;
  const retryOperation = allReceipts.filter(item => {
    try { const candidate = JSON.parse(item.resultIdentity ?? 'null'); return candidate?.purpose === 'admitted-retry' && candidate.retryOfRunId === receipt.runId; } catch { return false; }
  }).at(-1);
  let retryReceipt;
  try { retryReceipt = JSON.parse(retryOperation?.resultIdentity ?? 'null'); } catch { retryReceipt = null; }
  const lastSuccess = operations.reduce((last, operation) => {
    let candidate;
    try { candidate = JSON.parse(operation.resultIdentity ?? 'null'); } catch { return last; }
    const sameBoundAccount = !receipt.scope?.accountBinding || candidate?.scope?.accountBinding === receipt.scope.accountBinding;
    return sameBoundAccount && candidate?.sourceKind === sourceKind && ['healthy-empty', 'healthy-processed'].includes(candidate.status) && candidate.lastSuccessfulAt && (!last || Date.parse(candidate.lastSuccessfulAt) > Date.parse(last.at)) ? { at: candidate.lastSuccessfulAt, scope: candidate.scope } : last;
  }, null);
  const overdue = receipt.nextExpectedAt && Date.parse(receipt.nextExpectedAt) < Date.parse(serverTime);
  const accounts = projectIntakeAccounts(metadata, sourceKind);
  const readerLocations = sourceKind === 'email' && typeof metadata?.getEmailReaderLocator === 'function'
    ? (() => {
      const latestBySource = new Map();
      for (const account of accounts) if (!latestBySource.has(account.sourceExternalId)) latestBySource.set(account.sourceExternalId, account);
      let available = 0; let unavailable = 0; let missing = 0; let lookupFailed = 0; let lastObservedAt;
      for (const account of latestBySource.values()) {
        let locator;
        try { locator = metadata.getEmailReaderLocator(account.sourceExternalId, account.sourceVersion); }
        catch { lookupFailed += 1; continue; }
        if (!locator) { missing += 1; continue; }
        if (locator.status === 'available') available += 1;
        else if (locator.status === 'unavailable') unavailable += 1;
        else { lookupFailed += 1; continue; }
        if (!lastObservedAt || Date.parse(locator.observedAt) > Date.parse(lastObservedAt)) lastObservedAt = locator.observedAt;
      }
      const total = latestBySource.size;
      return Object.freeze({ status: lookupFailed ? 'unknown' : unavailable ? 'unavailable' : missing ? 'unconfirmed' : total ? 'recorded' : 'unknown', total, available, unavailable, missing, lookupFailed, ...(lastObservedAt ? { lastObservedAt } : {}) });
    })() : undefined;
  const accountedSources = accounts.filter(item => item.accounted).length;
  const resolvedSources = accounts.filter(item => item.resolved).length;
  const expectedOutcomes = accounts.reduce((sum, item) => sum + item.counts.expected, 0);
  const accountedOutcomes = accounts.reduce((sum, item) => sum + item.counts.accounted, 0);
  const pendingDecisions = accounts.reduce((sum, item) => sum + item.counts.decisionsPending, 0);
  const failedOutcomes = accounts.reduce((sum, item) => sum + item.counts.failed, 0);
  const unresolvedTopics = accounts.reduce((sum, item) => sum + item.counts.unresolvedTopics, 0);
  const incompleteEnumeration = receipt.status === 'incomplete' || receipt.continuation !== undefined;
  const receiptStatus = latest.state === 'pending' || receipt.status === 'pending' ? 'pending'
    : latest.state !== 'applied' || receipt.status === 'failed' ? 'failed'
      : receipt.status === 'incomplete' ? 'incomplete'
      : receipt.status === 'never-connected' ? 'never-connected'
        : overdue ? 'stale'
          : receipt.status === 'healthy-empty' ? 'healthy-empty' : 'receipt-current';
  const status = accounts.length && (failedOutcomes || unresolvedTopics || accounts.some(item => !item.accounted)) ? 'partial'
    : accounts.length && pendingDecisions ? 'needs-review'
      : incompleteEnumeration ? 'bounded' : receiptStatus;
  const label = sourceKind === 'email' ? 'Email intake' : sourceKind === 'chat' ? 'Chat commitments' : 'Note processing';
  const explanations = {
    pending: 'The maintained producer has started a run but has not recorded its final checkpoint.',
    failed: 'The maintained producer recorded a failed checkpoint.',
    'never-connected': 'The maintained producer reported that this source is not connected.',
    stale: 'The maintained producer has not recorded the next expected checkpoint.',
    'healthy-empty': 'The maintained producer completed successfully and found no new items.',
    incomplete: 'The maintained producer stopped at a durable continuation and can resume from its exact retained cursor.',
    'receipt-current': 'The maintained producer completed successfully and recorded its checkpoint.'
  };
  const accountExplanation = status === 'partial' ? 'Some source outcomes are missing, failed or awaiting Topic ownership; processing can resume from the retained source revision.'
    : status === 'needs-review' ? 'All source outcomes are accounted for, but at least one clarification still needs your decision.'
      : status === 'bounded' ? 'The recorded sources are accounted for, but the producer reported a bounded or incomplete enumeration scope.' : explanations[status];
  return Object.freeze({
    source: label, sourceKind, status, receiptStatus,
    lastObservedAt: receipt.observedAt,
    ...(lastSuccess ? { lastSuccessfulAt: lastSuccess.at } : {}),
    ...(receipt.nextExpectedAt ? { nextExpectedAt: receipt.nextExpectedAt } : {}),
    ...(retryReceipt ? { lastAdmittedRetry: Object.freeze({ observedAt: retryReceipt.observedAt, status: retryReceipt.status, processedCount: retryReceipt.processedCount, unadmittedSourceCount: retryReceipt.unadmittedSourceCount ?? 0 }) } : {}),
    ...(readerLocations ? { readerLocations } : {}),
    ...(receipt.scope ? { attemptScope: Object.freeze({ folders: receipt.scope.folders, sinceUtc: receipt.scope.sinceUtc, beforeUtc: receipt.scope.beforeUtc, maxMessages: receipt.scope.maxMessages, batchKind: receipt.scope.batchKind }) } : {}),
    ...(lastSuccess?.scope ? { lastSuccessfulScope: Object.freeze({ folders: lastSuccess.scope.folders, sinceUtc: lastSuccess.scope.sinceUtc, beforeUtc: lastSuccess.scope.beforeUtc, maxMessages: lastSuccess.scope.maxMessages, batchKind: lastSuccess.scope.batchKind }) } : {}),
    discovery: receipt.enumeration ? Object.freeze({ ...receipt.enumeration, canResume: receipt.continuation !== undefined }) : Object.freeze({ scope: 'unknown' }),
    counts: Object.freeze({ processed: receipt.processedCount, actionable: receipt.actionableCount, notes: receipt.noteCount }),
    sourceCounts: Object.freeze({ observed: accounts.length, accounted: accountedSources, resolved: resolvedSources }),
    outcomeCounts: Object.freeze({ expected: expectedOutcomes, accounted: accountedOutcomes, pendingDecisions, failed: failedOutcomes, unresolvedTopics }),
    recentSources: Object.freeze(accounts.slice(0, 10).map(account => Object.freeze({
      observedAt: account.observedAt,
      accounted: account.accounted,
      resolved: account.resolved,
      counts: account.counts,
      enumeration: Object.freeze({ scope: account.enumeration.scope, scannedCount: account.enumeration.scannedCount, remainingCount: account.enumeration.remainingCount, failedReadCount: account.enumeration.failedReadCount, scanCapReached: account.enumeration.scanCapReached, canResume: account.enumeration.scopeId !== undefined && account.enumeration.resumeCursor !== undefined }),
      outcomes: Object.freeze(account.outcomes.map(outcome => Object.freeze({
        kind: outcome.kind,
        status: outcome.status,
        ...(outcome.summary ? { summary: outcome.summary } : {}),
        ...(outcome.loopId ? { target: Object.freeze({ kind: 'open-loop', loopId: outcome.loopId }) } : {}),
        ...(outcome.status === 'quiet' && outcome.topicId && outcome.sourceReferenceId && outcome.sourcePath && outcome.sourceReferenceVersion ? { target: Object.freeze({ kind: 'topic-note', topicId: outcome.topicId, sourceReferenceId: outcome.sourceReferenceId, sourcePath: outcome.sourcePath, sourceVersion: outcome.sourceReferenceVersion }) } : {})
      })))
    }))),
    explanation: accountExplanation
  });
}

function intakeCoverage(metadata, serverTime) {
  const rows = [
    intakeReceiptCoverage(metadata, 'email', serverTime) ?? { source: 'Email intake', sourceKind: 'email', status: 'unknown', explanation: 'No maintained email-intake receipt is available.' },
    intakeReceiptCoverage(metadata, 'chat', serverTime) ?? { source: 'Chat commitments', sourceKind: 'chat', status: 'unknown', explanation: 'No maintained Chat-commitment receipt is available.' },
    intakeReceiptCoverage(metadata, 'note', serverTime) ?? { source: 'Note processing', sourceKind: 'note', status: 'unknown', explanation: 'No maintained Note-processing receipt is available.' }
  ];
  const operations = typeof metadata?.listOperations === 'function' ? metadata.listOperations().filter(item => item.operationKind === 'selected-source-intake-root') : [];
  const selected = operations.at(-1);
  if (!selected) return Object.freeze(rows.map(Object.freeze));
  let result;
  try { result = JSON.parse(selected.resultIdentity ?? 'null'); } catch { result = null; }
  const freshness = result?.freshness;
  const status = selected.state === 'pending' ? 'pending'
    : selected.state !== 'applied' ? 'failed'
      : freshness?.status === 'available' ? 'receipt-current'
        : freshness?.status === 'unavailable' ? 'failed' : 'unknown';
  rows.push({ source: 'Selected documents', sourceKind: 'document', status, ...(freshness?.lastObservedAt ? { lastObservedAt: freshness.lastObservedAt } : {}), ...(freshness?.lastAvailableAt ? { lastSuccessfulAt: freshness.lastAvailableAt } : {}), explanation: status === 'receipt-current' ? 'The last bounded selected-document read was acknowledged. This does not prove automatic email or Note coverage.' : status === 'pending' ? 'A selected-document read has not reached a durable outcome.' : status === 'failed' ? 'The latest selected-document read was unavailable or did not complete.' : 'The selected-document receipt has no usable freshness result.' });
  return Object.freeze(rows.map(row => Object.freeze(row)));
}

export async function projectDashboard({ sourceService, attentionService, metadata, dailyWorkspace, now = () => new Date().toISOString(), timeZone = 'UTC', activityOffset = 0, activityLimit = DEFAULT_ACTIVITY_LIMIT, navigationResolver, notificationSettings } = {}) {
  if (!Number.isInteger(activityOffset) || activityOffset < 0) throw sourceError('invalid-request', 'activityOffset must be a non-negative integer.');
  if (!Number.isInteger(activityLimit) || activityLimit < 1 || activityLimit > MAX_ACTIVITY_LIMIT) throw sourceError('invalid-request', 'activityLimit must be between 1 and 50.');
  const clock = typeof now === 'function' ? now() : now;
  const serverTimeMs = dateMs(clock);
  if (!Number.isSafeInteger(serverTimeMs)) throw sourceError('invalid-request', 'Dashboard server time is invalid.');
  if (typeof sourceService?.refreshReminderAttention === 'function') {
    try { await sourceService.refreshReminderAttention(); }
    catch { /* an unavailable scheduler cannot justify fabricating future entries */ }
  }
  const topics = await listTopics(metadata);
  const openLoopByReminderId = new Map((metadata?.listOpenLoops?.() ?? []).map(loop => [openLoopReminderReferenceId(loop.loopId), loop]));
  const reminderMatchesOpenLoop = (referenceId, dueAtMs) => {
    const loop = openLoopByReminderId.get(referenceId);
    if (!loop || ['suggested', 'resolved', 'cancelled'].includes(loop.state) || ['paid', 'cancelled'].includes(loop.paymentState)) return false;
    const accepted = loop.reviewAt ?? loop.dueAt ?? (loop.dueDate ? zonedDateAtNine(loop.dueDate, loop.dueTimeZone) : undefined);
    return Number.isSafeInteger(dueAtMs) && dateMs(accepted) === dueAtMs;
  };
  const attentionResult = typeof sourceService?.attentionList === 'function'
    ? await sourceService.attentionList({ schemaVersion: 1 })
    : attentionService?.list?.({ schemaVersion: 1 }) ?? { episodes: [], inProgress: [] };
  // Attention's owner admits Routine monitors too. Keep Dashboard's quieter
  // presentation, but never hide an approval or invent its decision actions.
  const active = asArray(attentionResult?.episodes).filter((episode) => episode?.state === 'Active' && (
    episode.severity !== 'Routine' || episode.sourceKind === 'approval'
    || asArray(episode.actions).some((action) => ['approval.approve', 'approval.reject'].includes(action.actionId))
    || episode.sourceCapabilityId === 'topic-review'
    || episode.sourceCapabilityId === 'reminders' && episode.evidenceFacts?.reminderDue === true
  )).map(compactEpisode);
  const inProgress = asArray(attentionResult?.inProgress).filter((episode) => episode?.state === 'Action running').map((episode) => Object.freeze({ ...compactEpisode(episode), actions: [] }));
  const topicById = new Map(topics.map((topic) => [topic.topicId, topic]));
  const reminders = await listReminderRows({ sourceService, metadata, topics });
  const futureOccurrenceKeys = new Set();
  const seenReminderOccurrences = new Set();
  const comingUp = [];
  for (const row of reminders) {
    const job = row?.job ?? row;
    if (job?.enabled !== true) continue;
    const dueAtMs = reminderDueAt(row);
    if (reminderMatchesOpenLoop(row?.sourceReference?.referenceId, dueAtMs)) continue;
    if (!Number.isSafeInteger(dueAtMs) || dueAtMs <= serverTimeMs) continue;
    const topic = topicById.get(row.topicId ?? row.sourceReference?.topicId);
    if (!topic) continue;
    const occurrenceKey = `${row?.sourceReference?.referenceId ?? row?.sourceReference?.externalSourceId ?? job?.id ?? ''}:${dueAtMs}`;
    if (seenReminderOccurrences.has(occurrenceKey)) continue;
    seenReminderOccurrences.add(occurrenceKey);
    if (row?.sourceReference?.referenceId) futureOccurrenceKeys.add(`${row.sourceReference.referenceId}:${dueAtMs}`);
    comingUp.push(publicReminder(row, topic, dueAtMs, timeZone));
  }
  comingUp.sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.context.localeCompare(right.context));
  const activity = await activityPage({ sourceService, attentionService, metadata, offset: activityOffset, limit: activityLimit, navigationResolver });
  const openLoops = openLoopProjection(metadata, new Date(serverTimeMs).toISOString());
  const settings = typeof notificationSettings === 'function' ? await notificationSettings() : notificationSettings;
  const visibleAttention = Object.freeze(active.filter((episode) => {
    const dueAtMs = dateMs(episode.evidence?.dueAt ?? episode.evidenceFacts?.dueAt);
    if (reminderMatchesOpenLoop(episode.sourceReferenceId, dueAtMs)) return false;
    return !episode.sourceReferenceId || !Number.isSafeInteger(dueAtMs) || !futureOccurrenceKeys.has(`${episode.sourceReferenceId}:${dueAtMs}`);
  }));
  return Object.freeze({
    schemaVersion: 1,
    serverTime: new Date(serverTimeMs).toISOString(),
    attention: visibleAttention,
    attentionBadgeCount: visibleAttention.length + openLoops.attentionTotal,
    inProgress: Object.freeze(inProgress),
    comingUp: Object.freeze(comingUp),
    openLoops,
    topics: Object.freeze(topics.map((topic) => Object.freeze({ topicId: topic.topicId, name: topicName(topic), paraCategory: topic.paraCategory }))),
    activity,
    intakeCoverage: intakeCoverage(metadata, new Date(serverTimeMs).toISOString()),
    ...(dailyWorkspace ? dailyWorkspace.get() : {}),
    activityOffset,
    activityLimit,
    ...(settings ? { notificationSettings: Object.freeze({ ...settings }) } : {})
  });
}

export function createDashboardService(options = {}) {
  const service = {
    async get(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw sourceError('invalid-request', 'Dashboard request must be an object.');
      const unsupported = Object.keys(input).filter((key) => !['schemaVersion', 'activityOffset', 'activityLimit'].includes(key));
      if (unsupported.length) throw sourceError('invalid-request', 'Dashboard reads do not accept client-selected current time.');
      if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw sourceError('unsupported-version', 'Dashboard schemaVersion must be 1.');
      return projectDashboard({ ...options, activityOffset: input.activityOffset ?? 0, activityLimit: input.activityLimit ?? DEFAULT_ACTIVITY_LIMIT });
    }
  };
  return Object.freeze(service);
}

export { DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT, reminderDueAt };
