import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateToProposal, eligibleTopics, orderProposals } from '../src/topics/analysis-policy.mjs';
import { materialEvidenceDigest, proposalIdentity } from '../src/topics/analysis-evidence.mjs';

const topic = { topicId: 'topic-fictional', lifecycle: 'active', paraCategory: 'project', revision: 4, name: 'Fictional Topic' };
const source = { referenceId: 'source-fictional', observedRevision: 'source-revision-4' };
const evidence = [{ evidenceId: 'evidence-fictional', sourceId: source.referenceId, sourceRevision: source.observedRevision, fact: 'A fictional source records a concrete category boundary in its latest revision.', material: true, observedAt: '2026-08-24T07:00:00Z' }];

function candidate(overrides = {}) {
  return {
    operation: 'recategorize', topic, affectedTopicIds: [topic.topicId], affectedSourceIds: [source.referenceId], before: { topicId: topic.topicId, paraCategory: 'project', revision: 4 }, after: { topicId: topic.topicId, paraCategory: 'area', revision: 5 }, rationale: 'The cited source records the intended PARA boundary.', evidenceFacts: evidence, provenance: { source: 'fictional-provider', observedAt: '2026-08-24T07:00:00Z' }, searchRetrievalConsequences: { category: 'Topic identity and retrieval remain unchanged.' }, reversibility: { reversible: true, irreversible: false, ambiguity: null }, ...overrides
  };
}

test('candidate policy admits only lifecycle-eligible Topics and the four MVP operations', () => {
  assert.deepEqual(eligibleTopics([topic, { ...topic, topicId: 'topic-archived', paraCategory: 'archive' }, { ...topic, topicId: 'topic-provisioning', lifecycle: 'provisioning' }, { ...topic, topicId: 'topic-retired', lifecycle: 'retired' }]).map((item) => item.topicId), ['topic-archived', 'topic-fictional']);
  assert.ok(candidateToProposal(candidate()));
  assert.equal(candidateToProposal(candidate({ operation: 'merge' })), null);
  assert.equal(candidateToProposal(candidate({ operation: 'archive', topic: { ...topic, paraCategory: 'archive' } })), null);
  assert.equal(candidateToProposal(candidate({ operation: 'restore', topic: { ...topic, paraCategory: 'project' } })), null);
  assert.equal(candidateToProposal(candidate({ operation: 'recategorize', after: { topicId: topic.topicId, paraCategory: 'archive', revision: 5 } })), null);
  assert.equal(candidateToProposal(candidate({ affectedTopicIds: ['topic-other'] })), null);
  assert.equal(candidateToProposal(candidate({ operation: 'restore', topic: { ...topic, paraCategory: 'archive' }, after: { topicId: topic.topicId, paraCategory: 'archive', revision: 5 } })), null);
  assert.equal(candidateToProposal(candidate({ topic: { ...topic, lifecycle: 'provisioning' } })), null);
});

test('decision readiness requires independent inspectable evidence and rejects opaque or private claims', () => {
  assert.equal(candidateToProposal(candidate({ evidenceFacts: [{ ...evidence[0], fact: 'No activity has occurred for a long time.', kind: 'inactivity' }] })), null);
  assert.equal(candidateToProposal(candidate({ evidenceFacts: [{ ...evidence[0], fact: 'The opaque confidence score is 0.98.' }] })), null);
  assert.equal(candidateToProposal(candidate({ evidenceFacts: [{ ...evidence[0], fact: 'pass' + 'word: fictional-redacted-value' }] })), null);
  assert.equal(candidateToProposal(candidate({ rationale: 'Only a rationale without a cited fact.' , evidenceFacts: [] })), null);
  assert.equal(candidateToProposal(candidate({ blockers: ['unresolved source recovery'] })), null);
});

test('proposal identity is stable across ordering, capture time, and rationale while material changes alter only revision', () => {
  const first = candidateToProposal(candidate());
  const reordered = candidateToProposal(candidate({ rationale: 'Reworded explanation.', evidenceFacts: [{ ...evidence[0], observedAt: '2026-08-31T07:00:00Z' }] }));
  assert.equal(first.proposalId, reordered.proposalId);
  assert.equal(first.materialEvidenceDigest, reordered.materialEvidenceDigest);
  assert.equal(first.materialEvidenceDigest, candidateToProposal(candidate({ evidenceFacts: [{ ...evidence[0], fact: '  A fictional source records a concrete   category boundary in its latest revision.\n' }] })).materialEvidenceDigest);
  assert.equal(proposalIdentity(first), first.proposalId);
  const changedDestination = candidateToProposal(candidate({ after: { topicId: topic.topicId, paraCategory: 'resource', revision: 5 } }));
  assert.notEqual(changedDestination.proposalId, first.proposalId);
  const successor = candidateToProposal(candidate({ operation: 'archive', after: { topicId: topic.topicId, paraCategory: 'archive', revision: 5 } }));
  assert.notEqual(successor.proposalId, first.proposalId);
  assert.equal(materialEvidenceDigest(evidence), first.materialEvidenceDigest);
});

test('every public proposal field is bounded and sanitized', () => {
  assert.equal(candidateToProposal(candidate({ rationale: 'bear' + 'er fictional-secret' })), null);
  assert.equal(candidateToProposal(candidate({ provenance: { path: '/' + 'home/fictional/private' } })), null);
  assert.equal(candidateToProposal(candidate({ searchRetrievalConsequences: { detail: `x${'y'.repeat(400)}` } })), null);
  assert.equal(candidateToProposal(candidate({ before: { topicId: topic.topicId, ['pass' + 'word']: 'sec' + 'ret=fake' } })), null);
});

test('proposal ordering is deterministic, dependency aware, and fails closed for missing or cyclic dependencies', () => {
  const root = candidateToProposal(candidate({ operation: 'archive', after: { topicId: topic.topicId, paraCategory: 'archive', revision: 5 } }));
  const dependent = candidateToProposal(candidate({ operation: 'restore', topic: { ...topic, paraCategory: 'archive' }, after: { topicId: topic.topicId, paraCategory: 'area', revision: 6 }, dependencies: [root.proposalId] }));
  assert.deepEqual(orderProposals([dependent, root]).map((item) => item.proposalId), [root.proposalId, dependent.proposalId]);
  assert.throws(() => orderProposals([candidateToProposal(candidate({ dependencies: ['sha256:missing'] }))]), /Missing/);
  const a = candidateToProposal(candidate({ operation: 'archive', after: { topicId: topic.topicId, paraCategory: 'archive', revision: 5 }, dependencies: [] }));
  const b = candidateToProposal(candidate({ operation: 'restore', topic: { ...topic, paraCategory: 'archive' }, after: { topicId: topic.topicId, paraCategory: 'area', revision: 6 }, dependencies: [a.proposalId] }));
  assert.throws(() => orderProposals([{ ...a, dependencies: [b.proposalId] }, b]), /cycle/i);
});
