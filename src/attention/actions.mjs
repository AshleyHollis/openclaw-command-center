import { validateActionDescriptor } from './contracts.mjs';

export function createActionRegistry() {
  const descriptors = new Map();
  return Object.freeze({
    register(descriptor) {
      const value = validateActionDescriptor(descriptor);
      if (descriptors.has(value.actionId)) throw new TypeError(`Action descriptor already registered: ${value.actionId}`);
      descriptors.set(value.actionId, value);
      return value;
    },
    get(actionId) { return descriptors.get(actionId) ?? null; },
    list() { return [...descriptors.values()]; },
    forEpisode(episode) {
      const values = typeof episode.actionIds?.[Symbol.iterator] === 'function'
        ? [...episode.actionIds].map((id) => descriptors.get(id)).filter(Boolean)
        : [...descriptors.values()].filter((descriptor) => descriptor.targetResolver(episode) !== null);
      if (values.length > 3) throw new Error('An Attention episode cannot expose more than three actions');
      return values;
    }
  });
}

export const createActionDescriptorRegistry = createActionRegistry;
