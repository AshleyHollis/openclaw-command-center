import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { candidateToProposal } from '../src/topics/analysis-policy.mjs';
import { createTopicReviewService } from '../src/topics/review.mjs';
import { createAttentionService } from '../src/attention/service.mjs';

const sourceId = 'source-review-fictional';
const topic = { topicId: 'topic-review-fictional', lifecycle: 'active', paraCategory: 'project', revision: 2, name: 'Review Topic' };
const fact = (id, revision, text = 'A fictional source records an explicit structural boundary.') => ({ evidenceId: id, sourceId, sourceRevision: revision, fact: text, material: true, observedAt: '2026-08-24T07:00:00.000Z' });

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-topic-review-'));
  const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { analysis: true, activity: true } });
  metadata.createTopic({ ...topic, createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
  metadata.createSourceReference({ version: 1, referenceId: sourceId, topicId: topic.topicId, sourceSystem: 'fictional', sourceKind: 'record', externalSourceId: 'review-record', observedRevision: 'review-r1', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
  try { return await run({ metadata }); } finally { metadata.close(); await rm(root, { recursive: true, force: true }); }
}

function makeProposal(operation, evidence = fact(`fact-${operation}`, 'review-r1'), overrides = {}) {
  const archived = operation === 'restore'; const currentTopic = archived ? { ...topic, paraCategory: 'archive' } : topic;
  const proposal = candidateToProposal({ operation, topic: currentTopic, affectedTopicIds: [topic.topicId], affectedSourceIds: [sourceId], before: { topicId: topic.topicId, paraCategory: currentTopic.paraCategory, revision: topic.revision }, after: { topicId: topic.topicId, paraCategory: operation === 'archive' ? 'archive' : operation === 'restore' ? 'area' : 'resource', revision: topic.revision + 1 }, rationale: `The fictional evidence supports ${operation}.`, evidenceFacts: [evidence], provenance: { source: 'fictional-review-provider', observedAt: '2026-08-24T07:00:00.000Z' }, searchRetrievalConsequences: { operation: 'History remains retained; retrieval identity is unchanged.' }, reversibility: { reversible: true, irreversible: false, ambiguity: null }, ...overrides });
  return proposal;
}

function persist(metadata, proposal, state = 'pending') {
  const { evidenceFacts, ...stored } = proposal;
  metadata.saveTopicProposal({ ...stored, state, createdAt: '2026-08-24T07:00:00.000Z', updatedAt: '2026-08-24T07:00:00.000Z' });
  metadata.setTopicAnalysisEvidence(proposal.proposalId, evidenceFacts);
  return proposal;
}

test('one Routine global review groups deterministic proposals and later analysis updates its episode', async () => {
  await fixture(async ({ metadata }) => {
    const first = persist(metadata, makeProposal('archive'));
    const second = persist(metadata, makeProposal('recategorize'));
    const review = createTopicReviewService({ metadata, now: () => Date.parse('2026-08-24T08:00:00Z') });
    const initial = review.refresh();
    assert.equal(initial.reviewId, 'topic-review:global'); assert.equal(initial.subject, 'topic-review:global'); assert.equal(initial.severity, 'Routine'); assert.equal(initial.notification, false); assert.equal(initial.groups.length, 2);
    assert.deepEqual(initial.groups.flatMap((group) => group.proposals).map((item) => item.proposalId), [...initial.proposals].map((item) => item.proposalId));
    const episodeRevision = initial.episodeRevision;
    const updated = { ...first, revision: 2, materialEvidenceDigest: undefined, evidenceFacts: [fact('fact-archive-new', 'review-r1', 'The fictional source repeats the same explicit boundary with a material clarification.')] };
    const normalized = candidateToProposal({ ...updated, evidenceFacts: updated.evidenceFacts, rationale: 'A materially clarified fictional boundary supports archive.' });
    persist(metadata, normalized, 'pending');
    const later = review.refresh();
    assert.equal(later.reviewId, initial.reviewId); assert.equal(later.episodeRevision, episodeRevision + 1); assert.ok(later.proposals.some((item) => item.proposalId === first.proposalId && item.revision === 2)); assert.equal(second.proposalId, later.proposals.find((item) => item.proposalId === second.proposalId).proposalId);
  });
});

test('snooze is metadata-only and independent Approve, Adjust, and Keep as-is decisions are revision checked', async () => {
  await fixture(async ({ metadata }) => {
    const archive = persist(metadata, makeProposal('archive'));
    const move = persist(metadata, makeProposal('recategorize'));
    const restore = persist(metadata, makeProposal('restore'));
    const review = createTopicReviewService({ metadata, now: () => Date.parse('2026-08-24T08:00:00Z') });
    let view = review.refresh();
    const snoozed = review.snooze({ schemaVersion: 1, logicalOperationId: 'snooze-review', reviewId: 'topic-review:global', expectedRevision: view.episodeRevision, snoozedUntil: '2026-08-25T08:00:00Z' });
    assert.equal(snoozed.state, 'Snoozed'); assert.equal(metadata.getTopic(archive.affectedTopicIds[0]).paraCategory, 'project');
    await assert.rejects(async () => review.decide({ schemaVersion: 1, logicalOperationId: 'approve-stale', action: 'approve', proposalId: archive.proposalId, expectedRevision: 99 }), (error) => error.code === 'conflict');
    await assert.rejects(async () => review.decide({ schemaVersion: 1, logicalOperationId: 'adjust-noop', action: 'adjust', proposalId: move.proposalId, expectedRevision: move.revision, adjustment: { paraCategory: 'project' } }), (error) => error.code === 'invalid-request');
    review.decide({ schemaVersion: 1, logicalOperationId: 'approve-archive', action: 'approve', proposalId: archive.proposalId, expectedRevision: archive.revision });
    review.decide({ schemaVersion: 1, logicalOperationId: 'keep-move', action: 'keep-as-is', proposalId: move.proposalId, expectedRevision: move.revision });
    const adjusted = review.decide({ schemaVersion: 1, logicalOperationId: 'adjust-restore', action: 'adjust', proposalId: restore.proposalId, expectedRevision: restore.revision, adjustment: { paraCategory: 'resource' } });
    assert.equal(metadata.getTopicProposal(archive.proposalId).state, 'approved'); assert.equal(metadata.getTopicProposal(move.proposalId).state, 'suppressed'); assert.equal(metadata.getTopicProposal(restore.proposalId).state, 'superseded'); assert.equal(adjusted.proposal.predecessorId, restore.proposalId); assert.equal(adjusted.proposal.state, 'approved');
    view = review.refresh(); assert.equal(view.state, 'Snoozed'); assert.equal(view.proposals.some((item) => item.proposalId === move.proposalId), false); assert.equal(view.proposals.some((item) => item.proposalId === adjusted.proposal.proposalId), true);
    const replay = review.decide({ schemaVersion: 1, logicalOperationId: 'approve-archive', action: 'approve', proposalId: archive.proposalId, expectedRevision: archive.revision });
    assert.equal(replay.proposal.state, 'approved');
  });
});

test('Keep as-is suppression reopens the same stable proposal identity only when material evidence changes', async () => {
  await fixture(async ({ metadata }) => {
    const proposal = persist(metadata, makeProposal('archive'));
    const review = createTopicReviewService({ metadata, now: () => Date.parse('2026-08-24T08:00:00Z') });
    review.refresh(); review.decide({ schemaVersion: 1, logicalOperationId: 'keep-until-evidence', action: 'keep-as-is', proposalId: proposal.proposalId, expectedRevision: proposal.revision });
    assert.equal(review.get().proposals.length, 0);
    const changed = candidateToProposal({ ...makeProposal('archive', fact('fact-material-change', 'review-r1', 'The fictional source adds a new explicit archive retention requirement.')), revision: 2, rationale: 'A new material retention requirement changes the review evidence.' });
    persist(metadata, changed, 'pending');
    const reopened = review.refresh();
    assert.equal(reopened.proposals.length, 1); assert.equal(reopened.proposals[0].proposalId, proposal.proposalId); assert.equal(reopened.proposals[0].revision, 2);
  });
});

test('the review projection registers one Routine Attention item and resolves it when the review becomes quiet', async () => {
  await fixture(async ({ metadata }) => {
    const attention = createAttentionService({ metadata, now: () => '2026-08-24T08:00:00.000Z' });
    attention.registerSourceCapability({ sourceCapabilityId: 'topic-review', sourceKind: 'topic-review', monitoring: true, actions: [], verifyTransition: () => true, deriveEvidence: (occurrence) => occurrence.evidenceFacts });
    try {
      const proposal = persist(metadata, makeProposal('archive'));
      const review = createTopicReviewService({ metadata, attentionService: attention, now: () => Date.parse('2026-08-24T08:00:00Z') });
      await review.refreshAndSync();
      const listed = attention.list({ schemaVersion: 1 });
      assert.equal(listed.episodes.length, 1); assert.equal(listed.episodes[0].stableSubjectId, 'topic-review:global'); assert.equal(listed.episodes[0].severity, 'Routine');
      const snoozed = review.snooze({ schemaVersion: 1, logicalOperationId: 'snooze-attention-projection', reviewId: 'topic-review:global', expectedRevision: review.get().episodeRevision, snoozedUntil: '2026-08-25T08:00:00.000Z' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(snoozed.state, 'Snoozed'); assert.equal(attention.list({ schemaVersion: 1 }).episodes.length, 0);
      review.refresh(); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(attention.list({ schemaVersion: 1 }).episodes.length, 0, 'later analysis projection must preserve presentation snooze');
      review.decide({ schemaVersion: 1, logicalOperationId: 'keep-attention', action: 'keep-as-is', proposalId: proposal.proposalId, expectedRevision: proposal.revision });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(attention.list({ schemaVersion: 1 }).episodes.length, 0);
    } finally { attention.close(); }
  });
});
