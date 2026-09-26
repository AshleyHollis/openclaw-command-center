import { createHash } from 'node:crypto';

const humanEvents = new Set(['human_input_required', 'product_decision_required', 'approval_required', 'feature_ready_for_review']);

function operationId(context, toolCallId) {
  if (typeof toolCallId !== 'string' || !toolCallId.trim()) throw new TypeError('Developer Work requires a stable tool call ID.');
  const hex = createHash('sha256').update(['command-center.developer-work.v1', context.sessionKey, context.sessionId, toolCallId].join('\u0000')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function developerWorkToolFactory({ getOwner, sessionReader, allowedAgentIds = [] } = {}) {
  if (typeof getOwner !== 'function' || typeof sessionReader !== 'function') throw new TypeError('Developer Work tool requires the DEV owner and public session reader.');
  return (toolContext = {}) => ({
    name: 'command_center_report_developer_work',
    description: 'Record one bounded DEV work request or aggregate outcome for LIVE Attention. Use only for a genuine human input, product decision, approval, review request, explicit request resolution/withdrawal, or completed feature/validation. Ordinary coding progress, commits and passing tests stay on DEV. This tool reports evidence; it does not answer a request or authorize deployment.',
    parameters: Object.freeze({
      type: 'object', additionalProperties: false,
      required: ['workId', 'eventType', 'context'],
      properties: {
        workId: { type: 'string', minLength: 1, maxLength: 128 },
        eventType: { enum: ['human_input_required', 'product_decision_required', 'approval_required', 'feature_ready_for_review', 'request_resolved', 'request_withdrawn', 'feature_completed', 'validation_completed'] },
        context: { type: 'object', additionalProperties: false, required: ['projectAlias'], properties: {
          projectAlias: { type: 'string', minLength: 1, maxLength: 80 }, repository: { type: 'string', maxLength: 128 }, issue: { type: 'string', maxLength: 128 }, pullRequest: { type: 'string', maxLength: 128 }, phase: { enum: ['investigating', 'implementing', 'validating', 'waiting', 'reviewing', 'deploying', 'completed', 'failed', 'cancelled'] }, candidateId: { type: 'string', maxLength: 128 }, originatingWorkId: { type: 'string', maxLength: 128 }
        } },
        request: { type: 'object', additionalProperties: false, required: ['requestId', 'kind', 'expectedRequestRevision'], properties: {
          requestId: { type: 'string', minLength: 1, maxLength: 128 }, kind: { enum: ['input', 'product-decision', 'approval', 'review'] }, expectedRequestRevision: { type: 'integer', minimum: 0 }, summary: { type: 'string', maxLength: 160 }, question: { type: 'string', maxLength: 1000 }, choices: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 120 } }, expiresAt: { type: 'string' }
        } },
        outcome: { type: 'object', additionalProperties: false, required: ['code'], properties: {
          code: { enum: ['answered', 'approved', 'reviewed', 'recovered', 'withdrawn', 'cancelled', 'invalidated', 'completed', 'validated'] }, requestId: { type: 'string', maxLength: 128 }, candidateId: { type: 'string', maxLength: 128 }
        } }
      }
    }),
    async execute(toolCallId, params) {
      const owner = getOwner();
      if (!owner) throw Object.assign(new Error('DEV Developer Work owner is not active.'), { code: 'capability-unavailable' });
      const sessionKey = toolContext.sessionKey;
      const sessionId = toolContext.sessionId;
      const agentId = toolContext.agentId ?? /^agent:([^:]+):/u.exec(sessionKey ?? '')?.[1];
      if (typeof sessionKey !== 'string' || !sessionKey || typeof sessionId !== 'string' || !sessionId || typeof agentId !== 'string' || !allowedAgentIds.includes(agentId)) throw Object.assign(new Error('An admitted exact DEV agent session is required.'), { code: 'unauthorized' });
      const readInput = { agentId, sessionKey, readConsistency: 'latest' };
      const entry = await sessionReader(readInput);
      if (!entry || entry.sessionId !== sessionId || typeof entry.lifecycleRevision !== 'string' || !entry.lifecycleRevision) throw Object.assign(new Error('The DEV session incarnation changed.'), { code: 'session-stale' });
      const binding = { agentId, sessionKey, sessionId, lifecycleRevision: entry.lifecycleRevision };
      const draft = {
        schemaVersion: 1, workId: params.workId, eventType: params.eventType, context: params.context,
        ...(params.request ? { request: params.request } : {}),
        ...(params.outcome ? { outcome: params.outcome } : {}),
        ...(params.request && (humanEvents.has(params.eventType) || params.eventType.startsWith('request_')) ? { session: binding } : {})
      };
      const assertSourceCurrent = expected => {
        const current = sessionReader(readInput);
        if (!current || typeof current.then === 'function' || current.sessionId !== expected.sessionId || current.lifecycleRevision !== expected.lifecycleRevision) throw Object.assign(new Error('The DEV session changed before work was recorded.'), { code: 'session-stale' });
      };
      const result = await owner.submit({ logicalOperationId: operationId({ sessionKey, sessionId }, toolCallId), draft, assertSourceCurrent });
      return Object.freeze({
        content: [{ type: 'text', text: JSON.stringify({ status: result.deliveryState, eventId: result.eventId, workRevision: result.workRevision, requestId: result.event.request?.requestId ?? null }) }],
        details: { deliveryState: result.deliveryState, eventId: result.eventId, workRevision: result.workRevision }
      });
    }
  });
}
