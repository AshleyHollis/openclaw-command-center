import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, open, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { loadIntakeSourceAccount, normalizeIntakeSourcePlan, projectIntakeAccounts, recordIntakeOutcome, recordIntakeSourcePlan } from '../src/open-loops/intake-accounting.mjs';
import { recordIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';
import { createProducerIntakeAdapter } from '../src/open-loops/producer-intake.mjs';
import { sourceNoteCaptureToolFactory, sourceNoteOperationId } from '../src/open-loops/source-intake-tool.mjs';
import { intentDigest, revisionForBytes } from '../src/sources/reference.mjs';

const topicId = 'topic-fictional';
const folderId = 'folder:fictional';
const originalBytes = Buffer.from('# Fictional original\nKeep this user edit.\n');

async function fixture(sourceKind, realNoteOwner = false) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-lineage-'));
  const stateDir = path.join(parent, 'state');
  const root = path.join(parent, 'notes');
  await mkdir(path.join(root, 'Inbox'), { recursive: true });
  await writeFile(path.join(root, 'original.md'), originalBytes);
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  let releaseHost = () => {};
  let sourceService;
  let reopenNoteOwner;
  let createCount = 0;
  const upstreamKinds = [];
  let loseResponse = true;
  const extraction = { schemaVersion: 1, proposedTopic: 'Fictional Topic', notePath: 'Inbox/derived.md', knowledgeMarkdown: '# Fictional retained knowledge\nTwo fictional source facts remain.\n', knowledgeOutcomeId: 'fictional-information', obligations: [] };
  const record = { schemaVersion: 1, sourceKind, sourceExternalId: 'fictional-source-message', sourceVersion: 'source-v1', checkpoint: 'fictional-source-message', acceptedExtraction: extraction };
  metadata.createTopic({ topicId, name: 'Fictional Topic', paraCategory: 'area', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: folderId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root, observedRevision: null });
  if (realNoteOwner) {
    const { installHostFileAccessFixture } = await import('./support/host-file-access-fixture.mjs');
    const { enrollFixtureFolder } = await import('./support/note-folder-fixture.mjs');
    const { createAuthoritativeSourceService } = await import('../src/sources/service.mjs');
    releaseHost = installHostFileAccessFixture();
    await enrollFixtureFolder(metadata, folderId, root);
    reopenNoteOwner = () => createAuthoritativeSourceService({ metadata, root, capabilities: { notes: true }, fsSafeRootFactory: async rootDir => ({ rootDir, rootReal: rootDir, resolve: async relative => path.join(rootDir, relative), open: async relative => ({ handle: await open(path.join(rootDir, relative), 'r') }) }) });
    sourceService = reopenNoteOwner();
  } else {
    // The SQLite accounting regression uses a bounded Note effect fixture.
    // Linux below separately exercises the real filesystem/journal owner.
    sourceService = { async notesCreate(input) {
      assert.equal(input.sourceKind, 'note', 'the created resource remains a Note');
      const digest = intentDigest(input);
      const prior = metadata.getOperation(input.logicalOperationId);
      if (prior && prior.intentDigest !== digest) throw Object.assign(new Error('changed Note intent'), { code: 'intent-mismatch' });
      const externalSourceId = path.join(root, input.path);
      const bytes = Buffer.from(input.text);
      const revision = revisionForBytes(bytes);
      const referenceId = 'note:fictional-derived';
      if (!prior) {
        await writeFile(externalSourceId, bytes, { flag: 'wx' });
        createCount += 1;
        metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId, observedRevision: revision });
        metadata.recordOperation({ logicalOperationId: input.logicalOperationId, transportRequestId: input.requestId, intentDigest: digest, operationKind: 'notes.create', state: 'applied', resultStatus: 'applied', resultIdentity: externalSourceId, observedRevision: revision, createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' });
      }
      return { status: 'applied', value: { note: { path: input.path, revision, sourceReference: metadata.getSourceReference(referenceId) } } };
    } };
  }
  const tool = sourceNoteCaptureToolFactory({ getOwners: () => ({ metadata, sourceService }) })();
  const adapter = createProducerIntakeAdapter({
    processorVersion: 'fictional-knowledge-v1', extract: async () => { throw new Error('accepted extraction must be retained'); },
    loadIntakeSourceAccount: input => loadIntakeSourceAccount(metadata, input),
    resolveTopic: async () => ({ topicId, noteFolderReferenceId: folderId }),
    async saveSourceNote(input) {
      upstreamKinds.push(input.sourceKind);
      const replayed = !!metadata.getOperation(sourceNoteOperationId(input));
      const result = await tool.execute('fictional-note-call', input);
      if (loseResponse) { loseResponse = false; throw new Error('fictional-response-lost-after-note-effect'); }
      const { note, sourceReference } = result.details;
      return { topicId, sourceReferenceId: sourceReference.referenceId, sourcePath: note.path, sourceReferenceVersion: note.revision, replayed };
    },
    captureSourceCommitment: async () => { throw new Error('quiet knowledge must not create work'); },
    captureChatCommitment: async () => { throw new Error('quiet knowledge must not create work'); },
    recordIntakeSourcePlan: input => recordIntakeSourcePlan(metadata, { schemaVersion: 1, ...input }),
    recordIntakeOutcome: input => recordIntakeOutcome(metadata, { schemaVersion: 1, ...input }),
    recordIntakeReceipt: input => recordIntakeReceipt(metadata, { schemaVersion: 1, ...input })
  });
  return { root, record, adapter, tool, extraction, upstreamKinds, metadata: () => metadata, createCount: () => createCount,
    reopen() { sourceService.close?.(); metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } }); if (reopenNoteOwner) sourceService = reopenNoteOwner(); },
    async cleanup() { sourceService.close?.(); releaseHost(); metadata.close(); await rm(parent, { recursive: true, force: true }); } };
}

async function verifyLineage(f, sourceKind, reopen = true) {
  const request = { runId: 'fictional-original-run', sourceKind, records: [f.record], nextExpectedAt: '2026-09-23T00:00:00.000Z' };
  await assert.rejects(() => f.adapter.process(request), /fictional-response-lost-after-note-effect/u);
  const originalDerivedBytes = await readFile(path.join(f.root, f.extraction.notePath));
  assert.equal(loadIntakeSourceAccount(f.metadata(), f.record).account.outcomes[0].status, 'missing');
  if (reopen) f.reopen();
  const resumed = await f.adapter.process({ ...request, runId: 'fictional-resume-run' });
  assert.equal(resumed.status, 'healthy-processed');
  assert.equal(resumed.noteCount, 0);
  assert.ok(f.upstreamKinds.every(kind => kind === sourceKind), 'the producer preserves upstream identity');
  const account = loadIntakeSourceAccount(f.metadata(), f.record).account;
  assert.equal(account.accounted, true);
  assert.equal(account.outcomes[0].status, 'quiet');
  const evidence = account.outcomes[0];
  assert.equal(f.metadata().getSourceReference(evidence.sourceReferenceId).sourceKind, 'note');
  const expectedId = sourceNoteOperationId({ topicId, sourceKind, sourceExternalId: f.record.sourceExternalId, sourceVersion: f.record.sourceVersion });
  assert.equal(f.metadata().getOperation(expectedId).operationKind, 'notes.create');
  await f.adapter.process({ ...request, runId: 'fictional-replay-run' });
  assert.equal(projectIntakeAccounts(f.metadata(), sourceKind).length, 1);
  assert.equal(f.metadata().listOperations().filter(item => item.operationKind === `intake-outcome.${sourceKind}.v1`).length, 1);
  const derivedRecord = { ...f.record, sourceKind: 'note', sourceExternalId: evidence.sourceReferenceId, sourceVersion: evidence.sourceReferenceVersion, checkpoint: 'fictional-derived-note', existingEvidence: { topicId, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.sourcePath, sourceReferenceVersion: evidence.sourceReferenceVersion } };
  await f.adapter.process({ runId: 'fictional-derived-run', sourceKind: 'note', records: [derivedRecord], nextExpectedAt: request.nextExpectedAt });
  await f.adapter.process({ runId: 'fictional-derived-replay-run', sourceKind: 'note', records: [derivedRecord], nextExpectedAt: request.nextExpectedAt });
  assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'notes.create').length, 1);
  assert.equal(f.metadata().listOpenLoops().length, 0);
  assert.deepEqual(await readFile(path.join(f.root, f.extraction.notePath)), originalDerivedBytes);
  assert.deepEqual(await readFile(path.join(f.root, 'original.md')), originalBytes);
}

for (const sourceKind of ['email', 'note']) {
  test(`${sourceKind} quiet Note retains upstream lineage through lost response, SQLite reopen and derived Note replay`, async () => {
    const f = await fixture(sourceKind);
    try { await verifyLineage(f, sourceKind); assert.equal(f.createCount(), 1); }
    finally { await f.cleanup(); }
  });
}

test('unscoped Chat producer refuses before Note publication on Linux', { skip: process.platform !== 'linux' && 'Real Note filesystem qualification requires the supported Linux runtime' }, async () => {
  const f = await fixture('chat', true);
  try {
    await assert.rejects(() => f.adapter.process({ runId: 'fictional-unscoped-run', sourceKind: 'chat', records: [f.record], nextExpectedAt: '2026-09-23T00:00:00.000Z' }), { code: 'source-recovery' });
    assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'notes.create' || item.operationKind.startsWith('intake-source.') || item.operationKind.startsWith('intake-outcome.')).length, 0);
    await assert.rejects(() => readFile(path.join(f.root, f.extraction.notePath)), { code: 'ENOENT' });
    const displaced = `${f.root}-displaced`;
    await rename(f.root, displaced);
    await assert.rejects(() => f.tool.execute('fictional-revoked-folder', { topicId, noteFolderReferenceId: folderId, sourceKind: 'chat', sourceExternalId: 'fictional-new-message', sourceVersion: 'v2', path: 'Inbox/new.md', markdown: '# Refused fictional Note\n' }));
    assert.deepEqual(await readFile(path.join(displaced, 'original.md')), originalBytes);
  }
  finally { await f.cleanup(); }
});

for (const realNoteOwner of [false, true]) {
  test(`legacy partial Chat Note effect remains unchanged and requires explicit reconciliation (${realNoteOwner ? 'Linux Note owner' : 'SQLite accounting'})`, { skip: realNoteOwner && process.platform !== 'linux' && 'Real Note filesystem qualification requires the supported Linux runtime' }, async () => {
    const f = await fixture('chat', realNoteOwner);
    try {
      // Seed persisted pre-accepted-plan state directly; current owners correctly
      // refuse to create this legacy Chat plan without authenticated acceptance.
      const plan = normalizeIntakeSourcePlan({ schemaVersion: 1, sourceKind: 'chat', sourceExternalId: f.record.sourceExternalId, sourceVersion: f.record.sourceVersion, checkpoint: f.record.checkpoint, observedAt: '2026-09-22T00:00:00.000Z', processorVersion: 'fictional-knowledge-v1', acceptedExtraction: f.extraction, outcomes: [{ outcomeId: 'fictional-information', kind: 'information' }] });
      const hex = createHash('sha256').update(`command-center:intake-source:chat:${plan.sourceExternalId}:${plan.sourceVersion}`).digest('hex').slice(0, 32).split('');
      hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
      const id = `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
      const database = new DatabaseSync(f.metadata().databasePath);
      try {
        database.prepare('INSERT INTO operation_journal (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, id, 'sha256:fictional-legacy-plan', 'intake-source.chat.v1', 'applied', 'planned', JSON.stringify(plan), plan.sourceVersion, plan.observedAt, plan.observedAt);
      } finally { database.close(); }
      const oldParams = { topicId, noteFolderReferenceId: folderId, sourceKind: 'note', sourceExternalId: f.record.sourceExternalId, sourceVersion: f.record.sourceVersion, path: f.extraction.notePath, markdown: f.extraction.knowledgeMarkdown };
      const oldResult = await f.tool.execute('fictional-legacy-call', oldParams);
      const oldBytes = await readFile(path.join(f.root, f.extraction.notePath));
      await assert.rejects(() => f.adapter.process({ runId: 'fictional-legacy-resume', sourceKind: 'chat', records: [f.record], nextExpectedAt: '2026-09-23T00:00:00.000Z' }));
      const account = loadIntakeSourceAccount(f.metadata(), f.record).account;
      assert.equal(account.accounted, false);
      assert.equal(account.outcomes[0].status, 'missing');
      assert.equal(f.metadata().getOperation(sourceNoteOperationId(oldParams)).state, 'applied');
      assert.notEqual(f.metadata().getOperation(sourceNoteOperationId({ ...oldParams, sourceKind: 'chat' }))?.state, 'applied');
      assert.deepEqual(await readFile(path.join(f.root, f.extraction.notePath)), oldBytes);
      assert.equal(f.metadata().getSourceReference(oldResult.details.sourceReference.referenceId).sourceKind, 'note');
      assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'notes.create' && item.state === 'applied').length, 1);
      assert.deepEqual(await readFile(path.join(f.root, 'original.md')), originalBytes);
    } finally { await f.cleanup(); }
  });
}

test('Chat upstream identity is declared but an unscoped Note tool cannot acquire authority', async () => {
  const tool = sourceNoteCaptureToolFactory({ getOwners: () => ({ sourceService: { notesCreate: async () => ({ note: { sourceReference: { topicId, sourceKind: 'chat', referenceId: 'fictional-wrong-kind' } } }) } }) })();
  assert.deepEqual(tool.parameters.properties.sourceKind.enum, ['email', 'chat', 'note']);
  await assert.rejects(() => tool.execute('fictional-call', { topicId, noteFolderReferenceId: folderId, sourceKind: 'chat', sourceExternalId: 'fictional-message', sourceVersion: 'v1', path: 'fictional.md', markdown: '# Fictional\n' }), { code: 'source-recovery' });
});
