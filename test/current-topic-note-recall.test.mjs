import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, chmod, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { prepareTopicSearchSnapshot, publishTopicSearchSnapshot } from '../src/search/rebuild.mjs';
import { createTopicSearchService } from '../src/search/service.mjs';
import { createCurrentTopicNoteRecallPolicy, topicContextLimits } from '../src/search/context.mjs';
import { currentTopicNoteRecallToolFactory } from '../src/search/tool.mjs';
import { revisionForBytes } from '../src/sources/reference.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { verifyInstalledRecallEvidence } from './support/notes-installed-journey.mjs';

const release = installHostFileAccessFixture();
test.after(release);
const fsSafeRootFactory = async rootDir => ({ rootDir, rootReal: rootDir, resolve: async relative => path.join(rootDir, relative), open: async relative => ({ handle: await (await import('node:fs/promises')).open(path.join(rootDir, relative), 'r') }) });
async function fixture(run, { count = 2, crlf = false, beforePathIo } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-note-recall-'));
  const stateDir = path.join(root, 'state');
  const metadata = { ...openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, search: true } }) };
  let sources, search;
  try {
    const notes = [];
    for (const topicId of ['topic-one', 'topic-two']) {
      const folder = path.join(root, topicId);
      await mkdir(path.join(folder, 'nested'), { recursive: true });
      metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
      metadata.createSourceReference({ version: 1, referenceId: `folder:${topicId}`, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folder, observedRevision: null });
      await enrollFixtureFolder(metadata, `folder:${topicId}`, folder);
      for (let index = 0; index < count; index++) {
        const notePath = index === 0 ? 'shared.md' : `nested/note-${index}.md`;
        const text = `# Recall ${index}${crlf ? '\r\n' : '\n'}alpha shared ${topicId} ${'bounded text '.repeat(50)}`;
        await writeFile(path.join(folder, notePath), text);
        const revision = revisionForBytes(Buffer.from(text));
        const sourceReference = metadata.createSourceReference({ version: 1, referenceId: `note:${topicId}:${index}`, topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${folder}/${notePath}`, observedRevision: revision });
        notes.push({ kind: 'note', topicId, sourceReference, folderReferenceId: `folder:${topicId}`, path: notePath, heading: `Recall ${index}`, revision, text: text.replaceAll('\r\n', '\n').trim(), provenance: 'native' });
      }
    }
    const sessionKey = 'agent:main:fictional-recall';
    metadata.createSourceReference({ version: 1, referenceId: 'session:recall', topicId: 'topic-one', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: null });
    metadata.setSessionState({ referenceId: 'session:recall', sessionId: 'fictional-incarnation', status: 'open', isPrimary: true });
    const prepared = await prepareTopicSearchSnapshot({ stateDir, metadata, topicIds: ['topic-one', 'topic-two'], authoritativeSources: { readTopicSnapshot: async ({ topicId }) => ({ note: { notes: notes.filter(note => note.topicId === topicId), sourceRevision: `fixture:${topicId}` }, conversation: { conversations: [], sourceRevision: 'empty' }, notes: notes.filter(note => note.topicId === topicId), conversations: [] }) } });
    await publishTopicSearchSnapshot({ stateDir, metadata, prepared });
    sources = createAuthoritativeSourceService({ metadata, capabilities: { notes: true }, fsSafeRootFactory, beforePathIo, noteRecoveryEffects: false });
    search = createTopicSearchService({ stateDir, metadata, sourceService: sources });
    const policy = createCurrentTopicNoteRecallPolicy({ metadata, searchService: search });
    const context = { sessionKey, sessionId: 'fictional-incarnation' };
    const tool = currentTopicNoteRecallToolFactory(policy)(context);
    await run({ metadata, sources, search, policy, tool, context, root, notes });
  } finally { search?.close(); sources?.close(); metadata.close(); await rm(root, { recursive: true, force: true }); }
}

test('public recall tool returns fresh root/shared and nested Notes from only the trusted Topic', async () => {
  await fixture(async ({ tool, notes, search }) => {
    const response = await tool.execute('recall', { query: 'alpha' });
    assert.equal(response.details.status, 'available');
    assert.equal(response.details.groups.notes.length, 2);
    assert.equal(response.details.groups.conversations.length, 0);
    const evidenceBasis = { topicId: 'topic-one', noteTextByReference: new Map(notes.filter(note => note.topicId === 'topic-one').map(note => [note.sourceReference.referenceId, { text: note.text, revision: note.revision, path: note.path }])) };
    verifyInstalledRecallEvidence(response.details, evidenceBasis);
    for (const mutate of [
      value => { value.currentTopic.topicId = 'topic-two'; },
      value => { value.retrievedTopic.topicId = 'topic-two'; },
      value => { value.groups.notes[0].sourceReference.topicId = 'topic-two'; },
      value => { value.groups.notes[0].navigation.topicId = 'topic-two'; },
      value => { value.groups.notes[0].citation.start = -1; },
      value => { value.groups.notes[0].citation.start = 0.5; },
      value => { value.groups.notes[0].citation.end = Number.MAX_SAFE_INTEGER; }
    ]) {
      const tampered = structuredClone(response.details); mutate(tampered);
      assert.throws(() => verifyInstalledRecallEvidence(tampered, evidenceBasis), { name: 'AssertionError' });
    }
    for (const item of response.details.groups.notes) {
      assert.equal(item.originatingTopic.topicId, 'topic-one');
      const note = notes.find(note => note.sourceReference.referenceId === item.sourceReference.referenceId);
      assert.equal(note.text.slice(item.citation.start, item.citation.end), item.excerpt);
      assert.equal(item.citation.revision, item.navigation.observedRevision);
      const opened = await search.navigate(item.navigation);
      assert.equal(opened.revision, item.citation.revision);
    }
    for (const params of [{ query: 'alpha', targetTopicId: 'topic-two' }, { query: 'alpha', sessionId: 'forged' }, { query: 'alpha', crossTopicBasis: 'task-necessity' }]) await assert.rejects(tool.execute('invalid', params), error => error.code === 'invalid-request');
  });
});

test('CRLF citation offsets preserve exact original bytes and existing navigation', async () => {
  await fixture(async ({ tool, search }) => {
    const response = await tool.execute('recall', { query: 'alpha' });
    assert.equal(response.details.status, 'available');
    for (const item of response.details.groups.notes) {
      const opened = await search.navigate(item.navigation);
      assert.equal(opened.text.slice(item.citation.start, item.citation.end), item.excerpt);
    }
  }, { crlf: true });
});

test('recall respects eight excerpts, Unicode excerpt bounds and serialized output bounds', async () => {
  await fixture(async ({ tool }) => {
    const response = await tool.execute('recall', { query: 'alpha' });
    assert.equal(response.details.groups.notes.length, 8);
    assert.equal(response.details.truncation.notes, true);
    assert.ok(Buffer.byteLength(response.content[0].text) <= topicContextLimits.maxOutputBytes);
    assert.ok(response.details.groups.notes.every(item => Array.from(item.excerpt).length <= 320));
    await assert.rejects(tool.execute('invalid', { query: 'alpha', limit: 9 }));
  }, { count: 10 });
});

for (const race of ['reset', 'reassignment', 'folder-binding', 'folder-replacement', 'revision', 'permission', 'nested-permission', 'reference-removal', 'cancel']) {
  test(`recall rejects ${race} during an awaited second Note read`, async () => {
    let change;
    let reads = 0;
    await fixture(async ({ metadata, sources, root, tool }) => {
      const controller = new AbortController();
      let firstPath;
      const originalRead = sources.prepareNotesRecall.bind(sources);
      sources.prepareNotesRecall = async input => {
        const lease = await originalRead(input);
        firstPath ??= lease.note.path;
        return lease;
      };
      change = async () => {
        if (race === 'reset') metadata.setSessionState({ referenceId: 'session:recall', sessionId: 'replacement', status: 'open', isPrimary: true });
        if (race === 'reassignment') {
          // Deployed metadata forbids reassignment of an already linked Session;
          // model a host/owner successor at the read authority boundary.
          const original = metadata.listSourceReferences;
          metadata.listSourceReferences = id => original(id).map(reference => reference.referenceId === 'session:recall' ? { ...reference, topicId: 'topic-two' } : reference);
        }
        if (race === 'folder-binding') metadata.setSourceLocator({ referenceId: 'folder:topic-one', locator: path.join(root, 'topic-two'), observedRevision: 'replaced', ownership: 'external' });
        if (race === 'revision') await writeFile(path.join(root, 'topic-one', firstPath), 'changed');
        if (race === 'folder-replacement') { await rename(path.join(root, 'topic-one'), path.join(root, 'replaced-folder')); await mkdir(path.join(root, 'topic-one')); }
        if (race === 'nested-permission') await chmod(path.join(root, 'topic-one/nested'), 0o000);
        if (race === 'reference-removal') { const original = metadata.getSourceReference; metadata.getSourceReference = id => id.startsWith('note:') ? null : original(id); }
        if (race === 'permission') await chmod(path.join(root, 'topic-one'), 0o000);
        if (race === 'cancel') controller.abort(new Error('fixture cancelled'));
      };
      try {
        if (race === 'nested-permission') {
          let response;
          try { response = await tool.execute('recall', { query: 'alpha' }, controller.signal); }
          catch (error) { assert.ok(['source-recovery', 'EACCES'].includes(error.code)); assert.ok(firstPath.startsWith('nested/')); }
          if (response) { assert.equal(response.details.status, 'partial'); assert.ok(!firstPath.startsWith('nested/')); assert.ok(response.details.groups.notes.every(item => !item.navigation.path.startsWith('nested/'))); }
        } else await assert.rejects(tool.execute('recall', { query: 'alpha' }, controller.signal), error => race === 'cancel' ? error.message === 'fixture cancelled' : ['source-recovery', 'conflict', 'EACCES'].includes(error.code));
        assert.ok(reads >= 2, 'the second read boundary was reached');
      } finally {
        if (race === 'permission') await chmod(path.join(root, 'topic-one'), 0o700);
        if (race === 'nested-permission') await chmod(path.join(root, 'topic-one/nested'), 0o700);
      }
    }, { beforePathIo: async ({ operation }) => { if (operation === 'read' && ++reads === 2) await change(); } });
  });
}

test('publication remains fenced through the tool await and releases all leases', async () => {
  await fixture(async ({ metadata, policy, context }) => {
    let closed = false;
    const tool = currentTopicNoteRecallToolFactory({ retrieve: async input => {
      const publication = await policy.retrieve(input);
      queueMicrotask(() => metadata.setSessionState({ referenceId: 'session:recall', sessionId: 'after-read-reset', status: 'open', isPrimary: true }));
      return { ...publication, close() { closed = true; publication.close(); } };
    } })(context);
    await assert.rejects(tool.execute('recall', { query: 'alpha' }), error => error.code === 'source-recovery');
    assert.equal(closed, true);
  });
});

test('empty result still requires an available Note owner', async () => {
  await fixture(async ({ sources, tool, root }) => {
    const response = await tool.execute('recall', { query: 'nomatches' });
    assert.equal(response.details.status, 'no-matches');
    sources.close();
    await assert.rejects(tool.execute('recall', { query: 'nomatches' }), error => error.code === 'capability-unavailable');
  });
});


test('unavailable committed projection returns an honest empty unavailable state', async () => {
  await fixture(async ({ search, tool }) => {
    await search.invalidate({ preserveCommittedProjection: true });
    const response = await tool.execute('recall', { query: 'alpha' });
    assert.equal(response.details.status, 'unavailable');
    assert.deepEqual(response.details.groups.notes, []);
  });
});
