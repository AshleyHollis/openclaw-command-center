import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { candidateToProposal } from '../src/topics/analysis-policy.mjs';
import { createTopicReviewApplicationService } from '../src/topics/review-application.mjs';
import { createTopicReviewService } from '../src/topics/review.mjs';
import { createTopicService } from '../src/topics/service.mjs';
import { createSourceReference } from '../src/sources/reference.mjs';

const source = (topicId) => `source-application-${topicId}`;

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-topic-application-'));
  const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { analysis: true, activity: true, notes: true, sessions: true, scheduler: true } });
  try { return await run({ metadata, root }); } finally { metadata.close(); await rm(root, { recursive: true, force: true }); }
}

function addTopic(metadata, topicId, category = 'project') {
  metadata.createTopic({ topicId, name: topicId, paraCategory: category, lifecycle: 'active', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
  metadata.createSourceReference({ version: 1, referenceId: source(topicId), topicId, sourceSystem: 'fictional', sourceKind: 'note_folder', externalSourceId: `fictional-folder-${topicId}`, observedRevision: `revision-${topicId}-1`, createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
}

function makeProposal(metadata, topicId, after = 'area', overrides = {}) {
  const current = metadata.getTopic(topicId); const referenceId = source(topicId); const revision = `revision-${topicId}-1`;
  const proposal = candidateToProposal({ operation: 'recategorize', topic: current, affectedTopicIds: [topicId], affectedSourceIds: [referenceId], before: { topicId, paraCategory: current.paraCategory, revision: current.revision }, after: { topicId, paraCategory: after, revision: current.revision + 1 }, rationale: 'A fictional source records the exact intended category.', evidenceFacts: [{ evidenceId: `evidence-${topicId}`, sourceId: referenceId, sourceRevision: revision, fact: `The fictional folder record explicitly requires the ${after} category.`, material: true, observedAt: '2026-08-24T07:00:00.000Z' }], provenance: { source: 'fictional-application-provider', observedAt: '2026-08-24T07:00:00.000Z' }, searchRetrievalConsequences: { category: 'Topic identity and retrieval remain unchanged.' }, reversibility: { reversible: true, irreversible: false, ambiguity: null }, ...overrides });
  const { evidenceFacts, ...stored } = proposal;
  metadata.saveTopicProposal({ ...stored, state: 'approved', createdAt: '2026-08-24T07:00:00.000Z', updatedAt: '2026-08-24T07:00:00.000Z' }); metadata.setTopicAnalysisEvidence(proposal.proposalId, evidenceFacts);
  return proposal;
}

async function productionTopics(metadata, root) {
  const vault = path.join(root, 'vault'); await mkdir(vault, { recursive: true });
  const sessionAdapterFactory = ({ metadata: store, topicId }) => ({
    async create({ label }) {
      const reference = createSourceReference({ referenceId: `session:${topicId}`, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: `agent:fictional:topic:${topicId}` });
      if (!store.getSourceReference(reference.referenceId)) store.createSourceReference(reference);
      store.setSessionState({ referenceId: reference.referenceId, sessionId: `session-fixture:${topicId}`, status: 'open', isPrimary: true });
      return { sourceReference: reference, sessionId: `session-fixture:${topicId}`, label, creationRevision: 'fictional-session-revision-1' };
    }
  });
  return createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory, schedulerFactory: () => ({ list: async () => [] }) });
}

function saveOperationProposal(metadata, topics, { operation, topicId, after, plannedTopicId }) {
  const current = topics.get(topicId); const reference = current.sourceReferences[0]; const observedRevision = current.locators.find((item) => item.referenceId === reference.referenceId)?.observedRevision ?? 'fictional-source-revision-1';
  const proposal = candidateToProposal({ operation, ...(operation === 'create' ? {} : { topic: current }), affectedTopicIds: [topicId], affectedSourceIds: [reference.referenceId], before: { topicId, name: current.name, paraCategory: current.paraCategory, lifecycle: current.lifecycle, revision: current.revision }, after: operation === 'create' ? { topicId: plannedTopicId, name: 'Review Created Topic', paraCategory: 'area', lifecycle: 'active', revision: 1 } : { topicId, name: current.name, paraCategory: after, lifecycle: current.lifecycle, revision: current.revision + 1 }, rationale: `The fictional authoritative record requires the ${operation} operation.`, evidenceFacts: [{ evidenceId: `evidence-production-${operation}-${topicId}`, sourceId: reference.referenceId, sourceRevision: observedRevision, fact: `The fictional structural record explicitly requires ${operation}.`, material: true, observedAt: '2026-08-24T07:00:00.000Z' }], provenance: { source: 'fictional-production-adapter-test', observedAt: '2026-08-24T07:00:00.000Z' }, searchRetrievalConsequences: { structuralChange: 'The reviewed Topic category and derived search projection will be updated.' }, reversibility: { reversible: operation !== 'create', irreversible: operation === 'create', ambiguity: operation === 'create' ? 'An activated Topic is not automatically removed.' : null } });
  const { evidenceFacts, ...stored } = proposal;
  metadata.saveTopicProposal({ ...stored, state: 'approved', createdAt: '2026-08-24T07:00:00.000Z', updatedAt: '2026-08-24T07:00:00.000Z' }); metadata.setTopicAnalysisEvidence(proposal.proposalId, evidenceFacts);
  return proposal;
}

test('checkpoint is preview-only, applies approved proposals topologically, and replay does not duplicate Activity', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-root'); addTopic(metadata, 'topic-independent'); addTopic(metadata, 'topic-dependent');
    const root = makeProposal(metadata, 'topic-root');
    const independent = makeProposal(metadata, 'topic-independent', 'resource');
    const dependent = makeProposal(metadata, 'topic-dependent', 'resource', { dependencies: [root.proposalId] });
    const calls = []; const application = createTopicReviewApplicationService({ metadata, executor: async ({ proposal }) => { calls.push(proposal.proposalId); metadata.updateTopic({ topicId: proposal.affectedTopicIds[0], paraCategory: proposal.after.paraCategory, expectedRevision: proposal.before.revision, updatedAt: '2026-08-24T08:00:00.000Z' }); return { status: 'applied', topicId: proposal.affectedTopicIds[0] }; } });
    const checkpoint = await application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-fictional-1', logicalOperationId: 'checkpoint-fictional-1' });
    assert.equal(metadata.getTopic('topic-root').paraCategory, 'project'); assert.ok(checkpoint.steps.slice(0, -1).map((step) => step.proposalId).includes(root.proposalId)); assert.equal(checkpoint.steps.at(-1).proposalId, dependent.proposalId); assert.ok(checkpoint.effects.every((effect) => effect.kind === 'recategorize'));
    const applied = await application.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true });
    assert.equal(applied.status, 'complete'); assert.deepEqual(calls, [root.proposalId, independent.proposalId].sort((left, right) => left.localeCompare(right)).concat(dependent.proposalId)); assert.equal(metadata.listActivity().filter((item) => item.operationKind === 'topic-review.apply').length, 1);
    const replay = await application.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true });
    assert.equal(replay.status, 'complete'); assert.equal(calls.length, 3); assert.equal(metadata.listActivity().filter((item) => item.operationKind === 'topic-review.apply').length, 1);
  });
});

test('proposal and Topic changes invalidate the exact checkpoint before authoritative dispatch', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-stale'); const proposal = makeProposal(metadata, 'topic-stale'); let calls = 0;
    const application = createTopicReviewApplicationService({ metadata, executor: async () => { calls += 1; return { status: 'applied' }; } });
    const checkpoint = await application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-stale', logicalOperationId: 'checkpoint-stale' });
    const { evidenceFacts: _evidenceFacts, ...stored } = proposal;
    metadata.saveTopicProposal({ ...stored, state: 'approved', revision: 2, updatedAt: '2026-08-24T08:00:00.000Z' });
    await assert.rejects(application.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true }), (error) => error.code === 'conflict');
    assert.equal(calls, 0); assert.equal(metadata.getTopic('topic-stale').paraCategory, 'project');
    assert.equal(metadata.getTopicApplicationPlan(checkpoint.applicationId).status, 'failed');
    assert.equal(metadata.listActivity().filter((item) => item.logicalOperationId === `topic-review-application:${checkpoint.applicationId}`).length, 1);
  });
});

test('a later review revision or changed current-proposal set invalidates the frozen checkpoint', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-frozen'); makeProposal(metadata, 'topic-frozen');
    metadata.saveTopicReview({ schemaVersion: 1, episodeRevision: 1, state: 'Active', groups: [], retainedBlockers: [], applicationSummary: {}, updatedAt: '2026-08-24T07:00:00.000Z' });
    let calls = 0;
    const application = createTopicReviewApplicationService({ metadata, executor: async () => { calls += 1; return { status: 'applied' }; } });
    const checkpoint = await application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 1, applicationId: 'application-review-race', logicalOperationId: 'checkpoint-review-race' });
    addTopic(metadata, 'topic-later'); const later = makeProposal(metadata, 'topic-later');
    metadata.saveTopicProposal({ ...metadata.getTopicProposal(later.proposalId), state: 'pending', updatedAt: '2026-08-24T08:00:00.000Z' });
    metadata.saveTopicReview({ schemaVersion: 1, episodeRevision: 2, state: 'Active', groups: [], retainedBlockers: [], applicationSummary: {}, updatedAt: '2026-08-24T08:00:00.000Z' });
    await assert.rejects(application.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true }), (error) => error.code === 'conflict');
    assert.equal(calls, 0); assert.equal(metadata.getTopic('topic-frozen').paraCategory, 'project');
    assert.equal(metadata.getTopicApplicationPlan(checkpoint.applicationId).reviewRevision, 1);
    assert.equal(metadata.getTopicApplicationPlan(checkpoint.applicationId).currentProposalRevisions.length, 1);
    assert.equal(metadata.getTopicApplicationPlan(checkpoint.applicationId).outcomes.checkpoint.status, 'conflict');
    assert.equal(metadata.listActivity().filter((item) => item.logicalOperationId === `topic-review-application:${checkpoint.applicationId}`).length, 1);
  });
});

test('checkpoint requires the exact review revision, every decision, and a nonempty approved set', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-undecided'); const proposal = makeProposal(metadata, 'topic-undecided');
    metadata.saveTopicProposal({ ...metadata.getTopicProposal(proposal.proposalId), state: 'pending', updatedAt: '2026-08-24T08:00:00.000Z' });
    const application = createTopicReviewApplicationService({ metadata, executor: async () => ({ status: 'applied' }) });
    await assert.rejects(application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-undecided', logicalOperationId: 'checkpoint-undecided' }), (error) => error.code === 'conflict');
    metadata.saveTopicProposal({ ...metadata.getTopicProposal(proposal.proposalId), state: 'suppressed', updatedAt: '2026-08-24T08:01:00.000Z' });
    await assert.rejects(application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 1, applicationId: 'application-empty', logicalOperationId: 'checkpoint-empty' }), (error) => error.code === 'conflict');
  });
});

test('a kept dependency visibly blocks its approved dependant while unrelated approved work continues', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-kept'); addTopic(metadata, 'topic-kept-dependent'); addTopic(metadata, 'topic-kept-independent');
    const kept = makeProposal(metadata, 'topic-kept');
    metadata.saveTopicProposal({ ...metadata.getTopicProposal(kept.proposalId), state: 'suppressed', suppressedDigest: kept.materialEvidenceDigest, updatedAt: '2026-08-24T08:00:00.000Z' });
    const dependent = makeProposal(metadata, 'topic-kept-dependent', 'area', { dependencies: [kept.proposalId] });
    const independent = makeProposal(metadata, 'topic-kept-independent', 'resource'); const calls = [];
    const application = createTopicReviewApplicationService({ metadata, executor: async ({ proposal }) => { calls.push(proposal.proposalId); return { status: 'applied' }; } });
    const checkpoint = await application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-kept-dependency', logicalOperationId: 'checkpoint-kept-dependency' });
    assert.equal(checkpoint.steps.find((step) => step.proposalId === dependent.proposalId).initialOutcome.status, 'blocked');
    assert.equal(metadata.getTopicProposal(dependent.proposalId).state, 'approved', 'preview-only checkpoint must not alter the decision');
    const result = await application.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true });
    assert.equal(result.status, 'failed'); assert.deepEqual(calls, [independent.proposalId]);
    assert.equal(metadata.getTopicProposal(dependent.proposalId).state, 'blocked');
    assert.equal(createTopicReviewService({ metadata }).get().proposals.find((item) => item.proposalId === dependent.proposalId).applicationOutcome.reason, 'dependency-not-approved');
  });
});

test('partial and unrecognized authoritative results are ambiguous and retain every recovery identity', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-ambiguous');
    metadata.createSourceReference({ version: 1, referenceId: 'source-application-secondary', topicId: 'topic-ambiguous', sourceSystem: 'fictional', sourceKind: 'note_folder', externalSourceId: 'fictional-secondary', observedRevision: 'revision-secondary-1', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
    const proposal = makeProposal(metadata, 'topic-ambiguous', 'area', { affectedSourceIds: [source('topic-ambiguous'), 'source-application-secondary'] });
    const application = createTopicReviewApplicationService({ metadata, executor: async () => ({ status: 'partial' }) });
    const checkpoint = await application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-ambiguous', logicalOperationId: 'checkpoint-ambiguous' });
    const result = await application.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true });
    assert.equal(result.outcomes[proposal.proposalId].status, 'ambiguous'); assert.deepEqual(result.outcomes[proposal.proposalId].recoveryIdentities.sourceIds, [source('topic-ambiguous'), 'source-application-secondary'].sort()); assert.equal(metadata.listSourceRecovery().length, 2);
  });
});

test('authoritative scheduler commitments are frozen and retained as exact recovery identities', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-scheduled-archive');
    metadata.createSourceReference({ version: 1, referenceId: 'schedule:fictional-weekly', topicId: 'topic-scheduled-archive', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'fictional-weekly', observedRevision: 'schedule-revision-7', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
    const proposal = makeProposal(metadata, 'topic-scheduled-archive', 'archive', { operation: 'archive', after: { topicId: 'topic-scheduled-archive', paraCategory: 'archive', revision: 2 } });
    const application = createTopicReviewApplicationService({ metadata, previewer: async () => ({ kind: 'archive', commitments: [{ referenceId: 'schedule:fictional-weekly', revision: 'schedule-revision-7', kind: 'schedule', disposition: 'disable-and-retain' }], expectedRevisions: [{ source: 'topic', id: 'topic-scheduled-archive', revision: 1 }, { source: 'reference', id: 'schedule:fictional-weekly', revision: 'schedule-revision-7' }] }), executor: async () => { throw new Error('fictional failure after schedule dispatch'); } });
    const checkpoint = await application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-scheduler-recovery', logicalOperationId: 'checkpoint-scheduler-recovery' });
    assert.deepEqual(checkpoint.steps[0].intent.authoritativeAffectedIdentities.sources.find((item) => item.referenceId === 'schedule:fictional-weekly'), { referenceId: 'schedule:fictional-weekly', topicId: 'topic-scheduled-archive', sourceSystem: 'scheduler', sourceKind: 'schedule', expectedRevision: 'schedule-revision-7' });
    const result = await application.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true });
    assert.equal(result.outcomes[proposal.proposalId].status, 'source-recovery');
    assert.deepEqual(result.outcomes[proposal.proposalId].recoveryIdentities.sources.find((item) => item.referenceId === 'schedule:fictional-weekly'), { referenceId: 'schedule:fictional-weekly', topicId: 'topic-scheduled-archive', sourceSystem: 'scheduler', sourceKind: 'schedule', expectedRevision: 'schedule-revision-7', state: 'required' });
    assert.equal(metadata.listSourceRecovery().some((item) => item.referenceId === 'schedule:fictional-weekly'), false, 'scheduler recovery remains in the durable application ledger');
  });
});

test('failed proposals do not stop unrelated work and block only dependency descendants', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-fail'); addTopic(metadata, 'topic-continue'); addTopic(metadata, 'topic-blocked');
    const failed = makeProposal(metadata, 'topic-fail'); const independent = makeProposal(metadata, 'topic-continue', 'resource'); const blocked = makeProposal(metadata, 'topic-blocked', 'resource', { dependencies: [failed.proposalId] });
    const calls = []; const application = createTopicReviewApplicationService({ metadata, executor: async ({ proposal }) => { calls.push(proposal.proposalId); if (proposal.proposalId === failed.proposalId) throw new Error('fictional authoritative failure'); metadata.updateTopic({ topicId: proposal.affectedTopicIds[0], paraCategory: proposal.after.paraCategory, expectedRevision: proposal.before.revision }); return { status: 'applied' }; } });
    const checkpoint = await application.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-failure', logicalOperationId: 'checkpoint-failure' });
    const result = await application.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true });
    assert.equal(result.status, 'failed'); assert.deepEqual(calls, [failed.proposalId, independent.proposalId].sort((left, right) => left.localeCompare(right))); assert.equal(result.outcomes[blocked.proposalId].status, 'blocked'); assert.equal(metadata.listActivity().filter((item) => item.operationKind === 'topic-review.apply').length, 1);
    const reloaded = createTopicReviewService({ metadata }).get();
    assert.equal(reloaded.state, 'Active');
    assert.equal(reloaded.proposals.find((item) => item.proposalId === failed.proposalId).applicationOutcome.stepState, 'source-recovery');
    assert.deepEqual(reloaded.proposals.find((item) => item.proposalId === failed.proposalId).applicationOutcome.recoveryIdentities.topicIds, ['topic-fail']);
    assert.equal(reloaded.proposals.find((item) => item.proposalId === blocked.proposalId).applicationOutcome.reason, 'dependency-failed');
    assert.match(reloaded.retainedBlockers.join(' '), /dependency did not apply/i);
  });
});

test('safe verified compensation and Source Recovery are reported distinctly, and running steps reconcile after restart', async () => {
  await fixture(async ({ metadata }) => {
    addTopic(metadata, 'topic-compensate'); const proposal = makeProposal(metadata, 'topic-compensate');
    const compensatedApp = createTopicReviewApplicationService({ metadata, executor: async () => { throw new Error('fictional post-dispatch failure'); }, compensator: async () => ({ status: 'applied' }), verifyCompensation: async () => true });
  const checkpoint = await compensatedApp.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-compensate', logicalOperationId: 'checkpoint-compensate' });
    const compensated = await compensatedApp.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: checkpoint.applicationId, planRevision: checkpoint.planRevision, confirm: true });
    assert.equal(compensated.outcomes[proposal.proposalId].status, 'compensated'); assert.equal(metadata.listSourceRecovery().length, 0);
    metadata.saveTopicProposal({ ...metadata.getTopicProposal(proposal.proposalId), state: 'applied', updatedAt: '2026-08-24T08:01:00.000Z' });

    addTopic(metadata, 'topic-recovery'); const recoveryProposal = makeProposal(metadata, 'topic-recovery');
    const recoveryApp = createTopicReviewApplicationService({ metadata, executor: async () => { throw new Error('fictional uncertain transport'); } });
  const recoveryCheckpoint = await recoveryApp.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-recovery', logicalOperationId: 'checkpoint-recovery' });
    const recovery = await recoveryApp.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: recoveryCheckpoint.applicationId, planRevision: recoveryCheckpoint.planRevision, confirm: true });
    assert.equal(recovery.outcomes[recoveryProposal.proposalId].status, 'source-recovery'); assert.equal(metadata.listSourceRecovery().length, 1);
    metadata.saveTopicProposal({ ...metadata.getTopicProposal(recoveryProposal.proposalId), state: 'applied', updatedAt: '2026-08-24T08:02:00.000Z' });

    addTopic(metadata, 'topic-restart'); const restartProposal = makeProposal(metadata, 'topic-restart');
    const restartApp = createTopicReviewApplicationService({ metadata, executor: async () => { throw new Error('executor must not be redispatched'); } });
  const restartCheckpoint = await restartApp.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-restart', logicalOperationId: 'checkpoint-restart' });
    const running = metadata.listTopicApplicationSteps(restartCheckpoint.applicationId)[0]; metadata.saveTopicApplicationStep({ ...running, state: 'running', updatedAt: '2026-08-24T08:00:00.000Z' });
    const resumed = createTopicReviewApplicationService({ metadata, executor: async () => { throw new Error('executor must not be redispatched'); }, reconcileOperation: async () => ({ status: 'applied', topicId: 'topic-restart' }) });
    const result = await resumed.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: restartCheckpoint.applicationId, planRevision: restartCheckpoint.planRevision, confirm: true });
    assert.equal(result.outcomes[restartProposal.proposalId].status, 'applied'); assert.equal(metadata.getTopicProposal(restartProposal.proposalId).state, 'applied');
  });
});

test('production Topic adapters preview and apply create, archive, restore, and recategorize with restart-safe replay', async () => {
  await fixture(async ({ metadata, root }) => {
    const topics = await productionTopics(metadata, root);
    const seed = async (name, category = 'project') => (await topics.create({ name, paraCategory: category, logicalOperationId: randomUUID() })).topic.topicId;
    const evidenceTopicId = await seed('Evidence Topic');

    const createProposal = saveOperationProposal(metadata, topics, { operation: 'create', topicId: evidenceTopicId, plannedTopicId: 'topic-created-by-review' });
    const createApplication = createTopicReviewApplicationService({ metadata, topicService: topics });
    const createCheckpoint = await createApplication.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-production-create', logicalOperationId: 'checkpoint-production-create' });
    assert.equal(metadata.getTopic('topic-created-by-review'), null);
    assert.equal(createCheckpoint.effects[0].kind, 'create');
    const createResult = await createApplication.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: createCheckpoint.applicationId, planRevision: createCheckpoint.planRevision, confirm: true });
    assert.equal(createResult.outcomes[createProposal.proposalId].status, 'applied'); assert.equal(topics.get('topic-created-by-review').paraCategory, 'area');

    const recategorizeTopicId = await seed('Recategorize Topic');
    const recategorizeProposal = saveOperationProposal(metadata, topics, { operation: 'recategorize', topicId: recategorizeTopicId, after: 'resource' });
    const recategorizeApplication = createTopicReviewApplicationService({ metadata, topicService: topics });
    const recategorizeCheckpoint = await recategorizeApplication.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-production-recategorize', logicalOperationId: 'checkpoint-production-recategorize' });
    assert.equal(topics.get(recategorizeTopicId).paraCategory, 'project'); assert.equal(recategorizeCheckpoint.effects[0].kind, 'recategorization');
    const persistedRunning = metadata.listTopicApplicationSteps(recategorizeCheckpoint.applicationId)[0]; metadata.saveTopicApplicationStep({ ...persistedRunning, state: 'running', updatedAt: '2026-08-24T08:00:00.000Z' });
    const resumed = createTopicReviewApplicationService({ metadata, topicService: topics });
    const recategorizeResult = await resumed.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: recategorizeCheckpoint.applicationId, planRevision: recategorizeCheckpoint.planRevision, confirm: true });
    assert.equal(recategorizeResult.outcomes[recategorizeProposal.proposalId].status, 'applied', JSON.stringify(recategorizeResult.outcomes[recategorizeProposal.proposalId])); assert.equal(topics.get(recategorizeTopicId).paraCategory, 'resource');
    const recategorizeReplay = await resumed.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: recategorizeCheckpoint.applicationId, planRevision: recategorizeCheckpoint.planRevision, confirm: true });
    assert.equal(recategorizeReplay.status, 'complete');

    const archiveTopicId = await seed('Archive Topic', 'area');
    const archiveProposal = saveOperationProposal(metadata, topics, { operation: 'archive', topicId: archiveTopicId, after: 'archive' });
    const archiveApplication = createTopicReviewApplicationService({ metadata, topicService: topics });
    const archiveCheckpoint = await archiveApplication.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-production-archive', logicalOperationId: 'checkpoint-production-archive' });
    assert.equal(topics.get(archiveTopicId).paraCategory, 'area'); assert.equal(archiveCheckpoint.effects[0].kind, 'archive');
    const archiveResult = await archiveApplication.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: archiveCheckpoint.applicationId, planRevision: archiveCheckpoint.planRevision, confirm: true });
    assert.equal(archiveResult.outcomes[archiveProposal.proposalId].status, 'applied'); assert.equal(topics.get(archiveTopicId).paraCategory, 'archive');

    const restoreProposal = saveOperationProposal(metadata, topics, { operation: 'restore', topicId: archiveTopicId, after: 'project' });
    const restoreApplication = createTopicReviewApplicationService({ metadata, topicService: topics });
    const restoreCheckpoint = await restoreApplication.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-production-restore', logicalOperationId: 'checkpoint-production-restore' });
    assert.equal(topics.get(archiveTopicId).paraCategory, 'archive'); assert.equal(restoreCheckpoint.effects[0].kind, 'restore');
    const restoreResult = await restoreApplication.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: restoreCheckpoint.applicationId, planRevision: restoreCheckpoint.planRevision, confirm: true });
    assert.equal(restoreResult.outcomes[restoreProposal.proposalId].status, 'applied'); assert.equal(topics.get(archiveTopicId).paraCategory, 'project');

    const failureTopicId = await seed('Recovery Topic');
    const failureProposal = saveOperationProposal(metadata, topics, { operation: 'recategorize', topicId: failureTopicId, after: 'area' });
    const failureApplication = createTopicReviewApplicationService({ metadata, topicService: topics });
    const failureCheckpoint = await failureApplication.createCheckpoint({ schemaVersion: 1, reviewId: 'topic-review:global', expectedReviewRevision: 0, applicationId: 'application-production-recovery', logicalOperationId: 'checkpoint-production-recovery' });
    const folderReference = metadata.listSourceReferences(failureTopicId).find((item) => item.sourceKind === 'note_folder');
    await rm(metadata.getSourceLocator(folderReference.referenceId).locator, { recursive: true, force: true });
    const failureResult = await failureApplication.apply({ schemaVersion: 1, reviewId: 'topic-review:global', applicationId: failureCheckpoint.applicationId, planRevision: failureCheckpoint.planRevision, confirm: true });
    assert.equal(failureResult.outcomes[failureProposal.proposalId].status, 'source-recovery');
    assert.equal(topics.get(failureTopicId).paraCategory, 'project');
    assert.ok(metadata.listSourceRecovery(failureTopicId).some((item) => item.state === 'required'));
  });
});
