import { materialEvidenceDigest, proposalIdentity } from './analysis-evidence.mjs';
import { normalizeOperation, validateProposalContract } from './review-contracts.mjs';

export const MAX_CHANGED_TOPICS = 100;
export const MAX_PROPOSALS = 100;
export const TOPIC_PAGE_SIZE = 100;

export function eligibleTopic(topic) { return topic?.lifecycle === 'active'; }
export function eligibleTopics(topics = []) { return topics.filter(eligibleTopic).sort((left, right) => String(left.topicId).localeCompare(String(right.topicId))); }

function operationAllowed(operation, topic) {
  const value = normalizeOperation(operation);
  if (value === 'restore') return topic?.paraCategory === 'archive';
  if (value === 'archive') return topic?.paraCategory !== 'archive' && topic?.lifecycle === 'active';
  if (value === 'recategorize') return topic?.paraCategory !== 'archive' && topic?.lifecycle === 'active';
  return value === 'create';
}

function intendedCategory(operation, candidate) {
  const value = candidate.after?.paraCategory ?? candidate.after?.topic?.paraCategory;
  if (operation === 'archive') return value === undefined || value === 'archive';
  if (operation === 'restore') return ['project', 'area', 'resource'].includes(value);
  if (operation === 'recategorize') return value === undefined || ['project', 'area', 'resource'].includes(value);
  return value === undefined || ['project', 'area', 'resource'].includes(value);
}

export function candidateToProposal(candidate = {}, { now = new Date().toISOString(), requireReady = true } = {}) {
  try {
    const operation = normalizeOperation(candidate.operation);
    const topic = candidate.topic ?? candidate.before?.topic;
    if (operation === 'create' && topic) return null;
    const requestedTopicIds = candidate.affectedTopicIds ?? (topic ? [topic.topicId] : []);
    const requestedSourceIds = candidate.affectedSourceIds ?? [];
    const requestedPlannedSourceIds = candidate.plannedSourceIds ?? [];
    if (!Array.isArray(requestedTopicIds) || !Array.isArray(requestedSourceIds) || !Array.isArray(requestedPlannedSourceIds)) return null;
    if (operation !== 'create' && ((topic && (requestedTopicIds.length !== 1 || requestedTopicIds[0] !== topic.topicId)) || (!topic && requestedTopicIds.length !== 1))) return null;
    if (topic && !eligibleTopic(topic)) return null;
    if (topic && !operationAllowed(operation, topic)) return null;
    if (!intendedCategory(operation, candidate)) return null;
    const affectedTopicIds = [...(candidate.affectedTopicIds ?? (topic ? [topic.topicId] : []))].sort();
    const affectedSourceIds = [...requestedSourceIds].sort();
    const plannedSourceIds = [...requestedPlannedSourceIds].sort();
    const proposal = {
      schemaVersion: 1,
      proposalId: proposalIdentity({ operation, affectedTopicIds, affectedSourceIds, plannedSourceIds, before: candidate.before ?? { topic: topic ?? null }, after: candidate.after ?? {} }),
      revision: candidate.revision ?? 1,
      ...(candidate.predecessorId ? { predecessorId: candidate.predecessorId } : {}),
      ...(candidate.successorId ? { successorId: candidate.successorId } : {}),
      operation, affectedTopicIds, affectedSourceIds, plannedSourceIds,
      before: candidate.before ?? { topic: topic ?? null }, after: candidate.after ?? {},
      rationale: candidate.rationale ?? '', evidenceFacts: candidate.evidenceFacts ?? [],
      materialEvidenceDigest: materialEvidenceDigest(candidate.evidenceFacts ?? []),
      provenance: candidate.provenance ?? { provider: 'fictional-deterministic-analysis', observedAt: now },
      searchRetrievalConsequences: candidate.searchRetrievalConsequences ?? { archive: 'history retained and searchable', recategorize: 'Topic identity and retrieval remain unchanged', create: 'new Topic has no implicit Note or Conversation moves', restore: 'history remains retained and searchable' },
      dependencies: candidate.dependencies ?? [], blockers: candidate.blockers ?? [],
      reversibility: candidate.reversibility ?? { reversible: true, irreversible: false, ambiguity: null }
    };
    return validateProposalContract(proposal, { requireReady });
  } catch { return null; }
}

export function orderProposals(proposals = [], dependencies = new Map()) {
  const byId = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
  if (byId.size !== proposals.length) throw new TypeError('Proposal dependency graph contains duplicate proposal identities.');
  const indegree = new Map(proposals.map((proposal) => [proposal.proposalId, 0]));
  for (const proposal of proposals) for (const dependency of proposal.dependencies ?? []) {
    if (!byId.has(dependency)) throw new TypeError(`Missing proposal dependency ${dependency}.`);
    indegree.set(proposal.proposalId, indegree.get(proposal.proposalId) + 1);
  }
  const ready = proposals.filter((proposal) => indegree.get(proposal.proposalId) === 0).map((proposal) => proposal.proposalId).sort(); const tier = new Map(ready.map((id) => [id, 0]));
  while (ready.length) {
    const id = ready.shift(); const level = tier.get(id) ?? 0;
    for (const proposal of proposals.filter((candidate) => (candidate.dependencies ?? []).includes(id)).sort((left, right) => left.proposalId.localeCompare(right.proposalId))) { tier.set(proposal.proposalId, Math.max(tier.get(proposal.proposalId) ?? 0, level + 1)); indegree.set(proposal.proposalId, indegree.get(proposal.proposalId) - 1); if (indegree.get(proposal.proposalId) === 0) ready.push(proposal.proposalId); }
    ready.sort();
  }
  if ([...indegree.values()].some((value) => value !== 0)) throw new TypeError('Proposal dependency graph contains a cycle.');
  return [...proposals].sort((left, right) => (tier.get(left.proposalId) - tier.get(right.proposalId)) || ((right.affectedTopicIds?.length ?? 0) + (right.affectedSourceIds?.length ?? 0)) - ((left.affectedTopicIds?.length ?? 0) + (left.affectedSourceIds?.length ?? 0)) || (right.evidenceFacts?.length ?? 0) - (left.evidenceFacts?.length ?? 0) || left.proposalId.localeCompare(right.proposalId));
}
