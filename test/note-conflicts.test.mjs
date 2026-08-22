import assert from 'node:assert/strict';
import { lstat, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NoteAdapter } from '../src/sources/notes.mjs';

const fsSafeRootFactory = async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative), open: async (relative) => ({ handle: await (await import('node:fs/promises')).open(path.join(rootDir, relative), 'r') }) });

test('external Note edits are reported as conflicts and preserve authoritative bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-conflict-'));
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-conflict', root });
    const original = await adapter.create({ path: 'note.md', text: 'original' });
    const current = await adapter.read({ path: 'note.md' });
    await writeFile(path.join(root, 'note.md'), 'external');
    await assert.rejects(() => adapter.edit({ path: 'note.md', expectedRevision: current.revision, text: 'unsafe overwrite' }), (error) => error.code === 'conflict' && error.currentRevision !== current.revision);
    assert.equal(await readFile(path.join(root, 'note.md'), 'utf8'), 'external');
    const reconciled = await adapter.edit({ path: 'note.md', expectedRevision: 'sha256:stale', text: 'external' });
    assert.equal(reconciled.status, 'reconciled');
    assert.equal(original.note.path, 'note.md');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rename and move refuse destination overwrite and cross-Topic movement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-move-'));
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-move', root });
    await adapter.create({ path: 'source.md', text: 'source' });
    await adapter.create({ path: 'destination.md', text: 'destination' });
    const current = await adapter.read({ path: 'source.md' });
    await assert.rejects(() => adapter.rename({ path: 'source.md', newPath: 'destination.md', expectedRevision: current.revision }), (error) => error.code === 'conflict');
    await assert.rejects(() => adapter.move({ path: 'source.md', destinationPath: 'other.md', destinationTopicId: 'other-topic', expectedRevision: current.revision }), (error) => error.code === 'cross-topic');
    assert.equal(await readFile(path.join(root, 'source.md'), 'utf8'), 'source');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('create uses a no-replace commit when an external Note appears at the final boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-create-race-'));
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory,
      topicId: 'topic-create-race',
      root,
      beforeAtomicCommit: async ({ operation }) => {
        if (operation === 'create') await writeFile(path.join(root, 'note.md'), 'external create');
      }
    });
    await assert.rejects(
      () => adapter.create({ path: 'note.md', text: 'command center' }),
      (error) => error.code === 'conflict'
    );
    assert.equal(await readFile(path.join(root, 'note.md'), 'utf8'), 'external create');
    assert.deepEqual((await readdir(root)).filter((entry) => entry.endsWith('.md')), ['note.md']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('edit preserves an external atomic replacement at the final commit boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-edit-race-'));
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-edit-race', root });
    const created = await adapter.create({ path: 'note.md', text: 'original' });
    adapter.beforeAtomicCommit = async ({ operation }) => {
      if (operation !== 'edit') return;
      const external = path.join(root, 'external-edit.tmp');
      await writeFile(external, 'external edit');
      await rename(external, path.join(root, 'note.md'));
    };
    await assert.rejects(
      () => adapter.edit({ path: 'note.md', expectedRevision: created.note.revision, text: 'command center' }),
      (error) => error.code === 'conflict'
    );
    assert.equal(await readFile(path.join(root, 'note.md'), 'utf8'), 'external edit');
    assert.deepEqual((await readdir(root)).filter((entry) => entry.endsWith('.md')), ['note.md']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('move preserves an external source replacement at the final commit boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-move-race-'));
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-move-race', root });
    const created = await adapter.create({ path: 'source.md', text: 'original' });
    adapter.beforeAtomicCommit = async ({ operation }) => {
      if (operation !== 'move') return;
      const external = path.join(root, 'external-move.tmp');
      await writeFile(external, 'external move');
      await rename(external, path.join(root, 'source.md'));
    };
    await assert.rejects(
      () => adapter.move({ path: 'source.md', destinationPath: 'destination.md', expectedRevision: created.note.revision }),
      (error) => error.code === 'conflict'
    );
    assert.equal(await readFile(path.join(root, 'source.md'), 'utf8'), 'external move');
    assert.equal(await readFile(path.join(root, 'destination.md'), 'utf8').catch(() => null), null);
    assert.deepEqual((await readdir(root)).filter((entry) => entry.endsWith('.md')), ['source.md']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('move never unlinks authoritative content that appears after destination publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-move-publish-race-'));
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-move-publish-race', root });
    const created = await adapter.create({ path: 'source.md', text: 'original' });
    adapter.afterAtomicPublish = async ({ operation }) => {
      if (operation === 'move') await writeFile(path.join(root, 'source.md'), 'external replacement');
    };
    const moved = await adapter.move({ path: 'source.md', destinationPath: 'destination.md', expectedRevision: created.note.revision });
    assert.equal(moved.status, 'applied');
    assert.equal(await readFile(path.join(root, 'source.md'), 'utf8'), 'external replacement');
    assert.equal(await readFile(path.join(root, 'destination.md'), 'utf8'), 'original');
    assert.deepEqual(((await readdir(root)).filter((entry) => entry.endsWith('.md'))).sort(), ['destination.md', 'source.md']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nested create and move never follow a directory component introduced during creation', async () => {
  for (const operation of ['create', 'move']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `command-center-note-${operation}-directory-race-`));
    const outside = await mkdtemp(path.join(os.tmpdir(), `command-center-note-${operation}-outside-`));
    try {
      const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: `topic-${operation}-directory-race`, root });
      let source;
      if (operation === 'move') source = await adapter.create({ path: 'source.md', text: 'original' });
      adapter.beforeDirectoryComponentCreate = async ({ segment }) => {
        if (segment === 'nested') await symlink(outside, path.join(root, 'nested'));
      };
      const mutate = operation === 'create'
        ? () => adapter.create({ path: 'nested/child/note.md', text: 'command center' })
        : () => adapter.move({ path: 'source.md', destinationPath: 'nested/child/note.md', expectedRevision: source.note.revision });
      await assert.rejects(mutate, (error) => ['unsafe-path', 'conflict'].includes(error.code));
      assert.deepEqual(await readdir(outside), []);
      if (operation === 'move') assert.equal(await readFile(path.join(root, 'source.md'), 'utf8'), 'original');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
});

test('edit rollback retains the verified claim when an external Note reappears', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-edit-rollback-race-'));
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-edit-rollback-race', root });
    const created = await adapter.create({ path: 'note.md', text: 'original' });
    adapter.afterSourceClaim = async ({ operation }) => {
      if (operation === 'edit') await writeFile(path.join(root, 'note.md'), 'external replacement');
    };
    await assert.rejects(
      () => adapter.edit({ path: 'note.md', expectedRevision: created.note.revision, text: 'command center' }),
      (error) => error.code === 'conflict'
    );
    assert.equal(await readFile(path.join(root, 'note.md'), 'utf8'), 'external replacement');
    const claim = (await readdir(root)).find((entry) => entry.includes('.command-center-claim-'));
    assert.ok(claim);
    assert.equal(await readFile(path.join(root, claim), 'utf8'), 'original');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('move rollback retains the verified claim when source and destination reappear', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-move-rollback-race-'));
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-move-rollback-race', root });
    const created = await adapter.create({ path: 'source.md', text: 'original' });
    adapter.afterSourceClaim = async ({ operation }) => {
      if (operation !== 'move') return;
      await writeFile(path.join(root, 'source.md'), 'external source');
      await writeFile(path.join(root, 'destination.md'), 'external destination');
    };
    await assert.rejects(
      () => adapter.move({ path: 'source.md', destinationPath: 'destination.md', expectedRevision: created.note.revision }),
      (error) => error.code === 'conflict'
    );
    assert.equal(await readFile(path.join(root, 'source.md'), 'utf8'), 'external source');
    assert.equal(await readFile(path.join(root, 'destination.md'), 'utf8'), 'external destination');
    const claim = (await readdir(root)).find((entry) => entry.includes('.command-center-claim-'));
    assert.ok(claim);
    assert.equal(await readFile(path.join(root, claim), 'utf8'), 'original');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('metadata failure rolls back a newly published Note without deleting external replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-metadata-failure-'));
  try {
    const metadata = {
      listSourceReferences: () => [],
      getSourceReference: () => null,
      createSourceReference: () => { throw new Error('fictional metadata failure'); }
    };
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-metadata-failure', root, metadata });
    await assert.rejects(() => adapter.create({ path: 'note.md', text: 'command center' }), /fictional metadata failure/);
    assert.equal(await readFile(path.join(root, 'note.md'), 'utf8').catch(() => null), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('edit rehashes the claimed inode after publication and preserves an open-descriptor write', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-open-descriptor-race-'));
  let descriptor;
  try {
    const adapter = new NoteAdapter({ fsSafeRootFactory, topicId: 'topic-open-descriptor-race', root });
    const created = await adapter.create({ path: 'note.md', text: 'original' });
    descriptor = await open(path.join(root, 'note.md'), 'r+');
    adapter.afterAtomicPublish = async ({ operation }) => {
      if (operation !== 'edit') return;
      await descriptor.truncate(0);
      await descriptor.writeFile('external descriptor edit');
      await descriptor.sync();
    };
    await assert.rejects(
      () => adapter.edit({ path: 'note.md', expectedRevision: created.note.revision, text: 'candidate' }),
      (error) => error.code === 'conflict'
    );
    assert.equal(await readFile(path.join(root, 'note.md'), 'utf8'), 'external descriptor edit');
    const claims = (await readdir(root)).filter((entry) => entry.includes('.command-center-claim-'));
    assert.equal(claims.length, 1);
    assert.equal(await readFile(path.join(root, claims[0]), 'utf8'), 'external descriptor edit');
    const [descriptorStat, claimStat] = await Promise.all([descriptor.stat(), lstat(path.join(root, claims[0]))]);
    assert.equal(claimStat.dev, descriptorStat.dev);
    assert.equal(claimStat.ino, descriptorStat.ino);
  } finally {
    await descriptor?.close();
    await rm(root, { recursive: true, force: true });
  }
});
