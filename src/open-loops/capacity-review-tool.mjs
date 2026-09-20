import { sourceError } from '../sources/errors.mjs';

export function capacityReviewToolFactory({ getOwner } = {}) {
  if (typeof getOwner !== 'function') throw new TypeError('Capacity review tool requires its authoritative owner.');
  return () => ({
    name: 'command_center_open_capacity_review',
    description: 'Open or reconcile the single scheduled Command Center capacity review. Use only from its owned native schedule.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {} }),
    async execute() {
      const owner = getOwner();
      if (!owner) throw sourceError('capability-unavailable', 'Capacity review scheduling is not configured.');
      const result = await owner.wake();
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
    }
  });
}
