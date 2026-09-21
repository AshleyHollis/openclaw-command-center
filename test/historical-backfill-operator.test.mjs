import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createHistoricalBackfillOperator } from '../src/open-loops/historical-backfill-operator.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { revisionForBytes } from '../src/sources/reference.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

const releaseHostFileAccessFixture = installHostFileAccessFixture();
test.after(() => releaseHostFileAccessFixture());
const linuxTest = process.platform === 'linux' ? test : test.skip;
const fsSafeRootFactory = async rootDir => ({ rootDir, rootReal: rootDir, resolve: async relative => path.join(rootDir, relative), open: async relative => ({ handle: await (await import('node:fs/promises')).open(path.join(rootDir, relative), 'r') }) });
const plan = { schemaVersion: 1, backfillId: 'fictional-owner', sourceKind: 'email', scope: { topicIds: [], topicNames: ['Fictional Home'], maxRecords: 2 } };
const capture = overrides => ({ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-1', sourceVersion: 'message-v1', sourceReferenceId: 'note:fictional-invoice', sourcePath: 'Invoices/Fictional.md', topicId: 'topic-fictional-home', title: 'Review fictional council invoice', obligationId: 'fictional-council-invoice', provenance: 'explicit', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-21T01:00:00.000Z', ...overrides });
const recordInput = overrides => ({ backfillId: plan.backfillId, logicalOperationId: `sha256:${'a'.repeat(64)}`, sourceKind: 'email', record: { schemaVersion: 1, sourceExternalId: 'fictional-message-1', sourceVersion: 'message-v1', checkpoint: '001' }, classification: { schemaVersion: 1, disposition: 'actionable', title: 'Review fictional council invoice', obligationId: 'fictional-council-invoice', provenance: 'explicit', historicalBaseline: true }, ...overrides });

async function withOwner(run, { assertCurrent = () => {}, wrapSource } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-backfill-owner-'));
  const stateDir = path.join(root, 'state');
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'Invoices'), { recursive: true });
  const noteBytes = Buffer.from('# Fictional invoice\n', 'utf8');
  await writeFile(path.join(vault, 'Invoices', 'Fictional.md'), noteBytes);
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  metadata.createTopic({ topicId: 'topic-fictional-home', name: 'Fictional Home', paraCategory: 'area', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-home', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault });
  await enrollFixtureFolder(metadata, 'folder:fictional-home', vault);
  metadata.createSourceReference({ version: 1, referenceId: 'note:fictional-invoice', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${vault}/Invoices/Fictional.md`, observedRevision: revisionForBytes(noteBytes) });
  const realSource = createAuthoritativeSourceService({ metadata, fsSafeRootFactory, capabilities: { notes: true } });
  const sourceService = wrapSource ? wrapSource(realSource) : realSource;
  let effects = [];
  const owner = createHistoricalBackfillOperator({ metadata, sourceService, plan, assertCurrent, now: () => '2026-09-21T02:00:00.000Z', loadBackfillState: async () => ({ effects }) });
  try { return await run({ metadata, sourceService, owner, setEffects: value => { effects = value; } }); }
  finally { realSource.close(); metadata.close(); await rm(root, { recursive: true, force: true }); }
}

async function admittedCapture(owner, input = recordInput(), value = capture()) {
  return owner.runWithRecordAuthority(input, async () => {
    const topic = owner.commandCenter.resolveTopic({ topicName: 'Fictional Home' });
    const evidence = await owner.commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: value.sourcePath });
    assert.equal(evidence.sourceReferenceId, value.sourceReferenceId);
    return owner.commandCenter.captureCommitment({ logicalOperationId: input.logicalOperationId, capture: value });
  });
}

linuxTest('real Note owner resolves exact evidence, captures, and replays one historical commitment', async () => {
  await withOwner(async ({ metadata, owner }) => {
    assert.throws(() => owner.commandCenter.resolveTopic({ topicName: 'Fictional Home' }), { code: 'backfill-record-authority-required' });
    const input = recordInput();
    const first = await admittedCapture(owner, input);
    assert.equal(first.disposition, 'created');
    assert.equal(metadata.getOpenLoop(first.effectId).attention.currentEvidence, false);
    const replay = await owner.runWithRecordAuthority(input, async () => {
      const topic = owner.commandCenter.resolveTopic({ topicName: 'Fictional Home' });
      await owner.commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: 'Invoices/Fictional.md' });
      return owner.commandCenter.reconcileCommitment({ logicalOperationId: input.logicalOperationId, capture: capture() });
    });
    assert.deepEqual(replay, { status: 'applied', result: first });
    assert.equal(metadata.listOpenLoops().length, 1);
  });
});

linuxTest('record authority rejects missing evidence, mismatched sources, and out-of-scope Topics', async () => {
  await withOwner(async ({ owner }) => {
    const input = recordInput();
    await assert.rejects(() => owner.runWithRecordAuthority(input, () => owner.commandCenter.captureCommitment({ logicalOperationId: input.logicalOperationId, capture: capture() })), { code: 'backfill-capture-evidence-required' });
    await assert.rejects(() => owner.runWithRecordAuthority(input, async () => {
      const topic = owner.commandCenter.resolveTopic({ topicName: 'Fictional Home' });
      await owner.commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: 'Invoices/Fictional.md' });
      return owner.commandCenter.captureCommitment({ logicalOperationId: input.logicalOperationId, capture: capture({ sourceKind: 'note' }) });
    }), { code: 'backfill-capture-authority-mismatch' });
    assert.throws(() => owner.runWithRecordAuthority(input, () => owner.commandCenter.resolveTopic({ topicName: 'Other Topic' })), { code: 'backfill-topic-out-of-scope' });
  });
});

linuxTest('cancellation after the real Note read fences the SQLite commitment commit', async () => {
  const controller = new AbortController();
  await withOwner(async ({ metadata, owner }) => {
    const input = recordInput();
    await assert.rejects(() => owner.runWithRecordAuthority(input, async () => {
      const topic = owner.commandCenter.resolveTopic({ topicName: 'Fictional Home' });
      await owner.commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: 'Invoices/Fictional.md' });
      controller.abort();
      return owner.commandCenter.captureCommitment({ logicalOperationId: input.logicalOperationId, capture: capture() });
    }), { name: 'AbortError' });
    assert.equal(metadata.listOpenLoops().length, 0);
  }, { assertCurrent: () => controller.signal.throwIfAborted() });
});

linuxTest('effect authority permits only the exact effect recorded by this backfill', async () => {
  await withOwner(async ({ metadata, owner, setEffects }) => {
    const created = await admittedCapture(owner);
    setEffects([created]);
    assert.deepEqual(await owner.runWithEffectAuthority({ effectId: created.effectId }, () => owner.commandCenter.inspectEffect({ effectId: created.effectId })), { revision: 1, userDecided: false });
    const withdrawal = { logicalOperationId: `sha256:${'c'.repeat(64)}`, effectId: created.effectId, expectedRevision: 1 };
    assert.deepEqual(await owner.runWithEffectAuthority(withdrawal, () => owner.commandCenter.withdrawEffect(withdrawal)), { status: 'applied' });
    assert.equal(metadata.getOpenLoop(created.effectId).state, 'cancelled');
    await assert.rejects(() => owner.runWithEffectAuthority({ effectId: 'open-loop:foreign' }, () => owner.commandCenter.inspectEffect({ effectId: 'open-loop:foreign' })), { code: 'backfill-effect-not-owned' });
  });
});
