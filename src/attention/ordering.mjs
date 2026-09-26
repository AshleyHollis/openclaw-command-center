import { severityRank } from './severity.mjs';
import { occurrenceInstant } from './contracts.mjs';

export function compareOccurrenceRows(left, right) {
  const instant = occurrenceInstant(right.occurred_at ?? right.occurredAt) - occurrenceInstant(left.occurred_at ?? left.occurredAt);
  if (instant !== 0n) return instant > 0n ? 1 : -1;
  return (right.created_at ?? right.createdAt).localeCompare(left.created_at ?? left.createdAt)
    || (right.insertion_order ?? right.insertionOrder) - (left.insertion_order ?? left.insertionOrder)
    || (right.occurrence_row_id ?? right.occurrenceRowId).localeCompare(left.occurrence_row_id ?? left.occurrenceRowId);
}

function compare(left, right) {
  const chronological = Date.parse(left.attentionSince) - Date.parse(right.attentionSince);
  if (chronological !== 0) return chronological;
  return left.episodeId.localeCompare(right.episodeId);
}

export function orderAttentionEpisodes(episodes, { now = new Date().toISOString() } = {}) {
  const presentable = episodes.filter((episode) => episode.state === 'Active' && !(episode.snoozedUntil && Date.parse(episode.snoozedUntil) > Date.parse(now)));
  const criticalOperational = presentable.filter((episode) => episode.severity === 'Critical' && episode.sourceKind !== 'reminder');
  const highOperational = presentable.filter((episode) => episode.severity === 'High' && episode.sourceKind !== 'reminder');
  const dueReminders = presentable.filter((episode) => episode.sourceKind === 'reminder' && episode.due === true);
  const routine = presentable.filter((episode) => episode.severity === 'Routine' && episode.sourceKind !== 'reminder');
  const buckets = [criticalOperational, highOperational, dueReminders, routine].map((bucket) => bucket.sort(compare));
  return Object.freeze({
    buckets: Object.freeze(buckets.map((bucket) => Object.freeze(bucket.map((episode) => ({ ...episode }))))),
    episodes: Object.freeze(buckets.flat().map((episode) => ({ ...episode })))
  });
}

export function compareAttention(left, right) {
  return compare(left, right) || severityRank(left.severity) - severityRank(right.severity);
}
