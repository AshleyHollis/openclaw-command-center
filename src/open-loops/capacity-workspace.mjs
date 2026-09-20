import { normalizeLoop } from './contracts.mjs';
import { zonedDateAtNine } from './reminder-coordinator.mjs';

const terminal = new Set(['resolved', 'cancelled']);
const rank = Object.freeze({ critical: 0, high: 1, normal: 2, low: 3 });
const day = value => value?.slice?.(0, 10);
const dateOf = loop => loop.dueAt ?? (loop.dueDate ? zonedDateAtNine(loop.dueDate, loop.dueTimeZone) : undefined);
const firstScheduledAt = loop => [dateOf(loop), loop.reviewAt, loop.attention?.plannedAt].filter(Boolean).sort()[0];
const compare = (left, right) => (rank[left.attention?.importance ?? 'normal'] - rank[right.attention?.importance ?? 'normal']) || (dateOf(left) ?? '9999').localeCompare(dateOf(right) ?? '9999') || left.loopId.localeCompare(right.loopId);
const compareScheduled = (left, right) => (firstScheduledAt(left) ?? '9999').localeCompare(firstScheduledAt(right) ?? '9999') || compare(left, right);
const ready = loop => ['confirmed'].includes(loop.state) && !(loop.attention?.dependencies?.length);
const decisionReasons = new Set(['decision-requested', 'response-requested', 'material-change', 'evidence-conflict', 'activated-blocker']);

function mandatoryGroups(mandatory, today) {
  const groups = { overdue: [], dueToday: [], decisions: [], reviews: [] };
  for (const loop of mandatory) {
    const due = day(dateOf(loop));
    if (due && due < today) groups.overdue.push(loop);
    else if (due === today) groups.dueToday.push(loop);
    else if (decisionReasons.has(loop.attention?.reason)) groups.decisions.push(loop);
    else groups.reviews.push(loop);
  }
  return Object.freeze(Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, Object.freeze(values)])));
}

export function projectCapacityWorkspace(input, { now = new Date().toISOString(), reviewLimit = 5, maxEffortMinutes, context, topicId, importance } = {}) {
  if (!Array.isArray(input) || !Number.isInteger(reviewLimit) || reviewLimit < 1 || reviewLimit > 25) throw new TypeError('capacity projection input is invalid');
  const loops = input.map(normalizeLoop);
  const today = day(now);
  const visible = loops.filter(loop => !terminal.has(loop.state));
  const mandatory = visible.filter(loop => {
    const due = dateOf(loop); const review = loop.reviewAt;
    return due && day(due) <= today || review && day(review) <= today || decisionReasons.has(loop.attention?.reason);
  }).sort(compareScheduled);
  const plannedToday = visible.filter(loop => day(loop.attention?.plannedAt) === today && !mandatory.some(item => item.loopId === loop.loopId)).sort(compare);
  const upcoming = visible.filter(loop => [dateOf(loop), loop.reviewAt, loop.attention?.plannedAt].some(value => value && day(value) > today)).sort(compareScheduled);
  const capacity = visible.filter(loop => ready(loop) && !loop.attention?.someday && !mandatory.some(item => item.loopId === loop.loopId) && !loop.attention?.plannedAt && !loop.reviewAt)
    .filter(loop => topicId === undefined || loop.topicId === topicId)
    .filter(loop => importance === undefined || (loop.attention?.importance ?? 'normal') === importance)
    .filter(loop => maxEffortMinutes === undefined || loop.attention?.effortMinutes !== undefined && loop.attention.effortMinutes <= maxEffortMinutes)
    .filter(loop => context === undefined || loop.attention?.contexts?.includes(context))
    .sort(compare);
  const waiting = visible.filter(loop => ['waiting', 'monitoring', 'uncertain'].includes(loop.state) || loop.attention?.dependencies?.length).sort(compare);
  const suggestions = visible.filter(loop => loop.state === 'suggested').sort(compare);
  const reviewEligible = visible.filter(loop => (ready(loop) || loop.state === 'suggested') && !loop.reviewAt && !loop.attention?.someday)
    .sort((left, right) => (left.attention?.lastConsideredAt ?? '0000').localeCompare(right.attention?.lastConsideredAt ?? '0000') || compare(left, right));
  const reviewBatch = reviewEligible.slice(0, reviewLimit);
  const someday = visible.filter(loop => loop.attention?.someday).sort(compare);
  const board = Object.freeze({
    ready: Object.freeze(visible.filter(loop => ready(loop)).sort(compare)),
    doing: Object.freeze(visible.filter(loop => loop.state === 'action-running').sort(compare)),
    waiting: Object.freeze(waiting),
    done: Object.freeze(loops.filter(loop => terminal.has(loop.state)).sort(compare)),
    suggestions: Object.freeze(suggestions)
  });
  const agenda = visible.flatMap(loop => [
    ...(dateOf(loop) ? [{ kind: 'deadline', at: dateOf(loop), loop }] : []),
    ...(loop.reviewAt ? [{ kind: 'review', at: loop.reviewAt, loop }] : []),
    ...(loop.attention?.plannedAt ? [{ kind: 'planned', at: loop.attention.plannedAt, loop }] : [])
  ]).sort((left, right) => left.at.localeCompare(right.at) || left.loop.loopId.localeCompare(right.loop.loopId));
  return Object.freeze({ schemaVersion: 1, now, today: Object.freeze({ mandatory: Object.freeze(mandatory), mandatoryTotal: mandatory.length, groups: mandatoryGroups(mandatory, today), planned: Object.freeze(plannedToday) }), upcoming: Object.freeze(upcoming), capacity: Object.freeze(capacity), waiting: Object.freeze(waiting), review: Object.freeze({ batch: Object.freeze(reviewBatch), remaining: reviewEligible.length - reviewBatch.length, eligibleTotal: reviewEligible.length }), someday: Object.freeze(someday), board, agenda: Object.freeze(agenda) });
}

export function planOrganizationChange(loopInput, input) {
  const loop = normalizeLoop(loopInput);
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1) throw new TypeError('organization action is invalid');
  const allowed = ['schemaVersion', 'action', 'importance', 'plannedAt', 'reviewAt', 'effortMinutes', 'contexts', 'dependencies', 'updatedAt'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new TypeError('organization action contains unsupported fields');
  const action = input.action;
  if (!['plan', 'keep', 'review-later', 'someday', 'drop', 'start', 'wait', 'reopen', 'complete', 'set-priority'].includes(action)) throw new TypeError('organization action is unsupported');
  if (action === 'complete' && loop.kind !== 'general') throw new TypeError('rich obligations require their specific outcome flow');
  const attention = { ...(loop.attention ?? {}), importance: loop.attention?.importance ?? 'normal', importanceOrigin: loop.attention?.importanceOrigin ?? 'processing', contexts: loop.attention?.contexts ?? [], dependencies: loop.attention?.dependencies ?? [], activated: loop.attention?.activated === true, currentEvidence: loop.attention?.currentEvidence === true, actions: loop.attention?.actions ?? [], someday: loop.attention?.someday === true, lastConsideredAt: input.updatedAt };
  if (action === 'set-priority') { attention.importance = input.importance; attention.importanceOrigin = 'user'; }
  if (action === 'plan') { attention.plannedAt = input.plannedAt; attention.someday = false; }
  if (action === 'review-later') { attention.someday = false; }
  if (action === 'someday') { attention.someday = true; delete attention.plannedAt; }
  if (input.effortMinutes !== undefined) attention.effortMinutes = input.effortMinutes;
  if (input.contexts !== undefined) attention.contexts = input.contexts;
  if (input.dependencies !== undefined) attention.dependencies = input.dependencies;
  const state = action === 'drop' ? 'cancelled' : action === 'start' ? 'action-running' : action === 'wait' ? 'waiting' : action === 'complete' ? 'resolved' : action === 'reopen' ? 'confirmed' : loop.state === 'suggested' && ['plan', 'keep', 'review-later'].includes(action) ? 'confirmed' : loop.state;
  return normalizeLoop({ ...loop, state, ...(action === 'review-later' ? { reviewAt: input.reviewAt } : {}), attention, revision: loop.revision + 1 });
}
