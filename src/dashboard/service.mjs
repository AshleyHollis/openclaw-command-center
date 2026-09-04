import { sourceError } from '../sources/errors.mjs';
import { opaqueNotificationId } from '../notifications/preview.mjs';

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 50;

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
  return dateMs(job?.nextRunAtMs);
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

export async function projectDashboard({ sourceService, attentionService, metadata, now = () => new Date().toISOString(), timeZone = 'UTC', activityOffset = 0, activityLimit = DEFAULT_ACTIVITY_LIMIT, navigationResolver, notificationSettings } = {}) {
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
  const attentionResult = typeof sourceService?.attentionList === 'function'
    ? await sourceService.attentionList({ schemaVersion: 1 })
    : attentionService?.list?.({ schemaVersion: 1 }) ?? { episodes: [], inProgress: [] };
  const active = asArray(attentionResult?.episodes).filter((episode) => episode?.state === 'Active' && (episode.severity !== 'Routine' || episode.sourceCapabilityId === 'topic-review' || episode.sourceCapabilityId === 'reminders' && episode.evidenceFacts?.reminderDue === true)).map(compactEpisode);
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
  const settings = typeof notificationSettings === 'function' ? await notificationSettings() : notificationSettings;
  return Object.freeze({
    schemaVersion: 1,
    serverTime: new Date(serverTimeMs).toISOString(),
    attention: Object.freeze(active.filter((episode) => {
      const dueAtMs = dateMs(episode.evidence?.dueAt ?? episode.evidenceFacts?.dueAt);
      return !episode.sourceReferenceId || !Number.isSafeInteger(dueAtMs) || !futureOccurrenceKeys.has(`${episode.sourceReferenceId}:${dueAtMs}`);
    })),
    attentionBadgeCount: active.filter((episode) => {
      const dueAtMs = dateMs(episode.evidence?.dueAt ?? episode.evidenceFacts?.dueAt);
      return !episode.sourceReferenceId || !Number.isSafeInteger(dueAtMs) || !futureOccurrenceKeys.has(`${episode.sourceReferenceId}:${dueAtMs}`);
    }).length,
    inProgress: Object.freeze(inProgress),
    comingUp: Object.freeze(comingUp),
    topics: Object.freeze(topics.map((topic) => Object.freeze({ topicId: topic.topicId, name: topicName(topic), paraCategory: topic.paraCategory }))),
    activity,
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
