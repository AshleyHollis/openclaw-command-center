import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, symlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NoteAdapter } from '../src/sources/notes.mjs';
import { normalizeNotePath } from '../src/sources/note-path.mjs';

const fsSafeRootFactory = async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative), open: async (relative) => ({ handle: await (await import('node:fs/promises')).open(path.join(rootDir, relative), 'r') }) });

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-notes-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('nested Note browse/create/read/edit/rename/move stays within one Topic root', async () => {
  await withRoot(async (root) => {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-notes', root });
    const created = await adapter.create({ path: 'nested/folder/note.md', text: '# fictional note\n' });
    assert.equal(created.status, 'applied');
    assert.deepEqual((await adapter.browse()).map((entry) => entry.path), ['nested/folder/note.md']);
    const current = await adapter.read({ path: 'nested/folder/note.md' });
    assert.equal(current.text, '# fictional note\n');
    const edited = await adapter.edit({ path: current.path, expectedRevision: current.revision, text: 'edited' });
    const moved = await adapter.move({ path: edited.note.path, destinationPath: 'renamed.md', expectedRevision: edited.note.revision });
    assert.equal(moved.note.path, 'renamed.md');
    assert.equal((await adapter.read({ path: 'renamed.md' })).text, 'edited');
    assert.deepEqual((await adapter.browse()).map((entry) => entry.path), ['renamed.md']);
    assert.equal(await readFile(path.join(root, 'renamed.md'), 'utf8'), 'edited');
    assert.equal(await readFile(path.join(root, 'nested/folder/note.md'), 'utf8').catch(() => null), null);
  });
});

test('Note browse resolves identities once and batches durable observations', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'existing.md'), 'existing');
    await writeFile(path.join(root, 'new.md'), 'new');
    const folder = { version: 1, referenceId: 'folder:batch', topicId: 'topic-batch', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root };
    const existing = { version: 1, referenceId: 'note:existing', topicId: 'topic-batch', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${root}/existing.md`, observedRevision: 'old' };
    let listCalls = 0;
    let observed = null;
    const metadata = {
      listSourceReferences: () => { listCalls += 1; return [folder, existing]; },
      getSourceReference: (id) => id === folder.referenceId ? folder : null,
      getSourceLocator: () => null,
      setSourceLocator: () => {},
      observeSourceReferences: (references) => { observed = references; return references; }
    };
    const adapter = new NoteAdapter({ fsSafeRootFactory, metadata, topicId: folder.topicId, noteFolderReferenceId: folder.referenceId });
    const notes = await adapter.browse();
    assert.equal(listCalls, 1);
    assert.equal(observed.length, 2);
    assert.equal(notes.find(({ path: notePath }) => notePath === 'existing.md').sourceReference.referenceId, existing.referenceId);
    adapter.close();
  });
});

test('a bound Note adapter refreshes its versioned folder locator after explicit replacement', async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-locator-first-'));
  const second = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-locator-second-'));
  try {
    await writeFile(path.join(first, 'note.md'), 'first');
    await writeFile(path.join(second, 'note.md'), 'second');
    let locator = first;
    const revisions = new Map(await Promise.all([first, second].map(async (directory) => {
      const stat = await lstat(directory);
      return [directory, `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`];
    })));
    const folder = { version: 1, referenceId: 'folder:refresh', topicId: 'topic-refresh', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'stable-folder-id' };
    const metadata = { listSourceReferences: () => [folder], getSourceReference: (id) => id === folder.referenceId ? folder : null, getSourceLocator: () => ({ referenceId: folder.referenceId, locator, locatorVersion: locator === first ? 1 : 2, observedRevision: revisions.get(locator) }), createSourceReference: (value) => value };
    const adapter = new NoteAdapter({ fsSafeRootFactory, metadata, topicId: folder.topicId, noteFolderReferenceId: folder.referenceId });
    assert.equal((await adapter.read({ path: 'note.md' })).text, 'first');
    locator = second;
    assert.equal((await adapter.read({ path: 'note.md' })).text, 'second');
    adapter.close();
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
});

test('a Note adapter refuses a different directory recreated at the exact stored path', async () => {
  await withRoot(async (container) => {
    const root = path.join(container, 'topic-root');
    await mkdir(root);
    const original = await lstat(root);
    const observedRevision = `fs:${original.dev}:${original.ino}:${original.birthtimeMs}`;
    const folder = { referenceId: 'folder:identity', topicId: 'topic-identity', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root };
    const metadata = {
      listSourceReferences: () => [folder],
      getSourceReference: (id) => id === folder.referenceId ? folder : null,
      getSourceLocator: () => ({ referenceId: folder.referenceId, locator: root, locatorVersion: 1, observedRevision })
    };
    await rm(root, { recursive: true });
    await mkdir(root);
    await writeFile(path.join(root, 'replacement.md'), 'foreign');
    const adapter = new NoteAdapter({ fsSafeRootFactory, metadata, topicId: folder.topicId, noteFolderReferenceId: folder.referenceId });
    await assert.rejects(() => adapter.browse(), (error) => error.code === 'source-recovery' && /identity/i.test(error.message));
  });
});

test('a cached Note adapter rebinds after an explicit same-path identity replacement', async () => {
  await withRoot(async (container) => {
    const root = path.join(container, 'topic-root');
    const detached = path.join(container, 'detached-root');
    await mkdir(root);
    await writeFile(path.join(root, 'original.md'), 'original');
    let stat = await lstat(root);
    let observedRevision = `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const folder = { referenceId: 'folder:authorized-rebind', topicId: 'topic-authorized-rebind', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root };
    const metadata = {
      listSourceReferences: () => [folder],
      getSourceReference: (id) => id === folder.referenceId ? folder : null,
      getSourceLocator: () => ({ referenceId: folder.referenceId, locator: root, locatorVersion: 2, observedRevision }),
      createSourceReference: (value) => value
    };
    const adapter = new NoteAdapter({ fsSafeRootFactory, metadata, topicId: folder.topicId, noteFolderReferenceId: folder.referenceId });
    assert.equal((await adapter.read({ path: 'original.md' })).text, 'original');
    await rename(root, detached);
    await mkdir(root);
    stat = await lstat(root);
    observedRevision = `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    await adapter.create({ path: 'authorized.md', text: 'replacement' });
    assert.equal(await readFile(path.join(root, 'authorized.md'), 'utf8'), 'replacement');
    assert.equal(await readFile(path.join(detached, 'authorized.md'), 'utf8').catch(() => null), null);
    adapter.close();
  });
});
test('path and symlink traversal fails closed, while large Markdown bytes round-trip exactly', async () => {
  await withRoot(async (root) => {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-notes', root });
    for (const value of ['/absolute.md', '../escape.md', 'nested/../../escape.md', 'nested\\escape.md', 'note.txt', '']) assert.throws(() => normalizeNotePath(value), /path/i);
    await mkdir(path.join(root, 'safe'), { recursive: true });
    await symlink(path.join(os.tmpdir()), path.join(root, 'safe', 'link'));
    await assert.rejects(() => adapter.read({ path: 'safe/link/escape.md' }), /symlink|unsafe/i);
    const text = 'x'.repeat(8 * 1024 * 1024) + '\n';
    const created = await adapter.create({ path: 'large.md', text });
    const read = await adapter.read({ path: created.note.path });
    assert.equal(read.text, text);
    assert.equal(read.revision, created.note.revision);
  });
});

test('every Note operation fails closed when an opened ancestor is replaced', async () => {
  for (const operation of ['browse', 'read', 'create', 'edit', 'rename', 'move']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `command-center-${operation}-swap-root-`));
    const outside = await mkdtemp(path.join(os.tmpdir(), `command-center-${operation}-swap-outside-`));
    try {
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'nested', 'note.md'), 'inside');
      await writeFile(path.join(outside, 'note.md'), 'outside');
      const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: `topic-${operation}-swap`, root });
      const current = await adapter.read({ path: 'nested/note.md' });
      let swapped = false;
      adapter.beforePathIo = async ({ operation: observed }) => {
        if (swapped || observed !== operation) return;
        swapped = true;
        await rename(path.join(root, 'nested'), path.join(root, 'detached'));
        await symlink(outside, path.join(root, 'nested'));
      };
      const invoke = {
        browse: () => adapter.browse(),
        read: () => adapter.read({ path: 'nested/note.md' }),
        create: () => adapter.create({ path: 'nested/new.md', text: 'candidate' }),
        edit: () => adapter.edit({ path: 'nested/note.md', expectedRevision: current.revision, text: 'candidate' }),
        rename: () => adapter.rename({ path: 'nested/note.md', newPath: 'nested/renamed.md', expectedRevision: current.revision }),
        move: () => adapter.move({ path: 'nested/note.md', destinationPath: 'nested/moved.md', expectedRevision: current.revision })
      }[operation];
      await assert.rejects(invoke, (error) => ['conflict', 'unsafe-path'].includes(error.code));
      assert.equal(swapped, true);
      assert.equal(await readFile(path.join(outside, 'note.md'), 'utf8'), 'outside');
      assert.equal(await readFile(path.join(outside, 'new.md'), 'utf8').catch(() => null), null);
      assert.equal(await readFile(path.join(outside, 'renamed.md'), 'utf8').catch(() => null), null);
      assert.equal(await readFile(path.join(outside, 'moved.md'), 'utf8').catch(() => null), null);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
});

test('every Note operation remains bound when the root or its parent is replaced', async () => {
  for (const boundary of ['root', 'parent']) for (const operation of ['browse', 'read', 'create', 'edit', 'rename', 'move']) {
    const container = await mkdtemp(path.join(os.tmpdir(), `command-center-${boundary}-${operation}-boundary-`));
    const parent = path.join(container, 'owned-parent');
    const root = path.join(parent, 'topic-root');
    const attackerParent = path.join(container, 'replacement-parent');
    const attackerRoot = boundary === 'root' ? path.join(container, 'replacement-root') : path.join(attackerParent, 'topic-root');
    const detached = path.join(container, `detached-${boundary}`);
    try {
      await mkdir(path.join(root, 'nested'), { recursive: true });
      await mkdir(path.join(attackerRoot, 'nested'), { recursive: true });
      await writeFile(path.join(root, 'nested', 'note.md'), 'inside');
      await writeFile(path.join(attackerRoot, 'nested', 'note.md'), 'outside');
      const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: `topic-${boundary}-${operation}`, root });
      const current = await adapter.read({ path: 'nested/note.md' });
      let swapped = false;
      adapter.afterRootResolved = async () => {
        if (swapped) return;
        swapped = true;
        if (boundary === 'root') {
          await rename(root, detached);
          await rename(attackerRoot, root);
        } else {
          await rename(parent, detached);
          await rename(attackerParent, parent);
        }
      };
      const invoke = {
        browse: () => adapter.browse(),
        read: () => adapter.read({ path: 'nested/note.md' }),
        create: () => adapter.create({ path: 'nested/new.md', text: 'candidate' }),
        edit: () => adapter.edit({ path: 'nested/note.md', expectedRevision: current.revision, text: 'candidate' }),
        rename: () => adapter.rename({ path: 'nested/note.md', newPath: 'nested/renamed.md', expectedRevision: current.revision }),
        move: () => adapter.move({ path: 'nested/note.md', destinationPath: 'nested/moved.md', expectedRevision: current.revision })
      }[operation];
      await assert.rejects(invoke, `${boundary}/${operation} must fail closed`);
      assert.equal(swapped, true);
      assert.equal(await readFile(path.join(root, 'nested', 'note.md'), 'utf8'), 'outside');
      assert.equal(await readFile(path.join(root, 'nested', 'new.md'), 'utf8').catch(() => null), null);
      assert.equal(await readFile(path.join(root, 'nested', 'renamed.md'), 'utf8').catch(() => null), null);
      assert.equal(await readFile(path.join(root, 'nested', 'moved.md'), 'utf8').catch(() => null), null);
      const detachedRoot = boundary === 'root' ? detached : path.join(detached, 'topic-root');
      assert.equal(await readFile(path.join(detachedRoot, 'nested', 'note.md'), 'utf8'), 'inside');
      assert.equal(await readFile(path.join(detachedRoot, 'nested', 'new.md'), 'utf8').catch(() => null), null);
      assert.equal(await readFile(path.join(detachedRoot, 'nested', 'renamed.md'), 'utf8').catch(() => null), null);
      assert.equal(await readFile(path.join(detachedRoot, 'nested', 'moved.md'), 'utf8').catch(() => null), null);
      assert.deepEqual(await readdir(path.join(root, 'nested')), ['note.md']);
      assert.deepEqual(await readdir(path.join(detachedRoot, 'nested')), ['note.md']);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  }
});
