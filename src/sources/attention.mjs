import { sourceError, assertNoUnexpectedKeys, nonBlank } from './errors.mjs';

export function createAttentionAdapter({ act, listActions } = {}) {
  return Object.freeze({
    act: typeof act === 'function' ? async (input) => {
      assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'requestId', 'attentionId', 'actionId', 'logicalOperationId'], 'Attention action request');
      nonBlank(input.attentionId, 'attentionId');
      nonBlank(input.actionId, 'actionId');
      if (typeof listActions === 'function') {
        const allowed = await listActions(input.attentionId);
        if (!Array.isArray(allowed) || !allowed.includes(input.actionId)) throw sourceError('invalid-action', 'The Attention action is not valid for this Attention Item.');
      }
      const result = await act(input);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw sourceError('unavailable', 'Attention provider returned an invalid result.');
      for (const key of Object.keys(result)) if (!['status', 'attentionId', 'actionId', 'observedRevision'].includes(key)) throw sourceError('unavailable', 'Attention provider returned an unsupported result field.');
      return Object.freeze({ ...result });
    } : async () => { throw sourceError('capability-unavailable', 'Attention capability is unavailable.', { capability: 'attention' }); }
  });
}
