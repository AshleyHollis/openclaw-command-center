import { sourceError } from '../sources/errors.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { createNoteMaintenanceService } from './notes.mjs';

function stableOperationId(context, toolCallId) {
  if (isCanonicalUuid(toolCallId)) return toolCallId.toLowerCase();
  if (typeof toolCallId !== 'string' || toolCallId.trim() === '') return randomUUID();
  // Native providers use opaque tool-call identifiers. Keep that identifier as
  // transport evidence, but derive the UUID-shaped durable operation identity
  // required by mutation/recovery owners. The binding prevents two Sessions
  // that happen to reuse an opaque provider ID from sharing an operation.
  const hex = createHash('sha256')
    .update(['command-center.note-maintenance.v1', context.sessionKey ?? '', context.sessionId ?? '', toolCallId].join('\0'))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 0x3 | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function topicNoteMaintenanceToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Topic Note maintenance requires authoritative source owners.');
  return (context = {}) => ({
    name: 'command_center_update_working_note',
    description: 'Create or update one working Markdown Note for the current linked Topic after meaningful work. Preserve prior factual content, corrections and open questions. Never use this for another Topic.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: { path: { type: 'string', minLength: 1 }, text: { type: 'string' } }, required: ['path', 'text'] }),
    async execute(toolCallId, params) {
      const { sourceService, metadata } = getOwners() ?? {};
      if (!sourceService) throw sourceError('capability-unavailable', 'Topic Note maintenance source ownership is not ready.');
      if (!metadata) throw sourceError('capability-unavailable', 'Topic Note maintenance metadata ownership is not ready.');
      const maintenance = createNoteMaintenanceService({ sourceService, metadata });
      if (!context.sessionKey) throw sourceError('source-recovery', 'Working Note maintenance requires the exact active native Conversation.');
      const binding = await sourceService.sessionTopicContext({ sessionKey: context.sessionKey });
      if (binding.status !== 'bound' || (context.sessionId && binding.sessionId !== context.sessionId)) throw sourceError('source-recovery', 'The active Conversation is not exactly linked to a writable Topic.');
      const catalog = await sourceService.notesBrowse({ topicId: binding.topicId, includeDocuments: false, limit: 100, offset: 0 });
      const entries = catalog.notes.filter(note => note.path === params.path && note.sourceReference?.sourceKind === 'note');
      if (entries.length > 1) throw sourceError('source-recovery', 'The requested working Note has ambiguous current Topic ownership.');
      const operation = {
        topicId: binding.topicId,
        path: params.path,
        text: params.text,
        logicalOperationId: stableOperationId(context, toolCallId),
        ...(typeof toolCallId === 'string' && toolCallId.trim() ? { requestId: toolCallId } : {})
      };
      const result = entries.length === 0
        ? await maintenance.create(operation)
        : await maintenance.run({ ...operation, referenceId: entries[0].sourceReference.referenceId, expectedRevision: entries[0].revision });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
    }
  });
}
