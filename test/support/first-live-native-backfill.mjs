import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureEnvironment, withIsolatedWorld } from '../../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, launchPinnedHost, restartPinnedHost, stopPinnedHost, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { isCommandCenterMetadataReady } from '../../src/acceptance-readiness.mjs';
import { resolveCommandCenterDatabasePath } from '../../src/metadata/path.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { revisionForBytes } from '../../src/sources/reference.mjs';
import { NOTE_FOLDER_IDENTITY_FILE } from '../../src/sources/note-folder-identity.mjs';
import { withDeadline, requestAuthenticatedGateway, stopHostOnAbort } from './real-host-runtime.mjs';
import { readHostNoteFolderIdentity } from './host-note-folder-identity.mjs';

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function runPackagedBackfillCli({ host, world, stateDir, mode, planPath, planDigest, adapterPath, adapterDigest, signal }) {
  const executable = host.host.runtimeExecutable || host.host.wrapper;
  const command = ['command-center', 'backfill', mode, '--plan', planPath, '--digest', planDigest, '--adapter', adapterPath, '--adapter-digest', adapterDigest];
  const args = host.host.runtimeExecutable ? [host.host.wrapper, ...command] : command;
  const guardModule = new URL('../../src/isolated-child-guard.mjs', import.meta.url);
  return new Promise((resolve, reject) => execFile(executable, args, {
    cwd: host.host.checkout, signal, timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, [fixtureEnvironment]: world.manifestPath, OPENCLAW_CONFIG_PATH: world.manifest.configPath,
      OPENCLAW_STATE_DIR: stateDir, HOME: world.root, TMPDIR: world.tempRoot, TMP: world.tempRoot, TEMP: world.tempRoot,
      COMMAND_CENTER_DISABLE_HOSTED_PLUGIN_CATALOG: '1', NODE_OPTIONS: `--import=${guardModule.href}` }
  }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
}

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
      await writeFile(path.join(vault, NOTE_FOLDER_IDENTITY_FILE), `${JSON.stringify({ version: 1, id: randomUUID() })}\n`, { flag: 'wx', mode: 0o600 });
      const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try {
        metadata.createTopic({ topicId: 'topic-fictional-packaged-backfill', name: 'Fictional Packaged Backfill', paraCategory: 'project', lifecycle: 'active' });
        metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-packaged-backfill', topicId: 'topic-fictional-packaged-backfill', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault });
        metadata.setSourceLocator({ referenceId: 'folder:fictional-packaged-backfill', locator: vault, observedRevision: await readHostNoteFolderIdentity(vault), ownership: 'external' });
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
      const packagedBackfill = await import(pathToFileURL(path.join(world.manifest.candidate.root, 'dist', 'open-loops', 'historical-backfill.mjs')).href);
      const cli = { host, world, stateDir, planPath, planDigest: packagedBackfill.historicalBackfillPlanDigest(plan), adapterPath, adapterDigest: sha256(adapterSource), signal };
      await runPackagedBackfillCli({ ...cli, mode: 'preview' });
      let verification = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try { assert.equal(verification.listOpenLoops().length, 0, 'preview must not create an effect'); }
      finally { verification.close(); }
      await assert.rejects(runPackagedBackfillCli({ ...cli, mode: 'apply' }), error => `${error.stdout}\n${error.stderr}`.includes('fictional-lost-reply'));
      await runPackagedBackfillCli({ ...cli, mode: 'apply' });
      verification = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try {
        const loops = verification.listOpenLoops();
        assert.equal(loops.length, 1);
        assert.equal(loops[0].title, 'Pay fictional packaged bill');
      } finally { verification.close(); }

      await restartHost();
      const dashboard = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.dashboard.get', params: { schemaVersion: 1, activityOffset: 0, activityLimit: 50 }, signal });
      assert.match(JSON.stringify(dashboard), /Pay fictional packaged bill/u);
      await stopPinnedHost(host.child);
      await host.outputDrained;
      removeAbortCleanup();
      await runPackagedBackfillCli({ ...cli, mode: 'withdraw' });

      await restartHost();
      const afterWithdrawal = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.dashboard.get', params: { schemaVersion: 1, activityOffset: 0, activityLimit: 50 }, signal });
      assert.doesNotMatch(JSON.stringify(afterWithdrawal), /Pay fictional packaged bill/u);
      return Object.freeze({ packaged: true, isolatedHost: true, previewed: true, lostReplyReconciled: true, visibleAfterRestart: true, withdrawn: true, absentAfterWithdrawalRestart: true });
    } finally {
      removeAbortCleanup();
      await stopPinnedHost(host.child);
      await host.outputDrained;
      for (const generation of host.generations) { assertNoFatalHostOutput(generation.diagnostics); generation.diagnostics.guard.assertClean(); }
      await assertRecordedChildTraffic(world);
    }
  }, { candidateRoot: process.cwd() });
}
