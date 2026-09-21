import { createHash } from 'node:crypto';

function operationId(context, toolCallId) {
  const hex = createHash('sha256').update(['command-center.briefing.v1', context.sessionKey ?? '', context.sessionId ?? '', toolCallId ?? ''].join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function briefingPublishToolFactory({ getOwner } = {}) {
  return (context = {}) => ({
    name: 'command_center_publish_briefing',
    description: 'Save one completed briefing edition in the Command Center reading list. Call once after the report is complete; do not create an Attention item for informational sections.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, required: ['briefingId', 'editionId', 'title', 'publishedAt', 'priority', 'summary'], properties: { briefingId: { type: 'string', minLength: 1 }, editionId: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 }, publishedAt: { type: 'string' }, priority: { type: 'integer', minimum: 0, maximum: 100 }, summary: { type: 'string', minLength: 1, maxLength: 2000 } } }),
    async execute(toolCallId, params) {
      const owner = getOwner?.(); if (!owner || !context.sessionKey) throw new Error('Briefing publication requires an active native report session.');
      const value = owner.publishBriefing({ schemaVersion: 1, logicalOperationId: operationId(context, toolCallId), ...params, source: { kind: 'session', sessionKey: context.sessionKey } });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: 'saved', editionId: value.editionId }) }], details: value });
    }
  });
}
