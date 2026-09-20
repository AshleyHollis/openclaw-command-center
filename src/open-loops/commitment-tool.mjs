import { createHash, randomUUID } from 'node:crypto';
import { createCommitmentCaptureService } from './commitment-capture.mjs';
import { sourceError } from '../sources/errors.mjs';

function operationId(context, toolCallId) {
  if (typeof toolCallId !== 'string' || !toolCallId.trim()) return randomUUID();
  const hex = createHash('sha256').update(['command-center.capture.v1', context.sessionKey ?? '', context.sessionId ?? '', toolCallId].join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function commitmentCaptureToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Commitment capture requires authoritative owners.');
  return (context = {}) => ({
    name: 'command_center_capture_commitment',
    description: 'Capture one explicit commitment or one bounded suggestion for the current Topic. Use explicit only when the user directly asks to add or do it. Quoted, hypothetical and vague text must be captured as quoted or idea, never as a confirmed commitment.',
    parameters: Object.freeze({
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1 }, obligationId: { type: 'string', minLength: 1 },
        provenance: { type: 'string', enum: ['explicit', 'inferred', 'idea', 'quoted'] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
        dueAt: { type: 'string' }, reviewAt: { type: 'string' }, plannedAt: { type: 'string' },
        importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'] }, importanceOrigin: { type: 'string', enum: ['source', 'processing'] },
        effortMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, contexts: { type: 'array', items: { type: 'string' }, maxItems: 8 }, dependencies: { type: 'array', items: { type: 'string' }, maxItems: 16 },
        sourceKind: { type: 'string', enum: ['chat', 'note', 'email'] }, sourceExternalId: { type: 'string' }, sourceVersion: { type: 'string' }, sourceReferenceId: { type: 'string' }
      },
      required: ['title', 'obligationId', 'provenance']
    }),
    async execute(toolCallId, params) {
      const { sourceService, metadata } = getOwners() ?? {};
      if (!sourceService || !metadata) throw sourceError('capability-unavailable', 'Commitment capture ownership is not ready.');
      if (!context.sessionKey) throw sourceError('source-recovery', 'Commitment capture requires an exact active native Conversation.');
      const binding = await sourceService.sessionTopicContext({ sessionKey: context.sessionKey });
      if (binding.status !== 'bound' || (context.sessionId && binding.sessionId !== context.sessionId)) throw sourceError('source-recovery', 'The active Conversation is not exactly linked to a Topic.');
      const now = new Date().toISOString();
      const sourceKind = params.sourceKind ?? 'chat';
      if (sourceKind !== 'chat' && !params.sourceReferenceId) throw sourceError('source-recovery', 'Note and email capture require an exact Topic Source Reference.');
      const capture = createCommitmentCaptureService({ metadata, sourceService });
      const result = await capture.capture({ schemaVersion: 1, logicalOperationId: operationId(context, toolCallId), sourceKind, sourceExternalId: params.sourceExternalId ?? context.sessionKey, sourceVersion: params.sourceVersion ?? context.sessionId ?? 'current', ...(params.sourceReferenceId ? { sourceReferenceId: params.sourceReferenceId } : {}), topicId: binding.topicId, title: params.title, obligationId: params.obligationId, provenance: params.provenance, ...(params.confidence === undefined ? {} : { confidence: params.confidence }), occurredAt: now, observedAt: now, historicalBaseline: false, ...Object.fromEntries(['dueAt', 'reviewAt', 'plannedAt', 'importance', 'importanceOrigin', 'effortMinutes', 'contexts', 'dependencies'].flatMap(key => params[key] === undefined ? [] : [[key, params[key]]])) });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: result.disposition, loopId: result.loop?.loopId, state: result.loop?.state }) }], details: result });
    }
  });
}
