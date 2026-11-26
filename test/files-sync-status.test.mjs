import assert from 'node:assert/strict';
import { chmod, chown, link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { enrollNoteFolderIdentity } from '../src/sources/note-folder-identity.mjs';
import { FILES_SYNC_STATUS_NAME } from '../src/sources/note-path.mjs';
import { createNoteAdapter } from '../src/sources/notes.mjs';
import { createTopicService } from '../src/topics/service.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

const topicId = 'fictional-sync-topic';
const referenceId = 'fictional-sync-folder';
const statusUnavailable = { schemaVersion: 1, state: 'unknown', lastSuccessAt: null, updatedAt: null };

async function fixture(t) {
  const restoreHost = installHostFileAccessFixture();
  t.after(restoreHost);
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fictional-files-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'topic');
  await mkdir(folder);
  const identity = await enrollNoteFolderIdentity(folder);
  const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { notes: true } });
  t.after(() => metadata.close());
  metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({
    version: 1, referenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'fictional-topic-folder'
  });
  metadata.setSourceLocator({ referenceId, locator: folder, observedRevision: identity, ownership: 'adopted' });
  const topics = createTopicService({ metadata });
  const getTopic = async () => (await invokeBridgeMethod({ topics }, 'command-center.v1.topics.get', { schemaVersion: 1, topicId })).topic;
  return { metadata, root, folder, identity, getTopic, statusPath: path.join(folder, FILES_SYNC_STATUS_NAME) };
}

test('verified Topic projects only the bound, current sync snapshot', {
  skip: process.platform !== 'linux' || process.getuid() !== 0 ? 'Linux root-owned status fixture' : false
}, async t => {
  const { metadata, root, folder, identity, getTopic, statusPath } = await fixture(t);
  assert.equal((await getTopic()).filesSyncStatus, undefined);
  const lastSuccessAt = '2000-01-02T03:04:05.000Z';
  const current = { schemaVersion: 1, state: 'waiting', lastSuccessAt, updatedAt: new Date().toISOString() };
  await writeFile(statusPath, JSON.stringify(current), { mode: 0o644 });
  assert.deepEqual((await getTopic()).filesSyncStatus, current);
  const stale = { ...current, updatedAt: lastSuccessAt };
  await writeFile(statusPath, JSON.stringify(stale));
  assert.deepEqual((await getTopic()).filesSyncStatus, { ...stale, state: 'unknown' });
  await writeFile(statusPath, JSON.stringify({ ...stale, state: 'paused' }));
  assert.deepEqual((await getTopic()).filesSyncStatus, { ...stale, state: 'paused' });

  for (const contents of ['bad json', 'x'.repeat(513), JSON.stringify({ ...current, error: 'private value' }),
    JSON.stringify({ ...current, updatedAt: '2026-02-30T00:00:00Z' }),
    JSON.stringify({ ...current, updatedAt: new Date(Date.now() + 3600_000).toISOString() })]) {
    await writeFile(statusPath, contents);
    assert.deepEqual((await getTopic()).filesSyncStatus, statusUnavailable);
  }
  await writeFile(statusPath, JSON.stringify(current));
  await chmod(statusPath, 0o666);
  assert.deepEqual((await getTopic()).filesSyncStatus, statusUnavailable);
  await chmod(statusPath, 0o644);
  await chown(statusPath, 1000, 1000);
  assert.deepEqual((await getTopic()).filesSyncStatus, statusUnavailable);
  await chown(statusPath, 0, 0);
  const alias = path.join(root, 'alias');
  await link(statusPath, alias);
  assert.deepEqual((await getTopic()).filesSyncStatus, statusUnavailable);
  await unlink(statusPath);
  await symlink(alias, statusPath);
  assert.deepEqual((await getTopic()).filesSyncStatus, statusUnavailable);
  await unlink(statusPath);
  await writeFile(statusPath, JSON.stringify(current), { mode: 0o644 });

  const replacement = path.join(root, 'replacement');
  await mkdir(replacement);
  await enrollNoteFolderIdentity(replacement);
  await writeFile(path.join(replacement, FILES_SYNC_STATUS_NAME), JSON.stringify(current), { mode: 0o644 });
  metadata.setSourceLocator({ referenceId, locator: replacement, observedRevision: identity, ownership: 'adopted' });
  const mismatched = await getTopic();
  assert.equal(mismatched.health, 'source-recovery');
  assert.equal(mismatched.filesSyncStatus, undefined);
  assert.equal(JSON.stringify(mismatched).includes(folder), false);
  assert.equal(JSON.stringify(mismatched).includes(replacement), false);
});

test('the Topic file catalog and reader skip publisher scratch and status entries', {
  skip: process.platform !== 'linux' ? 'Linux descriptor-anchored file paths' : false
}, async t => {
  const { metadata, folder, statusPath } = await fixture(t);
  const notePath = path.join(folder, 'fictional-note.md');
  await writeFile(notePath, '# Fictional note');
  // Both cycling entries disappear before content I/O. A normal symlink
  // remains an unsafe-path failure in the Note catalog.
  await symlink(notePath, statusPath);
  await symlink(notePath, path.join(folder, '.command-center-sync-status-fixture.tmp'));
  const notes = createNoteAdapter({
    metadata, topicId, noteFolderReferenceId: referenceId,
    fsSafeRootFactory: async rootDir => ({ rootDir, rootReal: rootDir, resolve: relative => path.join(rootDir, relative) })
  });
  t.after(() => notes.close());
  assert.deepEqual((await notes.browse({ includeDocuments: true, observe: false })).map(note => note.path), ['fictional-note.md']);
  assert.deepEqual((await notes.browsePage({ includeDocuments: true, observe: false })).notes.map(note => note.path), ['fictional-note.md']);
  await assert.rejects(notes.read({ path: FILES_SYNC_STATUS_NAME, sourceKind: 'document', observe: false }), { code: 'invalid-path' });
});

test('Topic bridge omits unapproved status metadata from its response', async () => {
  const topics = { getVerified: async () => ({
    topicId,
    filesSyncStatus: { ...statusUnavailable, path: 'private location' }
  }) };
  const answer = await invokeBridgeMethod({ topics }, 'command-center.v1.topics.get', { schemaVersion: 1, topicId });
  assert.deepEqual(answer, { topic: { topicId } });
});
