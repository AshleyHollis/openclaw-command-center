import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = row => { try { return JSON.parse(row.resultIdentity); } catch { return null; } };
const iso = (value, name) => { const date = new Date(value); if (Number.isNaN(date.valueOf())) throw new Error(`${name} must be an ISO date-time.`); return date.toISOString(); };
const nonBlank = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`); return value.trim(); };
const localParts = (instant, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
const ymd = parts => `${parts.year}-${parts.month}-${parts.day}`;
const addDays = (date, days) => { const value = new Date(`${date}T12:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const weekday = date => { const day = new Date(`${date}T12:00:00.000Z`).getUTCDay(); return day === 0 ? 7 : day; };
function zonedInstant(date, localTime, timeZone) {
  const [year, month, day] = date.split('-').map(Number); const [hour, minute] = localTime.split(':').map(Number);
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = localParts(guess, timeZone);
    const represented = Date.UTC(Number(actual.year), Number(actual.month) - 1, Number(actual.day), Number(actual.hour), Number(actual.minute));
    guess += Date.UTC(year, month - 1, day, hour, minute) - represented;
  }
  return new Date(guess).toISOString();
}
function nextOccurrence(routine, now) {
  const today = ymd(localParts(now, routine.timeZone));
  for (let offset = 0; offset <= 14 * Math.max(1, routine.intervalWeeks ?? 1); offset++) {
    const date = addDays(today, offset);
    if (weekday(date) !== routine.weekday) continue;
    const anchorWeeks = Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${routine.anchorDate}T12:00:00Z`)) / 604800000);
    if (anchorWeeks < 0 || anchorWeeks % (routine.intervalWeeks ?? 1) !== 0) continue;
    const dueAt = zonedInstant(date, routine.localTime, routine.timeZone);
    if (Date.parse(dueAt) >= Date.parse(now) - 86400000) return { occurrenceDate: date, dueAt };
  }
  return null;
}

export function createDailyWorkspaceService({ metadata, now = () => new Date().toISOString(), routines = [] } = {}) {
  if (!metadata?.recordOperation || !metadata?.listOperations) throw new Error('Daily workspace requires metadata operation ownership.');
  const operations = kind => metadata.listOperations().filter(row => row.operationKind === kind).map(row => ({ row, value: parse(row) })).filter(item => item.value);
  const commit = (operationKind, input, entityId, result, expectedRevision) => {
    if (typeof metadata.commitDailyWorkspaceOperation !== 'function') throw new Error('Daily workspace atomic mutation ownership is unavailable.');
    const row = metadata.commitDailyWorkspaceOperation({ logicalOperationId: input.logicalOperationId, intentDigest: digest(input), operationKind, entityId, ...(expectedRevision === undefined ? {} : { expectedRevision }), result, createdAt: now() });
    const committed = parse(row); if (!committed) throw new Error('Daily workspace operation receipt is unreadable.'); return committed;
  };
  const service = {
    metadata, routines,
    publishBriefing(input) {
      if (input?.schemaVersion !== 1) throw new Error('schemaVersion must be 1.');
      const value = { schemaVersion: 1, briefingId: nonBlank(input.briefingId, 'briefingId'), editionId: nonBlank(input.editionId, 'editionId'), title: nonBlank(input.title, 'title'), publishedAt: iso(input.publishedAt, 'publishedAt'), priority: Number.isSafeInteger(input.priority) ? input.priority : 0, summary: nonBlank(input.summary, 'summary'), source: { kind: 'session', sessionKey: nonBlank(input.source?.sessionKey, 'source.sessionKey') } };
      return commit('daily-workspace.briefing.publish', input, value.editionId, value);
    },
    setBriefingRead(input) {
      if (input?.schemaVersion !== 1 || typeof input.read !== 'boolean') throw new Error('A read decision is required.');
      const editionId = nonBlank(input.editionId, 'editionId');
      if (!operations('daily-workspace.briefing.publish').some(({ value }) => value.editionId === editionId)) throw new Error('Briefing edition was not found.');
      const value = { schemaVersion: 1, editionId, read: input.read, decidedAt: now() }; return commit('daily-workspace.briefing.read', input, editionId, value);
    },
    decideRoutine(input) {
      if (input?.schemaVersion !== 1 || !['complete', 'defer'].includes(input.action)) throw new Error('Routine action is invalid.');
      if (metadata.getOperation?.(input.logicalOperationId)) return commit('daily-workspace.routine.decision', input, `${input.routineId}:${input.occurrenceDate}`, { schemaVersion: 1 }, input.expectedRevision);
      const routine = routines.find(item => item.id === input.routineId); if (!routine) throw new Error('Routine was not found.');
      const occurrence = nextOccurrence(routine, now());
      if (!occurrence || occurrence.occurrenceDate !== input.occurrenceDate || Date.parse(now()) < Date.parse(occurrence.dueAt) - (routine.preparationHours ?? 24) * 3600000) throw new Error('The exact visible routine occurrence was not found.');
      const value = { schemaVersion: 1, routineId: input.routineId, occurrenceDate: input.occurrenceDate, action: input.action, ...(input.action === 'defer' ? { until: iso(input.until, 'until') } : {}), decidedAt: now() };
      return commit('daily-workspace.routine.decision', input, `${input.routineId}:${input.occurrenceDate}`, value, input.expectedRevision);
    },
    get({ includeRead = false } = {}) {
      const read = new Map(); for (const { value } of operations('daily-workspace.briefing.read')) if (!read.has(value.editionId) || (read.get(value.editionId).sequence ?? 0) < (value.sequence ?? 0)) read.set(value.editionId, value);
      const byEdition = new Map(); for (const { value } of operations('daily-workspace.briefing.publish')) byEdition.set(value.editionId, value);
      const history = [...byEdition.values()].map(value => ({ ...value, read: read.get(value.editionId)?.read === true })).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      const briefings = history.filter(value => includeRead || !value.read).sort((a, b) => b.priority - a.priority || b.publishedAt.localeCompare(a.publishedAt));
      const decisions = new Map(); for (const { value } of operations('daily-workspace.routine.decision')) { const key = `${value.routineId}:${value.occurrenceDate}`; if (!decisions.has(key) || (decisions.get(key).revision ?? 0) < (value.revision ?? 0)) decisions.set(key, value); }
      const current = now(); const routineOccurrences = [];
      for (const routine of routines) {
        const occurrence = nextOccurrence(routine, current); if (!occurrence) continue;
        const visibleAt = new Date(Date.parse(occurrence.dueAt) - (routine.preparationHours ?? 24) * 3600000).toISOString(); if (Date.parse(current) < Date.parse(visibleAt)) continue;
        const decision = decisions.get(`${routine.id}:${occurrence.occurrenceDate}`); if (decision?.action === 'complete' || decision?.action === 'defer' && Date.parse(current) < Date.parse(decision.until)) continue;
        const weeks = Math.floor((Date.parse(`${occurrence.occurrenceDate}T12:00:00Z`) - Date.parse(`${routine.anchorDate}T12:00:00Z`)) / 604800000);
        const variant = Array.isArray(routine.variants) && routine.variants.length ? routine.variants[((weeks % routine.variants.length) + routine.variants.length) % routine.variants.length] : null;
        routineOccurrences.push({ schemaVersion: 1, routineId: routine.id, occurrenceDate: occurrence.occurrenceDate, title: variant ? `${routine.title}: ${variant}` : routine.title, ...(variant ? { variant } : {}), topicId: routine.topicId, sourceReferenceId: routine.sourceReferenceId, dueAt: occurrence.dueAt, visibleAt, priority: routine.priority ?? 0, revision: decision?.revision ?? 0, actions: ['complete', 'defer'] });
      }
      return Object.freeze({ schemaVersion: 1, briefings: Object.freeze(briefings), briefingHistory: Object.freeze(history), routineOccurrences: Object.freeze(routineOccurrences) });
    }
  };
  return Object.freeze(service);
}
