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

export function interpretClarificationToolFactory({ interpret } = {}) {
  if (typeof interpret !== 'function') throw new TypeError('Targeted clarification requires its owning command.');
  return (context = {}) => ({
    name: 'command_center_interpret_clarification',
    description: 'Apply one clear item-specific decision or payment assertion to the exact saved clarification, or leave ambiguous words for review. Call only after loading the pending clarification; never reprocess siblings. A paid status is the user’s assertion, not independent payment evidence.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      loopId: { type: 'string', minLength: 1 }, expectedRevision: { type: 'integer', minimum: 1 },
      clarificationObservationId: { type: 'string', minLength: 1 }, processorVersion: { type: 'string', minLength: 1 },
      outcome: { type: 'string', enum: ['clear', 'ambiguous'] },
      decision: { type: 'string', enum: ['confirm', 'defer', 'dismiss', 'resolve', 'correct-date'] },
      paymentState: { type: 'string', enum: ['partially-paid', 'payment-pending', 'paid', 'disputed', 'cancelled', 'uncertain'] },
      paidAmount: { type: 'integer', minimum: 0 }, currency: { type: 'string', minLength: 3, maxLength: 3 },
      reviewAt: { type: 'string' }, dueAt: { type: 'string' }, dueDate: { type: 'string' }, dueTimeZone: { type: 'string' }
    }, required: ['loopId', 'expectedRevision', 'clarificationObservationId', 'processorVersion', 'outcome'] }),
    async execute(_toolCallId, params) {
      if (context.senderIsOwner !== true || typeof context.requesterSenderId !== 'string' || !context.requesterSenderId.trim())
        throw sourceError('unauthenticated', 'Targeted interpretation requires a trusted owner request.');
      const result = await interpret(params, { authenticatedRequesterId: context.requesterSenderId });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
    }
  });
}
