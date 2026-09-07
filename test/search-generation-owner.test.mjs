import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { NoteAdapter } from '../src/sources/notes.mjs';
import { enrollNoteFolderIdentity } from '../src/sources/note-folder-identity.mjs';
import { createSearchRebuildService } from '../src/search/rebuild.mjs';
import { createTopicSearchService } from '../src/search/service.mjs';
import { withGroupedProjectionPublication } from '../src/search/projection-store.mjs';

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-generation-'));
  const root = path.join(stateDir, 'fictional-notes'); await mkdir(root);
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, search: true } });
  try {
    const topicId = 'fictional-generation';
    metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder:generation', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root });
    metadata.setSourceLocator({ referenceId: 'folder:generation', locator: root, observedRevision: await enrollNoteFolderIdentity(root) });
    await writeFile(path.join(root, 'brief.md'), 'original quartz');
    const notes = new NoteAdapter({ metadata, topicId, noteFolderReferenceId: 'folder:generation', fsSafeRootFactory: async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative) }) });
    const rebuild = createSearchRebuildService({ stateDir, metadata, noteAdapterFactory: () => notes, transcriptReader: async () => [], requireAuthorizedPreparation: true });
    const search = createTopicSearchService({ stateDir, metadata, rebuild: (input) => rebuild.rebuild(input), preparedRebuild: async (input) => { await rebuild.prepareAuthorized(input); return rebuild.rebuildPrepared(input); } });
    await search.rebuild();
    await run({ stateDir, metadata, notes, rebuild, search, topicId });
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('an authorized prepared Search corpus cannot commit after a real Note edit invalidates its generation', async () => {
  await fixture(async ({ notes, rebuild, search, topicId }) => {
    const input = { topicId, logicalOperationId: randomUUID() };
    await rebuild.prepareAuthorized(input);
    const original = await notes.read({ path: 'brief.md' });
    await notes.edit({ path: 'brief.md', text: 'newest sapphire', expectedRevision: original.revision, logicalOperationId: randomUUID() });
    await search.invalidate({ preserveCommittedProjection: true });
    await assert.rejects(search.rebuildPrepared(input), (error) => error.code === 'conflict');
    await assert.rejects(search.query({ schemaVersion: 1, topicId, query: 'quartz' }), (error) => error.code === 'capability-unavailable');
    await search.rebuildPrepared(input);
    assert.equal((await search.query({ schemaVersion: 1, topicId, query: 'sapphire' })).notes.results.length, 1);
    assert.equal((await search.query({ schemaVersion: 1, topicId, query: 'quartz' })).notes.results.length, 0);
  });
});

test('a durable old Search receipt cannot clear a newer invalidation after reopening the service', async () => {
  await fixture(async ({ stateDir, metadata, notes, rebuild, search, topicId }) => {
    const input = { topicId, logicalOperationId: randomUUID() };
    const receipt = await search.rebuildPrepared(input);
    const original = await notes.read({ path: 'brief.md' });
    await notes.edit({ path: 'brief.md', text: 'newest sapphire', expectedRevision: original.revision, logicalOperationId: randomUUID() });
    await search.invalidate({ preserveCommittedProjection: true });
    await rebuild.rebuild();
    const reopened = createSearchRebuildService({ stateDir, metadata, requireAuthorizedPreparation: true });
    assert.deepEqual(await reopened.rebuildPrepared(input), receipt, 'An applied operation remains an immutable historical receipt.');
    const restarted = createTopicSearchService({ stateDir, metadata, preparedRebuild: (request) => reopened.rebuildPrepared(request) });
    await assert.rejects(restarted.rebuildPrepared(input), (error) => error.code === 'conflict');
    await assert.rejects(restarted.query({ schemaVersion: 1, topicId, query: 'quartz' }), (error) => error.code === 'capability-unavailable');
  });
});

test('a completed newer rebuild cannot make an older prepared snapshot fresh again', async () => {
  await fixture(async ({ notes, rebuild, search, topicId }) => {
    const input = { topicId, logicalOperationId: randomUUID() };
    await rebuild.prepareAuthorized(input);
    const original = await notes.read({ path: 'brief.md' });
    await notes.edit({ path: 'brief.md', text: 'newest sapphire', expectedRevision: original.revision, logicalOperationId: randomUUID() });
    await search.invalidate({ preserveCommittedProjection: true });
    await search.rebuild();
    await assert.rejects(search.rebuildPrepared(input), (error) => error.code === 'conflict');
    assert.equal((await search.query({ schemaVersion: 1, topicId, query: 'sapphire' })).notes.results.length, 1);
  });
});

test('publication rechecks freshness after waiting for the grouped projection owner', async () => {
  await fixture(async ({ stateDir, rebuild, search, topicId }) => {
    const input = { topicId, logicalOperationId: randomUUID() };
    await rebuild.prepareAuthorized(input);
    const entered = Promise.withResolvers(); const release = Promise.withResolvers();
    const holding = withGroupedProjectionPublication({ stateDir }, async () => { entered.resolve(); await release.promise; });
    let publishing;
    try {
      await entered.promise;
      publishing = rebuild.rebuildPrepared(input);
      const refusal = assert.rejects(publishing, (error) => error.code === 'conflict');
      await search.invalidate({ preserveCommittedProjection: true });
      release.resolve();
      await holding; await refusal;
      await assert.rejects(search.query({ schemaVersion: 1, topicId, query: 'quartz' }), (error) => error.code === 'capability-unavailable');
    } finally { release.resolve(); await holding; await publishing?.catch(() => {}); }
  });
});

test('freshness fencing preserves recovery of a corrupt disposable commit record', async () => {
  await fixture(async ({ stateDir, search, topicId }) => {
    await writeFile(path.join(stateDir, 'plugins', 'command-center', 'projections', 'topic-search-notes.commit.json'), '{corrupt disposable record');
    await search.rebuild();
    assert.equal((await search.query({ schemaVersion: 1, topicId, query: 'quartz' })).notes.results.length, 1);
  });
});

test('metadata-only invalidation still fences prepared rows when marker publication fails', async () => {
  await fixture(async ({ stateDir, notes, rebuild, search, topicId }) => {
    const input = { topicId, logicalOperationId: randomUUID() };
    await rebuild.prepareAuthorized(input);
    const original = await notes.read({ path: 'brief.md' });
    await notes.edit({ path: 'brief.md', text: 'newest sapphire', expectedRevision: original.revision, logicalOperationId: randomUUID() });
    const marker = path.join(stateDir, 'plugins', 'command-center', 'projections', '.topic-search.invalidated.json');
    await mkdir(marker);
    try { await search.invalidate({ preserveCommittedProjection: true }); }
    finally { await rmdir(marker); }
    await assert.rejects(search.rebuildPrepared(input), (error) => error.code === 'conflict');
    await assert.rejects(search.query({ schemaVersion: 1, topicId, query: 'quartz' }), (error) => error.code === 'capability-unavailable');
    await search.rebuildPrepared(input);
    assert.equal((await search.query({ schemaVersion: 1, topicId, query: 'sapphire' })).notes.results.length, 1);
  });
});

test('global Search rebuild replaces an oversized corrupt regular commit record', async () => {
  await fixture(async ({ stateDir, search, topicId }) => {
    await writeFile(path.join(stateDir, 'plugins', 'command-center', 'projections', 'topic-search-notes.commit.json'), 'corrupt'.repeat(32 * 1024));
    await search.rebuild();
    assert.equal((await search.query({ schemaVersion: 1, topicId, query: 'quartz' })).notes.results.length, 1);
  });
});

test('oversized invalidation markers remain a fail-closed rebuild refusal', async () => {
  await fixture(async ({ stateDir, search }) => {
    await writeFile(path.join(stateDir, 'plugins', 'command-center', 'projections', '.topic-search.invalidated.json'), 'invalidated'.repeat(8192));
    await assert.rejects(search.rebuild(), (error) => error.code === 'projection-unavailable');
  });
});

test('oversized symlinked commit records remain refused without touching their target', async () => {
  await fixture(async ({ stateDir, search }) => {
    const target = path.join(stateDir, 'fictional-foreign-commit.json'); const contents = 'foreign'.repeat(16 * 1024);
    await writeFile(target, contents);
    const commit = path.join(stateDir, 'plugins', 'command-center', 'projections', 'topic-search-notes.commit.json');
    await rm(commit); await symlink(target, commit, 'file');
    await assert.rejects(search.rebuild(), (error) => error.code === 'projection-unavailable');
    assert.equal(await readFile(target, 'utf8'), contents);
  });
});
