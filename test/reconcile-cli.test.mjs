import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import plugin from '../src/plugin.mjs';
import { producerSourceExternalId, readPinnedProducerIntakePlan, readProducerIntakePlanDigest, readPinnedReconciliationPlan, registerReconciliationCli, runConfiguredHistoricalBackfill, runConfiguredNoteFolderRecovery, runConfiguredProducerIntake, runConfiguredEmailReaderPlan, runConfiguredReconciliation, runConfiguredTopicPreparation } from '../src/migration/reconcile-cli.mjs';
import { reconciliationPlanDigest } from '../src/migration/reconcile.mjs';
import { historicalBackfillPlanDigest } from '../src/open-loops/historical-backfill.mjs';
import { producerIntakePlanDigest } from '../src/open-loops/producer-intake-plan.mjs';
import { emailReaderPlanDigest } from '../src/open-loops/email-reader-plan.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { revisionForBytes } from '../src/sources/reference.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { createHostFileAccessFixture, installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

const releaseHostFileAccessFixture = installHostFileAccessFixture();
test.after(() => releaseHostFileAccessFixture());

test('CLI metadata declares lazy reconciliation without runtime activation', async () => {
  let registration; let declaration;
  plugin.register({ registrationMode: 'cli-metadata', registerCli(callback, metadata) { registration = callback; declaration = metadata; },
    get runtime() { throw new Error('No activation during discovery'); }, get notifications() { throw new Error('No notification authority'); } });
  assert.deepEqual(declaration.descriptors.map(item => item.name), ['command-center']);
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.cliCommands, declaration.descriptors, 'native command ownership must be discoverable before runtime registration');
  const paths = []; const actions = []; const required = [];
  const command = name => ({ command(child) { return command(`${name} ${child}`.trim()); }, description() { return this; },
    requiredOption(option) { required.push([name, option]); return this; }, action(callback) { paths.push(name); actions.push(callback); return this; } });
  await registration({ program: command(''), config: {}, logger: {} });
  assert.deepEqual(paths, [
    ...['reconcile', 'prepare-topic'].flatMap(command => ['preflight', 'execute', 'resume', 'verify'].map(mode => `command-center ${command} ${mode}`)),
    'command-center initialize-metadata execute', 'command-center initialize-metadata verify',
    ...['preflight', 'execute', 'verify'].map(mode => `command-center recover-note-folders ${mode}`),
    ...['preview', 'apply', 'withdraw'].map(mode => `command-center backfill ${mode}`),
    'command-center intake digest', 'command-center intake apply', 'command-center intake reader-digest', 'command-center intake reader-apply',
    'command-center verify-discoverability'
  ]);
  assert.equal(required.length, 44); assert.equal(actions.length, 21);
});

test('producer intake digest uses the package canonicalizer and rejects dishonest enumeration', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'producer-intake-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = { schemaVersion: 1, purpose: 'command-center-producer-intake', runId: 'fictional-digest', sourceKind: 'email', sourceNamespace: 'fictional-graph:account-one', scope: { accountBinding: 'fictional-account-one', folders: ['inbox'], sinceUtc: '2026-09-15T12:40:00.000Z', beforeUtc: '2026-09-22T12:40:00.000Z', maxMessages: 5, batchKind: 'canary' }, processorVersion: 'fictional-v1', nextExpectedAt: '2026-09-22T12:00:00.000Z',
    enumeration: { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false }, records: [{ schemaVersion: 1, sourceExternalId: 'fictional-message', sourceVersion: 'fictional-change-key', checkpoint: 'fictional-checkpoint', acceptedExtraction: { schemaVersion: 1, notePath: '', knowledgeMarkdown: '', obligations: [] } }] };
  const planPath = path.join(root, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
  assert.equal(await readProducerIntakePlanDigest(planPath), producerIntakePlanDigest(plan));
  assert.throws(() => producerIntakePlanDigest({ ...plan, scope: { ...plan.scope, maxMessages: 6 } }), error => error.code === 'producer-plan-invalid');
  assert.throws(() => producerIntakePlanDigest({ ...plan, sourceNamespace: undefined }), error => error.code === 'producer-plan-invalid');
  assert.throws(() => producerIntakePlanDigest({ ...plan, enumeration: { ...plan.enumeration, scannedCount: 6 } }), error => error.code === 'producer-plan-invalid');
  plan.enumeration.scannedCount = 0; await writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(() => readProducerIntakePlanDigest(planPath), error => error.code === 'producer-plan-invalid');
});

test('producer intake CLI consumes accepted extraction with distinct upstream and retained Note revisions', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'producer-intake-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'); const notePath = 'Inbox/Fictional accepted email.md'; const noteFile = path.join(vault, 'Inbox', 'Fictional accepted email.md');
  await mkdir(path.dirname(noteFile), { recursive: true });
  const noteBytes = Buffer.from('# Fictional accepted email\n', 'utf8'); await writeFile(noteFile, noteBytes);
  const noteRevision = revisionForBytes(noteBytes);
  const plan = { schemaVersion: 1, purpose: 'command-center-producer-intake', runId: 'fictional-email-handoff-1', sourceKind: 'email', sourceNamespace: 'fictional-graph:account-one', scope: { accountBinding: 'fictional-account-one', folders: ['inbox'], sinceUtc: '2026-09-15T12:40:00.000Z', beforeUtc: '2026-09-22T12:40:00.000Z', maxMessages: 5, batchKind: 'canary' }, processorVersion: 'fictional-email-processor-v1', nextExpectedAt: '2026-09-22T12:00:00.000Z',
    enumeration: { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false }, records: [{ schemaVersion: 1, sourceExternalId: 'fictional-message-id', sourceVersion: 'email-change-key-9', checkpoint: 'fictional-checkpoint-1', retainedNoteRevision: noteRevision, acceptedExtraction: {
      schemaVersion: 1, proposedTopic: 'Fictional Email Intake', notePath, knowledgeMarkdown: '# Fictional accepted email\n', knowledgeOutcomeId: 'fictional-message:information', knowledgeSummary: 'Fictional email retained', obligations: [{ obligationId: 'fictional-message:payment', title: 'Pay fictional accepted invoice', provenance: 'explicit', importance: 'high', importanceOrigin: 'source' }]
    } }] };
  const planPath = path.join(root, 'producer-plan.json'); await writeFile(planPath, JSON.stringify(plan));
  assert.deepEqual(await readPinnedProducerIntakePlan(planPath, producerIntakePlanDigest(plan)), { ...plan, records: plan.records.map(item => ({ ...item, acceptedExtraction: { ...item.acceptedExtraction, obligations: item.acceptedExtraction.obligations.map(obligation => ({ ...obligation, classification: 'obligation' })) } })) });
  const saved = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = root;
  const hostFileAccess = createHostFileAccessFixture();
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { notes: true } });
    metadata.createTopic({ topicId: 'topic-fictional-email-intake', name: 'Fictional Email Intake', paraCategory: 'area', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-email-intake', topicId: 'topic-fictional-email-intake', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault });
    await enrollFixtureFolder(metadata, 'folder:fictional-email-intake', vault);
    assert.notEqual(noteRevision, plan.records[0].sourceVersion);
    metadata.createSourceReference({ version: 1, referenceId: 'note:fictional-accepted-email', topicId: 'topic-fictional-email-intake', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${vault}/${notePath}`, observedRevision: noteRevision });
    metadata.close();
    const first = await runConfiguredProducerIntake({ planPath, expectedDigest: producerIntakePlanDigest(plan), config: {}, hostFileAccess });
    const replay = await runConfiguredProducerIntake({ planPath, expectedDigest: producerIntakePlanDigest(plan), config: {}, hostFileAccess });
    assert.equal(first.status, 'healthy-processed'); assert.equal(replay.status, 'healthy-processed');
    const readerPlan = { schemaVersion: 1, purpose: 'command-center-email-reader-locators', sourceNamespace: plan.sourceNamespace, records: [{ sourceExternalId: 'fictional-message-id', sourceVersion: 'email-change-key-9', messageId: 'fictional-moved-message-id', status: 'available', webLink: 'https://outlook.office.com/mail/archive/id/fictional-moved-message-id', observedAt: '2026-09-22T13:00:00.000Z' }] };
    const readerPath = path.join(root, 'reader-plan.json'); await writeFile(readerPath, JSON.stringify(readerPlan));
    assert.deepEqual(await runConfiguredEmailReaderPlan({ planPath: readerPath, expectedDigest: emailReaderPlanDigest(readerPlan) }), { schemaVersion: 1, status: 'applied', count: 1, recorded: 1, updated: 0, duplicate: 0, stale: 0 });
    assert.deepEqual(await runConfiguredEmailReaderPlan({ planPath: readerPath, expectedDigest: emailReaderPlanDigest(readerPlan) }), { schemaVersion: 1, status: 'applied', count: 1, recorded: 0, updated: 0, duplicate: 1, stale: 0 });
    const verification = openCommandCenterMetadataService({ stateDir: root, capabilities: { notes: true } });
    try {
      const loops = verification.listOpenLoops(); assert.equal(loops.length, 1); assert.equal(loops[0].title, 'Pay fictional accepted invoice'); assert.equal(loops[0].revision, 1);
      const observation = loops[0].evidenceObservationIds.map(id => verification.getOpenLoopObservation(id)).find(item => item?.facts?.obligationId === 'fictional-message:payment');
      assert.equal(observation.facts.sourceVersion, 'email-change-key-9');
      assert.equal(observation.source.externalId, producerSourceExternalId('fictional-graph:account-one', 'fictional-message-id'));
      const account = verification.listOperations().find(item => item.operationKind === 'intake-source.email.v1');
      assert.equal(account.observedRevision, 'email-change-key-9');
      assert.equal(verification.getEmailReaderLocator(observation.source.externalId, observation.facts.sourceVersion).webLink, readerPlan.records[0].webLink);
    } finally { verification.close(); }
  } finally { if (saved === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = saved; }
});

test('producer source namespace encoding cannot collide across ambiguous separators', () => {
  assert.notEqual(producerSourceExternalId('a:b', 'c'), producerSourceExternalId('a', 'b:c'));
  assert.match(producerSourceExternalId('a:b', 'c'), /^namespaced:v1:sha256:[a-f0-9]{64}$/u);
});

test('historical backfill CLI runs a digest-pinned private adapter with durable metadata', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backfill-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'plan.json');
  const adapterPath = path.join(root, 'adapter.mjs');
  const vault = path.join(root, 'vault');
  const plan = { schemaVersion: 1, backfillId: 'fictional-cli-preview', sourceKind: 'email', scope: { topicIds: [], topicNames: [], maxRecords: 1 } };
  const adapterSource = `export function createHistoricalBackfillAdapter({ commandCenter }) { if (!commandCenter || 'metadata' in commandCenter) throw new Error('bounded-owner-required'); return {
    async readPage() { return { records: [{ schemaVersion: 1, sourceExternalId: 'fictional', sourceVersion: '1', checkpoint: '001' }], next: '001', done: true }; },
    async classify() { return { schemaVersion: 1, disposition: 'actionable', obligationId: 'fictional', title: 'Review fictional work', topicName: 'Fictional CLI', notePath: 'Inbox/Fictional.md', provenance: 'explicit', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-21T00:00:00.000Z' }; },
    async applyRecord(input) { const topic = commandCenter.resolveTopic({ topicName: input.classification.topicName }); const evidence = await commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: input.classification.notePath }); return commandCenter.captureCommitment({ logicalOperationId: input.logicalOperationId, capture: { schemaVersion: 1, sourceKind: input.sourceKind, sourceExternalId: input.record.sourceExternalId, sourceVersion: input.record.sourceVersion, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.path, topicId: topic.topicId, title: input.classification.title, obligationId: input.classification.obligationId, provenance: input.classification.provenance, occurredAt: input.classification.occurredAt, observedAt: input.classification.observedAt } }); },
    async reconcileRecord(input) { const topic = commandCenter.resolveTopic({ topicName: input.classification.topicName }); const evidence = await commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: input.classification.notePath }); return commandCenter.reconcileCommitment({ logicalOperationId: input.logicalOperationId, capture: { schemaVersion: 1, sourceKind: input.sourceKind, sourceExternalId: input.record.sourceExternalId, sourceVersion: input.record.sourceVersion, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.path, topicId: topic.topicId, title: input.classification.title, obligationId: input.classification.obligationId, provenance: input.classification.provenance, occurredAt: input.classification.occurredAt, observedAt: input.classification.observedAt } }); },
    async inspectEffect(input) { return commandCenter.inspectEffect(input); },
    async withdrawEffect(input) { return commandCenter.withdrawEffect(input); },
    async reconcileWithdrawal(input) { return commandCenter.reconcileWithdrawal(input); },
    async recordReceipt() {}
  }; }\n`;
  await writeFile(planPath, JSON.stringify(plan)); await writeFile(adapterPath, adapterSource);
  const adapterDigest = `sha256:${(await import('node:crypto')).createHash('sha256').update(adapterSource).digest('hex')}`;
  const saved = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = root;
  const hostFileAccess = createHostFileAccessFixture();
  try {
    await mkdir(path.join(vault, 'Inbox'), { recursive: true });
    const noteBytes = Buffer.from('# Fictional evidence\n', 'utf8');
    await writeFile(path.join(vault, 'Inbox', 'Fictional.md'), noteBytes);
    const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { notes: true } });
    metadata.createTopic({ topicId: 'topic-fictional-cli', name: 'Fictional CLI', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-cli', topicId: 'topic-fictional-cli', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault });
    await enrollFixtureFolder(metadata, 'folder:fictional-cli', vault);
    metadata.createSourceReference({ version: 1, referenceId: 'note:fictional-cli', topicId: 'topic-fictional-cli', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${vault}/Inbox/Fictional.md`, observedRevision: revisionForBytes(noteBytes) });
    metadata.close();
    const result = await runConfiguredHistoricalBackfill({ mode: 'preview', planPath, expectedDigest: historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: adapterDigest, config: {}, hostFileAccess });
    assert.equal(result.complete, true); assert.equal(result.counts.created, 0);
    const applied = await runConfiguredHistoricalBackfill({ mode: 'apply', planPath, expectedDigest: historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: adapterDigest, config: {}, hostFileAccess });
    assert.equal(applied.counts.created, 1);
    const withdrawn = await runConfiguredHistoricalBackfill({ mode: 'withdraw', planPath, expectedDigest: historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: adapterDigest, config: {}, hostFileAccess });
    assert.equal(withdrawn.counts.withdrawn, 1);
    await assert.rejects(runConfiguredHistoricalBackfill({ mode: 'preview', planPath, expectedDigest: historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: `sha256:${'0'.repeat(64)}`, config: {}, hostFileAccess }), { code: 'backfill-adapter-digest-mismatch' });
  } finally { if (saved === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = saved; }
});

test('Note Folder recovery CLI rejects an unpinned or noncanonical plan before opening metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-recovery-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'plan.json');
  const plan = { schemaVersion: 1, purpose: 'command-center-note-folder-recovery', stateDirectory: root, bindings: [] };
  await writeFile(planPath, JSON.stringify(plan));
  const saved = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = root;
  try {
    await assert.rejects(runConfiguredNoteFolderRecovery({ mode: 'execute', planPath, expectedDigest: reconciliationPlanDigest(plan), config: { plugins: { entries: { 'command-center': { config: { topics: { noteRoot: root } } } } } } }), { code: 'note-folder-recovery-plan-invalid' });
  } finally { if (saved === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = saved; }
});

test('a noncanonical preparation name is refused before native SDK or metadata initialization', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prepare-cli-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'plan.json');
  const saved = Object.fromEntries(['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_HOME'].map(key => [key, process.env[key]]));
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'openclaw.json');
  process.env.OPENCLAW_HOME = root;
  try {
  const plan = { schemaVersion: 1, logicalOperationId: randomUUID(), topicId: randomUUID(), name: ' Garden ', paraCategory: 'area',
    folderPath: path.join(root, 'Areas', 'Garden'), noteVaultRoots: [root], protectedSessions: [
      { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'fictional-main', lifecycleRevision: null }
    ] };
  await writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(runConfiguredTopicPreparation({ mode: 'execute', planPath, expectedDigest: reconciliationPlanDigest(plan),
    config: { plugins: { entries: { 'command-center': { config: { topics: { noteRoot: root } } } } } } }), { code: 'preparation-plan-invalid' });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('private plan reads are bounded, digest-pinned and cannot enable import without a configured reader', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reconcile-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'plan.json');
  const plan = { schemaVersion: 1, sourceOptions: { root: '/fictional/preserved-source' } };
  const digest = reconciliationPlanDigest(plan);
  await writeFile(filename, JSON.stringify(plan));
  assert.deepEqual(await readPinnedReconciliationPlan(filename, digest), plan);
  await assert.rejects(readPinnedReconciliationPlan(filename, '0'.repeat(64)), { code: 'reconciliation-plan-digest-mismatch' });
  await assert.rejects(runConfiguredReconciliation({ mode: 'execute', planPath: filename, expectedDigest: digest, config: {} }), { code: 'reconciliation-reader-not-configured' });
  await writeFile(filename, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(readPinnedReconciliationPlan(filename, digest), { code: 'reconciliation-plan-unsafe' });
});
