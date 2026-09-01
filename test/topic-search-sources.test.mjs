import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConversationSourceSnapshot, readNoteSourceSnapshot } from '../src/search/source-snapshot.mjs';
import { canonicalImportedUserMessage } from '../src/migration/transcript.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { NoteAdapter } from '../src/sources/notes.mjs';

const topic = { topicId: 'topic-one', paraCategory: 'project' };
const noteFolder = { version: 1, referenceId: 'folder:one', topicId: 'topic-one', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/topic-one', observedRevision: null };
const noteReference = { version: 1, referenceId: 'note:one', topicId: 'topic-one', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic-one/one.md', observedRevision: 'sha256:one' };
const sessionReference = { version: 1, referenceId: 'session:one', topicId: 'topic-one', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:command-center:one', observedRevision: null };
const fsSafeRootFactory = async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative) });

function metadata() {
  return {
    getTopic: (id) => id === topic.topicId ? topic : null,
    listSourceReferences: (id) => id === topic.topicId ? [noteFolder, noteReference, sessionReference] : [],
    getSessionState: (id) => id === sessionReference.referenceId ? { referenceId: id, sessionId: 'session-one', status: 'closed', isPrimary: false } : null
  };
}

function entry(id, text, createdAt, extra = {}) {
  return { id, role: 'user', createdAt, content: text, ...extra };
}

function visibleGateway(messages, observe = () => {}) {
  return { request: async (method, input) => {
    observe({ method, ...input });
    if (method === 'sessions.describe') return { session: { ['k' + 'ey']: input['k' + 'ey'], sessionId: input['k' + 'ey'] === sessionReference.externalSourceId ? 'session-one' : `session-id-${input['k' + 'ey'].split(':').at(-1)}`, derivedTitle: 'Fictional conversation' } };
    assert.equal(method, 'chat.history');
    return { sessionKey: input.sessionKey, sessionId: input.sessionKey === sessionReference.externalSourceId ? 'session-one' : `session-id-${input.sessionKey.split(':').at(-1)}`, messages: input.offset === 0 ? messages : [], hasMore: false };
  } };
}

test('Note source snapshot reads only the exact Topic Folder and preserves heading and context', async () => {
  const snapshot = await readNoteSourceSnapshot({
    topicId: topic.topicId, metadata: metadata(), query: 'alpha',
    noteAdapter: {
      browse: async () => [{ path: 'one.md', sourceReference: noteReference }],
      read: async () => ({ path: 'one.md', text: '# Heading\n\nalpha match\n\nbefore after', revision: 'sha256:one', sourceReference: noteReference })
    }
  });
  assert.equal(snapshot.notes[0].heading, 'Heading');
  assert.equal(snapshot.notes[0].path, 'one.md');
  assert.equal(snapshot.notes[0].sourceReference.referenceId, noteReference.referenceId);
  assert.equal(snapshot.notes[0].contextAfter, 'before after');
  await assert.rejects(() => readNoteSourceSnapshot({ topicId: topic.topicId, metadata: metadata(), noteAdapter: { browse: async () => [{ path: 'foreign.md', sourceReference: { ...noteReference, topicId: 'topic-two' } }], read: async () => ({}) } }), /foreign|identity/i);
});

test('production source snapshots settle when startup rebuild cancellation interrupts pending authority reads', async () => {
  const noteAbort = new AbortController();
  const noteSnapshot = readNoteSourceSnapshot({
    topicId: topic.topicId,
    metadata: metadata(),
    signal: noteAbort.signal,
    noteAdapter: { browse: () => new Promise(() => {}), read: async () => ({}) }
  });
  noteAbort.abort(new Error('cancel pending Note snapshot'));
  await assert.rejects(noteSnapshot, /cancel pending Note snapshot/u);

  const sessionAbort = new AbortController();
  const conversationSnapshot = readConversationSourceSnapshot({
    topicId: topic.topicId,
    metadata: metadata(),
    signal: sessionAbort.signal,
    gateway: { request: () => new Promise(() => {}) }
  });
  sessionAbort.abort(new Error('cancel pending Session snapshot'));
  await assert.rejects(conversationSnapshot, /cancel pending Session snapshot/u);
});

test('Note source snapshot indexes sections and preserves null headings with stable Note identities', async () => {
  const calls = [];
  const snapshot = await readNoteSourceSnapshot({ topicId: topic.topicId, metadata: metadata(), noteAdapter: {
    browse: async (input) => { calls.push(input); return [{ path: 'one.md', revision: 'sha256:one', sourceReference: noteReference }]; },
    read: async (input) => { calls.push(input); return { path: 'one.md', text: 'preamble\n\n# First\n\nalpha\n\n## Second\n\nbeta', revision: 'sha256:one', sourceReference: noteReference }; }
  } });
  assert.deepEqual(snapshot.notes.map(({ heading }) => heading), [null, 'First', 'Second']);
  assert.deepEqual(calls.map((input) => input.observe), [true, true, false]);
  assert.equal(calls[1].referenceId, noteReference.referenceId);
});

test('production Note snapshot registers the exact authoritative Note identity for navigation', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-note-state-'));
  const vault = path.join(stateDir, 'vault');
  let durable;
  let adapter;
  try {
    await mkdir(vault);
    await writeFile(path.join(vault, 'fixture.md'), '# Fictional\n\nsearchable alpha\n');
    durable = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    durable.createTopic({ topicId: 'topic-note-snapshot', paraCategory: 'project', lifecycle: 'active' });
    durable.createSourceReference({ version: 1, referenceId: 'folder:note-snapshot', topicId: 'topic-note-snapshot', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault, observedRevision: null });
    adapter = new NoteAdapter({ topicId: 'topic-note-snapshot', metadata: durable, root: vault, fsSafeRootFactory });
    const before = durable.listSourceReferences('topic-note-snapshot');
    const snapshot = await readNoteSourceSnapshot({ topicId: 'topic-note-snapshot', metadata: durable, noteAdapter: adapter });
    assert.equal(snapshot.notes[0].path, 'fixture.md');
    const after = durable.listSourceReferences('topic-note-snapshot');
    assert.equal(after.length, before.length + 1);
    assert.equal(after.find((reference) => reference.sourceKind === 'note')?.referenceId, snapshot.notes[0].sourceReference.referenceId);
    assert.equal(after.find((reference) => reference.sourceKind === 'note')?.observedRevision, snapshot.notes[0].revision);
  } finally {
    adapter?.close();
    durable?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Conversation snapshot uses exact public transcript identities and preserves Closed imported history', async () => {
  const calls = [];
  const importedMessage = canonicalImportedUserMessage('fictional-channel-imported', {
    messageId: 'fictional-imported-message', displayOrder: 0,
    author: { id: 'fictional-user', displayName: 'Fictional User' }, timestamp: '2026-08-23T00:01:00.000Z', text: 'imported message',
    edits: [], replyToMessageId: null, thread: null, reactions: [], attachments: []
  });
  const snapshot = await readConversationSourceSnapshot({
    topicId: topic.topicId,
    metadata: metadata(),
    gateway: visibleGateway([
      entry('native', 'native message', '2026-08-23T00:00:00.000Z'),
      entry('imported', 'imported message', '2026-08-23T00:01:00.000Z', importedMessage)
    ], (input) => calls.push(input))
  });
  assert.equal(calls.filter((call) => call.method === 'chat.history').length, 2, 'a stable verification read is required');
  assert.equal(snapshot.conversations.length, 2);
  assert.ok(snapshot.conversations.every((row) => row.closed));
  assert.equal(snapshot.conversations.find((row) => row.provenance === 'imported').importedFrom, 'legacy-discord-v1');
  assert.equal(snapshot.conversations[0].contextAfter, 'imported message');
});

test('Conversation snapshot rejects missing, resetting, malformed, and changing transcript pages', async () => {
  for (const result of [
    { session: null },
    { session: { ['k' + 'ey']: 'foreign', sessionId: 'foreign' } }
  ]) {
    await assert.rejects(() => readConversationSourceSnapshot({ topicId: topic.topicId, metadata: metadata(), gateway: { request: async () => result } }), /identity/i);
  }
  let reads = 0;
  await assert.rejects(() => readConversationSourceSnapshot({
    topicId: topic.topicId, metadata: metadata(), gateway: { request: async (method, input) => {
      reads += 1;
      if (method === 'sessions.describe') return { session: { ['k' + 'ey']: input['k' + 'ey'], sessionId: 'session-one' } };
      return { sessionKey: input.sessionKey, sessionId: 'session-one', messages: [entry('stable', reads < 3 ? 'before' : 'after', '2026-08-23T00:00:00.000Z')], hasMore: false };
    } }
  }), /changed during snapshotting/i);
});

test('Conversation snapshot rejects messages without an authoritative date', async () => {
  await assert.rejects(() => readConversationSourceSnapshot({
    topicId: topic.topicId, metadata: metadata(), gateway: visibleGateway([{ id: 'undated', role: 'user', content: 'undated' }])
  }), /authoritative date/i);
});

test('Conversation enumeration retains ordinary, Primary, Closed, and former-Primary exact links', async () => {
  const states = [
    ['ordinary', { status: 'open', isPrimary: false }],
    ['primary', { status: 'open', isPrimary: true }],
    ['closed', { status: 'closed', isPrimary: false }],
    ['former', { status: 'open', isPrimary: false, wasPrimary: true }]
  ];
  const references = states.map(([name]) => ({ ...sessionReference, referenceId: `session:${name}`, externalSourceId: `agent:main:${name}` }));
  const fixtureMetadata = {
    getTopic: () => topic,
    listSourceReferences: () => references,
    getSessionState: (id) => {
      const index = references.findIndex((reference) => reference.referenceId === id);
      return { referenceId: id, sessionId: `session-id-${states[index][0]}`, ...states[index][1] };
    }
  };
  const requested = [];
  const snapshot = await readConversationSourceSnapshot({ topicId: topic.topicId, metadata: fixtureMetadata, gateway: { request: async (method, input) => {
    requested.push([method, input.sessionKey ?? input['k' + 'ey']]);
    const sessionIdentity = input.sessionKey ?? input['k' + 'ey'];
    const sessionId = `session-id-${sessionIdentity.split(':').at(-1)}`;
    if (method === 'sessions.describe') return { session: { ['k' + 'ey']: sessionIdentity, sessionId } };
    return { sessionKey: sessionIdentity, sessionId, messages: [entry(`message:${sessionIdentity}`, `searchable ${sessionIdentity}`, '2026-08-23T00:00:00.000Z')], hasMore: false };
  } } });
  assert.equal(requested.filter(([method]) => method === 'chat.history').length, references.length * 2);
  assert.deepEqual(snapshot.conversations.map((row) => [row.sourceReference.referenceId, row.closed, row.primaryState]).sort(), [
    ['session:closed', true, 'ordinary'], ['session:former', false, 'former-primary'], ['session:ordinary', false, 'ordinary'], ['session:primary', false, 'primary']
  ]);
});

test('Conversation snapshot reads durable names and former-Primary provenance after metadata reopen', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-session-state-'));
  let durable;
  try {
    durable = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    durable.createTopic({ topicId: 'topic-durable-search', paraCategory: 'project', lifecycle: 'active' });
    const references = ['first', 'replacement'].map((name) => ({ version: 1, referenceId: `session:${name}`, topicId: 'topic-durable-search', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: `agent:main:command-center:${name}`, observedRevision: null }));
    durable.createSessionBinding({ reference: references[0], state: { referenceId: references[0].referenceId, sessionId: 'session-first', status: 'open', isPrimary: true, displayName: 'Fictional First Primary' } });
    durable.createSessionBinding({ reference: references[1], state: { referenceId: references[1].referenceId, sessionId: 'session-replacement', status: 'open', isPrimary: true, displayName: 'Fictional Replacement Primary' } });
    durable.close();
    durable = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    const snapshot = await readConversationSourceSnapshot({ topicId: 'topic-durable-search', metadata: durable, gateway: { request: async (method, input) => {
      const sessionIdentity = input.sessionKey ?? input['k' + 'ey'];
      const sessionId = sessionIdentity.endsWith('first') ? 'session-first' : 'session-replacement';
      if (method === 'sessions.describe') return { session: { ['k' + 'ey']: sessionIdentity, sessionId, derivedTitle: `Host ${sessionIdentity}` } };
      return { sessionKey: sessionIdentity, sessionId, messages: [entry(`message:${sessionIdentity}`, `searchable ${sessionIdentity}`, '2026-08-23T00:00:00.000Z')], hasMore: false };
    } } });
    assert.deepEqual(snapshot.conversations.map(({ name, primaryState }) => [name, primaryState]).sort(), [
      ['Host agent:main:command-center:first', 'former-primary'], ['Host agent:main:command-center:replacement', 'primary']
    ]);
  } finally {
    durable?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Conversation snapshot never enumerates or reads an unlinked Session', async () => {
  const requested = [];
  const snapshot = await readConversationSourceSnapshot({ topicId: topic.topicId, metadata: metadata(), gateway: visibleGateway([
    entry('exact-linked', 'searchable linked history', '2026-08-23T00:00:00.000Z')
  ], (input) => requested.push(input)) });
  assert.deepEqual(requested.filter((call) => call.method === 'chat.history').map((call) => call.sessionKey), [sessionReference.externalSourceId, sessionReference.externalSourceId]);
  assert.deepEqual(snapshot.conversations.map((row) => row.messageId), ['exact-linked']);
});
