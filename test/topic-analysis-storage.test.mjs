import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createTopicAnalysisRunner } from '../src/topics/analysis-runner.mjs';
import { proposalIdentity } from '../src/topics/analysis-evidence.mjs';
import { metadataSchemaV7Sql } from '../src/metadata/schema.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { mkdir } from 'node:fs/promises';

const sourceId = 'source-fictional';
const sourceRevision = (value) => `source-revision-${value}`;

async function withMetadata(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-topic-analysis-'));
  const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { analysis: true, activity: true } });
  try { return await run({ root, metadata }); } finally { metadata.close(); await rm(root, { recursive: true, force: true }); }
}

function addTopic(metadata, topicId, paraCategory = 'area', lifecycle = 'active') {
  metadata.createTopic({ topicId, paraCategory, lifecycle, name: topicId, createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
}

function addSource(metadata, topicId, revision = sourceRevision(1)) {
  metadata.createSourceReference({ version: 1, referenceId: sourceId, topicId, sourceSystem: 'fictional', sourceKind: 'record', externalSourceId: 'fictional-record', observedRevision: revision, createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
}

function proposal(topic, revision) {
  return {
    operation: 'recategorize', topic, affectedTopicIds: [topic.topicId], affectedSourceIds: [sourceId],
    before: { topicId: topic.topicId, paraCategory: topic.paraCategory, revision: topic.revision },
    after: { topicId: topic.topicId, paraCategory: 'resource', revision: topic.revision + 1 },
    rationale: 'A fictional source records a concrete PARA boundary.',
    evidenceFacts: [{ evidenceId: `evidence-${revision}`, sourceId, sourceRevision: revision, fact: `The fictional record explicitly names the resource boundary at revision ${revision}.`, material: true, observedAt: '2026-08-24T07:00:00.000Z' }],
    provenance: { source: 'fictional-deterministic-provider', observedAt: '2026-08-24T07:00:00.000Z' },
    searchRetrievalConsequences: { category: 'Topic identity and retrieval remain unchanged.' },
    reversibility: { reversible: true, irreversible: false, ambiguity: null }
  };
}

test('failed initial analysis establishes no baseline and a later success establishes it once', async () => {
  await withMetadata(async ({ metadata }) => {
    addTopic(metadata, 'topic-initial-failure'); addSource(metadata, 'topic-initial-failure');
    let fail = true;
    const runner = createTopicAnalysisRunner({ metadata, analyzer: async () => { if (fail) throw new Error('fictional baseline provider unavailable'); return []; } });
    const failed = await runner.run({ trigger: 'manual' });
    assert.equal(failed.outcome, 'failed'); assert.equal(metadata.listTopicAnalysisWatermarks().length, 0);
    fail = false;
    const baseline = await runner.run({ trigger: 'weekly' });
    assert.equal(baseline.baseline, true); assert.equal(metadata.listTopicAnalysisWatermarks().length, 2);
  });
});

test('failed later analysis does not advance success watermarks and retains older evidence', async () => {
  await withMetadata(async ({ metadata }) => {
    addTopic(metadata, 'topic-evidence'); addSource(metadata, 'topic-evidence');
    let fail = false;
    const runner = createTopicAnalysisRunner({ metadata, now: () => Date.parse('2026-08-24T07:00:00Z'), analyzer: async ({ topic, sources }) => { if (fail) throw new Error('fictional provider unavailable'); return [proposal(topic, sources[0].observedRevision)]; } });
    const baseline = await runner.run({ trigger: 'manual' });
    assert.equal(baseline.baseline, true); assert.equal(baseline.proposalCount, 0); assert.equal(metadata.listTopicAnalysisWatermarks().length, 2);
    metadata.updateSourceReference({ version: 1, referenceId: sourceId, observedRevision: sourceRevision(2), updatedAt: '2026-08-25T07:00:00.000Z' });
    fail = true;
    const failed = await runner.run({ trigger: 'manual' });
    assert.equal(failed.outcome, 'failed'); assert.equal(metadata.getTopicAnalysisWatermark(`source:${sourceId}`).observedRevision, sourceRevision(1)); assert.equal(metadata.getActivity(`activity:topic-analysis:${failed.runId}`).outcome, 'failed');
    fail = false;
    const later = await runner.run({ trigger: 'manual' });
    assert.equal(later.proposalCount, 1); assert.equal(metadata.listTopicProposals().length, 1); assert.equal(metadata.listTopicAnalysisEvidence(metadata.listTopicProposals()[0].proposalId).length, 1);
    metadata.updateSourceReference({ version: 1, referenceId: sourceId, observedRevision: sourceRevision(3), updatedAt: '2026-08-26T07:00:00.000Z' });
    await runner.run({ trigger: 'manual' });
    const stored = metadata.listTopicProposals()[0];
    assert.equal(stored.revision, 2); assert.equal(metadata.listTopicAnalysisEvidence(stored.proposalId).length, 2); assert.equal(metadata.listTopicAnalysisEvidence(stored.proposalId, { currentOnly: true }).length, 1);
  });
});

test('analysis uses the authoritative locator revision when the source-reference observation is stale', async () => {
  await withMetadata(async ({ metadata }) => {
    addTopic(metadata, 'topic-locator-revision'); addSource(metadata, 'topic-locator-revision');
    const runner = createTopicAnalysisRunner({ metadata, analyzer: async ({ topic, sources }) => [proposal(topic, sources[0].observedRevision)] });
    await runner.run({ trigger: 'manual' });
    metadata.setSourceLocator({ referenceId: sourceId, locator: 'fictional-record', ownership: 'external', observedRevision: sourceRevision(2), updatedAt: '2026-08-25T07:00:00.000Z' });
    const result = await runner.run({ trigger: 'manual' });
    const stored = metadata.listTopicProposals()[0];
    assert.equal(result.outcome, 'success');
    assert.equal(result.proposalCount, 1);
    assert.equal(metadata.listTopicAnalysisEvidence(stored.proposalId, { currentOnly: true })[0].sourceRevision, sourceRevision(2));
    assert.equal(metadata.getTopicAnalysisWatermark(`source:${sourceId}`).observedRevision, sourceRevision(2));
  });
});

test('meaningful proposal state changes increment the stable proposal revision and reset approval', async () => {
  await withMetadata(async ({ metadata }) => {
    addTopic(metadata, 'topic-proposal-revision'); addSource(metadata, 'topic-proposal-revision');
    let destination = 'resource';
    const runner = createTopicAnalysisRunner({ metadata, analyzer: async ({ topic, sources }) => [{ ...proposal(topic, sources[0].observedRevision), after: { topicId: topic.topicId, paraCategory: destination, revision: topic.revision + 1 }, rationale: destination === 'resource' ? 'The fictional source supports the first destination.' : 'The fictional source supports the revised destination.' }] });
    await runner.run({ trigger: 'manual' });
    metadata.updateSourceReference({ version: 1, referenceId: sourceId, observedRevision: sourceRevision(2), updatedAt: '2026-08-25T07:00:00.000Z' });
    const first = await runner.run({ trigger: 'weekly' });
    const stored = metadata.listTopicProposals()[0]; metadata.saveTopicProposal({ ...stored, state: 'approved', updatedAt: '2026-08-25T07:00:00.000Z' });
    destination = 'area';
    metadata.updateSourceReference({ version: 1, referenceId: sourceId, observedRevision: sourceRevision(3), updatedAt: '2026-08-26T07:00:00.000Z' });
    await runner.run({ trigger: 'weekly' });
    const predecessor = metadata.getTopicProposal(stored.proposalId); const revised = metadata.listTopicProposals().find((item) => item.predecessorId === stored.proposalId);
    assert.equal(first.proposalCount, 1); assert.equal(predecessor.state, 'superseded'); assert.equal(revised.state, 'pending'); assert.notEqual(revised.proposalId, predecessor.proposalId);
  });
});

test('an analyzed candidate operation change supersedes the continuing topic lineage', async () => {
  await withMetadata(async ({ metadata }) => {
    addTopic(metadata, 'topic-operation-successor'); addSource(metadata, 'topic-operation-successor');
    let operation = 'recategorize';
    const runner = createTopicAnalysisRunner({ metadata, analyzer: async ({ topic, sources }) => [{ ...proposal(topic, sources[0].observedRevision), operation, after: { topicId: topic.topicId, paraCategory: operation === 'archive' ? 'archive' : 'resource', revision: topic.revision + 1 }, rationale: `The fictional structural record explicitly requires ${operation}.` }] });
    await runner.run({ trigger: 'manual' });
    metadata.updateSourceReference({ version: 1, referenceId: sourceId, observedRevision: sourceRevision(2), updatedAt: '2026-08-25T07:00:00.000Z' });
    await runner.run({ trigger: 'weekly' }); const predecessor = metadata.listTopicProposals()[0];
    operation = 'archive'; metadata.updateSourceReference({ version: 1, referenceId: sourceId, observedRevision: sourceRevision(3), updatedAt: '2026-08-26T07:00:00.000Z' });
    const result = await runner.run({ trigger: 'weekly' }); const successor = metadata.listTopicProposals().find((item) => item.predecessorId === predecessor.proposalId);
    assert.equal(result.outcome, 'success'); assert.equal(metadata.getTopicProposal(predecessor.proposalId).state, 'superseded'); assert.equal(successor.operation, 'archive'); assert.equal(successor.state, 'pending');
  });
});

test('analysis scopes active and Archived Topics, excludes Provisioning and Retired, and rejects changed-topic overflow atomically', async () => {
  await withMetadata(async ({ metadata }) => {
    addTopic(metadata, 'topic-active'); addTopic(metadata, 'topic-archived', 'archive'); addTopic(metadata, 'topic-provisioning', 'area', 'provisioning'); addTopic(metadata, 'topic-retired', 'area', 'retired');
    const seen = [];
    const runner = createTopicAnalysisRunner({ metadata, analyzer: async ({ topic }) => { seen.push(topic.topicId); return []; } });
    const baseline = await runner.run({ trigger: 'manual' }); assert.equal(baseline.baseline, true);
    for (const topicId of ['topic-active', 'topic-archived']) metadata.updateTopic({ topicId, paraCategory: metadata.getTopic(topicId).paraCategory, expectedRevision: metadata.getTopic(topicId).revision, updatedAt: '2026-08-25T07:00:00.000Z' });
    const before = metadata.listTopicAnalysisWatermarks();
    const bounded = createTopicAnalysisRunner({ metadata, maxChangedTopics: 1, analyzer: async ({ topic }) => { seen.push(topic.topicId); return []; } });
    const first = await bounded.run({ trigger: 'weekly' });
    assert.equal(first.outcome, 'failed'); assert.equal(first.retainedOverflowCount, 1); assert.deepEqual(metadata.listTopicAnalysisWatermarks(), before); assert.deepEqual(metadata.listTopicProposals(), []);
  });
});

test('analysis operation replay returns the durable result without a second run Activity', async () => {
  await withMetadata(async ({ metadata }) => {
    addTopic(metadata, 'topic-replay');
    const runner = createTopicAnalysisRunner({ metadata, analyzer: () => [] });
    const first = await runner.run({ trigger: 'manual', logicalOperationId: 'analysis-operation-fictional' });
    const count = metadata.listActivity().length;
    const replay = await runner.run({ trigger: 'manual', logicalOperationId: 'analysis-operation-fictional' });
    assert.deepEqual(replay, first); assert.equal(metadata.listActivity().length, count);
    await assert.rejects(runner.run({ trigger: 'weekly', logicalOperationId: 'analysis-operation-fictional' }), (error) => error.code === 'intent-mismatch');
  });
});

test('invalid dependency graphs and proposal overflow fail before publication or watermark advancement', async () => {
  await withMetadata(async ({ metadata }) => {
    addTopic(metadata, 'topic-atomic'); addSource(metadata, 'topic-atomic');
    const baseline = createTopicAnalysisRunner({ metadata, analyzer: async () => [] }); await baseline.run({ trigger: 'manual' });
    metadata.updateSourceReference({ version: 1, referenceId: sourceId, observedRevision: sourceRevision(2), updatedAt: '2026-08-25T07:00:00.000Z' });
    const before = metadata.listTopicAnalysisWatermarks();
    const invalid = createTopicAnalysisRunner({ metadata, analyzer: async ({ topic, sources }) => [{ ...proposal(topic, sources[0].observedRevision), dependencies: ['sha256:missing'] }] });
    assert.equal((await invalid.run({ trigger: 'weekly' })).outcome, 'failed'); assert.deepEqual(metadata.listTopicAnalysisWatermarks(), before); assert.deepEqual(metadata.listTopicProposals(), []);
    const overflow = createTopicAnalysisRunner({ metadata, maxProposals: 1, analyzer: async ({ topic, sources }) => [proposal(topic, sources[0].observedRevision), { ...proposal(topic, sources[0].observedRevision), after: { topicId: topic.topicId, paraCategory: 'project', revision: topic.revision + 1 } }] });
    assert.equal((await overflow.run({ trigger: 'weekly' })).outcome, 'failed'); assert.deepEqual(metadata.listTopicAnalysisWatermarks(), before); assert.deepEqual(metadata.listTopicProposals(), []);
  });
});

test('evidence kind survives durable storage so gated digests remain stable after reopen', async () => {
  await withMetadata(async ({ root, metadata }) => {
    addTopic(metadata, 'topic-kind'); addSource(metadata, 'topic-kind');
    const before = { topicId: 'topic-kind', paraCategory: 'area', revision: 0 }; const after = { topicId: 'topic-kind', paraCategory: 'resource', revision: 1 };
    const proposalId = proposalIdentity({ operation: 'recategorize', affectedTopicIds: ['topic-kind'], affectedSourceIds: [sourceId], plannedSourceIds: [], before, after });
    metadata.saveTopicProposal({
      schemaVersion: 1,
      proposalId,
      revision: 1,
      operation: 'recategorize',
      affectedTopicIds: ['topic-kind'],
      affectedSourceIds: [sourceId],
      plannedSourceIds: [],
      before,
      after,
      rationale: 'A fictional direct observation supports the category boundary.',
      provenance: { source: 'fictional-provider' },
      searchRetrievalConsequences: { category: 'Topic identity remains unchanged.' },
      dependencies: [],
      blockers: [],
      reversibility: { reversible: true, irreversible: false, ambiguity: null },
      materialEvidenceDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      state: 'pending',
      createdAt: '2026-08-24T07:00:00Z',
      updatedAt: '2026-08-24T07:00:00Z'
    });
    metadata.setTopicAnalysisEvidence(proposalId, [{ evidenceId: 'evidence-kind', sourceId, sourceRevision: sourceRevision(1), fact: 'The fictional record states a concrete category boundary.', material: true, kind: 'direct-observation', observedAt: '2026-08-24T07:00:00Z' }]);
    metadata.close();
    const reopened = openCommandCenterMetadataService({ stateDir: root, capabilities: { analysis: true, activity: true } });
    assert.equal(reopened.listTopicAnalysisEvidence()[0].kind, 'direct-observation');
    reopened.close();
  });
});

test('schema-7 forward migration creates durable analysis tables and survives reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-topic-analysis-migration-'));
  const databasePath = resolveCommandCenterDatabasePath(root); await mkdir(path.dirname(databasePath), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(metadataSchemaV7Sql);
  legacy.prepare('INSERT INTO topics (topic_id, para_category, lifecycle, revision, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('topic-migrated', 'area', 'active', 0, 'topic-migrated', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
  legacy.close();
  const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { analysis: true, activity: true } });
  assert.notEqual(metadata.getOperatingStatus().mode, 'recovery-only'); assert.equal(metadata.getOperatingStatus().schemaVersion, 8);
  metadata.setTopicAnalysisSettings({ schemaVersion: 1, enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', revision: 1, initialized: true, nextDueAt: '2026-08-31T07:00:00.000Z', updatedAt: '2026-08-24T07:00:00.000Z' });
  metadata.setTopicAnalysisCursor({ nextTopicId: 'topic-migrated', nextSourceId: null, updatedAt: '2026-08-24T07:00:00.000Z' });
  metadata.close();
  const reopened = openCommandCenterMetadataService({ stateDir: root, capabilities: { analysis: true, activity: true } });
  assert.equal(reopened.getTopicAnalysisSettings().localTime, '07:00'); assert.equal(reopened.getTopicAnalysisCursor().nextTopicId, 'topic-migrated');
  const database = new DatabaseSync(reopened.databasePath, { readOnly: true });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 8);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'topic_analysis_%' ORDER BY name").all().map((row) => row.name), ['topic_analysis_cursors', 'topic_analysis_evidence', 'topic_analysis_runs', 'topic_analysis_settings', 'topic_analysis_watermarks']);
  database.close(); reopened.close(); await rm(root, { recursive: true, force: true });
});
