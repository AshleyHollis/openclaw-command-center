import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withIsolatedWorld } from '../../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, launchPinnedHost, restartPinnedHost, stopPinnedHost, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { isCommandCenterMetadataReady } from '../../src/acceptance-readiness.mjs';
import { resolveCommandCenterDatabasePath } from '../../src/metadata/path.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { revisionForBytes } from '../../src/sources/reference.mjs';
import { withDeadline, requestAuthenticatedGateway, stopHostOnAbort } from './real-host-runtime.mjs';
import { enrollFixtureFolder } from './note-folder-fixture.mjs';

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function waitForMetadata(world, host, signal) {
  await waitForConsecutiveReadiness(
    async () => isCommandCenterMetadataReady(resolveCommandCenterDatabasePath(path.join(world.root, '.openclaw'))),
    host.earlyExit,
    { required: 2, deadlineMs: 120_000, delayMs: 100, signal }
  );
}

/**
 * Qualifies the sealed package's private-adapter boundary in a disposable
 * native host. The adapter deliberately loses its first apply reply so the
 * second invocation must reconcile the durable operation before withdrawal.
 */
export async function exerciseNativeHistoricalBackfillJourney({ descriptor, buildReceipt, signal }) {
  return withIsolatedWorld(async world => {
    const stateDir = path.join(world.root, '.openclaw');
    let host = await withDeadline('historical backfill host launch', launchSignal => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    let removeAbortCleanup = stopHostOnAbort(signal, host);
    const restartHost = async () => {
      const predecessor = host;
      host = await withDeadline('historical backfill retained host restart', restartSignal => restartPinnedHost(predecessor, { signal: restartSignal }), 120_000, signal);
      removeAbortCleanup();
      removeAbortCleanup = stopHostOnAbort(signal, host);
      await waitForMetadata(world, host, signal);
    };
    const savedStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      await waitForMetadata(world, host, signal);
      await stopPinnedHost(host.child);
      await host.outputDrained;
      removeAbortCleanup();

      const vault = world.paths.vault;
      const notePath = 'Inbox/Fictional packaged bill.md';
      const noteFile = path.join(vault, ...notePath.split('/'));
      const noteBytes = Buffer.from('# Fictional packaged bill\n\nPay the fictional test invoice.\n', 'utf8');
      await mkdir(path.dirname(noteFile), { recursive: true });
      await writeFile(noteFile, noteBytes);
      const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try {
        metadata.createTopic({ topicId: 'topic-fictional-packaged-backfill', name: 'Fictional Packaged Backfill', paraCategory: 'project', lifecycle: 'active' });
        metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-packaged-backfill', topicId: 'topic-fictional-packaged-backfill', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault });
        await enrollFixtureFolder(metadata, 'folder:fictional-packaged-backfill', vault);
        metadata.createSourceReference({ version: 1, referenceId: 'note:fictional-packaged-backfill', topicId: 'topic-fictional-packaged-backfill', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: noteFile, observedRevision: revisionForBytes(noteBytes) });
      } finally { metadata.close(); }

      const plan = { schemaVersion: 1, backfillId: 'fictional-packaged-backfill', sourceKind: 'email', scope: { topicIds: [], topicNames: ['Fictional Packaged Backfill'], maxRecords: 1 } };
      const planPath = path.join(world.tempRoot, 'fictional-backfill-plan.json');
      const adapterPath = path.join(world.tempRoot, 'fictional-backfill-adapter.mjs');
      const adapterSource = `export function createHistoricalBackfillAdapter({ commandCenter }) { return {
  async readPage() { return { records: [{ schemaVersion: 1, sourceExternalId: 'fictional-packaged-message', sourceVersion: '1', checkpoint: '001' }], next: '001', done: true }; },
  async classify() { return { schemaVersion: 1, disposition: 'actionable', obligationId: 'fictional-packaged-bill', title: 'Pay fictional packaged bill', topicName: 'Fictional Packaged Backfill', notePath: 'Inbox/Fictional packaged bill.md', provenance: 'explicit', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-21T00:00:00.000Z' }; },
  async applyRecord(input) { const topic = commandCenter.resolveTopic({ topicName: input.classification.topicName }); const evidence = await commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: input.classification.notePath }); await commandCenter.captureCommitment({ logicalOperationId: input.logicalOperationId, capture: { schemaVersion: 1, sourceKind: input.sourceKind, sourceExternalId: input.record.sourceExternalId, sourceVersion: input.record.sourceVersion, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.path, topicId: topic.topicId, title: input.classification.title, obligationId: input.classification.obligationId, provenance: input.classification.provenance, occurredAt: input.classification.occurredAt, observedAt: input.classification.observedAt } }); throw Object.assign(new Error('fictional-lost-reply'), { code: 'fictional-lost-reply' }); },
  async reconcileRecord(input) { const topic = commandCenter.resolveTopic({ topicName: input.classification.topicName }); const evidence = await commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: input.classification.notePath }); return commandCenter.reconcileCommitment({ logicalOperationId: input.logicalOperationId, capture: { schemaVersion: 1, sourceKind: input.sourceKind, sourceExternalId: input.record.sourceExternalId, sourceVersion: input.record.sourceVersion, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.path, topicId: topic.topicId, title: input.classification.title, obligationId: input.classification.obligationId, provenance: input.classification.provenance, occurredAt: input.classification.occurredAt, observedAt: input.classification.observedAt } }); },
  async inspectEffect(input) { return commandCenter.inspectEffect(input); }, async withdrawEffect(input) { return commandCenter.withdrawEffect(input); }, async reconcileWithdrawal(input) { return commandCenter.reconcileWithdrawal(input); }, async recordReceipt() {}
}; }\n`;
      await writeFile(planPath, `${JSON.stringify(plan)}\n`);
      await writeFile(adapterPath, adapterSource);
      const packagedCli = await import(pathToFileURL(path.join(world.manifest.candidate.root, 'dist', 'migration', 'reconcile-cli.mjs')).href);
      const packagedBackfill = await import(pathToFileURL(path.join(world.manifest.candidate.root, 'dist', 'open-loops', 'historical-backfill.mjs')).href);
      const options = { planPath, expectedDigest: packagedBackfill.historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: sha256(adapterSource), config: {}, signal };
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const preview = await packagedCli.runConfiguredHistoricalBackfill({ ...options, mode: 'preview' });
      assert.deepEqual({ complete: preview.complete, created: preview.counts.created, effectCount: preview.effectCount }, { complete: true, created: 0, effectCount: 0 });
      await assert.rejects(packagedCli.runConfiguredHistoricalBackfill({ ...options, mode: 'apply' }), { code: 'fictional-lost-reply' });
      const applied = await packagedCli.runConfiguredHistoricalBackfill({ ...options, mode: 'apply' });
      assert.deepEqual({ complete: applied.complete, created: applied.counts.created, effectCount: applied.effectCount }, { complete: true, created: 1, effectCount: 1 });

      await restartHost();
      const dashboard = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.dashboard.get', params: { schemaVersion: 1, activityOffset: 0, activityLimit: 50 }, signal });
      assert.match(JSON.stringify(dashboard), /Pay fictional packaged bill/u);
      await stopPinnedHost(host.child);
      await host.outputDrained;
      removeAbortCleanup();
      const withdrawn = await packagedCli.runConfiguredHistoricalBackfill({ ...options, mode: 'withdraw' });
      assert.equal(withdrawn.counts.withdrawn, 1);

      await restartHost();
      const afterWithdrawal = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.dashboard.get', params: { schemaVersion: 1, activityOffset: 0, activityLimit: 50 }, signal });
      assert.doesNotMatch(JSON.stringify(afterWithdrawal), /Pay fictional packaged bill/u);
      return Object.freeze({ packaged: true, isolatedHost: true, previewed: true, lostReplyReconciled: true, visibleAfterRestart: true, withdrawn: true, absentAfterWithdrawalRestart: true });
    } finally {
      if (savedStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = savedStateDir;
      removeAbortCleanup();
      await stopPinnedHost(host.child);
      await host.outputDrained;
      for (const generation of host.generations) { assertNoFatalHostOutput(generation.diagnostics); generation.diagnostics.guard.assertClean(); }
      await assertRecordedChildTraffic(world);
    }
  }, { candidateRoot: process.cwd() });
}
