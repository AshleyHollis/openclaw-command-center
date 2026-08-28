import { randomUUID, createHash } from 'node:crypto';
import { materialEvidenceDigest, canonicalJson } from './analysis-evidence.mjs';
import { orderProposals } from './analysis-policy.mjs';

function iso(now) { const value = typeof now === 'function' ? now() : now; return new Date(typeof value === 'number' ? value : Date.parse(value)).toISOString(); }
function digest(value) { return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`; }
function deterministicOperationId(value) {
  const hex = createHash('sha256').update(String(value)).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}
function errorCode(error) { return error?.code ?? (/source.?recovery/i.test(String(error?.message)) ? 'source-recovery' : /conflict|stale/i.test(String(error?.message)) ? 'conflict' : 'failed'); }
function publicFailure(error, status) { if (status === 'conflict') return 'Approved Topic change was blocked by a revision conflict.'; if (status === 'source-recovery') return 'The affected source requires recovery before the change can be completed.'; if (status === 'ambiguous') return 'The authoritative result was ambiguous and requires recovery.'; return 'The approved Topic change was not applied.'; }
function proposalKey(item) { return `${item.proposalId}@${item.revision}`; }
function proposalRevisionSet(items) { return items.map(({ proposalId, revision }) => ({ proposalId, revision })).sort((a, b) => proposalKey(a).localeCompare(proposalKey(b))); }
function storedProposal(proposal, extra = {}) { const { evidenceFacts: _evidenceFacts, ...value } = proposal; return { ...value, ...extra }; }
function topicState(value) { return value?.topic && typeof value.topic === 'object' ? value.topic : value; }
function verifiedSuccess(result, proposal) {
  if (!result || typeof result !== 'object') return false;
  if (result.status !== undefined) return result.status === 'applied' && result.verified !== false;
  const topic = result.topic && typeof result.topic === 'object' ? result.topic : result;
  const expected = topicState(proposal.after); const expectedTopicId = expected?.topicId ?? proposal.affectedTopicIds[0];
  return topic.topicId === expectedTopicId && (expected?.paraCategory === undefined || topic.paraCategory === expected.paraCategory);
}
function authoritativeIdentities(metadata, proposal, preview) {
  const topicIds = [...new Set([...(proposal.affectedTopicIds ?? []), ...(proposal.operation === 'create' ? [topicState(proposal.after)?.topicId].filter(Boolean) : [])])].sort();
  const ids = new Set([...(proposal.affectedSourceIds ?? []), ...(proposal.plannedSourceIds ?? [])]);
  for (const commitment of preview?.commitments ?? []) if (commitment?.referenceId) ids.add(commitment.referenceId);
  const expectedRevisions = new Map(Array.isArray(preview?.expectedRevisions) ? preview.expectedRevisions.filter((item) => item?.source === 'reference' && item.id).map((item) => [item.id, item.revision]) : Object.entries(preview?.expectedRevisions ?? {}));
  for (const referenceId of expectedRevisions.keys()) ids.add(referenceId);
  const sources = [...ids].sort().map((referenceId) => {
    const reference = metadata.getSourceReference?.(referenceId);
    const commitment = (preview?.commitments ?? []).find((item) => item?.referenceId === referenceId);
    const revision = commitment?.revision ?? expectedRevisions.get(referenceId) ?? metadata.getSourceLocator?.(referenceId)?.observedRevision ?? reference?.observedRevision ?? null;
    return { referenceId, topicId: reference?.topicId ?? commitment?.topicId ?? topicIds[0] ?? null, sourceSystem: reference?.sourceSystem ?? commitment?.sourceSystem ?? null, sourceKind: reference?.sourceKind ?? commitment?.sourceKind ?? commitment?.kind ?? null, expectedRevision: revision };
  });
  return { topicIds, sources };
}

export class TopicReviewApplicationService {
  constructor(options = {}) {
    this.metadata = options.metadata;
    if (!this.metadata) throw new TypeError('Topic application requires metadata.');
    this.topicService = options.topicService;
    this.executor = options.applyProposal ?? options.executor;
    this.previewer = options.previewProposal ?? options.previewer;
    this.compensator = options.compensateProposal ?? options.compensator ?? options.compensate;
    this.reconciler = options.reconcileOperation ?? options.reconcile;
    this.verifyCompensation = options.verifyCompensation;
    this.now = options.now ?? (() => Date.now());
    this.activityService = options.activityService;
  }

  currentProposals() { return (this.metadata.listTopicProposals?.() ?? []).filter((proposal) => proposal.state === 'approved'); }
  proposalWithEvidence(proposal) { return { ...proposal, evidenceFacts: this.metadata.listTopicAnalysisEvidence?.(proposal.proposalId, { currentOnly: true }) ?? [] }; }

  async createCheckpoint(input = {}) {
    if (input.schemaVersion !== 1 || input.reviewId !== 'topic-review:global' || typeof input.applicationId !== 'string' || !input.applicationId.trim() || typeof input.logicalOperationId !== 'string' || !input.logicalOperationId.trim()) throw Object.assign(new Error('Apply checkpoint requires the global review identity, schemaVersion, applicationId, and logicalOperationId.'), { code: 'invalid-request' });
    const review = this.metadata.getTopicReview?.();
    if (!Number.isInteger(input.expectedReviewRevision) || input.expectedReviewRevision !== (review?.episodeRevision ?? 0)) throw Object.assign(new Error('Topic Review revision changed before checkpoint creation.'), { code: 'conflict' });
    const allProposals = this.metadata.listTopicProposals?.() ?? [];
    const current = allProposals.filter((proposal) => !['kept', 'suppressed', 'superseded', 'applied'].includes(proposal.state));
    if (current.some((proposal) => proposal.state !== 'approved')) throw Object.assign(new Error('Every current proposal must be decided before Apply.'), { code: 'conflict' });
    const currentProposalRevisions = proposalRevisionSet(current);
    const approved = current.map((proposal) => this.proposalWithEvidence(proposal));
    if (approved.length === 0) throw Object.assign(new Error('Apply requires at least one approved proposal.'), { code: 'conflict' });
    if (input.approvedProposalRevisions) {
      const requested = [...input.approvedProposalRevisions].sort((a, b) => proposalKey(a).localeCompare(proposalKey(b)));
      const actual = proposalRevisionSet(approved);
      if (canonicalJson(requested) !== canonicalJson(actual)) throw Object.assign(new Error('Approved proposal revisions changed since the checkpoint request.'), { code: 'conflict' });
    }
    const byId = new Map(allProposals.map((proposal) => [proposal.proposalId, proposal]));
    const approvedIds = new Set(approved.map((proposal) => proposal.proposalId));
    if (approved.some((proposal) => (proposal.dependencies ?? []).some((id) => !byId.has(id)))) throw Object.assign(new Error('An approved proposal has an unknown dependency.'), { code: 'conflict' });
    const dependencyStatus = new Map(approved.map((proposal) => [proposal.proposalId, (proposal.dependencies ?? []).filter((id) => byId.get(id)?.state !== 'applied' && !approvedIds.has(id))]));
    const ordered = orderProposals(approved.map((proposal) => ({ ...proposal, dependencies: (proposal.dependencies ?? []).filter((id) => approvedIds.has(id)) })));
    const dependencies = Object.fromEntries(ordered.map((proposal) => [proposal.proposalId, [...(proposal.dependencies ?? []), ...(dependencyStatus.get(proposal.proposalId) ?? [])].sort()]));
    const steps = [];
    for (const [index, proposal] of ordered.entries()) {
      const rejectedDependencies = dependencyStatus.get(proposal.proposalId) ?? [];
      const preconditions = rejectedDependencies.length ? { proposalRevision: proposal.revision, materialEvidenceDigest: materialEvidenceDigest(proposal.evidenceFacts), dependencyIds: rejectedDependencies } : await this.preconditions(proposal);
      const preview = rejectedDependencies.length ? { kind: 'blocked', reason: 'dependency-not-approved', dependencyIds: rejectedDependencies } : await this.authoritativePreview(proposal, preconditions);
      const identities = authoritativeIdentities(this.metadata, proposal, preview);
      steps.push({ stepId: `step:${String(index).padStart(4, '0')}:${proposal.proposalId}`, proposalId: proposal.proposalId, logicalOperationId: deterministicOperationId(`topic-review.apply:${input.applicationId}:${proposal.proposalId}`), operationKind: `topic-review.apply.${proposal.operation}`, intent: { operation: proposal.operation, proposalId: proposal.proposalId, proposalRevision: proposal.revision, before: proposal.before, after: proposal.after, authoritativePreview: preview, authoritativeAffectedIdentities: identities, materialEvidenceDigest: materialEvidenceDigest(proposal.evidenceFacts) }, preconditions, compensation: this.compensationFor(proposal), ...(rejectedDependencies.length ? { initialOutcome: { status: 'blocked', reason: 'dependency-not-approved', dependencyIds: rejectedDependencies } } : {}) });
    }
    const approvedProposalRevisions = proposalRevisionSet(ordered.filter((proposal) => !(dependencyStatus.get(proposal.proposalId) ?? []).length));
    if (approvedProposalRevisions.length === 0) throw Object.assign(new Error('Apply requires at least one executable approved proposal.'), { code: 'conflict' });
    const planRevision = digest({ reviewRevision: input.expectedReviewRevision, currentProposalRevisions, approvedProposalRevisions, dependencies, steps: steps.map(({ stepId, proposalId, logicalOperationId, operationKind, intent, preconditions, compensation }) => ({ stepId, proposalId, logicalOperationId, operationKind, intent, preconditions, compensation })) });
    const plan = this.metadata.saveTopicApplicationPlan({ applicationId: input.applicationId, schemaVersion: 1, planRevision, reviewRevision: input.expectedReviewRevision, currentProposalRevisions, approvedProposalRevisions, dependencies, status: 'preview', outcomes: {}, createdAt: iso(this.now), updatedAt: iso(this.now) });
    for (const step of steps) {
      const blocked = step.initialOutcome;
      const { initialOutcome: _initialOutcome, ...storedStep } = step;
      this.metadata.saveTopicApplicationStep({ applicationId: input.applicationId, ...storedStep, state: blocked ? 'blocked' : 'pending', ...(blocked ? { outcome: blocked } : {}), updatedAt: iso(this.now) });
    }
    return Object.freeze({ schemaVersion: 1, applicationId: plan.applicationId, planRevision, reviewRevision: plan.reviewRevision, currentProposalRevisions: plan.currentProposalRevisions, approvedProposalRevisions: plan.approvedProposalRevisions, dependencies, steps: Object.freeze(steps), effects: steps.map((step) => step.intent.authoritativePreview), blockers: ordered.flatMap((proposal) => proposal.blockers ?? []) });
  }

  async authoritativePreview(proposal, preconditions) {
    if (this.previewer) return this.previewer({ proposal, preconditions });
    const topicId = proposal.affectedTopicIds[0]; const common = { topicId, expectedRevision: preconditions.topicRevisions[0]?.revision };
    if (proposal.operation === 'archive' && this.topicService?.archivePreview) return this.topicService.archivePreview(common);
    if (proposal.operation === 'restore' && this.topicService?.restorePreview) return this.topicService.restorePreview({ ...common, paraCategory: topicState(proposal.after).paraCategory });
    if (proposal.operation === 'recategorize' && this.topicService?.recategorizationPreview) return this.topicService.recategorizationPreview({ ...common, paraCategory: topicState(proposal.after).paraCategory });
    if (proposal.operation === 'create') return { kind: 'create', plannedTopic: preconditions.plannedTopic, after: proposal.after, sourceMoves: [], implicitMoves: false };
    if (this.executor) return { kind: proposal.operation, before: proposal.before, after: proposal.after, preconditions };
    throw Object.assign(new Error('Authoritative Topic preview capability is unavailable.'), { code: 'capability-unavailable' });
  }

  getPlan(applicationId) {
    const plan = this.metadata.getTopicApplicationPlan(applicationId); if (!plan) return null;
    return Object.freeze({ ...plan, steps: Object.freeze(this.metadata.listTopicApplicationSteps(applicationId)) });
  }

  async preconditions(proposal) {
    const readTopic = (topicId) => {
      let topic;
      try { topic = this.topicService?.get?.(topicId); } catch { topic = null; }
      topic ??= this.metadata.getTopic(topicId);
      return topic;
    };
    const topicIds = [...(proposal.affectedTopicIds ?? [])];
    const topics = topicIds.map((topicId) => {
      const topic = readTopic(topicId);
      if (!topic) throw Object.assign(new Error('Affected Topic identity could not be verified.'), { code: 'conflict' });
      if (proposal.operation === 'create') return { topicId: topic.topicId, revision: topic.revision, lifecycle: topic.lifecycle, paraCategory: topic.paraCategory };
      const before = topicState(proposal.before); const after = topicState(proposal.after);
      if (before?.topicId !== topic.topicId || before?.revision !== topic.revision || before?.paraCategory !== topic.paraCategory || (before?.lifecycle !== undefined && before.lifecycle !== topic.lifecycle) || after?.topicId !== undefined && after.topicId !== topic.topicId) throw Object.assign(new Error('The approved Topic before/after state does not match the authoritative Topic.'), { code: 'conflict' });
      return { topicId: topic.topicId, revision: topic.revision, lifecycle: topic.lifecycle, paraCategory: topic.paraCategory };
    }).filter(Boolean);
    const plannedTopic = proposal.operation === 'create' ? proposal.after?.topic ?? proposal.after : null;
    const plannedTopicId = plannedTopic?.topicId;
    if (proposal.operation === 'create' && (!plannedTopicId || readTopic(plannedTopicId))) throw Object.assign(new Error('A create proposal requires an absent planned Topic identity.'), { code: 'conflict' });
    const sourceRevisions = (proposal.affectedSourceIds ?? []).map((referenceId) => {
      const reference = this.metadata.getSourceReference(referenceId);
      if (!reference) throw Object.assign(new Error('Affected Source identity could not be verified.'), { code: 'source-recovery' });
      if (!proposal.affectedTopicIds.includes(reference.topicId)) throw Object.assign(new Error('Affected Source identity is bound to another Topic.'), { code: 'conflict' });
      return { referenceId, revision: this.metadata.getSourceLocator?.(referenceId)?.observedRevision ?? reference.observedRevision ?? null };
    });
    return { topicRevisions: topics, ...(proposal.operation === 'create' ? { plannedTopic: { topicId: plannedTopicId, absent: true } } : {}), sourceRevisions, recovery: (proposal.affectedTopicIds ?? []).flatMap((topicId) => this.metadata.listSourceRecovery?.(topicId) ?? []).filter((item) => item.state === 'required').map((item) => ({ topicId, referenceId: item.referenceId })), proposalRevision: proposal.revision, materialEvidenceDigest: materialEvidenceDigest(proposal.evidenceFacts) };
  }

  compensationFor(proposal) {
    const reversible = proposal.operation !== 'create' && proposal.reversibility?.reversible === true && proposal.reversibility?.ambiguity == null;
    return { eligible: reversible, inverse: reversible ? { operation: proposal.operation === 'archive' ? 'restore' : proposal.operation === 'restore' ? 'archive' : proposal.operation, before: proposal.after, after: proposal.before } : null };
  }

  async revalidate(proposal, step) {
    const currentProposal = this.metadata.getTopicProposal(proposal.proposalId);
    if (!currentProposal || currentProposal.revision !== step.preconditions.proposalRevision || currentProposal.state !== 'approved') throw Object.assign(new Error('Approved proposal changed after checkpoint.'), { code: 'conflict' });
    if (materialEvidenceDigest(this.metadata.listTopicAnalysisEvidence?.(proposal.proposalId, { currentOnly: true }) ?? []) !== step.preconditions.materialEvidenceDigest) throw Object.assign(new Error('Proposal evidence changed after checkpoint.'), { code: 'conflict' });
    if (step.preconditions.recovery?.length) throw Object.assign(new Error('Required Source Recovery is unresolved.'), { code: 'source-recovery' });
    if (step.preconditions.plannedTopic?.absent) {
      let current;
      try { current = this.topicService?.get?.(step.preconditions.plannedTopic.topicId); } catch { current = null; }
      current ??= this.metadata.getTopic(step.preconditions.plannedTopic.topicId);
      if (current) throw Object.assign(new Error('The planned Topic identity is no longer absent.'), { code: 'conflict' });
    }
    for (const expected of step.preconditions.topicRevisions) {
      let current;
      try { current = this.topicService?.get?.(expected.topicId); } catch { current = null; }
      current ??= this.metadata.getTopic(expected.topicId);
      if (!current || current.revision !== expected.revision || current.lifecycle !== expected.lifecycle || current.paraCategory !== expected.paraCategory) throw Object.assign(new Error('Topic precondition changed after checkpoint.'), { code: 'conflict' });
    }
    for (const expected of step.preconditions.sourceRevisions) {
      const reference = this.metadata.getSourceReference(expected.referenceId); const current = this.metadata.getSourceLocator?.(expected.referenceId)?.observedRevision ?? reference?.observedRevision ?? null;
      if (current !== expected.revision) throw Object.assign(new Error('Source precondition changed after checkpoint.'), { code: 'conflict' });
    }
  }

  async dispatch(proposal, step) {
    if (this.executor) return this.executor({ proposal, step });
    const topicId = proposal.affectedTopicIds[0]; const topic = this.topicService;
    if (!topic) throw Object.assign(new Error('Topic mutation capability is unavailable.'), { code: 'capability-unavailable' });
    if (proposal.operation === 'create') return topic.create({ ...(proposal.after.topic ?? proposal.after), name: proposal.after.topic?.name ?? proposal.after.name, paraCategory: proposal.after.topic?.paraCategory ?? proposal.after.paraCategory, logicalOperationId: step.logicalOperationId });
    const common = { topicId, expectedRevision: step.preconditions.topicRevisions[0]?.revision, logicalOperationId: step.logicalOperationId };
    const preview = step.intent.authoritativePreview;
    if (proposal.operation === 'archive') return topic.archiveConfirm({ ...common, structuralChangeId: preview.structuralChangeId, previewDigest: preview.digest, expectedRevisions: preview.expectedRevisions });
    if (proposal.operation === 'restore') return topic.restoreConfirm({ ...common, paraCategory: topicState(proposal.after).paraCategory, structuralChangeId: preview.structuralChangeId, previewDigest: preview.digest, expectedRevisions: preview.expectedRevisions });
    return topic.recategorizationConfirm({ ...common, paraCategory: topicState(proposal.after).paraCategory, structuralChangeId: preview.structuralChangeId, previewDigest: preview.digest, expectedRevisions: preview.expectedRevisions });
  }

  async reconcileStep(proposal, step) {
    let result;
    if (typeof this.reconciler === 'function') result = await this.reconciler({ proposal, step, logicalOperationId: step.logicalOperationId });
    else if (this.topicService && !this.executor) result = await this.dispatch(proposal, step);
    else throw Object.assign(new Error('A running application step has no reconciliation proof.'), { code: 'unknown' });
    if (!verifiedSuccess(result, proposal)) throw Object.assign(new Error('The prior application effect is not a closed verified success.'), { code: result?.status === 'conflict' ? 'conflict' : ['failed', 'not-applied'].includes(result?.status) ? 'failed' : 'unknown' });
    return result;
  }

  async compensate(proposal, step, error) {
    if (!step.compensation?.eligible || typeof this.compensator !== 'function') return null;
    const result = await this.compensator({ proposal, step, inverse: step.compensation.inverse, error });
    if (!result || !['applied', 'compensated'].includes(result.status)) return null;
    if (typeof this.verifyCompensation !== 'function' || !(await this.verifyCompensation({ proposal, step, result }))) return null;
    return result;
  }

  rejectCheckpoint(plan, message) {
    const outcomes = { checkpoint: { status: 'conflict', error: 'The Topic Review changed after the final checkpoint.' } };
    this.metadata.saveTopicApplicationPlan({ ...plan, status: 'failed', outcomes, updatedAt: iso(this.now) });
    this.recordActivity(plan, 'failed');
    throw Object.assign(new Error(message), { code: 'conflict' });
  }

  async apply(input = {}) {
    if (input.schemaVersion !== 1 || input.reviewId !== 'topic-review:global' || typeof input.applicationId !== 'string' || typeof input.planRevision !== 'string' || input.confirm !== true) throw Object.assign(new Error('Apply requires exact checkpoint confirmation.'), { code: 'invalid-request' });
    const plan = this.metadata.getTopicApplicationPlan(input.applicationId); if (!plan || plan.planRevision !== input.planRevision) throw Object.assign(new Error('Application checkpoint is stale.'), { code: 'conflict' });
    if (plan.status === 'complete' || plan.status === 'failed') return this.getPlan(input.applicationId);
    const review = this.metadata.getTopicReview?.();
    const current = (this.metadata.listTopicProposals?.() ?? []).filter((proposal) => !['kept', 'suppressed', 'superseded', 'applied'].includes(proposal.state));
    if ((review?.episodeRevision ?? 0) !== plan.reviewRevision || canonicalJson(proposalRevisionSet(current)) !== canonicalJson(plan.currentProposalRevisions)) this.rejectCheckpoint(plan, 'Topic Review changed after checkpoint creation.');
    const checkpointSteps = this.metadata.listTopicApplicationSteps(input.applicationId);
    for (const expected of plan.approvedProposalRevisions) {
      const current = this.metadata.getTopicProposal(expected.proposalId);
      if (!current || current.revision !== expected.revision || current.state !== 'approved') this.rejectCheckpoint(plan, 'Approved proposal changed after checkpoint.');
      const checkpoint = checkpointSteps.find((step) => step.proposalId === expected.proposalId);
      if (!checkpoint || materialEvidenceDigest(this.metadata.listTopicAnalysisEvidence?.(expected.proposalId, { currentOnly: true }) ?? []) !== checkpoint.preconditions.materialEvidenceDigest) this.rejectCheckpoint(plan, 'Proposal evidence changed after checkpoint.');
    }
    this.metadata.saveTopicApplicationPlan({ ...plan, status: 'running', updatedAt: iso(this.now) });
    this.recordActivity(plan, 'running');
    const steps = checkpointSteps; const outcomes = {};
    for (const step of steps) {
      if (step.state === 'applied' || step.state === 'compensated') { outcomes[step.proposalId] = step.outcome; continue; }
      if (['failed', 'blocked', 'ambiguous', 'source-recovery'].includes(step.state)) {
        outcomes[step.proposalId] = step.outcome ?? { status: step.state };
        if (step.state === 'blocked') { const proposal = this.metadata.getTopicProposal(step.proposalId); if (proposal?.state === 'approved') this.metadata.saveTopicProposal(storedProposal(proposal, { state: 'blocked', blockers: [...new Set([...(proposal.blockers ?? []), 'Blocked because a dependency was kept as-is or otherwise not approved.'])], updatedAt: iso(this.now) })); }
        continue;
      }
      const deps = plan.dependencies[step.proposalId] ?? [];
      if (deps.some((id) => ['failed', 'conflict', 'compensated', 'blocked', 'ambiguous', 'source-recovery'].includes(outcomes[id]?.status ?? this.metadata.listTopicApplicationSteps(input.applicationId).find((candidate) => candidate.proposalId === id)?.state))) {
        const blockedOutcome = { status: 'blocked', reason: 'dependency-failed', dependencyIds: deps };
        this.metadata.saveTopicApplicationStep({ ...step, state: 'blocked', outcome: blockedOutcome, updatedAt: iso(this.now) });
        const blockedProposal = this.metadata.getTopicProposal(step.proposalId);
        this.metadata.saveTopicProposal(storedProposal(blockedProposal, { state: 'blocked', blockers: [...new Set([...(blockedProposal.blockers ?? []), 'Blocked because an approved dependency did not apply.'])], materialEvidenceDigest: blockedProposal.materialEvidenceDigest, updatedAt: iso(this.now) }));
        outcomes[step.proposalId] = blockedOutcome; continue;
      }
      const proposal = this.proposalWithEvidence(this.metadata.getTopicProposal(step.proposalId));
      this.metadata.saveTopicApplicationStep({ ...step, state: 'running', updatedAt: iso(this.now) });
      let outcome; let dispatched = false;
      try {
        const journal = this.metadata.getOperation?.(step.logicalOperationId);
        if (journal) {
          if (journal.intentDigest !== canonicalJson(step.intent)) throw Object.assign(new Error('Application logical operation intent changed.'), { code: 'intent-mismatch' });
          if (journal.state === 'applied') {
            outcome = { status: 'applied', result: journal.resultIdentity ? JSON.parse(journal.resultIdentity) : { status: 'applied' } };
            this.metadata.saveTopicProposal(storedProposal(proposal, { state: 'applied', materialEvidenceDigest: proposal.materialEvidenceDigest, updatedAt: iso(this.now) }));
            this.metadata.saveTopicApplicationStep({ ...step, state: 'applied', outcome, updatedAt: iso(this.now) });
            outcomes[step.proposalId] = outcome;
            continue;
          }
        }
        if (step.state === 'running') {
          const reconciled = await this.reconcileStep(proposal, step);
          outcome = { status: 'applied', result: reconciled };
          this.metadata.saveTopicProposal(storedProposal(proposal, { state: 'applied', materialEvidenceDigest: proposal.materialEvidenceDigest, updatedAt: iso(this.now) }));
          this.metadata.saveTopicApplicationStep({ ...step, state: 'applied', outcome, updatedAt: iso(this.now) });
          this.metadata.recordOperation?.({ logicalOperationId: step.logicalOperationId, transportRequestId: step.logicalOperationId, intentDigest: canonicalJson(step.intent), operationKind: step.operationKind, state: 'applied', resultStatus: 'applied', resultIdentity: JSON.stringify(reconciled), observedRevision: null, createdAt: iso(this.now), updatedAt: iso(this.now) });
          outcomes[step.proposalId] = outcome;
          continue;
        }
        this.metadata.recordOperation?.({ logicalOperationId: step.logicalOperationId, transportRequestId: step.logicalOperationId, intentDigest: canonicalJson(step.intent), operationKind: step.operationKind, state: 'pending', resultStatus: 'pending', observedRevision: null, createdAt: iso(this.now), updatedAt: iso(this.now) });
        await this.revalidate(proposal, step);
        dispatched = true;
        const result = await this.dispatch(proposal, step);
        if (!verifiedSuccess(result, proposal)) throw Object.assign(new Error('The authoritative application did not return a closed verified-success result.'), { code: ['failed', 'not-applied', 'conflict'].includes(result?.status) ? result.status === 'conflict' ? 'conflict' : 'failed' : 'unknown' });
        outcome = { status: 'applied', result: { status: 'applied', topicId: result.topic?.topicId ?? result.topicId ?? topicState(proposal.after)?.topicId } };
        this.metadata.saveTopicProposal(storedProposal(proposal, { state: 'applied', materialEvidenceDigest: proposal.materialEvidenceDigest, updatedAt: iso(this.now) }));
        this.metadata.saveTopicApplicationStep({ ...step, state: 'applied', outcome, updatedAt: iso(this.now) });
        this.metadata.recordOperation?.({ logicalOperationId: step.logicalOperationId, transportRequestId: step.logicalOperationId, intentDigest: canonicalJson(step.intent), operationKind: step.operationKind, state: 'applied', resultStatus: 'applied', resultIdentity: JSON.stringify(outcome.result), observedRevision: null, createdAt: iso(this.now), updatedAt: iso(this.now) });
      } catch (error) {
        const statusCode = errorCode(error);
        const compensated = dispatched ? await this.compensate(proposal, step, error).catch(() => null) : null;
        const status = compensated ? 'compensated' : statusCode === 'source-recovery' ? 'source-recovery' : statusCode === 'conflict' ? 'conflict' : statusCode === 'unknown' ? 'ambiguous' : dispatched && step.compensation?.eligible ? 'source-recovery' : 'failed';
        outcome = { status, error: publicFailure(error, status), ...(compensated ? { compensation: 'verified' } : {}), ...(!compensated && step.compensation?.eligible ? { recoveryRequired: true } : {}) };
        const recoveryRequired = status === 'source-recovery' || status === 'ambiguous' || (dispatched && !compensated && step.compensation?.eligible);
        const plannedTopicId = proposal.operation === 'create' ? topicState(proposal.after)?.topicId : null;
        const frozen = step.intent.authoritativeAffectedIdentities ?? authoritativeIdentities(this.metadata, proposal, step.intent.authoritativePreview);
        const recoveryIdentities = { topicIds: [...new Set([...(frozen.topicIds ?? []), ...(plannedTopicId ? [plannedTopicId] : [])])].sort(), sourceIds: [...new Set((frozen.sources ?? []).map((item) => item.referenceId))].sort(), sources: (frozen.sources ?? []).map((item) => ({ ...item, state: 'required' })) };
        if (recoveryRequired) {
          outcome.recoveryIdentities = recoveryIdentities;
          for (const affected of recoveryIdentities.sources) {
            const referenceId = affected.referenceId; const reference = this.metadata.getSourceReference?.(referenceId);
            if (!reference || !recoveryIdentities.topicIds.includes(reference.topicId)) continue;
            if (!['note_folder', 'session'].includes(reference.sourceKind)) continue;
            this.metadata.recordSourceRecovery?.({ recoveryId: `recovery:application:${step.proposalId}:${referenceId}`, topicId: reference.topicId, referenceId, sourceKind: reference.sourceKind, state: 'required', revision: 1, failure: outcome.error, diagnostics: [{ check: 'application-effect', result: status, proposalId: proposal.proposalId }], updatedAt: iso(this.now) });
          }
        }
        this.metadata.saveTopicApplicationStep({ ...step, state: recoveryRequired ? 'source-recovery' : status === 'compensated' ? 'compensated' : 'failed', outcome: { ...outcome, ...(recoveryRequired && status !== 'source-recovery' ? { recoveryRequired: true } : {}) }, updatedAt: iso(this.now) });
        this.metadata.saveTopicProposal(storedProposal(proposal, { state: 'failed', blockers: [...new Set([...(proposal.blockers ?? []), outcome.error])], materialEvidenceDigest: proposal.materialEvidenceDigest, updatedAt: iso(this.now) }));
        this.metadata.recordOperation?.({ logicalOperationId: step.logicalOperationId, transportRequestId: step.logicalOperationId, intentDigest: canonicalJson(step.intent), operationKind: step.operationKind, state: status === 'ambiguous' ? 'unknown' : status === 'conflict' ? 'conflict' : 'not-applied', resultStatus: status, resultIdentity: JSON.stringify(outcome), observedRevision: null, createdAt: iso(this.now), updatedAt: iso(this.now) });
      }
      outcomes[step.proposalId] = outcome;
    }
    const finalStatus = Object.values(outcomes).some((outcome) => ['failed', 'conflict', 'ambiguous', 'source-recovery', 'compensated', 'blocked'].includes(outcome.status)) ? 'failed' : 'complete';
    this.metadata.saveTopicApplicationPlan({ ...plan, status: finalStatus, outcomes, updatedAt: iso(this.now) });
    this.recordActivity(plan, finalStatus);
    return this.getPlan(input.applicationId);
  }

  recordActivity(plan, finalStatus) {
    const logicalOperationId = `topic-review-application:${plan.applicationId}`;
    try { this.metadata.recordActivity({ activityId: `activity:${plan.applicationId}`, topicId: null, logicalOperationId, transportRequestId: logicalOperationId, operationKind: 'topic-review.apply', outcome: finalStatus === 'complete' ? 'applied' : finalStatus === 'running' ? 'unknown' : 'failed', observedRevision: plan.planRevision, createdAt: iso(this.now), updatedAt: iso(this.now) }); } catch { /* durable plan outcome remains authoritative if Activity storage is unavailable */ }
  }
}

export function createTopicReviewApplicationService(options) { return new TopicReviewApplicationService(options); }
export const createReviewApplicationService = createTopicReviewApplicationService;
