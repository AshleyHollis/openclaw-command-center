import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { readTopicSearchFreshness } from '../src/search/freshness.mjs';
import { openProjectionStore } from '../src/search/projection-store.mjs';
import { publishTopicSearchSnapshot, rebuildTopicSearchProjections, reconcileTopicSearchBookkeeping } from '../src/search/rebuild.mjs';

const childFile = fileURLToPath(new URL('./fixtures/topic-search-process-death.mjs', import.meta.url));
const capabilities = { notes: true, sessions: true, search: true };
const topicId = 'fictional-topic';
const query = (word) => ({ schemaVersion: 1, topicId, query: word });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-death-'));
  const notesDir = path.join(stateDir, 'fictional-notes');
  const sessionsDir = path.join(stateDir, 'fictional-sessions');
  await mkdir(notesDir); await mkdir(sessionsDir);
  const noteFile = path.join(notesDir, 'brief.md');
  const sessionFile = path.join(sessionsDir, 'conversation.jsonl');
  await writeFile(noteFile, 'oldtoken fictional Note');
  await writeFile(sessionFile, '{"role":"user","text":"oldtoken fictional Conversation"}\n');
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  try {
    metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    const folder = metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: notesDir });
    const session = metadata.createSourceReference({ version: 1, referenceId: 'session:fictional', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional' });
    metadata.setSessionState({ referenceId: session.referenceId, sessionId: 'fictional-session', status: 'closed', isPrimary: false });
    const prepared = (word) => ({
      freshness: readTopicSearchFreshness(stateDir), topicId: null, topicIds: [topicId],
      noteSourceRevision: `fictional-notes-${word}`, conversationSourceRevision: `fictional-conversations-${word}`,
      notes: [{ topicId, sourceReference: folder, folderReferenceId: folder.referenceId, path: 'brief.md', heading: 'Brief', revision: `fictional-${word}`, text: `${word} fictional Note`, provenance: 'native' }],
      conversations: [{ topicId, sourceReference: session, sessionKey: session.externalSourceId, sessionId: 'fictional-session', messageId: 'message-1', name: 'Fictional Conversation', date: '2026-08-26T00:00:00.000Z', closed: true, primaryState: 'ordinary', role: 'user', provenance: 'native', text: `${word} fictional Conversation` }]
    });
    await publishTopicSearchSnapshot({ stateDir, prepared: prepared('oldtoken'), metadata });
    await writeFile(noteFile, 'newtoken fictional Note');
    await writeFile(sessionFile, '{"role":"user","text":"newtoken fictional Conversation"}\n');
    const sourceDigests = [digest(await readFile(noteFile)), digest(await readFile(sessionFile))];
    const rebuildFromSources = () => rebuildTopicSearchProjections({ stateDir, metadata,
      authoritativeSources: { readTopicSnapshot: async () => {
        const note = await readFile(noteFile, 'utf8');
        const conversation = await readFile(sessionFile, 'utf8');
        const word = note.includes('newtoken') && conversation.includes('newtoken') ? 'newtoken' : 'oldtoken';
        const snapshot = prepared(word);
        return { notes: snapshot.notes, conversations: snapshot.conversations,
          note: { sourceRevision: digest(note) }, conversation: { sourceRevision: digest(conversation) } };
      } } });
    await run({ stateDir, metadata, prepared, sourceDigests, noteFile, sessionFile, rebuildFromSources });
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

async function pair(stateDir, metadata) {
  const notes = await openProjectionStore({ stateDir, kind: 'note' });
  const conversations = await openProjectionStore({ stateDir, kind: 'conversation' });
  try {
    const manifests = [notes.manifest(), conversations.manifest()];
    assert.ok(manifests.every(Boolean), 'both committed projections must exist');
    for (const manifest of manifests) {
      const checkpoint = metadata.getProjectionBookkeeping(manifest.projectionId);
      assert.equal(checkpoint.sourceRevision, manifest.sourceRevision);
      assert.equal(checkpoint.inputDigest, manifest.inputDigest);
    }
    return { generations: manifests.map(({ generation }) => generation),
      old: [notes.query(query('oldtoken')).length, conversations.query(query('oldtoken')).length],
      next: [notes.query(query('newtoken')).length, conversations.query(query('newtoken')).length] };
  } finally { notes.close(); conversations.close(); }
}

function killAt(stateDir, mode, preparedFile, point) {
  const child = spawnSync(process.execPath, [childFile, stateDir, mode, preparedFile], {
    encoding: 'utf8', env: { ...process.env, COMMAND_CENTER_SEARCH_PROJECTION_CRASH_AT: point }, timeout: 30_000
  });
  assert.equal(child.signal, 'SIGKILL', `Process must die at ${point}: ${child.stderr}`);
}

test('real process death during grouped Search publication restores one complete pair or finalizes the new pair', { skip: process.platform !== 'linux', timeout: 180_000 }, async () => {
  const rollbackPoints = [
    'group-marker-publication', 'write', 'database-publication', 'manifest-publication', 'manifest-write', 'publication',
    'note:write', 'note:database-backup', 'note:commit-backup',
    'note:database-publication', 'note:manifest-publication', 'note:manifest-write',
    'conversation:write', 'conversation:database-backup', 'conversation:commit-backup',
    'conversation:database-publication', 'conversation:manifest-publication', 'conversation:manifest-write',
    'group-pair-finalization'
  ];
  for (const point of [...rollbackPoints, 'group-marker-removal']) await fixture(async ({ stateDir, metadata, prepared, sourceDigests, noteFile, sessionFile, rebuildFromSources }) => {
    const old = await pair(stateDir, metadata);
    const preparedFile = path.join(stateDir, 'fictional-prepared.json');
    await writeFile(preparedFile, JSON.stringify(prepared('newtoken')));
    killAt(stateDir, 'group', preparedFile, point);
    if (point === 'note:write' || point === 'conversation:write') {
      const pending = await readdir(path.join(stateDir, 'plugins', 'command-center', 'projections'));
      assert.ok(pending.some((name) => name.includes('.rebuilding-')), `${point}: expected dead writer's temporary artifact`);
    }
    assert.equal(await reconcileTopicSearchBookkeeping({ stateDir, metadata }), true, `${point}: restart must reconcile the pair`);
    const recovered = await pair(stateDir, metadata);
    const isCommittedNew = point === 'group-marker-removal';
    if (isCommittedNew) {
      assert.deepEqual(recovered.old, [0, 0], point);
      assert.deepEqual(recovered.next, [1, 1], point);
      assert.notDeepEqual(recovered.generations, old.generations, point);
    } else {
      assert.deepEqual(recovered, old, point);
    }
    assert.deepEqual([digest(await readFile(noteFile)), digest(await readFile(sessionFile))], sourceDigests, `${point}: authoritative sources changed`);
    // A stale rebuilding file left by the dead writer must never be selected
    // as the committed pair by recovery or the next production publication.
    if (!isCommittedNew) {
      await rebuildFromSources();
      const rebuilt = await pair(stateDir, metadata);
      assert.deepEqual(rebuilt.old, [0, 0], point);
      assert.deepEqual(rebuilt.next, [1, 1], point);
      assert.notDeepEqual(rebuilt.generations, old.generations, point);
    }
    const entries = await readdir(path.join(stateDir, 'plugins', 'command-center', 'projections'));
    assert.equal(entries.includes('.projections.group-publication.json'), false, point);
    assert.equal(entries.some((name) => name.endsWith('.group-rollback')), false, point);
  });
});

test('a killed standalone Note rebuild after moving its old database keeps its committed manifest', { skip: process.platform !== 'linux' }, async () => fixture(async ({ stateDir, metadata, prepared }) => {
  const old = await pair(stateDir, metadata);
  const preparedFile = path.join(stateDir, 'fictional-prepared.json');
  await writeFile(preparedFile, JSON.stringify(prepared('newtoken')));
  killAt(stateDir, 'note', preparedFile, 'note:database-backup');
  const recovered = await pair(stateDir, metadata);
  assert.deepEqual(recovered, old);
}));
