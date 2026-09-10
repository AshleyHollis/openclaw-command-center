import { randomUUID } from 'node:crypto';
import { canonicalJson, materialEvidenceDigest, proposalIdentity } from './analysis-evidence.mjs';
import { orderProposals } from './analysis-policy.mjs';
import { validateProposalContract } from './review-contracts.mjs';
import { createTopicReviewApplicationService } from './review-application.mjs';

const HIDDEN_TERMINAL = new Set(['kept', 'suppressed', 'superseded', 'applied']);
const DECISION_TERMINAL = new Set([...HIDDEN_TERMINAL, 'failed']);
const DECISION_STATES = new Set(['pending', 'approved', 'adjusted', 'kept', 'suppressed', 'blocked']);
const PARA = new Set(['project', 'area', 'resource']);
function clockIso(now) { const value = typeof now === 'function' ? now() : now; return new Date(typeof value === 'number' ? value : Date.parse(value)).toISOString(); }
function operationId(value) { if (typeof value !== 'string' || !value.trim()) throw Object.assign(new TypeError('logicalOperationId is required.'), { code: 'invalid-request' }); return value; }

export class TopicReviewService {
  constructor(options = {}) {
    this.metadata = options.metadata;
    if (!this.metadata) throw new TypeError('Topic Review requires metadata.');
    this.now = options.now ?? (() => Date.now());
    this.attentionService = options.attentionService;
    this.logger = options.logger;
    this.application = options.application ?? createTopicReviewApplicationService({ metadata: this.metadata, topicService: options.topicService, now: this.now, activityService: options.activityService });
  }

  async syncAttention(view) {
    if (typeof this.attentionService?.ingest !== 'function') return;
    const proposalDigest = canonicalJson(view.proposals.map((proposal) => ({ proposalId: proposal.proposalId, revision: proposal.revision, state: proposal.state })));
    const occurrence = {
      schemaVersion: 1,
      sourceCapabilityId: 'topic-review',
      stableSubjectId: 'topic-review:global',
      attentionReason: 'topic-review',
      occurrenceId: `topic-review:${view.episodeRevision}:${proposalDigest}`,
      occurredAt: clockIso(this.now),
      evidenceFacts: { proposalCount: view.proposals.length, episodeRevision: view.episodeRevision },
      ...(view.proposals.length === 0 ? { transitionEvidence: { state: 'resolved', source: 'topic-review-projection' } } : {})
    };
    try {
      const result = await this.attentionService.ingest(occurrence);
      if (view.state === 'Snoozed' && result?.episode?.state === 'Active' && view.snoozedUntil) {
        await this.attentionService.act({ schemaVersion: 1, logicalOperationId: randomUUID(), episodeId: result.episode.episodeId, expectedEpisodeRevision: result.episode.revision, actionId: 'attention.snooze', input: { until: view.snoozedUntil } });
      }
    } catch (error) {
      this.logger?.warn?.(`Topic Review Attention projection remains pending: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }

  proposals() {
    const plans = this.metadata.listTopicApplicationPlans?.() ?? [];
    const applications = new Map();
    for (const plan of [...plans].reverse()) for (const step of this.metadata.listTopicApplicationSteps?.(plan.applicationId) ?? []) {
      if (!applications.has(step.proposalId)) applications.set(step.proposalId, { plan, step, outcome: plan.outcomes?.[step.proposalId] ?? step.outcome });
    }
    return (this.metadata.listTopicProposals?.() ?? []).filter((proposal) => !HIDDEN_TERMINAL.has(proposal.state)).map((proposal) => {
      const application = applications.get(proposal.proposalId);
      return { ...proposal, evidenceFacts: this.metadata.listTopicAnalysisEvidence?.(proposal.proposalId, { currentOnly: true }) ?? [], ...(application?.outcome ? { applicationOutcome: { applicationId: application.plan.applicationId, planStatus: application.plan.status, stepState: application.step.state, ...application.outcome } } : {}) };
    });
  }

  #groups(proposals) {
    const visibleIds = new Set(proposals.map((proposal) => proposal.proposalId));
    const ordered = orderProposals(proposals.map((proposal) => ({ ...proposal, dependencies: (proposal.dependencies ?? []).filter((id) => visibleIds.has(id)) })));
    const groups = new Map();
    for (const proposal of ordered) {
      const topicId = proposal.affectedTopicIds[0] ?? proposal.plannedSourceIds[0] ?? 'planned'; const groupKey = `${topicId}:${proposal.operation}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { topicId, operation: proposal.operation, proposals: [] });
      groups.get(groupKey).proposals.push(proposal);
    }
    return [...groups.values()].map((group) => ({ ...group, proposals: Object.freeze(group.proposals) }));
  }

  get() {
    const stored = this.metadata.getTopicReview?.(); const proposals = this.proposals(); const groups = this.#groups(proposals);
    const actionable = proposals.filter((proposal) => ['pending', 'approved', 'adjusted', 'blocked', 'failed'].includes(proposal.state));
    const currentSnooze = stored?.snoozedUntil && Date.parse(stored.snoozedUntil) > Date.parse(clockIso(this.now)) ? stored.snoozedUntil : null;
    return Object.freeze({ schemaVersion: 1, reviewId: 'topic-review:global', subject: 'topic-review:global', sourceCapabilityId: 'topic-review', severity: 'Routine', notification: false, episodeRevision: stored?.episodeRevision ?? 0, state: currentSnooze && actionable.length ? 'Snoozed' : actionable.length ? 'Active' : 'Resolved', snoozedUntil: currentSnooze, groups: Object.freeze(groups), proposals: Object.freeze(proposals), retainedBlockers: Object.freeze(proposals.flatMap((proposal) => proposal.blockers ?? [])), applicationSummary: stored?.applicationSummary ?? { applied: 0, failed: 0, blocked: 0, recovery: 0 } });
  }

  #refresh({ applicationSummary = undefined } = {}) {
    const view = this.get(); const old = this.metadata.getTopicReview?.();
    if (!old && view.proposals.length === 0) return { result: view, synchronize: false };
    const now = clockIso(this.now);
    const saved = this.metadata.saveTopicReview({ schemaVersion: 1, episodeRevision: (old?.episodeRevision ?? 0) + 1, state: view.state, snoozedUntil: view.snoozedUntil, groups: view.groups, retainedBlockers: view.retainedBlockers, applicationSummary: applicationSummary ?? view.applicationSummary, updatedAt: now });
    const result = Object.freeze({ ...view, ...saved, groups: view.groups, proposals: view.proposals });
    return { result, synchronize: true };
  }

  refresh(options = {}) {
    const refreshed = this.#refresh(options);
    if (refreshed.synchronize) void this.syncAttention(refreshed.result);
    return refreshed.result;
  }

  async refreshAndSync(options = {}) {
    const refreshed = this.#refresh(options);
    if (refreshed.synchronize) await this.syncAttention(refreshed.result);
    return refreshed.result;
  }

  #find(input) {
    const proposal = this.metadata.getTopicProposal(input.proposalId);
    if (!proposal) throw Object.assign(new Error('Topic proposal was not found.'), { code: 'not-found' });
    if (proposal.revision !== input.expectedRevision) throw Object.assign(new Error('Topic proposal revision is stale.'), { code: 'conflict', currentRevision: proposal.revision });
    return proposal;
  }

  decide(input = {}) {
    const value = input.action ? input : { ...input, action: input.decision };
    const allowed = ['schemaVersion', 'logicalOperationId', 'action', 'proposalId', 'expectedRevision', 'adjustment'];
    if (value.schemaVersion !== 1 || Object.keys(value).some((key) => !allowed.includes(key)) || !['approve', 'adjust', 'keep-as-is'].includes(value.action)) throw Object.assign(new TypeError('Proposal decision contract is closed.'), { code: 'invalid-request' });
    const logicalOperationId = operationId(value.logicalOperationId); const intent = { action: value.action, proposalId: value.proposalId, expectedRevision: value.expectedRevision, adjustment: value.adjustment ?? null };
    const journal = this.metadata.getOperation?.(logicalOperationId);
    if (journal) { if (journal.intentDigest !== canonicalJson(intent)) throw Object.assign(new Error('Logical operation ID was reused with different intent.'), { code: 'intent-mismatch' }); if (journal.resultIdentity) return JSON.parse(journal.resultIdentity); }
    const proposal = this.#find(value);
    if (DECISION_TERMINAL.has(proposal.state)) throw Object.assign(new Error('Terminal Topic proposals cannot receive another decision.'), { code: 'conflict' });
    let result;
    if (value.action === 'approve') {
      if (!['pending', 'adjusted'].includes(proposal.state)) throw Object.assign(new Error('Only pending proposals can be approved.'), { code: 'conflict' });
      result = this.metadata.saveTopicProposal({ ...proposal, schemaVersion: 1, state: 'approved', decisionRevision: proposal.revision, materialEvidenceDigest: proposal.materialEvidenceDigest, updatedAt: clockIso(this.now) });
    } else if (value.action === 'keep-as-is') {
      const digest = proposal.materialEvidenceDigest; result = this.metadata.saveTopicProposal({ ...proposal, schemaVersion: 1, state: 'suppressed', suppressedDigest: digest, decisionRevision: proposal.revision, materialEvidenceDigest: digest, updatedAt: clockIso(this.now) });
    } else {
      const adjustment = value.adjustment;
      if (!adjustment || typeof adjustment !== 'object' || Array.isArray(adjustment)) throw Object.assign(new Error('Adjust requires a closed operation patch.'), { code: 'invalid-request' });
      const allowedAdjustment = proposal.operation === 'create' ? ['name', 'paraCategory'] : ['paraCategory'];
      if (proposal.operation === 'archive' || Object.keys(adjustment).length === 0 || Object.keys(adjustment).some((key) => !allowedAdjustment.includes(key))) throw Object.assign(new Error('This proposal does not support that adjustment.'), { code: 'invalid-request' });
      if (adjustment.paraCategory !== undefined && !PARA.has(adjustment.paraCategory)) throw Object.assign(new Error('Adjusted PARA category is invalid.'), { code: 'invalid-request' });
      if (proposal.operation === 'recategorize' && adjustment.paraCategory === (proposal.before?.topic?.paraCategory ?? proposal.before?.paraCategory)) throw Object.assign(new Error('Recategorization cannot adjust back to the current category.'), { code: 'invalid-request' });
      if (adjustment.name !== undefined && (typeof adjustment.name !== 'string' || !adjustment.name.trim() || adjustment.name.length > 200)) throw Object.assign(new Error('Adjusted Topic name is invalid.'), { code: 'invalid-request' });
      const priorEvidenceFacts = this.metadata.listTopicAnalysisEvidence?.(proposal.proposalId, { currentOnly: true }) ?? [];
      const target = proposal.after?.topic && typeof proposal.after.topic === 'object' ? { ...proposal.after.topic, ...adjustment } : { ...proposal.after, ...adjustment };
      const identityInput = { schemaVersion: 1, operation: proposal.operation, affectedTopicIds: proposal.affectedTopicIds, affectedSourceIds: proposal.affectedSourceIds, plannedSourceIds: proposal.plannedSourceIds, before: proposal.before, after: proposal.after?.topic && typeof proposal.after.topic === 'object' ? { ...proposal.after, topic: target } : target, rationale: proposal.rationale, provenance: proposal.provenance, searchRetrievalConsequences: proposal.searchRetrievalConsequences, dependencies: proposal.dependencies, blockers: proposal.blockers, reversibility: proposal.reversibility, predecessorId: proposal.proposalId, revision: 1 };
      const successorId = proposalIdentity(identityInput); const evidenceFacts = priorEvidenceFacts.map((fact, index) => ({ ...fact, evidenceId: `evidence:${successorId.slice(7, 31)}:${index}` }));
      const replacementInput = { ...identityInput, evidenceFacts };
      const replacement = validateProposalContract({ ...replacementInput, proposalId: successorId }, { requireReady: true });
      if (replacement.proposalId === proposal.proposalId) throw Object.assign(new Error('An Adjust decision must change the intended operation.'), { code: 'conflict' });
      const { evidenceFacts: _evidenceFacts, ...storedReplacement } = replacement;
      result = this.metadata.saveTopicProposal({ ...storedReplacement, predecessorId: proposal.proposalId, state: 'approved', decisionRevision: 1, materialEvidenceDigest: materialEvidenceDigest(replacement.evidenceFacts), updatedAt: clockIso(this.now) });
      this.metadata.saveTopicProposal({ ...proposal, schemaVersion: 1, state: 'superseded', successorId: replacement.proposalId, materialEvidenceDigest: proposal.materialEvidenceDigest, updatedAt: clockIso(this.now) });
      this.metadata.setTopicAnalysisEvidence(replacement.proposalId, replacement.evidenceFacts.map((fact) => ({ ...fact, observedAt: fact.observedAt ?? clockIso(this.now) })));
      for (const dependent of this.metadata.listTopicProposals?.() ?? []) if ((dependent.dependencies ?? []).includes(proposal.proposalId) && !HIDDEN_TERMINAL.has(dependent.state)) this.metadata.saveTopicProposal({ ...dependent, schemaVersion: 1, revision: dependent.revision + 1, dependencies: dependent.dependencies.map((id) => id === proposal.proposalId ? replacement.proposalId : id), updatedAt: clockIso(this.now) });
    }
    const output = Object.freeze({ schemaVersion: 1, action: value.action, proposal: result });
    this.metadata.recordOperation?.({ logicalOperationId, transportRequestId: logicalOperationId, intentDigest: canonicalJson(intent), operationKind: `topic-review.${value.action}`, state: 'applied', resultStatus: 'applied', resultIdentity: JSON.stringify(output), observedRevision: String(result.revision), createdAt: clockIso(this.now), updatedAt: clockIso(this.now) });
    this.refresh(); return output;
  }

  snooze(input = {}) {
    const allowed = ['schemaVersion', 'logicalOperationId', 'reviewId', 'expectedRevision', 'snoozedUntil', 'until'];
    if (Object.keys(input).some((key) => !allowed.includes(key)) || input.schemaVersion !== 1 || typeof input.logicalOperationId !== 'string' || input.reviewId !== 'topic-review:global') throw Object.assign(new Error('Topic Review revision is stale or missing.'), { code: 'conflict' });
    const intent = { action: 'review.snooze', reviewId: input.reviewId, expectedRevision: input.expectedRevision, snoozedUntil: input.snoozedUntil ?? input.until };
    const journal = this.metadata.getOperation?.(input.logicalOperationId);
    if (journal) { if (journal.intentDigest !== canonicalJson(intent)) throw Object.assign(new Error('Logical operation ID was reused with different snooze intent.'), { code: 'intent-mismatch' }); if (journal.resultIdentity) return JSON.parse(journal.resultIdentity); }
    if (input.expectedRevision !== this.get().episodeRevision) throw Object.assign(new Error('Topic Review revision is stale or missing.'), { code: 'conflict' });
    const until = input.snoozedUntil ?? input.until; if (typeof until !== 'string' || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.parse(clockIso(this.now))) throw Object.assign(new Error('snoozedUntil must be a future RFC3339 instant.'), { code: 'invalid-request' });
    const current = this.get(); const result = this.metadata.saveTopicReview({ schemaVersion: 1, episodeRevision: current.episodeRevision + 1, state: 'Snoozed', snoozedUntil: until, groups: current.groups, retainedBlockers: current.retainedBlockers, applicationSummary: current.applicationSummary, updatedAt: clockIso(this.now) });
    const output = Object.freeze({ ...current, ...result, state: 'Snoozed', snoozedUntil: until });
    this.metadata.recordOperation?.({ logicalOperationId: input.logicalOperationId, transportRequestId: input.logicalOperationId, intentDigest: canonicalJson(intent), operationKind: 'topic-review.snooze', state: 'applied', resultStatus: 'applied', resultIdentity: JSON.stringify(output), observedRevision: String(output.episodeRevision), createdAt: clockIso(this.now), updatedAt: clockIso(this.now) });
    void this.syncAttention(output);
    return output;
  }

  checkpoint(input = {}) { return this.application.createCheckpoint(input); }
  async apply(input = {}) {
    const result = await this.application.apply(input);
    this.refresh({ applicationSummary: result ? { applicationId: result.applicationId, status: result.status, outcomes: result.outcomes } : undefined });
    return result;
  }
  getPlan(applicationId) { return this.application.getPlan(applicationId); }
}

export function createTopicReviewService(options) { return new TopicReviewService(options); }
export const createReviewService = createTopicReviewService;
