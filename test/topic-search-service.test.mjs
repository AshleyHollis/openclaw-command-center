import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTopicSearchService } from '../src/search/service.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';

const noteReference = { version: 1, referenceId: 'note:one', topicId: 'topic-one', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic-one/one.md', observedRevision: null, createdAt: null, updatedAt: null };
const sessionReference = { version: 1, referenceId: 'session:one', topicId: 'topic-one', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:one', observedRevision: null, createdAt: null, updatedAt: null };
const folderReference = { version: 1, referenceId: 'folder:one', topicId: 'topic-one', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/topic-one', observedRevision: null, createdAt: null, updatedAt: null };
const references = { 'folder:one': folderReference, 'note:one': noteReference, 'session:one': sessionReference };
const metadata = {
  getTopic: (id) => id === 'topic-one' ? { topicId: id, paraCategory: 'project' } : null,
  getPresentationPreferences: () => ({ displayLabel: 'Topic One' }),
  getSourceReference: (id) => references[id] ?? null,
  listSourceReferences: () => Object.values(references),
  getSessionState: () => ({ sessionId: 'session-one', status: 'closed', isPrimary: false, wasPrimary: false })
};
const noteStore = { query: () => [{ schemaVersion: 1, kind: 'note', topicId: 'topic-one', referenceId: 'folder:one', folderReferenceId: 'folder:one', sourceReference: folderReference, score: -1, sourceRevision: null, path: 'one.md', heading: null, revision: null, text: 'fresh note', snippet: 'note', context: { before: '', after: '' }, contextBefore: '', contextAfter: '', provenance: 'native', navigation: { kind: 'note', topicId: 'topic-one', path: 'one.md', sourceReference: folderReference } }], resolveNoteTarget: (descriptor) => descriptor.path === 'one.md' && descriptor.heading === null && descriptor.observedRevision === null ? { heading: null, revision: null, text: 'fresh note' } : null };
const conversationStore = { query: () => [{ schemaVersion: 1, kind: 'conversation', topicId: 'topic-one', referenceId: 'session:one', sourceReference: sessionReference, score: -2, sourceRevision: null, sessionKey: sessionReference.externalSourceId, sessionId: 'session-one', messageId: 'message-one', name: 'agent:main:one', date: '2026-08-23T00:00:00.000Z', role: 'user', historyProvenance: 'linked-session', status: 'closed', closed: true, primaryState: 'ordinary', importedFrom: null, snippet: 'conversation', context: { before: '', after: '' }, contextBefore: '', contextAfter: '', provenance: 'native', navigation: { kind: 'conversation', topicId: 'topic-one', sessionKey: sessionReference.externalSourceId, sessionId: 'session-one', sourceReference: sessionReference, messageId: 'message-one' } }] };

test('search service returns separate independently ranked groups and exact navigation', async () => {
  const calls = [];
  const service = createTopicSearchService({ metadata, noteStore, conversationStore, sourceService: {
    notesRead: async (input) => { calls.push(['note', input]); return { path: 'one.md', text: 'fresh note', revision: noteReference.observedRevision, sourceReference: noteReference }; },
    sessionsNavigate: async (input) => { calls.push(['navigate', input]); return { sessionKey: sessionReference.externalSourceId, sessionId: 'session-one', controlUiPath: '/chat/main/one', sourceReference: sessionReference }; }
  } });
  const result = await service.query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha', limit: 1 });
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'topicId', 'query', 'notes', 'conversations']);
  assert.equal(result.notes.results.length, 1);
  assert.equal(result.conversations.results.length, 1);
  assert.deepEqual(result.notes.results[0].kind, 'note');
  assert.equal('externalSourceId' in result.notes.results[0].sourceReference, false);
  assert.doesNotMatch(JSON.stringify(result.notes.results[0]), /\/fictional\/topic-one/u);
  assert.deepEqual(result.conversations.results[0].provenance, { role: 'topic-conversation', status: 'closed', importedPrimaryHistory: false });
  assert.equal(result.conversations.results[0].sessionKey, sessionReference.externalSourceId);
  await service.navigate(result.notes.results[0].navigation);
  await service.navigate(result.conversations.results[0].navigation);
  assert.deepEqual(calls.map(([kind]) => kind), ['note', 'navigate']);
  await assert.rejects(() => service.navigate({ ...result.notes.results[0].navigation, path: 'replacement.md' }), /committed projection/i);
  await assert.rejects(() => service.navigate({ ...result.notes.results[0].navigation, heading: 'Replacement' }), /committed projection/i);
  await assert.rejects(() => service.navigate({ ...result.notes.results[0].navigation, extra: true }), /unsupported/i);
});

test('search withholds stale and foreign projected identities', async () => {
  const staleMetadata = { ...metadata, getSourceReference: (id) => id === 'session:one' ? { ...sessionReference, externalSourceId: 'agent:main:changed' } : references[id] ?? null };
  const result = await createTopicSearchService({ metadata: staleMetadata, noteStore, conversationStore }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' });
  assert.equal(result.notes.results.length, 1);
  assert.equal(result.conversations.results.length, 0);
});

test('search and navigation reject a projected Note after its Source Reference is missing', async () => {
  const missingFolderMetadata = { ...metadata, getSourceReference: (id) => id === folderReference.referenceId ? null : references[id] ?? null, listSourceReferences: () => [sessionReference] };
  const service = createTopicSearchService({ metadata: missingFolderMetadata, noteStore, conversationStore: { query: () => [] }, sourceService: { notesRead: async () => ({ text: 'must not open' }) } });
  const result = await service.query({ schemaVersion: 1, topicId: 'topic-one', query: 'new' });
  assert.equal(result.notes.results.length, 0);
  await assert.rejects(
    service.navigate({ kind: 'note', topicId: 'topic-one', referenceId: folderReference.referenceId, path: 'new.md', observedRevision: 'sha256:new' }),
    (error) => error.code === 'source-recovery'
  );
});

test('unobserved folder-owned Markdown is searchable through the exact Folder Source Reference', async () => {
  const externalSourceId = '/fictional/topic-one/new.md';
  const referenceId = `note:topic-one:${createHash('sha256').update(externalSourceId).digest('hex').slice(0, 24)}`;
  const sourceReference = { ...noteReference, referenceId, externalSourceId, observedRevision: 'sha256:new' };
  const projected = { ...noteStore.query()[0], path: 'new.md', revision: 'sha256:new' };
  const calls = [];
  const service = createTopicSearchService({
    metadata,
    noteStore: { ...noteStore, query: () => [projected], resolveNoteTarget: (descriptor) => descriptor.path === 'new.md' && descriptor.observedRevision === 'sha256:new' ? { heading: null, revision: 'sha256:new', text: 'new text' } : null },
    conversationStore: { query: () => [] },
    sourceService: { notesRead: async (input) => { calls.push(input); return { path: 'new.md', text: 'new text', revision: 'sha256:new', sourceReference }; } }
  });
  const result = await service.query({ schemaVersion: 1, topicId: 'topic-one', query: 'new' });
  assert.equal(result.notes.results.length, 1);
  await service.navigate(result.notes.results[0].navigation);
  assert.equal(calls[0].referenceId, folderReference.referenceId);
  assert.equal(calls[0].observedRevision, 'sha256:new');
});

test('search withholds rows after folder ambiguity, Note revision, or Session state changes', async () => {
  const ambiguous = { ...metadata, listSourceReferences: () => [...Object.values(references), { ...folderReference, referenceId: 'folder:other', externalSourceId: '/fictional/other' }] };
  assert.deepEqual((await createTopicSearchService({ metadata: ambiguous, noteStore, conversationStore }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' })).notes.results, []);
  const revised = { ...metadata, getSourceReference: (id) => id === 'folder:one' ? { ...folderReference, externalSourceId: '/fictional/changed' } : references[id] ?? null };
  assert.equal((await createTopicSearchService({ metadata: revised, noteStore, conversationStore }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' })).notes.results.length, 0);
  const reopened = { ...metadata, getSessionState: () => ({ status: 'open', isPrimary: false, wasPrimary: false }) };
  assert.equal((await createTopicSearchService({ metadata: reopened, noteStore, conversationStore }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' })).conversations.results.length, 0);
  const rebound = { ...metadata, getSessionState: () => ({ sessionId: 'replacement-session', status: 'closed', isPrimary: false, wasPrimary: false }) };
  assert.equal((await createTopicSearchService({ metadata: rebound, noteStore, conversationStore }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' })).conversations.results.length, 0);
});

test('invalidating before a failed authoritative refresh makes stale projections unavailable', async () => {
  let available = true;
  const stale = Object.freeze({
    query() {
      if (!available) {
        const error = new Error('projection unavailable');
        error.code = 'projection-unavailable';
        throw error;
      }
      return [];
    },
    delete() { available = false; return true; }
  });
  const topicId = '10000000-0000-4000-8000-000000000001';
  const service = createTopicSearchService({
    metadata: { getTopic: () => ({ topicId }), listSourceReferences: () => [] },
    noteStore: stale,
    conversationStore: stale,
    rebuild: async () => { throw new Error('authoritative source unavailable'); }
  });

  await service.invalidate();
  await assert.rejects(service.rebuild({ topicId }), /authoritative source unavailable/u);
  await assert.rejects(
    service.query({ schemaVersion: 1, topicId, query: 'stale' }),
    (error) => error.code === 'capability-unavailable'
  );
});

test('a corrupt disposable projection cannot fail invalidation or expose stale results', async () => {
  const checkpoints = new Map();
  const projectionMetadata = {
    ...metadata,
    setProjectionBookkeepingBatch(rows) {
      for (const row of rows) checkpoints.set(row.projectionId, row);
    },
    getProjectionBookkeeping(projectionId) { return checkpoints.get(projectionId) ?? null; }
  };
  const corruptStore = {
    delete() { throw Object.assign(new Error('tampered projection'), { code: 'projection-unavailable' }); },
    query: noteStore.query,
    manifest() { return { projectionId: 'topic-search-notes', sourceRevision: 'old', inputDigest: 'old' }; }
  };
  const corruptConversationStore = {
    ...corruptStore,
    query: conversationStore.query,
    manifest() { return { projectionId: 'topic-search-conversations', sourceRevision: 'old', inputDigest: 'old' }; }
  };
  const service = createTopicSearchService({ metadata: projectionMetadata, noteStore: corruptStore, conversationStore: corruptConversationStore });

  assert.deepEqual(await service.invalidate(), { notes: false, conversations: false });
  assert.deepEqual([...checkpoints.values()].map(({ sourceRevision, inputDigest }) => [sourceRevision, inputDigest]), [
    ['invalidated', 'invalidated'],
    ['invalidated', 'invalidated']
  ]);
  await assert.rejects(
    service.query({ schemaVersion: 1, topicId: 'topic-one', query: 'stale' }),
    (error) => error.code === 'capability-unavailable'
  );
});

test('a missing projection remains a side-effect-free unavailable read', async () => {
  let rebuilds = 0;
  const store = { query: () => {
    throw Object.assign(new Error('missing'), { code: 'projection-unavailable' });
  }, exists: () => false };
  const service = createTopicSearchService({
    metadata,
    noteStore: store,
    conversationStore: store,
    rebuild: async () => { rebuilds += 1; }
  });
  await assert.rejects(service.query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' }), (error) => error.code === 'capability-unavailable');
  assert.equal(rebuilds, 0);
});

test('authoritative mutation refresh invalidates stale projections before a rebuild can fail', async () => {
  const calls = [];
  const sourceService = new AuthoritativeSourceService({
    metadata: {},
    searchProvider: {
      async invalidate(input) { calls.push(['invalidate', input]); },
      async rebuild(input) { calls.push(['rebuild', input]); throw new Error('fixture rebuild failure'); }
    }
  });
  await sourceService.refreshSearch('topic-one');
  assert.deepEqual(calls, [['invalidate', {}], ['rebuild', {}]]);
});

test('disposable projection maintenance failures cannot fail an authoritative mutation refresh', async () => {
  const calls = [];
  const sourceService = new AuthoritativeSourceService({
    metadata: {},
    searchProvider: {
      async invalidate(input) { calls.push(['invalidate', input]); throw new Error('corrupt disposable index'); },
      async rebuild(input) { calls.push(['rebuild', input]); throw new Error('fixture rebuild failure'); }
    }
  });

  await sourceService.refreshSearch('topic-one');
  assert.deepEqual(calls, [['invalidate', {}], ['rebuild', {}]]);
});

test('authoritative mutation refresh republishes complete Topic coverage after global invalidation', async () => {
  let publishedTopics = new Set(['topic-one', 'topic-two']);
  const sourceService = new AuthoritativeSourceService({
    metadata: {},
    searchProvider: {
      async invalidate(input) {
        assert.deepEqual(input, {});
        publishedTopics.clear();
      },
      async rebuild(input) {
        assert.deepEqual(input, {});
        publishedTopics = new Set(['topic-one', 'topic-two']);
      }
    }
  });

  await sourceService.refreshSearch('topic-one');
  assert.deepEqual([...publishedTopics], ['topic-one', 'topic-two']);
});

test('overlapping authoritative refreshes cannot publish an older snapshot last', async () => {
  const calls = [];
  let releaseFirst;
  const firstRebuild = new Promise((resolve) => { releaseFirst = resolve; });
  let rebuilds = 0;
  const sourceService = new AuthoritativeSourceService({
    metadata: {},
    searchProvider: {
      async invalidate() { calls.push(`invalidate-${rebuilds + 1}`); },
      async rebuild() {
        rebuilds += 1;
        calls.push(`rebuild-${rebuilds}`);
        if (rebuilds === 1) await firstRebuild;
      }
    }
  });
  const older = sourceService.refreshSearch('topic-one');
  await new Promise((resolve) => setImmediate(resolve));
  const newer = sourceService.refreshSearch('topic-one');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['invalidate-1', 'rebuild-1']);
  releaseFirst();
  await Promise.all([older, newer]);
  assert.deepEqual(calls, ['invalidate-1', 'rebuild-1', 'invalidate-2', 'rebuild-2']);
});
