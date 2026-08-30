import { sourceError } from './errors.mjs';

export function unavailableAnalysis() {
  throw sourceError('capability-unavailable', 'Topic Analysis capability is unavailable.', { capability: 'analysis' });
}
export function createAnalysisAdapter({ provider, topicId } = {}) {
  const request = (input) => {
    if (!input?.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw sourceError('invalid-request', 'Topic Analysis input must be an object.');
    if (Object.keys(input.input).length !== 0) throw sourceError('invalid-request', 'Topic Analysis input does not support caller-defined fields.');
    return { ...input, topicId };
  };
  const normalize = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('unavailable', 'Topic Analysis provider returned an invalid result.');
    for (const key of Object.keys(value)) if (!['status', 'analysisId', 'observedRevision'].includes(key)) throw sourceError('unavailable', 'Topic Analysis provider returned an unsupported result field.');
    if (typeof value.status !== 'string' || value.status.trim() === '') throw sourceError('unavailable', 'Topic Analysis provider returned no status.');
    return Object.freeze({ ...value });
  };
  return Object.freeze({
    status: typeof provider?.status === 'function' ? async (input = {}) => normalize(await provider.status({ ...input, topicId })) : unavailableAnalysis,
    run: typeof provider?.run === 'function' ? async (input = {}) => normalize(await provider.run(request(input))) : unavailableAnalysis
  });
}
