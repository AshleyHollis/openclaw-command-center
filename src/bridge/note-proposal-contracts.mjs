export const NOTE_PROPOSAL_METHODS = Object.freeze(['prepare', 'context', 'publish', 'inspect', 'discard'].map(action => `command-center.v1.notes.proposals.${action}`));
const string = { type: 'string' };
const object = properties => ({ type: 'object', additionalProperties: false, properties });
const descriptor = object({ referenceId: string, path: string, revision: string });
const snapshot = object({ ...descriptor.properties, text: string });
export const NOTE_PROPOSAL_PARAMS = Object.freeze({
  generation: { type: 'integer', const: 1 }, expectedTopicRevision: { type: 'integer', minimum: 0 }, target: descriptor,
  sources: { type: 'array', items: descriptor }, panel: object({ sessionKey: string, sessionId: string, referenceId: string }),
  basisDigest: string, proposedText: string, citations: { type: 'array', items: object({ referenceId: string, revision: string }) }
});
export const NOTE_PROPOSAL_RESULT = Object.freeze(object({ schemaVersion: { const: 1 }, logicalOperationId: string, topicId: string,
  generation: { type: 'integer' }, status: string, basisDigest: { type: ['string', 'null'] }, publicationDigest: { type: ['string', 'null'] }, verifiedAt: { type: ['string', 'null'] },
  snapshot: object({ target: snapshot, sources: { type: 'array', items: snapshot } }), proposedText: string,
  citations: NOTE_PROPOSAL_PARAMS.citations, comparison: object({ before: string, after: string }) }));
export function proposalFields(method) {
  return ['topicId', 'generation', ...(method.endsWith('.prepare') ? ['expectedTopicRevision', 'target', 'sources', 'panel'] : method.endsWith('.publish') ? ['basisDigest', 'proposedText', 'citations'] : [])];
}
