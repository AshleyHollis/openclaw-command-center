import { loadPendingClarificationContext } from './clarification-context.mjs';
import { sourceError } from '../sources/errors.mjs';

export function pendingClarificationToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Pending clarification requires authoritative owners.');
  return () => ({
    name: 'command_center_get_pending_clarification',
    description: 'Load one saved item-specific clarification and its exact accepted intake outcome for targeted interpretation. Never reprocess the source or sibling outcomes.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      loopId: { type: 'string', minLength: 1 }, expectedRevision: { type: 'integer', minimum: 1 }
    }, required: ['loopId', 'expectedRevision'] }),
    async execute(_toolCallId, params) {
      const { metadata } = getOwners() ?? {};
      if (!metadata) throw sourceError('capability-unavailable', 'Pending clarification is not ready.');
      const result = loadPendingClarificationContext(metadata, params);
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
    }
  });
}
