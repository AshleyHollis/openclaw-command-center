export function developerWorkFlushToolFactory({ getOwner } = {}) {
  if (typeof getOwner !== 'function') throw new TypeError('Developer Work flush tool requires its owner.');
  return () => ({
    name: 'command_center_flush_developer_work',
    description: 'Retry one bounded batch of already recorded DEV Developer Work deliveries. This creates no new work event and sends no chat message.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {} }),
    async execute(_toolCallId, params) {
      if (!params || Object.keys(params).length !== 0) throw Object.assign(new Error('Developer Work retry takes no arguments.'), { code: 'invalid-request' });
      const owner = getOwner();
      if (!owner) throw Object.assign(new Error('DEV Developer Work owner is not active.'), { code: 'capability-unavailable' });
      const result = await owner.flush();
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
    }
  });
}
