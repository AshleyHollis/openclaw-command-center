import { sourceError } from '../sources/errors.mjs';

export function topicAnalysisToolFactory({ run } = {}) {
  if (typeof run !== 'function') throw new TypeError('Topic Analysis tool requires a runner.');
  return () => Object.freeze({
    name: 'command_center_topic_analysis',
    description: 'Run one bounded Command Center Topic Analysis and return its pull-based review result.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {} }),
    async execute(_toolCallId, params = {}) {
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length) throw sourceError('invalid-request', 'Topic Analysis does not accept tool parameters.');
      const result = await run({ trigger: 'weekly' });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    }
  });
}
