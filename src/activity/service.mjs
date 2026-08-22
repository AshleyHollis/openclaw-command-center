import { randomUUID } from 'node:crypto';
import { sourceError, nonBlank } from '../sources/errors.mjs';

export function createActivityService({ metadata } = {}) {
  return Object.freeze({
    record(input) {
      if (!metadata?.recordActivity) throw sourceError('capability-unavailable', 'Activity capability is unavailable.', { capability: 'activity' });
      return metadata.recordActivity({ activityId: input.activityId ?? `activity:${randomUUID()}`, ...input });
    },
    list(topicId) { return metadata?.listActivity?.(topicId) ?? []; }
  });
}
