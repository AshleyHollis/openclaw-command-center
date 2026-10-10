import { assertNoUnexpectedKeys } from '../sources/errors.mjs';
import { noteProposalBasis, assertNoteProposalBasis, readNoteProposalSnapshot } from '../sources/note-proposal-snapshot.mjs';
import { proposalAuthority, prepareProposalRequest, proposalAccess, validateStaging, noteProposalDigest, proposalSummary, terminalProposal, proposalError } from './proposal-contract.mjs';

/** Operator-only staged review. This owner has no Note write or model dispatcher. */
export class NoteProposalService {
  constructor({ sourceService, metadata }) { this.sourceService = sourceService; this.metadata = metadata; }
  basis(row) { return () => assertNoteProposalBasis(this.sourceService, row.intent.request, row.intent.basis); }
  transition(row, status, authority, result) {
    return this.metadata.transitionNoteProposal({ ...proposalAccess(row.intent.request), basisDigest: row.result.basisDigest,
      expectedStatus: row.currentStep, status, ...(result ? { result } : {}), verifiedAt: new Date().toISOString() }, authority,
      // A stale transition confirms drift, so it must not require the old basis.
      status === 'stale' || status === 'failed' ? () => {} : this.basis(row));
  }
  async verify(row, authority) {
    try { return await readNoteProposalSnapshot(this.sourceService, row.intent.request, row.intent.basis, authority); }
    catch (error) {
      // Revocation must not turn a private snapshot into a terminal source decision.
      authority.assertCurrent();
      if (error.code === 'conflict') return this.transition(row, 'stale', authority);
      if (['capability-unavailable', 'unavailable', 'source-recovery', 'read-only'].includes(error.code)) {
        // An unavailable source is not proof of drift. Do not reveal cached text.
        return { ...row, blocked: true };
      }
      if (error.code === 'invalid-request' && row.currentStep === 'reading') return this.transition(row, 'failed', authority);
      throw proposalError(error.code ?? 'unavailable');
    }
  }
  respond(row, authority, privateText = false) {
    authority.assertCurrent();
    // Another owner can have discarded or invalidated this proposal after awaits.
    const current = this.metadata.readNoteProposal(row.intent.request, authority);
    if (row.blocked) { authority.assertCurrent(); return proposalSummary(current, 'blocked'); }
    if (privateText && ['prepared', 'review-required'].includes(current.currentStep)) {
      try { this.basis(current)(); }
      catch (error) {
        authority.assertCurrent();
        if (error.code === 'conflict') return this.respond(this.transition(current, 'stale', authority), authority);
        if (['capability-unavailable', 'unavailable', 'source-recovery', 'read-only'].includes(error.code)) { authority.assertCurrent(); return proposalSummary(current, 'blocked'); }
        throw proposalError(error.code ?? 'unavailable');
      }
    }
    const value = proposalSummary(current);
    if (privateText && ['prepared', 'review-required'].includes(current.currentStep)) Object.assign(value, { snapshot: current.result.snapshot,
      ...(current.currentStep === 'review-required' ? { proposedText: current.result.proposedText, citations: current.result.citations,
        comparison: current.result.comparison } : {}) });
    authority.assertCurrent(); return value;
  }
  completeRead(row, snapshot, authority) {
    if (row.currentStep !== 'reading') return row;
    try { return this.transition(row, 'prepared', authority, { snapshot }); }
    catch (error) {
      if (error.code !== 'conflict') throw error;
      const current = this.metadata.readNoteProposal(row.intent.request, authority);
      if (!terminalProposal(current.currentStep) && noteProposalDigest(current.result.snapshot) !== noteProposalDigest(snapshot)) throw error;
      return current;
    }
  }
  async prepare(input, runtime) {
    const authority = proposalAuthority(runtime);
    const request = prepareProposalRequest(input);
    let row;
    try { row = this.metadata.readNoteProposal(request, authority); }
    catch (error) { if (error.code !== 'source-recovery') throw error; }
    if (row) {
      if (noteProposalDigest(row.intent.request) !== noteProposalDigest(request)) throw proposalError('intent-mismatch');
    } else {
      const basis = noteProposalBasis(this.sourceService, request);
      row = this.metadata.prepareNoteProposal({ request, basis }, authority, () => assertNoteProposalBasis(this.sourceService, request, basis));
    }
    if (terminalProposal(row.currentStep)) return this.respond(row, authority);
    const snapshot = await this.verify(row, authority);
    if (snapshot.currentStep) return this.respond(snapshot, authority);
    row = this.completeRead(row, snapshot, authority);
    return this.respond(row, authority, true);
  }
  async inspect(input, runtime) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'logicalOperationId', 'generation'], 'Note proposal inspection');
    const authority = proposalAuthority(runtime);
    let row = this.metadata.readNoteProposal(proposalAccess(input), authority);
    if (!terminalProposal(row.currentStep)) {
      const verified = await this.verify(row, authority);
      if (verified.currentStep) row = verified;
      else row = this.completeRead(row, verified, authority);
    }
    return this.respond(row, authority, true);
  }
  context(input, runtime) { return this.inspect(input, runtime); }
  async publish(input, runtime) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'logicalOperationId', 'generation', 'basisDigest', 'proposedText', 'citations'], 'Note proposal publication');
    const authority = proposalAuthority(runtime);
    let row = this.metadata.readNoteProposal(proposalAccess(input), authority);
    if (input.basisDigest !== row.result.basisDigest) throw proposalError('intent-mismatch');
    const staged = validateStaging(input, row.intent.request.sources);
    const publicationDigest = noteProposalDigest(staged);
    if (row.result.publicationDigest && row.result.publicationDigest !== publicationDigest) throw proposalError('intent-mismatch');
    if (terminalProposal(row.currentStep)) return this.respond(row, authority);
    if (!['prepared', 'review-required'].includes(row.currentStep)) throw proposalError('conflict');
    const verified = await this.verify(row, authority);
    if (verified.currentStep) return this.respond(verified, authority);
    if (row.currentStep === 'prepared') {
      try { row = this.transition(row, 'review-required', authority, { snapshot: row.result.snapshot, ...staged, publicationDigest,
        comparison: { before: row.result.snapshot.target.text, after: staged.proposedText } }); }
      catch (error) {
        if (error.code !== 'conflict') throw error;
        row = this.metadata.readNoteProposal(row.intent.request, authority);
        if (!terminalProposal(row.currentStep) && row.result.publicationDigest !== publicationDigest) throw error;
      }
    }
    return this.respond(row, authority, true);
  }
  async discard(input, runtime) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'logicalOperationId', 'generation'], 'Note proposal discard');
    const authority = proposalAuthority(runtime);
    let row = this.metadata.readNoteProposal(proposalAccess(input), authority);
    row = this.metadata.transitionNoteProposal({ ...proposalAccess(input), basisDigest: row.result.basisDigest, expectedStatus: row.currentStep, status: 'discarded' }, authority);
    return this.respond(row, authority);
  }
}
