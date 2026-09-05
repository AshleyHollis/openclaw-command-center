import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { NoteAdapter } from '../src/sources/notes.mjs';

test('folder relocation atomically preserves existing Note identities and fences stale ownership', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-note-locator-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    for (const topicId of ['topic-notes', 'topic-foreign']) metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    const from = path.join(stateDir, 'fictional-vault', 'Original');
    const to = path.join(stateDir, 'fictional-vault', 'Renamed');
    const final = path.join(stateDir, 'fictional-vault', 'Final');
    const create = (referenceId, sourceKind, externalSourceId, topicId = 'topic-notes') => metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'obsidian', sourceKind, externalSourceId, observedRevision: 'revision-original' });
    const folder = create('folder:notes', 'note_folder', 'note-folder:topic-notes');
    const note = create('note:nested', 'note', `${from}/nested/evidence.md`);
    const sibling = create('note:sibling', 'note', `${from}-sibling/evidence.md`);
    metadata.setSourceLocator({ referenceId: folder.referenceId, locator: from, observedRevision: 'folder-identity' });
    const move = (source, destination, version) => metadata.relocateNoteFolder({ referenceId: folder.referenceId, from: source, to: destination, expectedLocatorVersion: version, expectedSourceRevision: 'folder-identity' });
    assert.throws(() => move(from, to, 0), /stale|conflict/i);
    move(from, to, 1);
    assert.deepEqual(metadata.getSourceReference(note.referenceId), note);
    assert.equal(metadata.getSourceLocator(note.referenceId).locator, `${to}/nested/evidence.md`);
    assert.equal(metadata.getSourceLocator(sibling.referenceId), null);
    const adapter = new NoteAdapter({ metadata, topicId: 'topic-notes' });
    const resolved = adapter.noteReference(to, 'nested/evidence.md', note.observedRevision);
    assert.equal(resolved.referenceId, note.referenceId);
    assert.equal(resolved.externalSourceId, note.externalSourceId);
    assert.throws(() => move(from, final, 1), /stale|conflict/i);
    const foreign = create('note:foreign', 'note', `${final}/nested/evidence.md`, 'topic-foreign');
    const before = metadata.listSourceLocators();
    assert.throws(() => move(to, final, 2), /owned|ambiguous|conflict/i);
    assert.deepEqual(metadata.listSourceLocators(), before, 'failed relocation must not partially move folder or child locators');
    assert.deepEqual(metadata.getSourceReference(foreign.referenceId), foreign);
    const safeDestination = path.join(stateDir, 'fictional-vault', 'Area');
    move(to, safeDestination, 2);
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    assert.equal(metadata.getSourceLocator(folder.referenceId).locator, safeDestination);
    assert.equal(metadata.getSourceLocator(note.referenceId).locator, `${safeDestination}/nested/evidence.md`);
    assert.deepEqual(metadata.getSourceReference(note.referenceId), note);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
