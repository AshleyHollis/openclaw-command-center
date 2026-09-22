import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function countDurableOpenLoopOperations(stateDir) {
  const database = new DatabaseSync(resolveCommandCenterDatabasePath(stateDir), { readOnly: true });
  try { return database.prepare('SELECT COUNT(*) AS count FROM open_loop_operations').get().count; }
  finally { database.close(); }
}

async function runPackagedBackfillCli({ host, world, stateDir, mode, planPath, planDigest, adapterPath, adapterDigest, signal }) {
  const executable = host.host.runtimeExecutable || host.host.wrapper;
  const command = ['command-center', 'backfill', mode, '--plan', planPath, '--digest', planDigest, '--adapter', adapterPath, '--adapter-digest', adapterDigest];
  const args = host.host.runtimeExecutable ? [host.host.wrapper, ...command] : command;
  const guardModule = new URL('../../src/isolated-child-guard.mjs', import.meta.url);
  // Each native CLI process owns a fresh scratch lifetime. OpenClaw captures an
  // immutable plugin generation below TMP and normally has a supervising parent
  // reclaim it. This acceptance process is that parent, so remove the exited
  // child's generation before starting the next crash/replay phase.
  const childTemp = await mkdtemp(path.join(world.tempRoot, 'backfill-cli-'));
  try {
    return await new Promise((resolve, reject) => execFile(executable, args, {
      cwd: host.host.checkout, signal, timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, [fixtureEnvironment]: world.manifestPath, OPENCLAW_CONFIG_PATH: world.manifest.configPath,
        OPENCLAW_STATE_DIR: stateDir, HOME: world.root, TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp,
        COMMAND_CENTER_DISABLE_HOSTED_PLUGIN_CATALOG: '1', NODE_OPTIONS: `--import=${guardModule.href}` }
    }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
  } finally { await rm(childTemp, { recursive: true, force: true }); }
}

async function waitForMetadata(world, host, signal) {
  await waitForConsecutiveReadiness(
    async () => isCommandCenterMetadataReady(resolveCommandCenterDatabasePath(path.join(world.root, '.openclaw'))),
    host.earlyExit,
    { required: 2, deadlineMs: 120_000, delayMs: 100, signal }
  );
}

async function readDashboardWhenReady(world, host, signal) {
  let dashboard;
  await waitForConsecutiveReadiness(async probeSignal => {
    try {
      dashboard = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.dashboard.get', params: { schemaVersion: 1, activityOffset: 0, activityLimit: 50 }, signal: probeSignal });
      return true;
    } catch (error) {
      probeSignal.throwIfAborted();
      if (error?.startupPending === true || /Gateway (?:connect|connection|challenge).*failed/iu.test(error?.message ?? '') || error?.category === 'transport-timeout') return false;
      throw error;
    }
  }, host.earlyExit, { required: 2, deadlineMs: 60_000, delayMs: 100, signal });
  return dashboard;
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
      const retainedNotePath = 'Inbox/Fictional retained review.md';
      const noteFile = path.join(vault, ...notePath.split('/'));
      const retainedNoteFile = path.join(vault, ...retainedNotePath.split('/'));
      const noteBytes = Buffer.from('# Fictional packaged bill\n\nPay the fictional test invoice.\n', 'utf8');
      const retainedNoteBytes = Buffer.from('# Fictional retained review\n\nReview the fictional service renewal.\n', 'utf8');
      await mkdir(path.dirname(noteFile), { recursive: true });
      await writeFile(noteFile, noteBytes);
      await writeFile(retainedNoteFile, retainedNoteBytes);
      await writeFile(path.join(vault, NOTE_FOLDER_IDENTITY_FILE), `${JSON.stringify({ version: 1, id: randomUUID() })}\n`, { flag: 'wx', mode: 0o600 });
      const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try {
        metadata.createTopic({ topicId: 'topic-fictional-packaged-backfill', name: 'Fictional Packaged Backfill', paraCategory: 'project', lifecycle: 'active' });
        metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-packaged-backfill', topicId: 'topic-fictional-packaged-backfill', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault });
        metadata.setSourceLocator({ referenceId: 'folder:fictional-packaged-backfill', locator: vault, observedRevision: await readHostNoteFolderIdentity(vault), ownership: 'external' });
        metadata.createSourceReference({ version: 1, referenceId: 'note:fictional-packaged-backfill', topicId: 'topic-fictional-packaged-backfill', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: noteFile, observedRevision: revisionForBytes(noteBytes) });
        metadata.createSourceReference({ version: 1, referenceId: 'note:fictional-retained-review', topicId: 'topic-fictional-packaged-backfill', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: retainedNoteFile, observedRevision: revisionForBytes(retainedNoteBytes) });
      } finally { metadata.close(); }

      const plan = { schemaVersion: 1, backfillId: 'fictional-packaged-backfill', sourceKind: 'email', scope: { topicIds: [], topicNames: ['Fictional Packaged Backfill'], maxRecords: 2 } };
      const planPath = path.join(world.tempRoot, 'fictional-backfill-plan.json');
      const adapterPath = path.join(world.tempRoot, 'fictional-backfill-adapter.mjs');
      const adapterSource = `export function createHistoricalBackfillAdapter({ commandCenter }) { return {
  async readPage() { return { records: [{ schemaVersion: 1, sourceExternalId: 'fictional-packaged-message', sourceVersion: 'message-v1', checkpoint: '001' }, { schemaVersion: 1, sourceExternalId: 'fictional-retained-message', sourceVersion: 'message-v2', checkpoint: '002' }], next: '002', done: true }; },
  async classify({ record }) { return record.sourceExternalId === 'fictional-packaged-message' ? { schemaVersion: 1, disposition: 'actionable', obligationId: 'fictional-packaged-bill', title: 'Pay fictional packaged bill', topicName: 'Fictional Packaged Backfill', notePath: 'Inbox/Fictional packaged bill.md', provenance: 'explicit', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-21T00:00:00.000Z' } : { schemaVersion: 1, disposition: 'actionable', obligationId: 'fictional-retained-review', title: 'Review fictional retained renewal', topicName: 'Fictional Packaged Backfill', notePath: 'Inbox/Fictional retained review.md', provenance: 'explicit', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-21T01:00:00.000Z' }; },
  async applyRecord(input) { const result = await capture(input, false); if (input.record.sourceExternalId === 'fictional-packaged-message') throw Object.assign(new Error('fictional-lost-reply'), { code: 'fictional-lost-reply' }); return result; },
  async reconcileRecord(input) { return capture(input, true); },
  async inspectEffect(input) { return commandCenter.inspectEffect(input); }, async withdrawEffect(input) { return commandCenter.withdrawEffect(input); }, async reconcileWithdrawal(input) { return commandCenter.reconcileWithdrawal(input); }, async recordReceipt() {}
}; async function capture(input, reconcile) { const topic = commandCenter.resolveTopic({ topicName: input.classification.topicName }); const evidence = await commandCenter.readNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, path: input.classification.notePath }); const value = { logicalOperationId: input.logicalOperationId, capture: { schemaVersion: 1, sourceKind: input.sourceKind, sourceExternalId: input.record.sourceExternalId, sourceVersion: input.record.sourceVersion, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.path, topicId: topic.topicId, title: input.classification.title, obligationId: input.classification.obligationId, provenance: input.classification.provenance, occurredAt: input.classification.occurredAt, observedAt: input.classification.observedAt } }; return reconcile ? commandCenter.reconcileCommitment(value) : commandCenter.captureCommitment(value); } }\n`;
      await writeFile(planPath, `${JSON.stringify(plan)}\n`);
      await writeFile(adapterPath, adapterSource);
      const packagedBackfill = await import(pathToFileURL(path.join(world.manifest.candidate.root, 'dist', 'open-loops', 'historical-backfill.mjs')).href);
      const cli = { host, world, stateDir, planPath, planDigest: packagedBackfill.historicalBackfillPlanDigest(plan), adapterPath, adapterDigest: sha256(adapterSource), signal };
      await runPackagedBackfillCli({ ...cli, mode: 'preview' });
      let verification = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try { assert.equal(verification.listOpenLoops().length, 0, 'preview must not create an effect'); }
      finally { verification.close(); }
      await assert.rejects(runPackagedBackfillCli({ ...cli, mode: 'apply' }), error => `${error.stdout}\n${error.stderr}`.includes('fictional-lost-reply'));
      let firstCommit;
      verification = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try {
        const loop = verification.listOpenLoops().find(item => item.title === 'Pay fictional packaged bill');
        assert.ok(loop, 'lost reply must follow a durable first commitment');
        firstCommit = { loopId: loop.loopId, revision: loop.revision, evidenceCount: loop.evidenceObservationIds.length,
          observationCount: verification.listOpenLoopObservations().length,
          operationCount: countDurableOpenLoopOperations(stateDir) };
      } finally { verification.close(); }
      await runPackagedBackfillCli({ ...cli, mode: 'apply' });
      verification = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try {
        const loops = verification.listOpenLoops();
        assert.equal(loops.length, 2);
        const replayed = verification.getOpenLoop(firstCommit.loopId);
        assert.equal(replayed.title, 'Pay fictional packaged bill');
        assert.equal(replayed.revision, firstCommit.revision, 'retry must not revise the committed effect');
        assert.equal(replayed.evidenceObservationIds.length, firstCommit.evidenceCount, 'retry must not append evidence');
        assert.equal(verification.listOpenLoopObservations().length, firstCommit.observationCount + 1, 'only the second record may add evidence');
        assert.equal(countDurableOpenLoopOperations(stateDir), firstCommit.operationCount + 1, 'only the second record may add a durable open-loop operation');
      } finally { verification.close(); }

      await restartHost();
      const dashboard = await readDashboardWhenReady(world, host, signal);
      assert.match(JSON.stringify(dashboard), /Pay fictional packaged bill/u);
      assert.match(JSON.stringify(dashboard), /Review fictional retained renewal/u);
      await stopPinnedHost(host.child);
      await host.outputDrained;
      removeAbortCleanup();
      verification = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      try {
        const retained = verification.listOpenLoops().find(item => item.title === 'Review fictional retained renewal');
        assert.ok(retained);
        const decided = verification.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-retained-user-decision', loopId: retained.loopId, expectedRevision: retained.revision, decision: 'defer', reviewAt: '2026-09-28T00:00:00.000Z', actorId: 'fictional-operator', rationale: 'Keep this fictional review for the accepted date.', updatedAt: '2026-09-21T02:30:00.000Z' });
        assert.equal(decided.loop.revision, retained.revision + 1);
      } finally { verification.close(); }
      await runPackagedBackfillCli({ ...cli, mode: 'withdraw' });

      await restartHost();
      const afterWithdrawal = await readDashboardWhenReady(world, host, signal);
      assert.doesNotMatch(JSON.stringify(afterWithdrawal), /Pay fictional packaged bill/u);
      assert.match(JSON.stringify(afterWithdrawal), /Review fictional retained renewal/u);
      return Object.freeze({ packaged: true, isolatedHost: true, previewed: true, lostReplyReconciledWithoutDuplicate: true, visibleAfterRestart: true, withdrawn: true, userDecisionPreservedAfterRestart: true, absentAfterWithdrawalRestart: true });
    } finally {
      removeAbortCleanup();
      await stopPinnedHost(host.child);
      await host.outputDrained;
      for (const generation of host.generations) { assertNoFatalHostOutput(generation.diagnostics); generation.diagnostics.guard.assertClean(); }
      await assertRecordedChildTraffic(world);
    }
  }, { candidateRoot: process.cwd() });
}
