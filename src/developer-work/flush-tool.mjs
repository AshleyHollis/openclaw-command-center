export function developerWorkFlushToolFactory({ getOwner } = {}) {
  if (typeof getOwner !== 'function') throw new TypeError('Developer Work flush tool requires its owner.');
  return () => ({
    name: 'command_center_flush_developer_work',
    description: 'Retry one bounded batch of already recorded DEV Developer Work deliveries. This creates no new work event and sends no chat message.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: { resumePaused: { type: 'boolean', description: 'Explicitly retry paused authentication or schema failures after the receiver problem has been corrected.' } } }),
    async execute(_toolCallId, params) {
      if (!params || Object.keys(params).some(key => key !== 'resumePaused') || params.resumePaused !== undefined && typeof params.resumePaused !== 'boolean') throw Object.assign(new Error('Developer Work retry parameters are invalid.'), { code: 'invalid-request' });
      const owner = getOwner();
      if (!owner) throw Object.assign(new Error('DEV Developer Work owner is not active.'), { code: 'capability-unavailable' });
      const result = await owner.flush({ resumePaused: params.resumePaused === true });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
    }
  });
}
