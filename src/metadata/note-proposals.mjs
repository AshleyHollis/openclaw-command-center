import { NOTE_PROPOSAL_KIND, NOTE_PROPOSAL_LIMIT, noteProposalDigest, proposalAccess, prepareProposalRequest, validateStaging, terminalProposal } from '../maintenance/proposal-contract.mjs';
import { revisionForBytes } from '../sources/reference.mjs';

export function installNoteProposalMetadata(service, { mutate, inspect, ErrorType }) {
  const fail = code => { throw new ErrorType(code, 'The exact Note proposal is unavailable or changed.'); };
  const decode = row => row && ({ logicalOperationId: row.logical_operation_id, topicId: row.topic_id,
    currentStep: row.current_step, intent: JSON.parse(row.intent_json), result: row.result_json ? JSON.parse(row.result_json) : null });
  function owned(db, input, authority) {
    authority.assertCurrent();
    const access = proposalAccess(input);
    const row = db.prepare('SELECT * FROM topic_operations WHERE logical_operation_id = ?').get(access.logicalOperationId);
    if (!row || row.operation_kind !== NOTE_PROPOSAL_KIND || row.topic_id !== access.topicId) fail('source-recovery');
    const value = decode(row);
    if (value.intent.principalId !== authority.principalId || value.intent.request.generation !== access.generation) fail('unauthenticated');
    if (!db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(access.topicId)) fail('source-recovery');
    return value;
  }
  function validateSnapshot(request, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.sources)) fail('invalid-request');
    const expected = [request.target, ...request.sources];
    const actual = [snapshot.target, ...snapshot.sources];
    if (expected.length !== actual.length) fail('invalid-request');
    for (let index = 0; index < expected.length; index++) {
      const item = actual[index];
      if (!item || Object.keys(item).sort().join(',') !== 'path,referenceId,revision,text' || noteProposalDigest({ referenceId: item.referenceId, path: item.path, revision: item.revision }) !== noteProposalDigest(expected[index])
        || typeof item.text !== 'string' || Buffer.byteLength(item.text, 'utf8') > NOTE_PROPOSAL_LIMIT || revisionForBytes(Buffer.from(item.text, 'utf8')) !== item.revision) fail('invalid-request');
    }
    if (actual.slice(1).reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0) > NOTE_PROPOSAL_LIMIT) fail('invalid-request');
  }
  function currentBasis(intent) {
    const topic = service.getTopic(intent.request.topicId);
    if (!topic || topic.lifecycle !== 'active' || topic.paraCategory === 'archive' || noteProposalDigest({ topicId: topic.topicId, revision: topic.revision, lifecycle: topic.lifecycle, paraCategory: topic.paraCategory }) !== noteProposalDigest(intent.basis.topic)) fail('conflict');
    for (const item of [intent.basis.folder, ...intent.basis.files]) {
      const reference = service.getSourceReference(item.identity.referenceId);
      if (!reference || noteProposalDigest(Object.fromEntries(Object.keys(item.identity).map(key => [key, reference[key]]))) !== noteProposalDigest(item.identity)
        || noteProposalDigest(service.getSourceLocator(item.identity.referenceId) ?? null) !== noteProposalDigest(item.locator)) fail('conflict');
    }
    if (intent.basis.panel) {
      const panel = intent.basis.panel;
      if (noteProposalDigest(service.getSourceReference(panel.reference.referenceId)) !== noteProposalDigest(panel.reference)
        || noteProposalDigest(service.getSessionState(panel.reference.referenceId)) !== noteProposalDigest(panel.state)
        || noteProposalDigest(service.getSourceLocator(panel.reference.referenceId) ?? null) !== noteProposalDigest(panel.locator)) fail('conflict');
    }
  }
  service.readNoteProposal = (input, authority) => inspect(db => owned(db, input, authority));
  service.prepareNoteProposal = (input, authority, assertBasis) => mutate(null, db => {
    authority.assertCurrent(); assertBasis();
    const request = prepareProposalRequest({ schemaVersion: 1, ...input.request, ...(input.request.panel === null ? { panel: undefined } : {}) });
    const { basis } = input;
    if (!basis || basis.topic?.topicId !== request.topicId || basis.topic?.revision !== request.expectedTopicRevision) fail('invalid-request');
    const intent = { version: 1, principalId: authority.principalId, request, basis };
    currentBasis(intent);
    const existing = db.prepare('SELECT * FROM topic_operations WHERE logical_operation_id = ?').get(request.logicalOperationId);
    if (existing) {
      const row = owned(db, request, authority);
      if (noteProposalDigest(row.intent) !== noteProposalDigest(intent)) fail('intent-mismatch');
      return row;
    }
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO topic_operations (logical_operation_id, topic_id, operation_kind, state, current_step, intent_json, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 'reading', ?, ?, ?, ?)`).run(request.logicalOperationId, request.topicId, NOTE_PROPOSAL_KIND,
      JSON.stringify(intent), JSON.stringify({ status: 'reading', basisDigest: noteProposalDigest(intent) }), now, now);
    authority.assertCurrent();
    return owned(db, request, authority);
  });
  service.transitionNoteProposal = (input, authority, assertBasis = () => {}) => mutate(null, db => {
    const row = owned(db, input, authority);
    if (input.basisDigest !== row.result.basisDigest) fail('intent-mismatch');
    if (terminalProposal(row.currentStep)) return row;
    if (input.status === 'discarded') {
      // Current ownership/authority suffices; source rereads must not prevent discard.
      const topic = db.prepare('SELECT topic_id FROM topics WHERE topic_id = ?').get(row.topicId);
      if (!topic) fail('source-recovery');
    } else {
      assertBasis();
      if (!['stale', 'failed'].includes(input.status)) currentBasis(row.intent);
      if (row.currentStep !== input.expectedStatus) fail('conflict');
      const allowed = { reading: ['prepared', 'failed', 'stale'], prepared: ['review-required', 'stale', 'failed'], 'review-required': ['stale'] };
      if (!allowed[row.currentStep]?.includes(input.status)) fail('invalid-request');
    }
    if (input.status === 'prepared' || input.status === 'review-required') {
      validateSnapshot(row.intent.request, input.result?.snapshot);
      if (input.status === 'review-required') {
        const staged = validateStaging(input.result, row.intent.request.sources);
        if (input.result.publicationDigest !== noteProposalDigest(staged) || noteProposalDigest(input.result.snapshot) !== noteProposalDigest(row.result.snapshot)
          || input.result.comparison?.before !== row.result.snapshot.target.text || input.result.comparison?.after !== staged.proposedText) fail('invalid-request');
      }
    }
    const result = terminalProposal(input.status)
      ? { status: input.status, basisDigest: row.result.basisDigest, publicationDigest: row.result.publicationDigest ?? null, verifiedAt: input.verifiedAt ?? null }
      : { ...input.result, status: input.status, basisDigest: row.result.basisDigest, verifiedAt: input.verifiedAt ?? null };
    if (!terminalProposal(input.status) && !['prepared', 'review-required'].includes(input.status)) fail('invalid-request');
    const state = input.status === 'review-required' ? 'applied' : input.status === 'stale' ? 'conflict' : terminalProposal(input.status) ? 'not-applied' : 'pending';
    authority.assertCurrent();
    db.prepare('UPDATE topic_operations SET state = ?, current_step = ?, result_json = ?, updated_at = ? WHERE logical_operation_id = ? AND current_step = ?')
      .run(state, input.status, JSON.stringify(result), new Date().toISOString(), row.logicalOperationId, row.currentStep);
    authority.assertCurrent();
    return owned(db, input, authority);
  });
}
