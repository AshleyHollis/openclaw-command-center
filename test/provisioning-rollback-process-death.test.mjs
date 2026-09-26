import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { TopicProvisioningService } from '../src/topics/provisioning.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

for (const [mode, checkpoint] of [['after-session-checkpoint', 'session-cleared'], ['after-marker-unlink', 'folder-cleaning']])
test(`rollback resumes after child death ${mode}`,
  { skip: process.platform !== 'linux' || !process.env.COMMAND_CENTER_TEST_BTRFS_ROOT }, async () => {
    const root = await mkdtemp(path.join(process.env.COMMAND_CENTER_TEST_BTRFS_ROOT, 'topic-rollback-death-'));
    const stateDir = path.join(root, 'state'); const vault = path.join(root, 'vault');
    await mkdir(stateDir); await mkdir(vault);
    const operationId = randomUUID(); const topicId = randomUUID();
    const release = installHostFileAccessFixture();
    let metadata;
    try {
      const child = spawnSync(process.execPath, ['./test/fixtures/rollback-folder-interruption.mjs',
        stateDir, vault, operationId, topicId, mode], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60_000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
      assert.equal(metadata.getConditionalProvisioningRollback(operationId).phase, checkpoint);
      const folderPath = path.join(vault, 'Projects', 'Fictional Recovery');
      assert.ok((await lstat(folderPath)).isDirectory());
      const owner = new TopicProvisioningService({ metadata, noteVaultRoot: vault,
        sessionStore: { getSessionEntry: () => null }, gateway: { request: () => { throw new Error('No Session existed.'); } } });
      const result = await owner.rollback({ logicalOperationId: operationId, topicId, expectedRevision: 0 });
      assert.equal(result.status, 'not-applied');
      assert.equal(metadata.getTopic(topicId), null);
      assert.equal(metadata.getTopicOperation(operationId).currentStep, 'rolled-back');
      assert.deepEqual(await readdir(path.join(vault, 'Projects')), []);
    } finally {
      metadata?.close(); release(); await rm(root, { recursive: true, force: true });
    }
  });
