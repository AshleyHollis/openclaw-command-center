import { NOTE_PROPOSAL_LIMIT, noteProposalDigest, proposalError } from '../maintenance/proposal-contract.mjs';
import { revisionForBytes } from './reference.mjs';

function referenceIdentity(reference) {
  if (!reference) throw proposalError('source-recovery');
  return Object.fromEntries(['referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId'].map(key => [key, reference[key]]));
}

export function noteProposalBasis(sourceService, request) {
  const metadata = sourceService.metadata;
  const topic = metadata.getTopic(request.topicId);
  if (!topic || topic.revision !== request.expectedTopicRevision || topic.paraCategory === 'archive') throw proposalError('conflict');
  const folders = metadata.listSourceReferences(request.topicId).filter(row => row.sourceSystem === 'obsidian' && row.sourceKind === 'note_folder');
  if (folders.length !== 1) throw proposalError('conflict');
  const folder = folders[0]; const locator = metadata.getSourceLocator(folder.referenceId);
  if (!locator?.observedRevision) throw proposalError('conflict');
  const files = [request.target, ...request.sources].map(descriptor => {
    const reference = metadata.getSourceReference(descriptor.referenceId);
    if (!reference || reference.topicId !== request.topicId || reference.observedRevision !== descriptor.revision) throw proposalError('conflict');
    sourceService.assertExactNoteReference({ topicId: request.topicId, referenceId: descriptor.referenceId, path: descriptor.path, observedRevision: descriptor.revision }, { read: true });
    return { ...descriptor, identity: referenceIdentity(reference), locator: metadata.getSourceLocator(descriptor.referenceId) ?? null };
  });
  let panel = null;
  if (request.panel) {
    const reference = metadata.getSourceReference(request.panel.referenceId);
    const state = metadata.getSessionState(request.panel.referenceId);
    const binding = metadata.getSourceLocator(request.panel.referenceId) ?? null;
    if (reference?.topicId !== request.topicId || reference.sourceSystem !== 'openclaw' || reference.sourceKind !== 'session'
      || state?.sessionId !== request.panel.sessionId || state.status !== 'open'
      || (binding?.locator ?? reference.externalSourceId) !== request.panel.sessionKey) throw proposalError('conflict');
    panel = { reference, state, locator: binding };
  }
  sourceService.requireTopicService({ topicId: request.topicId }, { requiredSourceKinds: ['note_folder'] });
  return { topic: { topicId: topic.topicId, revision: topic.revision, lifecycle: topic.lifecycle, paraCategory: topic.paraCategory },
    folder: { identity: referenceIdentity(folder), locator }, files, panel };
}

export function assertNoteProposalBasis(sourceService, request, basis) {
  if (noteProposalDigest(noteProposalBasis(sourceService, request)) !== noteProposalDigest(basis)) throw proposalError('conflict');
}

export async function readNoteProposalSnapshot(sourceService, request, basis, authority) {
  authority.assertCurrent(); assertNoteProposalBasis(sourceService, request, basis);
  const owner = sourceService.requireTopicService({ topicId: request.topicId }, { requiredSourceKinds: ['note_folder'] }).notes;
  // The Note owner verifies the filesystem witness, not just a matching locator.
  if (!owner?.resolveRoot || !owner.assertCurrentRoot) throw proposalError('capability-unavailable');
  const root = await owner.resolveRoot();
  authority.assertCurrent(); assertNoteProposalBasis(sourceService, request, basis);
  const snapshots = [];
  for (const descriptor of [request.target, ...request.sources]) {
    const value = await sourceService.notesRead({ schemaVersion: 1, topicId: request.topicId, referenceId: descriptor.referenceId, path: descriptor.path, observedRevision: descriptor.revision });
    authority.assertCurrent(); assertNoteProposalBasis(sourceService, request, basis);
    if (typeof value.text === 'string' && Buffer.byteLength(value.text, 'utf8') > NOTE_PROPOSAL_LIMIT) throw proposalError('invalid-request');
    if (value.path !== descriptor.path || value.revision !== descriptor.revision || noteProposalDigest(referenceIdentity(value.sourceReference)) !== noteProposalDigest(basis.files.find(item => item.referenceId === descriptor.referenceId).identity)
      || typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > NOTE_PROPOSAL_LIMIT || revisionForBytes(Buffer.from(value.text, 'utf8')) !== value.revision) throw proposalError('conflict');
    snapshots.push({ ...descriptor, text: value.text });
  }
  if (snapshots.slice(1).reduce((total, row) => total + Buffer.byteLength(row.text, 'utf8'), 0) > NOTE_PROPOSAL_LIMIT) throw proposalError('invalid-request');
  await owner.resolveRoot();
  authority.assertCurrent(); owner.assertCurrentRoot(root); assertNoteProposalBasis(sourceService, request, basis);
  if (request.panel) {
    const current = await sourceService.sessionTopicContext({ sessionKey: request.panel.sessionKey });
    authority.assertCurrent();
    if (current.status !== 'bound' || current.topicId !== request.topicId || current.sessionId !== request.panel.sessionId || current.referenceId !== request.panel.referenceId || current.sessionKey !== request.panel.sessionKey) throw proposalError('conflict');
  }
  authority.assertCurrent(); assertNoteProposalBasis(sourceService, request, basis);
  return { target: snapshots[0], sources: snapshots.slice(1) };
}
