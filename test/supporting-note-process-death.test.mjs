import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { createCommitmentCaptureService } from '../src/open-loops/commitment-capture.mjs';
import { prepareSupportingNoteAnnotation } from '../src/open-loops/supporting-note-annotation.mjs';
import { createMetadataService } from '../src/plugin-service.mjs';
import { createHostFileAccessFixture, installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';

for (const clarifyBeforeRecovery of [false, true]) test(
  clarifyBeforeRecovery
    ? 'clarification after process death keeps published Note bytes visible as an unknown prior effect'
    : 'a saved bill decision recovers its exact Note after process death at filesystem publication',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-follow-up-death-'));
    const root = path.join(stateDir, 'vault');
    const notePath = 'Inbox/fictional-bill.md';
    const original = '# Fictional bill\n';
    const decisionId = randomUUID();
    let metadata; let source; let service;
    const releaseFixture = installHostFileAccessFixture();
    try {
      await mkdir(path.join(root, 'Inbox'), { recursive: true });
      await writeFile(path.join(root, notePath), original);
      metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
      metadata.createTopic({ topicId: 'topic-fictional-bill', name: 'Fictional bills', paraCategory: 'area', lifecycle: 'active' });
      metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-bill', topicId: 'topic-fictional-bill',
        sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root });
      await enrollFixtureFolder(metadata, 'folder:fictional-bill', root);
      source = createAuthoritativeSourceService({ metadata, root, capabilities: { notes: true }, noteRecoveryEffects: false,
        fsSafeRootFactory: async rootDir => ({ rootDir, rootReal: rootDir, resolve: async relative => path.join(rootDir, relative) }) });
      const note = await source.notesRead({ schemaVersion: 1, topicId: 'topic-fictional-bill', path: notePath });
      const captured = await createCommitmentCaptureService({ metadata, sourceService: source }).capture({
        schemaVersion: 1, logicalOperationId: randomUUID(), topicId: 'topic-fictional-bill',
        sourceKind: 'email', sourceExternalId: 'fictional-source', sourceVersion: 'email-change-key-1',
        sourceReferenceId: note.sourceReference.referenceId, sourcePath: notePath, sourceReferenceVersion: note.revision,
        title: 'Pay fictional bill', obligationId: 'fictional-payment', obligationKind: 'payment', provenance: 'explicit',
        occurredAt: '2026-09-24T00:00:00.000Z', observedAt: '2026-09-24T00:01:00.000Z', historicalBaseline: false
      });
      const accepted = metadata.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: decisionId,
        loopId: captured.loop.loopId, expectedRevision: captured.loop.revision, paymentState: 'paid', actorId: 'fictional-operator',
        rationale: 'Fictional user assertion; no payment occurred.', updatedAt: '2026-09-24T00:02:00.000Z' });
      assert.equal(accepted.supportingNoteTarget.status, 'ready');
      assert.throws(() => metadata.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: randomUUID(),
        expectedRevision: accepted.loop.revision,
        loop: { ...accepted.loop, revision: accepted.loop.revision + 1 },
        evidenceRoles: {}, updatedAt: '2026-09-24T00:03:00.000Z' }),
      error => error.code === 'open-loop-follow-up-pending', 'source publication cannot strand the accepted Note effect');
      const desired = prepareSupportingNoteAnnotation({ text: original, loopId: captured.loop.loopId,
        observation: metadata.getOpenLoopSupportingNoteIntent(decisionId).observation }).text;
      const intent = metadata.prepareOpenLoopSupportingNoteIntent({ schemaVersion: 1, decisionOperationId: decisionId,
        expectedLoopRevision: accepted.loop.revision, target: accepted.supportingNoteTarget.target, text: desired });
      const effect = { schemaVersion: 1, logicalOperationId: intent.logicalOperationId,
        topicId: 'topic-fictional-bill', referenceId: note.sourceReference.referenceId,
        path: notePath, expectedRevision: note.revision, text: intent.text };
      source.close(); source = undefined; metadata.close(); metadata = undefined;

      const child = spawn(process.execPath, ['test/fixtures/supporting-note-crash-child.mjs', stateDir, root, JSON.stringify(effect)],
        { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
      assert.deepEqual(exit, { code: null, signal: 'SIGKILL' }, stderr);
      assert.match(stdout, /supporting-note-published/u);
      const published = await stat(path.join(root, notePath));
      assert.equal(await readFile(path.join(root, notePath), 'utf8'), desired);
      metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
      assert.equal(metadata.getTopicOperation(`notes.fs:${effect.logicalOperationId}`).state, 'pending');
      assert.equal(metadata.getOperation(effect.logicalOperationId).state, 'pending');
      assert.equal(metadata.getOpenLoopSupportingNoteIntent(decisionId).outcome, undefined);
      metadata.close(); metadata = undefined;

      const api = { config: { agents: { defaults: { userTimezone: 'UTC' } } }, pluginConfig: { sourceCapabilities: { sessions: false, scheduler: false } },
        logger: { info() {}, warn() {}, error() {} }, runtime: { state: { resolveStateDir: () => stateDir }, fileAccess: createHostFileAccessFixture() } };
      service = createMetadataService(api); await service.start();
      if (clarifyBeforeRecovery) {
        const words = await service.openLoopsClarify({ schemaVersion: 1, logicalOperationId: randomUUID(),
          loopId: captured.loop.loopId, expectedRevision: accepted.loop.revision,
          authenticatedOperatorId: 'fictional-operator', rationale: 'I may have marked the wrong fictional bill paid.' });
        assert.equal(words.loop.attention.pendingClarificationId !== undefined, true);
        const prior = service.sourceService.metadata.getOpenLoopSupportingNoteIntent(decisionId);
        assert.equal(prior.outcome.status, 'unknown');
        assert.equal(prior.outcome.reason, 'prior-note-publication-unverified');
        assert.equal(await readFile(path.join(root, notePath), 'utf8'), desired);
        assert.equal((await stat(path.join(root, notePath))).ino, published.ino);
        const stopped = await service.openLoopsResumeFollowUp({ schemaVersion: 1, logicalOperationId: decisionId,
          authenticatedOperatorId: 'fictional-operator' }, { gateway: { request: async () => { throw new Error('No native Reminder is needed.'); } } });
        assert.equal(stopped.supportingNote.status, 'superseded');
        assert.equal(service.sourceService.metadata.getOpenLoopSupportingNoteIntent(decisionId).outcome.status, 'unknown');
        return;
      }
      const recovered = await service.openLoopsResumeFollowUp({ schemaVersion: 1, logicalOperationId: decisionId,
        authenticatedOperatorId: 'fictional-operator' }, { gateway: { request: async () => { throw new Error('No native Reminder is needed for this paid assertion.'); } } });
      assert.equal(recovered.supportingNote.status, 'completed', JSON.stringify(recovered));
      assert.equal((await stat(path.join(root, notePath))).ino, published.ino, 'recovery must not publish a second Note inode');
      assert.equal(await readFile(path.join(root, notePath), 'utf8'), desired);
      assert.equal(service.sourceService.metadata.getOperation(effect.logicalOperationId).state, 'applied');
      assert.equal(service.sourceService.metadata.getOpenLoopSupportingNoteIntent(decisionId).outcome.status, 'completed');
      const replay = await service.openLoopsResumeFollowUp({ schemaVersion: 1, logicalOperationId: decisionId,
        authenticatedOperatorId: 'fictional-operator' }, { gateway: { request: async () => { throw new Error('No native Reminder is needed for replay.'); } } });
      assert.equal(replay.supportingNote.status, 'completed');
      assert.equal((await stat(path.join(root, notePath))).ino, published.ino);
    } finally {
      await service?.stop(); source?.close(); metadata?.close(); releaseFixture();
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
