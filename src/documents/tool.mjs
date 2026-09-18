import { sourceError } from '../sources/errors.mjs';

function validate(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw sourceError('invalid-request', 'Attachment filing input must be an object.');
  for (const key of Object.keys(params)) if (!['mediaRef', 'subfolder'].includes(key)) throw sourceError('invalid-request', `Attachment filing input contains unsupported field: ${key}`);
  if (typeof params.mediaRef !== 'string' || !params.mediaRef.trim()) throw sourceError('invalid-request', 'mediaRef must be a managed attachment reference.');
  if (params.subfolder !== undefined && (typeof params.subfolder !== 'string' || !params.subfolder.trim())) throw sourceError('invalid-request', 'subfolder must be a non-empty relative path.');
  return params;
}

/** Actual model-callable entry point for permanent filing of a current Chat attachment. */
export function topicDocumentFileToolFactory({ file } = {}) {
  if (typeof file !== 'function') throw new TypeError('Topic document filing owner is required.');
  return (context = {}) => ({
    name: 'command_center_file_topic_attachment',
    description: 'Permanently file one managed attachment from this linked Topic Conversation. Use only an attachment reference supplied in the current Chat; optionally choose a safe Topic-relative subfolder.',
    parameters: Object.freeze({
      type: 'object', additionalProperties: false,
      properties: {
        mediaRef: { type: 'string', minLength: 1, description: 'The exact media://inbound attachment reference from this Chat.' },
        subfolder: { type: 'string', minLength: 1, description: 'Optional safe path below Documents, for example Case 2025-26.' },
      },
      required: ['mediaRef'],
    }),
    async execute(toolCallId, params) {
      const input = validate(params);
      if (typeof context.sessionKey !== 'string' || !context.sessionKey) throw sourceError('source-recovery', 'Attachment filing requires the exact active native Conversation.');
      const result = await file({ ...input, sessionKey: context.sessionKey, ...(context.sessionId ? { sessionId: context.sessionId } : {}), requestId: String(toolCallId ?? '') || undefined });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result.value ?? result) }], details: result.value ?? result });
    },
  });
}
