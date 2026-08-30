import { sourceError, assertNoUnexpectedKeys, nonBlank } from './errors.mjs';

export function createAttentionAdapter({ act, ingest, list, get, listActions } = {}) {
  return Object.freeze({
    act: typeof act === 'function' ? async (input) => {
      assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'requestId', 'sourceReferenceId', 'episodeId', 'expectedEpisodeRevision', 'expectedSourceRevision', 'actionId', 'input', 'approvalId', 'logicalOperationId', 'authenticatedOperatorId'], 'Attention action request');
      nonBlank(input.episodeId, 'episodeId');
      nonBlank(input.actionId, 'actionId');
      if (typeof listActions === 'function') {
        const allowed = await listActions(input.episodeId);
        if (!Array.isArray(allowed) || !allowed.includes(input.actionId)) throw sourceError('invalid-action', 'The Attention action is not valid for this Attention Item.');
      }
      const result = await act(input);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw sourceError('unavailable', 'Attention provider returned an invalid result.');
      for (const key of Object.keys(result)) if (!['schemaVersion', 'status', 'episode', 'attempt', 'activity', 'navigation', 'approval'].includes(key)) throw sourceError('unavailable', 'Attention provider returned an unsupported result field.');
      return Object.freeze({ ...result });
    } : async () => { throw sourceError('capability-unavailable', 'Attention capability is unavailable.', { capability: 'attention' }); },
    ingest: typeof ingest === 'function' ? ingest : async () => { throw sourceError('capability-unavailable', 'Attention capability is unavailable.', { capability: 'attention' }); },
    list: typeof list === 'function' ? list : () => ({ schemaVersion: 1, revision: 0, buckets: [[], [], [], []], episodes: [] }),
    get: typeof get === 'function' ? get : () => ({ schemaVersion: 1, revision: 0, episode: null })
  });
}
