import { sourceError } from '../sources/errors.mjs';

const toolFields = Object.freeze(['query', 'targetTopicId', 'crossTopicBasis', 'limit']);
function validateToolInput(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw sourceError('invalid-request', 'Topic context input must be an object.');
  for (const key of Object.keys(params)) if (!toolFields.includes(key)) throw sourceError('invalid-request', `Topic context input contains unsupported field: ${key}`);
  if (typeof params.query !== 'string' || params.query.trim() === '' || params.query.trim().length > 256) throw sourceError('invalid-request', 'query must be 1–256 UTF-16 code units.');
  if (params.targetTopicId !== undefined && (typeof params.targetTopicId !== 'string' || params.targetTopicId.trim() === '')) throw sourceError('invalid-request', 'targetTopicId must be a non-blank string.');
  if (params.crossTopicBasis !== undefined && !['explicit-reference', 'task-necessity'].includes(params.crossTopicBasis)) throw sourceError('invalid-request', 'crossTopicBasis is unsupported.');
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 8)) throw sourceError('invalid-request', 'limit must be an integer between 1 and 8.');
  return params;
}

export function createTopicContextTool({ policy } = {}) {
  if (!policy?.retrieve) throw new TypeError('Topic context policy is required');
  return Object.freeze({
    name: 'command_center_topic_context',
    description: 'Retrieve bounded lexical excerpts from the current Topic, or a justified explicitly referenced Topic.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', minLength: 1, maxLength: 256 }, targetTopicId: { type: 'string', minLength: 1 },
      crossTopicBasis: { type: 'string', enum: ['explicit-reference', 'task-necessity'] }, limit: { type: 'integer', minimum: 1, maximum: 8 }
    }, required: ['query'] }),
    async execute(_toolCallId, params) {
      const result = await policy.retrieve({ ...validateToolInput(params), sessionKey: this?.sessionKey });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    }
  });
}

export function topicContextToolFactory(policy) {
  return (context) => {
    const tool = createTopicContextTool({ policy });
    return Object.freeze({ ...tool, execute: async (_toolCallId, params) => {
      const result = await policy.retrieve({ ...validateToolInput(params), sessionKey: context?.sessionKey });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } });
  };
}
