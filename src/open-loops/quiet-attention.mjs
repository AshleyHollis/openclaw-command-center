import { normalizeLoop } from './contracts.mjs';

const terminal = new Set(['resolved', 'cancelled']);

function instant(value, label) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be a valid instant`);
  return result;
}

function explain(loop, reason) {
  if (loop.attention?.whyNow) return loop.attention.whyNow;
  if (reason === 'overdue') return `${loop.title} is past its accepted due date.`;
  if (reason === 'due-window') return `${loop.title} is approaching its accepted due date.`;
  if (reason === 'response-requested') return `${loop.title} needs a response.`;
  if (reason === 'decision-requested') return `${loop.title} needs a decision.`;
  if (reason === 'material-change') return `${loop.title} has materially changed evidence to review.`;
  if (reason === 'activated-blocker') return `${loop.title} blocks an active stage.`;
  return `${loop.title} has conflicting evidence to reconcile.`;
}

export function projectQuietAttention(input, { now = new Date().toISOString(), leadTimeMs = 3 * 24 * 60 * 60 * 1000 } = {}) {
  const loop = normalizeLoop(input);
  const nowMs = instant(now, 'now');
  if (!Number.isSafeInteger(leadTimeMs) || leadTimeMs < 0) throw new TypeError('leadTimeMs must be a non-negative safe integer');
  if (terminal.has(loop.state)) return Object.freeze({ group: 'terminal', loop });
  if (loop.state === 'action-running') return Object.freeze({ group: 'in-progress', loop });
  if (loop.state === 'suggested') return Object.freeze({ group: 'suggested', loop });

  const dueMs = loop.dueAt === undefined ? undefined : instant(loop.dueAt, 'dueAt');
  const explicitReason = loop.attention?.reason;
  const historicalOnly = loop.attention && loop.attention.currentEvidence !== true;
  let reason;
  if (explicitReason && ['response-requested', 'decision-requested', 'material-change', 'activated-blocker', 'evidence-conflict'].includes(explicitReason)) reason = explicitReason;
  else if (dueMs !== undefined && dueMs < nowMs) reason = 'overdue';
  else if (dueMs !== undefined && dueMs - nowMs <= leadTimeMs) reason = 'due-window';

  const actions = loop.attention?.actions ?? [];
  const actionable = reason !== undefined && actions.length > 0 && !historicalOnly;
  if (actionable) return Object.freeze({ group: 'attention', reason, whyNow: explain(loop, reason), actions, loop });
  if (dueMs !== undefined && dueMs >= nowMs) return Object.freeze({ group: 'coming-up', dueAt: loop.dueAt, loop });
  if (loop.reviewAt !== undefined && instant(loop.reviewAt, 'reviewAt') > nowMs) return Object.freeze({ group: 'deferred', reviewAt: loop.reviewAt, loop });
  return Object.freeze({ group: loop.state === 'uncertain' ? 'reconciliation' : 'waiting', loop });
}

export function projectQuietInbox(loops, options = {}) {
  if (!Array.isArray(loops)) throw new TypeError('loops must be an array');
  const groups = { attention: [], inProgress: [], comingUp: [], waiting: [], suggested: [], deferred: [], reconciliation: [], terminal: [] };
  for (const candidate of loops) {
    const projected = projectQuietAttention(candidate, options);
    const key = ({ 'in-progress': 'inProgress', 'coming-up': 'comingUp' })[projected.group] ?? projected.group;
    groups[key].push(projected);
  }
  const byDue = (left, right) => Date.parse(left.loop.dueAt ?? '9999-12-31T23:59:59Z') - Date.parse(right.loop.dueAt ?? '9999-12-31T23:59:59Z') || left.loop.loopId.localeCompare(right.loop.loopId);
  groups.attention.sort(byDue);
  groups.comingUp.sort(byDue);
  return Object.freeze(Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, Object.freeze(value)])));
}

