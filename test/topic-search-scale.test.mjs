import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openProjectionStore } from '../src/search/projection-store.mjs';
import { createTopicSearchService } from '../src/search/service.mjs';

const topicId = 'topic-large-fictional';
const folderReference = { version: 1, referenceId: 'folder:large', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/large', observedRevision: null };
const sessionReference = { version: 1, referenceId: 'session:large', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:large', observedRevision: null };

test('large repeated Topic queries use the FTS virtual-table index without authoritative reads', async (context) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-search-scale-'));
  let authoritativeReads = 0;
  let projectionDigestReads = 0;
  try {
    const noteReferences = Array.from({ length: 5_000 }, (_, index) => ({ version: 1, referenceId: `note:large:${index}`, topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `/fictional/large/${index}.md`, observedRevision: `fictional-${index}` }));
    const digestFile = (file) => {
      projectionDigestReads += 1;
      return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
    };
    const store = await openProjectionStore({ stateDir, kind: 'note', digestFile });
    const conversationStore = await openProjectionStore({ stateDir, kind: 'conversation', digestFile });
    await store.rebuild({ rows: Array.from({ length: 5_000 }, (_, index) => ({
      topicId, sourceReference: noteReferences[index], folderReferenceId: 'folder:large', path: `${index}.md`, heading: `Fictional ${index}`, revision: `fictional-${index}`,
      text: index === 0 ? 'x'.repeat(8_388_609) : index % 100 === 0 ? `indexed needle ${index}` : `ordinary fictional record ${index}`, provenance: 'native'
    })) });
    await conversationStore.rebuild({ rows: Array.from({ length: 5_000 }, (_, index) => ({
      topicId, sourceReference: sessionReference, sessionKey: sessionReference.externalSourceId, sessionId: 'session-large', messageId: `message-${index}`, name: 'Large fixture', date: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
      closed: false, primaryState: 'ordinary', role: 'user', text: `Fictional indexed scale phrase ${index}. ${index % 100 === 0 ? `indexed needle ${index}` : `ordinary fictional message ${index}`}`, provenance: 'native'
    })) });
    const request = { schemaVersion: 1, topicId, query: 'needle', limit: 20 };
    const plan = store.explainQueryPlan(request).map((row) => String(row.detail)).join('\n');
    assert.match(plan, /VIRTUAL TABLE INDEX/iu);
    assert.match(plan, /note_documents_topic_idx/iu);
    const conversationPlan = conversationStore.explainQueryPlan(request).map((row) => String(row.detail)).join('\n');
    assert.match(conversationPlan, /VIRTUAL TABLE INDEX/iu);
    assert.match(conversationPlan, /conversation_documents_topic_idx/iu);
    assert.ok(projectionDigestReads > 0, 'opening a committed projection performs one full integrity validation');
    projectionDigestReads = 0;
    const references = new Map([[folderReference.referenceId, folderReference], [sessionReference.referenceId, sessionReference], ...noteReferences.map((reference) => [reference.referenceId, reference])]);
    const search = createTopicSearchService({
      metadata: { getTopic: (id) => id === topicId ? { topicId } : null, getSourceReference: (id) => references.get(id), listSourceReferences: () => [...references.values()], getSessionState: () => ({ sessionId: 'session-large', status: 'open', isPrimary: false, wasPrimary: false }) },
      noteStore: store,
      conversationStore,
      sourceService: { notesRead: () => { authoritativeReads += 1; }, sessionsNavigate: () => { authoritativeReads += 1; } }
    });
    for (let render = 0; render < 5; render += 1) {
      const grouped = await search.query(request);
      assert.equal(grouped.notes.results.length, 20);
      assert.equal(grouped.conversations.results.length, 20);
      assert.doesNotThrow(() => JSON.stringify({ notes: grouped.notes, conversations: grouped.conversations }));
    }
    assert.equal(authoritativeReads, 0);
    assert.equal(projectionDigestReads, 0, 'unchanged repeated queries must not rescan the SQLite projection file');
    const highHitStarted = performance.now();
    const highHit = await search.query({ schemaVersion: 1, topicId, query: 'Fictional indexed scale phrase', limit: 50 });
    context.diagnostic(`high-hit-query=${JSON.stringify({ corpus: 5000, largeNoteBytes: 8_388_609, elapsedMs: Math.ceil(performance.now() - highHitStarted), results: highHit.conversations.results.length })}`);
    assert.equal(highHit.conversations.results.length, 50);
    assert.equal(new Set(highHit.conversations.results.map((result) => result.messageId)).size, 50);
    assert.equal(authoritativeReads, 0);
    assert.equal(projectionDigestReads, 0);
    store.close();
    conversationStore.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
