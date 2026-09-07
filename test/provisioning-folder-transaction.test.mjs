import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { TopicProvisioningService } from '../src/topics/provisioning.mjs';

const referenceId = 'note-folder:fictional-topic';
const intent = { name: 'Fictional', paraCategory: 'project' };
async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'provisioning-folder-transaction-'));
  const vault = path.join(stateDir, 'vault');
  await mkdir(vault);
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  try {
    metadata.createTopic({ topicId: 'fictional-topic', ...intent, lifecycle: 'provisioning' });
    await run({ stateDir, vault, get metadata() { return metadata; },
      owner: () => new TopicProvisioningService({ metadata, noteVaultRoot: vault }),
      reopen() { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } }); }
    });
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('process death before Folder binding commit leaves no partial reference, locator or conventions', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async f => {
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/provisioning-folder-interruption.mjs', f.stateDir, f.vault], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    f.reopen();
    assert.equal(f.metadata.getSourceReference(referenceId), null);
    assert.equal(f.metadata.getSourceLocator(referenceId), null);
    assert.deepEqual(f.metadata.getSourceConventionState(referenceId), []);
    const markerPath = path.join(f.vault, 'Projects', intent.name, '.command-center-folder-identity');
    const marker = await readFile(markerPath);
    const result = await f.owner().bindFolder('fictional-topic', intent);
    assert.equal(result.referenceId, referenceId);
    assert.deepEqual(await readFile(markerPath), marker);
    assert.equal(f.metadata.getSourceLocator(referenceId).locatorVersion, 1);
    assert.deepEqual(f.metadata.getSourceConventionState(referenceId).map(value => value.aspect), ['location', 'name']);
  });
});

test('lost reply after Folder binding commit preserves the complete binding and replay does not reset customized conventions', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async f => {
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/provisioning-folder-interruption.mjs', f.stateDir, f.vault, 'after-commit'], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    f.reopen();
    const locator = f.metadata.getSourceLocator(referenceId);
    assert.equal(locator.ownership, 'created');
    assert.deepEqual(f.metadata.getSourceConventionState(referenceId).map(value => value.aspect), ['location', 'name']);
    f.metadata.setSourceConventionState({ referenceId, aspect: 'name', state: 'customized', expectedValue: 'Operator preference' });
    const conventions = f.metadata.getSourceConventionState(referenceId);
    await f.owner().bindFolder('fictional-topic', intent);
    assert.deepEqual(f.metadata.getSourceLocator(referenceId), locator);
    assert.deepEqual(f.metadata.getSourceConventionState(referenceId), conventions);
  });
});

for (const change of ['topic-revision', 'locator-generation']) test(`Folder enrollment refuses a competing ${change} during actual filesystem verification`, { skip: process.platform !== 'linux' }, async () => {
  await fixture(async f => {
    if (change === 'locator-generation') await f.owner().bindFolder('fictional-topic', intent);
    const competing = openCommandCenterMetadataService({ stateDir: f.stateDir, capabilities: { notes: true } });
    const originalOpen = filesystem.open;
    let changed = false;
    filesystem.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!changed && String(args[0]).endsWith('/.command-center-folder-identity')) {
        changed = true;
        if (change === 'topic-revision') {
          competing.setTopicName({ topicId: 'fictional-topic', name: 'Temporary', expectedRevision: 0 });
          competing.setTopicName({ topicId: 'fictional-topic', name: intent.name, expectedRevision: 1 });
        } else competing.setSourceLocator({ ...competing.getSourceLocator(referenceId), locatorVersion: 2 });
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.owner().bindFolder('fictional-topic', intent), { code: 'conflict' });
      assert.equal(changed, true, 'the competing write must occur at the actual filesystem boundary');
    } finally { filesystem.open = originalOpen; syncBuiltinESMExports(); competing.close(); }
    f.reopen();
    if (change === 'topic-revision') {
      assert.equal(f.metadata.getTopic('fictional-topic').revision, 2);
      assert.equal(f.metadata.getSourceReference(referenceId), null);
    } else assert.equal(f.metadata.getSourceLocator(referenceId).locatorVersion, 2);
  });
});
