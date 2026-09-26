import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { ensureConventionalFolder, setHostDurableDirectoryPublisher } from '../src/topics/conventions.mjs';
import { setHostDurableFolderStager, setHostFilesystemIdentityReader } from '../src/sources/note-folder-identity.mjs';
import { setHostNoteFilesystemCoordinator } from '../src/sources/note-filesystem-owner.mjs';

const supported = process.platform === 'linux' && process.env.COMMAND_CENTER_TEST_BTRFS_ROOT;

for (const mode of ['before-publication', 'after-publication']) test(`conditional folder resumes after process death ${mode}`, { skip: !supported }, async () => {
  const root = await mkdtemp(path.join(process.env.COMMAND_CENTER_TEST_BTRFS_ROOT, 'topic-folder-death-'));
  const stateDir = path.join(root, 'state'); const vault = path.join(root, 'vault');
  await mkdir(stateDir); await mkdir(vault);
  const operationId = randomUUID(); const topicId = randomUUID();
  const fileAccess = await import('openclaw/plugin-sdk/file-access-runtime');
  const sqlite = await import('openclaw/plugin-sdk/sqlite-runtime');
  const releaseStager = setHostDurableFolderStager(fileAccess.stageDurableFileInDirectory);
  const releaseReader = setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  const releaseCoordinator = setHostNoteFilesystemCoordinator(sqlite.tryAcquireExclusiveSqliteCoordinator);
  const releasePublisher = setHostDurableDirectoryPublisher(fileAccess.publishDurableDirectoryNoReplace);
  let metadata;
  try {
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs',
      './test/fixtures/conditional-folder-interruption.mjs', stateDir, vault, mode], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, TOPIC_TEST_OPERATION_ID: operationId, TOPIC_TEST_TOPIC_ID: topicId }
    });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const receiptBefore = metadata.getConditionalFolderCreation(operationId);
    assert.equal(receiptBefore.phase, 'identified');
    const folderPath = path.join(vault, 'Projects', 'Fictional Recovery');
    const result = await ensureConventionalFolder({ noteVaultRoots: [vault], name: 'Fictional Recovery', paraCategory: 'project',
      folderPath, metadata, topicId, enrollmentOperationId: operationId, assertCurrent: () => {} });
    assert.equal(result.ownership, 'created');
    assert.equal(result.revision, receiptBefore.markerIdentity);
    assert.equal(metadata.getConditionalFolderCreation(operationId).phase, 'published');
    assert.deepEqual(await readdir(folderPath), ['.command-center-folder-identity']);
    if (mode === 'after-publication') {
      const foreign = `${folderPath}-foreign`;
      await rename(folderPath, foreign);
      await mkdir(folderPath);
      await assert.rejects(() => ensureConventionalFolder({ noteVaultRoots: [vault], name: 'Fictional Recovery',
        paraCategory: 'project', folderPath, metadata, topicId, enrollmentOperationId: operationId, assertCurrent: () => {} }),
      error => error.code === 'source-recovery');
    }
  } finally {
    metadata?.close(); releasePublisher(); releaseCoordinator(); releaseReader(); releaseStager();
    await rm(root, { recursive: true, force: true });
  }
});

test('conditional preparation resumes after process death following native Session creation', { skip: !supported }, async () => {
  const root = await mkdtemp(path.join(process.env.COMMAND_CENTER_TEST_BTRFS_ROOT, 'topic-session-death-'));
  const stateDir = path.join(root, 'state'); const vault = path.join(root, 'vault');
  await mkdir(stateDir); await mkdir(vault);
  const operationId = randomUUID(); const topicId = randomUUID();
  const fileAccess = await import('openclaw/plugin-sdk/file-access-runtime');
  const sqlite = await import('openclaw/plugin-sdk/sqlite-runtime');
  const native = await import('openclaw/plugin-sdk/session-store-runtime');
  const releaseStager = setHostDurableFolderStager(fileAccess.stageDurableFileInDirectory);
  const releaseReader = setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  const releaseCoordinator = setHostNoteFilesystemCoordinator(sqlite.tryAcquireExclusiveSqliteCoordinator);
  const releasePublisher = setHostDurableDirectoryPublisher(fileAccess.publishDurableDirectoryNoReplace);
  let metadata;
  try {
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs',
      './test/fixtures/conditional-folder-interruption.mjs', stateDir, vault, 'after-session-create'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, TOPIC_TEST_OPERATION_ID: operationId, TOPIC_TEST_TOPIC_ID: topicId }
    });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const receipt = metadata.getProvisioningPrimary(operationId);
    assert.equal(receipt.phase, 'creating');
    const primary = receipt.intent.primary;
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const entry = native.getSessionEntry({ agentId: 'main', sessionKey: primary.sessionKey, env, readConsistency: 'latest' });
    assert.equal(entry.sessionId, primary.sessionId);
    assert.equal(entry.lifecycleRevision, primary.lifecycleRevision);
    assert.equal(entry.updatedAt, primary.sessionUpdatedAt);
    assert.equal(entry.pluginOwnerId, 'command-center');
    const owner = new TopicProvisioningService({ metadata, noteVaultRoot: vault,
      sessionStore: { getSessionEntry: native.getSessionEntry, patchSessionEntry: native.patchSessionEntry } });
    const input = { logicalOperationId: operationId, topicId, name: 'Fictional Recovery', paraCategory: 'project',
      folderPath: path.join(vault, 'Projects', 'Fictional Recovery') };
    const resumed = await owner.prepare(input, { env, provisioningAuthority: { assertCurrent: () => {} } }, 'resume');
    assert.equal(resumed.status, 'applied');
    await assert.rejects(() => owner.prepare({ ...input, name: 'Changed Intent' },
      { env, provisioningAuthority: { assertCurrent: () => {} } }, 'resume'));
  } finally {
    metadata?.close(); releasePublisher(); releaseCoordinator(); releaseReader(); releaseStager();
    await rm(root, { recursive: true, force: true });
  }
});
