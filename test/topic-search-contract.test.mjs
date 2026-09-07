import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildFtsQuery, parseLexicalQuery, validateSearchRequest } from '../src/search/query.mjs';
import { openProjectionStore } from '../src/search/projection-store.mjs';
import { createSearchAdapter } from '../src/sources/search.mjs';
import { sanitizeBridgeResult } from '../src/bridge/contracts.mjs';

test('lexical contract supports exact mixed phrases and keywords only', () => {
  assert.deepEqual(parseLexicalQuery('alpha "beta gamma" delta'), [
    { kind: 'keyword', value: 'alpha' },
    { kind: 'phrase', value: 'beta gamma' },
    { kind: 'keyword', value: 'delta' }
  ]);
  assert.deepEqual(parseLexicalQuery('"beta gamma"'), [{ kind: 'phrase', value: 'beta gamma' }]);
  assert.throws(() => parseLexicalQuery('unbalanced "quote'), /unmatched quote/u);
  assert.equal(buildFtsQuery(parseLexicalQuery('"beta gamma"')), '"beta gamma"');
  assert.throws(() => parseLexicalQuery('!!!'), /token/i);
  assert.throws(() => validateSearchRequest({ schemaVersion: 1, topicId: 'topic', query: ' '.repeat(257) }), /256/);
  assert.throws(() => validateSearchRequest({ topicId: 'topic', query: 'alpha' }), /schemaVersion/u);
  assert.throws(() => validateSearchRequest({ schemaVersion: 1, topicId: 'topic', query: '""' }), /token/i);
  assert.deepEqual(parseLexicalQuery('cafe\u0301'), [{ kind: 'keyword', value: 'café' }]);
  assert.equal(validateSearchRequest({ schemaVersion: 1, topicId: 'topic', query: '𐐀'.repeat(128) }).query, '𐐀'.repeat(128));
  assert.throws(() => validateSearchRequest({ schemaVersion: 1, topicId: 'topic', query: '𐐀'.repeat(129) }), /256/u);
});

test('bridge query bounds count UTF-16 code units', async () => {
  const query = '𐐀'.repeat(128);
  const calls = [];
  const provider = { query: async (input) => { calls.push(input); return { schemaVersion: 1, topicId: input.topicId, query: input.query, notes: { results: [] }, conversations: { results: [] } }; } };
  const result = await createSearchAdapter({ provider }).query({ schemaVersion: 1, topicId: 'topic-one', query });
  assert.equal(result.query, query);
  await assert.rejects(
    createSearchAdapter({ provider }).query({ schemaVersion: 1, topicId: 'topic-one', query: `${query}𐐀` }),
    /256/u
  );
  await assert.rejects(createSearchAdapter({ provider }).query({ topicId: 'topic-one', query: 'alpha' }), /schemaVersion/u);
  await assert.rejects(createSearchAdapter({ provider }).query({ schemaVersion: 2, topicId: 'topic-one', query: 'alpha' }), /schemaVersion/u);
  await assert.rejects(createSearchAdapter({ provider }).query({ schemaVersion: 1, topicId: 'topic-one', query: '!!!' }), /token/u);
  assert.equal(calls.length, 1);
});

test('owned projection store publishes a versioned disposable SQLite FTS store', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-contract-'));
  try {
    const store = await openProjectionStore({ stateDir, kind: 'note' });
    await store.rebuild({ topicId: 'topic-one', rows: [{
      topicId: 'topic-one', sourceReference: { version: 1, referenceId: 'note:one', topicId: 'topic-one', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic-one/one.md', observedRevision: 'sha256:one', createdAt: null, updatedAt: null }, folderReferenceId: 'folder:one',
      path: 'one.md', heading: 'Heading', revision: 'sha256:one',
      text: 'before paragraph\n\nalpha beta gamma cafe\u0301\n\nafter paragraph', provenance: 'native'
    }] });
    const result = store.query({ topicId: 'topic-one', query: 'alpha' });
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'one.md');
    assert.equal(result[0].contextBefore, 'before paragraph');
    assert.equal(result[0].contextAfter, 'after paragraph');
    assert.equal(result[0].referenceId, 'note:one');
    assert.equal(result[0].folderReferenceId, 'folder:one');
    assert.deepEqual(result[0].snippetHighlights.map(({ start, end }) => result[0].snippet.slice(start, end)), ['alpha']);
    assert.equal(store.query({ topicId: 'topic-one', query: 'CAFÉ' }).length, 1);
    const noteReference = { version: 1, referenceId: 'note:one', topicId: 'topic-one', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic-one/one.md', observedRevision: 'sha256:one', createdAt: null, updatedAt: null };
    const exactNote = {
      kind: 'note', topicId: 'topic-one', sourceReference: noteReference, path: result[0].path, heading: result[0].heading, snippet: result[0].snippet, highlights: result[0].snippetHighlights,
      contextBefore: result[0].context.before, contextAfter: result[0].context.after,
      navigation: { kind: 'note', topicId: 'topic-one', referenceId: noteReference.referenceId, path: 'one.md', heading: 'Heading', observedRevision: 'sha256:one' }
    };
    const validResponse = { schemaVersion: 1, topicId: 'topic-one', query: 'alpha', notes: { results: [exactNote] }, conversations: { results: [] } };
    const adapted = await createSearchAdapter({ provider: { query: async () => validResponse } }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' });
    const bridged = sanitizeBridgeResult('command-center.v1.search.query', adapted);
    assert.deepEqual(bridged.notes.results[0].navigation, exactNote.navigation);
    const invalidNotes = [
      (row) => { delete row.navigation; },
      (row) => { row.heading = 42; },
      (row) => { row.snippet = 'x'.repeat(241); },
      (row) => { row.contextBefore = 'x'.repeat(601); },
      (row) => { row.sourceReference.sourceSystem = 'foreign'; },
      (row) => { row.navigation.extra = 'unsupported'; }
    ];
    for (const invalidate of invalidNotes) {
      const incomplete = structuredClone(validResponse);
      invalidate(incomplete.notes.results[0]);
      await assert.rejects(
        () => createSearchAdapter({ provider: { query: async () => incomplete } }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' }),
        (error) => error.code === 'unavailable'
      );
    }
    const sessionReference = { version: 1, referenceId: 'session:one', topicId: 'topic-one', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional', observedRevision: null, createdAt: null, updatedAt: null };
    const conversationResult = {
      kind: 'conversation', topicId: 'topic-one', sourceReference: sessionReference, sessionKey: sessionReference.externalSourceId, messageId: 'message-one', conversationName: 'Fictional Session', date: '2026-08-23T00:00:00.000Z', originatingTopicId: 'topic-one',
      snippet: 'alpha message', highlights: [{ start: 0, end: 5 }], contextBefore: '', contextAfter: '',
      provenance: { role: 'topic-conversation', status: 'open', importedPrimaryHistory: false },
      navigation: { kind: 'conversation', topicId: 'topic-one', referenceId: sessionReference.referenceId, sessionKey: sessionReference.externalSourceId, sessionId: 'session-one', messageId: 'message-one' }
    };
    const conversationResponse = { schemaVersion: 1, topicId: 'topic-one', query: 'alpha', notes: { results: [] }, conversations: { results: [conversationResult] } };
    await createSearchAdapter({ provider: { query: async () => conversationResponse } }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' });
    const emptyConversation = structuredClone(conversationResult);
    emptyConversation.messageId = null;
    emptyConversation.navigation.messageId = null;
    const emptyAdapted = await createSearchAdapter({ provider: { query: async () => ({ ...conversationResponse, conversations: { results: [emptyConversation] } }) } }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' });
    assert.equal(emptyAdapted.conversations.results[0].messageId, null);
    assert.equal(sanitizeBridgeResult('command-center.v1.search.query', emptyAdapted).conversations.results[0].navigation.messageId, null);
    const mismatchedSession = structuredClone(conversationResult);
    mismatchedSession.sourceReference.externalSourceId = 'agent:main:other';
    await assert.rejects(
      () => createSearchAdapter({ provider: { query: async () => ({ ...conversationResponse, conversations: { results: [mismatchedSession] } }) } }).query({ schemaVersion: 1, topicId: 'topic-one', query: 'alpha' }),
      (error) => error.code === 'unavailable'
    );
    await store.rebuild({ topicId: 'topic-one', rows: [{
      topicId: 'topic-one', sourceReference: { version: 1, referenceId: 'note:boundary', topicId: 'topic-one', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic-one/boundary.md' }, folderReferenceId: 'folder:one',
      path: 'boundary.md', heading: 'Boundary', revision: 'fictional-boundary', text: 'current section only', contextBefore: 'secret phrase', contextAfter: 'phrase across', provenance: 'native'
    }] });
    assert.equal(store.query({ topicId: 'topic-one', query: '"secret phrase"' }).length, 0);
    const manifest = JSON.parse(await readFile(store.manifestPath, 'utf8'));
    assert.equal(manifest.projectionId, 'topic-search-notes');
    assert.equal(manifest.schemaVersion, 1);
    assert.match(manifest.inputDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(manifest.databaseDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(manifest.databaseDigest, manifest.inputDigest);
    assert.equal((await stat(path.dirname(store.databasePath))).mode & 0o777, 0o700);
    assert.equal((await stat(store.databasePath)).mode & 0o777, 0o600);
    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
    database.close();
    const conversation = await openProjectionStore({ stateDir, kind: 'conversation' });
    await conversation.rebuild({ topicId: 'topic-one', rows: [] });
    assert.equal(conversation.manifest().projectionId, 'topic-search-conversations');
    assert.notEqual(conversation.databasePath, store.databasePath);
    assert.equal(store.delete(), true);
    assert.equal(await conversation.exists(), true);
    assert.equal(await store.exists(), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('tampered or missing independent projection manifests gate queries', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-manifest-'));
  try {
    const store = await openProjectionStore({ stateDir, kind: 'note' });
    await store.rebuild({ rows: [{
      topicId: 'topic-one', sourceReference: { referenceId: 'note:one', topicId: 'topic-one' }, folderReferenceId: 'folder:one',
      path: 'one.md', heading: 'One', text: 'alpha projection', provenance: 'native'
    }] });
    const manifest = JSON.parse(await readFile(store.manifestPath, 'utf8'));
    await writeFile(store.manifestPath, `${JSON.stringify({ ...manifest, databaseDigest: `sha256:${'0'.repeat(64)}` })}\n`);
    assert.equal(store.exists(), false);
    assert.throws(() => store.query({ topicId: 'topic-one', query: 'alpha' }), (error) => error.code === 'projection-unavailable');
    await writeFile(store.manifestPath, `${JSON.stringify(manifest)}\n`);
    await unlink(store.manifestPath);
    assert.equal(store.exists(), false);
    assert.throws(() => store.query({ topicId: 'topic-one', query: 'alpha' }), (error) => error.code === 'projection-unavailable');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('snippet truncation never splits a non-BMP Unicode character', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-unicode-'));
  try {
    const store = await openProjectionStore({ stateDir, kind: 'note' });
    await store.rebuild({ rows: [{
      topicId: 'topic-one', sourceReference: { referenceId: 'note:unicode', topicId: 'topic-one' }, folderReferenceId: 'folder:one',
      path: 'unicode.md', heading: 'Unicode', text: `alpha ${'x'.repeat(400)}😀 tail`, provenance: 'native'
    }] });
    const [result] = store.query({ topicId: 'topic-one', query: 'alpha' });
    assert.doesNotMatch(result.snippet, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    assert.ok(Array.from(result.snippet).length <= 240);
    assert.match(result.snippet, /…$/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('equivalent projection inputs have order-independent digests and results', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-order-'));
  const rows = ['two', 'one'].map((id) => ({
    topicId: 'topic-one', sourceReference: { referenceId: `note:${id}`, topicId: 'topic-one' }, folderReferenceId: 'folder:one',
    path: `${id}.md`, heading: id, revision: `sha256:${id}`, text: 'shared lexical fixture', provenance: 'native'
  }));
  try {
    const store = await openProjectionStore({ stateDir, kind: 'note' });
    const first = await store.rebuild({ rows });
    const firstResults = store.query({ topicId: 'topic-one', query: 'shared' });
    const rowIds = () => {
      const database = new DatabaseSync(store.databasePath, { readOnly: true });
      try { return database.prepare('SELECT row_id FROM note_documents ORDER BY row_id').all().map(({ row_id: rowId }) => rowId); }
      finally { database.close(); }
    };
    const firstRowIds = rowIds();
    const second = await store.rebuild({ rows: [...rows].reverse() });
    assert.equal(second.inputDigest, first.inputDigest);
    assert.deepEqual(store.query({ topicId: 'topic-one', query: 'shared' }), firstResults);
    assert.deepEqual(rowIds(), firstRowIds);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Conversation projections reject an unavailable authoritative date', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-null-date-'));
  try {
    const store = await openProjectionStore({ stateDir, kind: 'conversation' });
    await assert.rejects(() => store.rebuild({ rows: [{
      topicId: 'topic-one',
      sourceReference: { referenceId: 'session:undated', topicId: 'topic-one', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:undated' },
      sessionKey: 'agent:main:undated', messageId: 'message-undated', name: 'Undated fixture', date: null,
      text: 'credible undated transcript', provenance: 'native', status: 'open'
    }] }), /authoritative ISO date/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
