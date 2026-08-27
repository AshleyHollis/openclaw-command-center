import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sanitizeBridgeResult } from '../src/bridge/contracts.mjs';
import { createTopicSearchService } from '../src/search/service.mjs';
import { createSearchRebuildService } from '../src/search/rebuild.mjs';
import { createSearchAdapter } from '../src/sources/search.mjs';

const topic = { topicId: 'topic-fictional', paraCategory: 'project', lifecycle: 'active' };
const folder = { version: 1, referenceId: 'folder:fictional', topicId: topic.topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/topic', observedRevision: null };
const note = { version: 1, referenceId: 'note:fictional', topicId: topic.topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic/readme.md', observedRevision: 'sha256:note' };
const session = { version: 1, referenceId: 'session:fictional', topicId: topic.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:command-center:fictional', observedRevision: null };
const linkedSessions = [
  session,
  { ...session, referenceId: 'session:primary', externalSourceId: 'agent:main:command-center:primary' },
  { ...session, referenceId: 'session:ordinary', externalSourceId: 'agent:main:command-center:ordinary' },
  { ...session, referenceId: 'session:former', externalSourceId: 'agent:main:command-center:former' }
];

test('an empty authoritative workspace publishes both empty projection generations', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-topic-search-empty-'));
  try {
    const rebuild = createSearchRebuildService({ stateDir, metadata: { listTopics: () => [] } });
    const result = await rebuild.rebuild();
    assert.equal(result.notes.rowCount, 0);
    assert.equal(result.conversations.rowCount, 0);
    assert.deepEqual((await readdir(path.join(stateDir, 'plugins', 'command-center', 'projections'))).sort(), [
      'topic-search-conversations.commit.json', 'topic-search-conversations.json', 'topic-search-conversations.sqlite',
      'topic-search-notes.commit.json', 'topic-search-notes.json', 'topic-search-notes.sqlite'
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('temporary authoritative fixtures rebuild equivalent grouped Topic Search results', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-topic-search-acceptance-'));
  const authoritative = JSON.stringify({ markdown: '# Readme\n\nalpha phrase', session: 'closed conversation alpha phrase', metadata: 'Topic metadata' });
  try {
    const metadata = {
      listTopics: () => [topic],
      getTopic: (id) => id === topic.topicId ? topic : null,
      listSourceReferences: (id) => id === topic.topicId ? [folder, note, ...linkedSessions] : [],
      getSourceReference: (id) => [folder, note, ...linkedSessions].find((reference) => reference.referenceId === id) ?? null,
      getSessionState: (id) => {
        const reference = linkedSessions.find((item) => item.referenceId === id);
        if (!reference) return null;
        return { referenceId: id, sessionId: `session-id-${id.split(':')[1]}`, status: id === session.referenceId ? 'closed' : 'open', isPrimary: id === 'session:primary', wasPrimary: id === 'session:former' };
      },
      getPresentationPreferences: () => ({ displayLabel: 'Fictional Topic' })
    };
    const noteAdapter = {
      browse: async () => [{ path: 'readme.md', sourceReference: note }],
      read: async () => ({ path: 'readme.md', text: '# Readme\n\nbefore\n\nalpha phrase\n\nafter', revision: note.observedRevision, sourceReference: note })
    };
    const gateway = { request: async (method, input) => {
      const sessionKey = input.sessionKey ?? input.key;
      const reference = linkedSessions.find((item) => item.externalSourceId === sessionKey);
      assert.ok(reference, 'only exact linked Session keys may be read');
      const sessionId = `session-id-${reference.referenceId.split(':')[1]}`;
      if (method === 'sessions.describe') return { session: { ['k' + 'ey']: sessionKey, sessionId, derivedTitle: `Fixture ${sessionKey}` } };
      assert.equal(method, 'chat.history');
      const imported = reference.referenceId === 'session:primary';
      return { sessionKey, sessionId, messages: input.offset === 0 ? [{ id: `message-${reference.referenceId}`, role: 'user', createdAt: '2026-08-23T00:00:00.000Z', content: `${reference.referenceId} alpha phrase`, ...(imported ? { __openclaw: { importedFrom: 'agent:main:legacy-primary' } } : {}) }] : [], hasMore: false };
    } };
    const rebuild = createSearchRebuildService({ stateDir, metadata, noteAdapterFactory: () => noteAdapter, gateway });
    const search = createTopicSearchService({ stateDir, metadata });
    const logicalOperationId = '11111111-2222-4333-8444-555555555555';
    const committed = await rebuild.rebuildPrepared({ topicId: topic.topicId, logicalOperationId });
    assert.notEqual(committed.notes.sourceRevision, committed.conversations.sourceRevision);
    assert.deepEqual(await rebuild.rebuildPrepared({ topicId: topic.topicId, logicalOperationId }), committed);
    await assert.rejects(() => rebuild.rebuildPrepared({ topicId: 'topic-other', logicalOperationId }), /another Topic/i);
    const before = await search.query({ schemaVersion: 1, topicId: topic.topicId, query: '"alpha phrase"', limit: 50 });
    assert.equal(before.notes.results.length, 1);
    assert.equal(before.conversations.results.length, 4);
    assert.ok(before.conversations.results.some((result) => result.provenance.status === 'closed'));
    assert.ok(before.conversations.results.some((result) => result.provenance.role === 'primary' && result.provenance.importedPrimaryHistory));
    assert.ok(before.conversations.results.some((result) => result.sourceReference.referenceId === 'session:former'));
    assert.equal(before.notes.results[0].kind, 'note');
    assert.equal(before.conversations.results[0].kind, 'conversation');
    assert.equal(before.notes.results[0].heading, 'Readme');
    assert.equal(before.notes.results[0].sourceReference.sourceKind, 'note_folder');
    const bridged = sanitizeBridgeResult('command-center.v1.search.query', await createSearchAdapter({ provider: search }).query({
      schemaVersion: 1,
      topicId: topic.topicId,
      query: '"alpha phrase"',
      limit: 50
    }));
    assert.equal(bridged.notes.results[0].sourceReference.referenceId, folder.referenceId);
    assert.deepEqual(bridged.notes.results[0].navigation, before.notes.results[0].navigation);
    const authorityDigest = createHash('sha256').update(authoritative).digest('hex');
    await rebuild.delete();
    await rebuild.rebuild();
    const after = await search.query({ schemaVersion: 1, topicId: topic.topicId, query: '"alpha phrase"', limit: 50 });
    assert.deepEqual(after, before);
    assert.equal(createHash('sha256').update(authoritative).digest('hex'), authorityDigest);
    assert.doesNotMatch(await readFile(path.join(stateDir, 'plugins', 'command-center', 'projections', 'topic-search-notes.json'), 'utf8'), /authoritative/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a Topic-scoped refresh preserves every unrelated committed Topic', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-topic-search-refresh-'));
  const secondTopic = { topicId: 'topic-fictional-two', paraCategory: 'area', lifecycle: 'active' };
  const metadata = {
    listTopics: () => [topic, secondTopic],
    getTopic: (id) => [topic, secondTopic].find((item) => item.topicId === id) ?? null,
    listSourceReferences: (topicId) => ['folder', 'note'].map((kind) => ({
      version: 1, referenceId: `${kind}:${topicId}`, topicId, sourceSystem: 'obsidian', sourceKind: kind === 'note' ? 'note' : 'note_folder', externalSourceId: `/fictional/${topicId}${kind === 'note' ? '/readme.md' : ''}`, observedRevision: kind === 'note' ? 'sha256:fixture' : null
    })),
    getSourceReference: (referenceId) => {
      const [kind, topicId] = referenceId.split(':');
      if (!['note', 'folder'].includes(kind) || ![topic.topicId, secondTopic.topicId].includes(topicId)) return null;
      return { version: 1, referenceId, topicId, sourceSystem: 'obsidian', sourceKind: kind === 'note' ? 'note' : 'note_folder', externalSourceId: `/fictional/${topicId}${kind === 'note' ? '/readme.md' : ''}`, observedRevision: kind === 'note' ? 'sha256:fixture' : null };
    }
  };
  const authoritativeSources = {
    readTopicSnapshot: async ({ topicId }) => ({
      notes: [{
        topicId,
        sourceReference: { version: 1, referenceId: `folder:${topicId}`, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: `/fictional/${topicId}`, observedRevision: null },
        folderReferenceId: `folder:${topicId}`,
        path: 'readme.md', heading: 'Fixture', revision: 'sha256:fixture', text: `content for ${topicId}`, provenance: 'native'
      }],
      conversations: []
    })
  };
  try {
    const rebuild = createSearchRebuildService({ stateDir, metadata, authoritativeSources });
    await rebuild.rebuild();
    await rebuild.rebuild({ topicId: topic.topicId });
    const search = createTopicSearchService({ stateDir, metadata });
    assert.equal((await search.query({ schemaVersion: 1, topicId: topic.topicId, query: 'content' })).notes.results.length, 1);
    assert.equal((await search.query({ schemaVersion: 1, topicId: secondTopic.topicId, query: 'content' })).notes.results.length, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a fresh Topic-scoped generation reports every unbuilt Topic unavailable', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-topic-search-coverage-'));
  const secondTopic = { topicId: 'topic-fictional-two', paraCategory: 'area', lifecycle: 'active' };
  const metadata = {
    listTopics: () => [topic, secondTopic],
    getTopic: (id) => [topic, secondTopic].find((item) => item.topicId === id) ?? null,
    listSourceReferences: () => []
  };
  const authoritativeSources = { readTopicSnapshot: async () => ({ notes: [], conversations: [], sourceRevision: 'fictional-coverage' }) };
  try {
    const rebuild = createSearchRebuildService({ stateDir, metadata, authoritativeSources });
    await rebuild.rebuild({ topicId: topic.topicId });
    const search = createTopicSearchService({ stateDir, metadata });
    assert.deepEqual((await search.query({ schemaVersion: 1, topicId: topic.topicId, query: 'absent' })).notes.results, []);
    await assert.rejects(
      search.query({ schemaVersion: 1, topicId: secondTopic.topicId, query: 'absent' }),
      (error) => error.code === 'capability-unavailable'
    );
    await rebuild.rebuild({ topicId: secondTopic.topicId });
    assert.deepEqual((await search.query({ schemaVersion: 1, topicId: secondTopic.topicId, query: 'absent' })).notes.results, []);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('groups and opens authoritative Topic Search results', async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
  }
  const elements = Object.fromEntries(['topic-search-form', 'topic-search-topic-id', 'topic-search-query', 'topic-search-status', 'topic-search-detail', 'notes-results', 'conversations-results'].map((id) => [id, new Element()]));
  const sent = [];
  let receive;
  const fakeWindow = {
    location: { search: '' },
    addEventListener(type, listener) { if (type === 'message') receive = listener; },
    postMessage(message) { sent.push(message.payload); }
  };
  const prior = { window: globalThis.window, document: globalThis.document };
  globalThis.window = fakeWindow;
  globalThis.document = {
    body: { dataset: {} },
    querySelector(selector) { return elements[selector.slice(1)] ?? null; },
    createElement() { return new Element(); },
    createTextNode(text) { return { textContent: text }; }
  };
  try {
    await import(`../src/ui/app.js?acceptance=${Date.now()}`);
    receive({ source: fakeWindow, data: { type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.search.query', 'command-center.v1.notes.read', 'command-center.v1.sessions.navigate', 'ui.session.navigate'] } } });
    elements['topic-search-topic-id'].value = topic.topicId;
    const noteResult = { kind: 'note', heading: 'Readme', path: 'readme.md', snippet: 'alpha', highlights: [], contextBefore: '', contextAfter: '', navigation: { kind: 'note', topicId: topic.topicId, referenceId: folder.referenceId, path: 'readme.md', heading: 'Readme', observedRevision: note.observedRevision } };
    const conversationResult = { kind: 'conversation', conversationName: 'Closed fixture', date: '2026-08-23T00:00:00.000Z', snippet: 'alpha', highlights: [], contextBefore: '', contextAfter: '', provenance: { role: 'topic-conversation', status: 'closed', importedPrimaryHistory: false }, navigation: { kind: 'conversation', topicId: topic.topicId, referenceId: session.referenceId, sessionKey: session.externalSourceId, sessionId: 'session-fictional', messageId: 'message-fictional' } };
    const grouped = { notes: { results: [noteResult] }, conversations: { results: [conversationResult] } };
    const searchPromise = fakeWindow.CommandCenterSearch.search('alpha');
    await new Promise((resolve) => setImmediate(resolve));
    const searchRequest = sent.find((item) => item.method === 'command-center.v1.search.query');
    assert.deepEqual(searchRequest.params, { schemaVersion: 1, topicId: topic.topicId, query: 'alpha', limit: 50 });
    receive({ source: fakeWindow, data: { type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: searchRequest.requestId, result: { result: grouped } } } });
    await searchPromise;
    assert.equal(elements['notes-results'].children.length, 1);
    assert.equal(elements['conversations-results'].children.length, 1);
    const noteOpen = fakeWindow.CommandCenterSearch.openResult(noteResult);
    await new Promise((resolve) => setImmediate(resolve));
    const noteRequest = sent.find((item) => item.method === 'command-center.v1.notes.read');
    assert.deepEqual(noteRequest.params, { schemaVersion: 1, topicId: topic.topicId, referenceId: folder.referenceId, path: 'readme.md', observedRevision: note.observedRevision });
    receive({ source: fakeWindow, data: { type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: noteRequest.requestId, result: { result: { path: 'readme.md', revision: note.observedRevision, text: '# Readme' } } } } });
    await noteOpen;
    assert.equal(elements['topic-search-detail'].textContent, '# Readme');
    const conversationOpen = fakeWindow.CommandCenterSearch.openResult(conversationResult);
    await new Promise((resolve) => setImmediate(resolve));
    const resolveRequest = sent.find((item) => item.method === 'command-center.v1.sessions.navigate');
    assert.deepEqual(resolveRequest.params, { schemaVersion: 1, topicId: topic.topicId, referenceId: session.referenceId });
    receive({ source: fakeWindow, data: { type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: resolveRequest.requestId, result: { result: { sessionKey: session.externalSourceId, sessionId: 'session-fictional', sourceReference: session } } } } });
    await new Promise((resolve) => setImmediate(resolve));
    const navigateRequest = sent.find((item) => item.method === 'ui.session.navigate');
    assert.deepEqual(navigateRequest.params, { sessionKey: session.externalSourceId });
    receive({ source: fakeWindow, data: { type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: navigateRequest.requestId, result: {} } } });
    await conversationOpen;
  } finally {
    globalThis.window = prior.window;
    globalThis.document = prior.document;
  }
});
