import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { NoteAdapter } from '../src/sources/notes.mjs';
import { ensureConventionalFolder } from '../src/topics/conventions.mjs';
import { TopicRecoveryService } from '../src/topics/recovery.mjs';

const markerName = '.command-center-folder-identity';

async function fixture(run) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-folder-identity-'));
  let metadata; let adapter;
  const open = async () => {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    const tryAcquireExclusiveSqliteCoordinator = process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME
      ? (await import(process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME)).tryAcquireExclusiveSqliteCoordinator : undefined;
    adapter = new NoteAdapter({ metadata, topicId: 'fictional-topic', noteFolderReferenceId: 'fictional-folder',
      tryAcquireExclusiveSqliteCoordinator,
      fsSafeRootFactory: async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative) }) });
  };
  try {
    await open();
    metadata.createTopic({ topicId: 'fictional-topic', paraCategory: 'project', lifecycle: 'active' });
    const vault = path.join(stateDir, 'vault'); await fs.mkdir(vault);
    const folder = await ensureConventionalFolder({ noteVaultRoot: vault, paraCategory: 'project', name: 'Fictional', metadata, topicId: 'fictional-topic' });
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-folder', topicId: 'fictional-topic', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'note-folder:fictional-topic' });
    metadata.setSourceLocator({ referenceId: 'fictional-folder', locator: folder.path, ownership: folder.ownership, observedRevision: folder.revision });
    await fs.writeFile(path.join(folder.path, 'note.md'), 'original');
    await run({ root: folder.path, vault, get metadata() { return metadata; }, get adapter() { return adapter; },
      async reopen() { adapter.close(); metadata.close(); await open(); } });
  } finally { adapter?.close(); metadata?.close(); await fs.rm(stateDir, { recursive: true, force: true }); }
}

test('ordinary Note access after SQLite reopen never enrolls a folder whose reserved identity marker is missing', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async (f) => {
    assert.equal((await f.adapter.read({ path: 'note.md' })).text, 'original');
    await fs.rm(path.join(f.root, markerName), { force: true });
    await f.reopen();
    await assert.rejects(() => f.adapter.read({ path: 'note.md' }), (error) => error.code === 'source-recovery');
    await assert.rejects(fs.lstat(path.join(f.root, markerName)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.root, 'note.md'), 'utf8'), 'original');
  });
});

test('authorized replacement enrolls a recreated Note Folder and advances its durable binding', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async (f) => {
    const previous = f.metadata.getSourceLocator('fictional-folder');
    await fs.rm(f.root, { recursive: true }); await fs.mkdir(f.root);
    await fs.writeFile(path.join(f.root, 'note.md'), 'replacement');
    await f.reopen();
    await assert.rejects(() => f.adapter.read({ path: 'note.md' }), (error) => error.code === 'source-recovery');
    const recovery = new TopicRecoveryService({ metadata: f.metadata, noteVaultRoot: f.vault });
    const result = await recovery.verify({ topicId: 'fictional-topic', referenceId: 'fictional-folder', replacementLocator: f.root,
      expectedRevision: f.metadata.getTopic('fictional-topic').revision, expectedSourceRevision: previous.observedRevision, logicalOperationId: randomUUID() });
    assert.equal(result.status, 'replaced');
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locatorVersion, previous.locatorVersion + 1);
    await f.reopen();
    assert.equal((await f.adapter.read({ path: 'note.md' })).text, 'replacement');
  });
});

test('a copied marker alone does not reauthorize a recreated folder after SQLite reopen', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async (f) => {
    const copied = await fs.readFile(path.join(f.root, markerName));
    await fs.rename(f.root, `${f.root}-original`);
    await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, markerName), copied);
    await fs.writeFile(path.join(f.root, 'note.md'), 'foreign');
    await f.reopen();
    await assert.rejects(() => f.adapter.read({ path: 'note.md' }), (error) => error.code === 'source-recovery');
    assert.equal(await fs.readFile(path.join(f.root, 'note.md'), 'utf8'), 'foreign');
    assert.deepEqual(await fs.readFile(path.join(f.root, markerName)), copied);
  });
});

test('copying identical marker bytes into the same directory does not preserve its binding', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async (f) => {
    const target = path.join(f.root, markerName);
    const copied = await fs.readFile(target);
    await fs.rename(target, path.join(f.vault, 'preserved-identity'));
    await fs.writeFile(target, copied, { flag: 'wx' });
    await f.reopen();
    await assert.rejects(() => f.adapter.read({ path: 'note.md' }), (error) => error.code === 'source-recovery');
    assert.equal(await fs.readFile(path.join(f.root, 'note.md'), 'utf8'), 'original');
  });
});

test('a legitimate folder move preserves its marker and Note ownership through the versioned locator', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async (f) => {
    const note = await f.adapter.read({ path: 'note.md' });
    const previous = f.metadata.getSourceLocator('fictional-folder');
    const marker = await fs.readFile(path.join(f.root, markerName));
    const destination = path.join(f.vault, 'Moved'); await fs.rename(f.root, destination);
    f.metadata.relocateNoteFolder({ referenceId: 'fictional-folder', from: f.root, to: destination, expectedLocatorVersion: previous.locatorVersion, expectedSourceRevision: previous.observedRevision });
    await f.reopen();
    const moved = await f.adapter.read({ path: 'note.md' });
    assert.equal(moved.sourceReference.referenceId, note.sourceReference.referenceId);
    assert.equal(moved.text, 'original');
    assert.deepEqual(await fs.readFile(path.join(destination, markerName)), marker);
  });
});
