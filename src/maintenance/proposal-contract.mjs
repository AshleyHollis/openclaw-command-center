import { intentDigest } from '../sources/reference.mjs';
import { sourceError, assertNoUnexpectedKeys, nonBlank } from '../sources/errors.mjs';
import { normalizeNotePath } from '../sources/note-path.mjs';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';

export const NOTE_PROPOSAL_KIND = 'notes.proposal.v1';
export const NOTE_PROPOSAL_ACTIONS = Object.freeze(['prepare', 'context', 'publish', 'inspect', 'discard']);
export const NOTE_PROPOSAL_LIMIT = 256 * 1024;
export const noteProposalDigest = intentDigest;
export const terminalProposal = status => ['stale', 'failed', 'discarded'].includes(status);
export function proposalError(code) { return sourceError(code, 'The exact Note proposal is unavailable or changed.'); }

export function proposalAuthority(runtime) {
  const authority = runtime?.proposalAuthority;
  if (!authority || authority.role !== 'operator' || authority.canWrite !== true || typeof authority.assertCurrent !== 'function') throw proposalError('unauthenticated');
  const principalId = nonBlank(authority.principalId, 'principalId');
  const check = authority.assertCurrent;
  const assertCurrent = () => {
    if (runtime.proposalAuthority !== authority || authority.principalId !== principalId || authority.assertCurrent !== check || authority.role !== 'operator' || authority.canWrite !== true) throw proposalError('unauthenticated');
    if (check()?.then) throw proposalError('unauthenticated');
  };
  assertCurrent();
  return { principalId, assertCurrent };
}

export function proposalAccess(input) {
  const logicalOperationId = nonBlank(input.logicalOperationId, 'logicalOperationId');
  if (!isCanonicalUuid(logicalOperationId) || input.generation !== 1 || input.schemaVersion !== 1) throw proposalError('invalid-request');
  return { schemaVersion: 1, logicalOperationId, topicId: nonBlank(input.topicId, 'topicId'), generation: 1 };
}

function descriptor(input) {
  assertNoUnexpectedKeys(input, ['referenceId', 'path', 'revision'], 'Note proposal source');
  const path = normalizeNotePath(input.path);
  if (!path.toLowerCase().endsWith('.md')) throw proposalError('invalid-request');
  return { referenceId: nonBlank(input.referenceId, 'referenceId'), path, revision: nonBlank(input.revision, 'revision') };
}

export function prepareProposalRequest(input) {
  assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'logicalOperationId', 'generation', 'expectedTopicRevision', 'target', 'sources', 'panel'], 'Note proposal preparation');
  const access = proposalAccess(input);
  if (!Number.isSafeInteger(input.expectedTopicRevision) || input.expectedTopicRevision < 0 || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 2) throw proposalError('invalid-request');
  const target = descriptor(input.target);
  const sources = input.sources.map(descriptor);
  if (new Set([target, ...sources].map(item => item.referenceId)).size !== sources.length + 1) throw proposalError('invalid-request');
  let panel = null;
  if (input.panel !== undefined) {
    assertNoUnexpectedKeys(input.panel, ['sessionKey', 'sessionId', 'referenceId'], 'Note proposal Conversation');
    panel = Object.fromEntries(['sessionKey', 'sessionId', 'referenceId'].map(key => [key, nonBlank(input.panel[key], key)]));
  }
  return { ...access, expectedTopicRevision: input.expectedTopicRevision, target, sources, panel };
}

export function validateStaging(input, sources) {
  if (typeof input.proposedText !== 'string' || Buffer.byteLength(input.proposedText, 'utf8') > NOTE_PROPOSAL_LIMIT || !Array.isArray(input.citations)) throw proposalError('invalid-request');
  const expected = sources.map(({ referenceId, revision }) => ({ referenceId, revision }));
  for (const citation of input.citations) assertNoUnexpectedKeys(citation, ['referenceId', 'revision'], 'Note proposal citation');
  if (noteProposalDigest(input.citations) !== noteProposalDigest(expected)) throw proposalError('invalid-request');
  return { proposedText: input.proposedText, citations: expected };
}

// This projection never returns actor identities, internal locators or snapshots.
export function proposalSummary(row, status = row.currentStep) {
  return { schemaVersion: 1, logicalOperationId: row.logicalOperationId, topicId: row.topicId, generation: 1, status,
    basisDigest: row.result?.basisDigest ?? null, publicationDigest: row.result?.publicationDigest ?? null,
    verifiedAt: row.result?.verifiedAt ?? null };
}
