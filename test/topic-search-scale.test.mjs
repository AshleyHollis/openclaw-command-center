import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openProjectionStore } from '../src/search/projection-store.mjs';
import { createTopicSearchService } from '../src/search/service.mjs';
import { chromium } from 'playwright';

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
    const noteRows = Array.from({ length: 5_000 }, (_, index) => ({
      topicId, sourceReference: noteReferences[index], folderReferenceId: 'folder:large', path: `${index}.md`, heading: `Fictional ${index}`, revision: `fictional-${index}`,
      text: index === 0 ? 'x'.repeat(8_388_609) : index % 100 === 0 ? `indexed needle ${index}` : `ordinary fictional record ${index}`, provenance: 'native'
    }));
    await store.rebuild({ rows: noteRows });
    const conversationRows = Array.from({ length: 5_000 }, (_, index) => ({
      topicId, sourceReference: sessionReference, sessionKey: sessionReference.externalSourceId, sessionId: 'session-large', messageId: `message-${index}`, name: 'Large fixture', date: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
      closed: false, primaryState: 'ordinary', role: 'user', text: `Fictional indexed scale phrase ${index}. ${index % 100 === 0 ? `indexed needle ${index}` : `ordinary fictional message ${index}`}`, provenance: 'native'
    }));
    await conversationStore.rebuild({ rows: conversationRows });
    const request = { schemaVersion: 1, topicId, query: 'needle', limit: 20 };
    const plan = store.explainQueryPlan(request).map((row) => String(row.detail)).join('\n');
    assert.match(plan, /VIRTUAL TABLE INDEX/iu);
    assert.match(plan, /note_documents_topic_idx/iu);
    assert.match(plan.split('\n')[0], /SCAN note_documents_fts VIRTUAL TABLE INDEX/iu, 'FTS matches must drive keyed document lookups, not one FTS scan per Topic document');
    assert.match(plan, /topic_id=\? AND rowid=\?/u);
    const conversationPlan = conversationStore.explainQueryPlan(request).map((row) => String(row.detail)).join('\n');
    assert.match(conversationPlan, /VIRTUAL TABLE INDEX/iu);
    assert.match(conversationPlan, /conversation_documents_topic_idx/iu);
    assert.match(conversationPlan.split('\n')[0], /SCAN conversation_documents_fts VIRTUAL TABLE INDEX/iu);
    assert.match(conversationPlan, /topic_id=\? AND rowid=\?/u);
    assert.ok(projectionDigestReads > 0, 'opening a committed projection performs one full integrity validation');
    projectionDigestReads = 0;
    const references = new Map([[folderReference.referenceId, folderReference], [sessionReference.referenceId, sessionReference], ...noteReferences.map((reference) => [reference.referenceId, reference])]);
    const search = createTopicSearchService({
      metadata: { getTopic: (id) => id === topicId ? { topicId } : null, getSourceReference: (id) => references.get(id), listSourceReferences: () => [...references.values()], getSessionState: () => ({ sessionId: 'session-large', status: 'open', isPrimary: false, wasPrimary: false }) },
      noteStore: store,
      conversationStore,
      sourceService: { notesRead: () => { authoritativeReads += 1; }, sessionsNavigate: () => { authoritativeReads += 1; } }
    });
    const server = createServer(async (req, res) => {
      if (req.url === '/search-results.mjs') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../src/native-ui/search-results.mjs', import.meta.url))); return; }
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><title>Fictional native Search</title><main id="results" style="width:320px"></main></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
      browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const render = async (grouped) => page.evaluate(async (value) => {
        const { renderGroupedSearchResults } = await import('/search-results.mjs');
        const root = document.querySelector('#results');
        window.openedSearch = [];
        renderGroupedSearchResults(root, value, { openNote: (navigation) => window.openedSearch.push(navigation), openConversation: (navigation) => window.openedSearch.push(navigation) });
        return { notes: root.querySelectorAll('[data-search-group="notes"] article').length, conversations: root.querySelectorAll('[data-search-group="conversations"] article').length, text: root.textContent };
      }, grouped);
      const before = await search.query(request);
      const longPath = `archive/${'x'.repeat(800)}.md`;
      const contextFixture = { notes: { results: [
        { heading: 'Shared heading', path: 'planning/one.md', snippet: 'Fictional first Note', navigation: { kind: 'note', topicId, referenceId: 'note:one', path: 'planning/one.md', observedRevision: 'one' } },
        { heading: 'Shared heading', path: longPath, snippet: 'Fictional second Note', navigation: { kind: 'note', topicId, referenceId: 'note:two', path: longPath, observedRevision: 'two' } }
      ] }, conversations: { results: [
        { conversationName: 'Shared name', date: '2026-08-01', snippet: 'Fictional transcript', provenance: { role: 'former-primary', status: 'closed', importedPrimaryHistory: true }, navigation: { kind: 'conversation', topicId, referenceId: 'session:one', sessionKey: 'agent:main:one', sessionId: 'one' } }
      ] } };
      const contextPaint = await render(contextFixture);
      assert.match(contextPaint.text, /Shared heading.*planning\/one\.md.*Shared heading.*archive\/x+.*Shared name.*2026-08-01.*former-primary.*closed.*Imported history/u);
      assert.equal(await page.locator('[data-search-group="notes"] article').last().evaluate((article) => article.scrollWidth <= article.clientWidth && article.querySelector('p').textContent.length <= 500), true, 'long paths remain bounded and wrap in the narrow native result group');
      const destinations = await page.evaluate(() => {
        const root = document.querySelector('#results');
        root.querySelectorAll('button').forEach((button) => button.click());
        return window.openedSearch;
      });
      assert.deepEqual(destinations, [contextFixture.notes.results[0].navigation, contextFixture.notes.results[1].navigation, contextFixture.conversations.results[0].navigation]);
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const painted = await render(await search.query(request));
        assert.deepEqual([painted.notes, painted.conversations], [20, 20]);
        assert.match(painted.text, /Notes.*Fictional.*\.md.*Conversations.*Large fixture.*2026-08/u);
      }
      assert.equal(authoritativeReads, 0);
      assert.equal(projectionDigestReads, 0, 'repeated query and native rendering do not rescan projection databases');
      store.delete(); conversationStore.delete();
      await store.rebuild({ rows: noteRows }); await conversationStore.rebuild({ rows: conversationRows });
      const after = await search.query(request);
      assert.deepEqual(after, before, 'deleting and rebuilding disposable projections preserves grouped results');
      const rebuilt = await render(after);
      assert.deepEqual([rebuilt.notes, rebuilt.conversations], [20, 20]);
      assert.match(store.explainQueryPlan(request).map((row) => String(row.detail)).join('\n'), /VIRTUAL TABLE INDEX/iu);
      assert.match(conversationStore.explainQueryPlan(request).map((row) => String(row.detail)).join('\n'), /VIRTUAL TABLE INDEX/iu);
      projectionDigestReads = 0;
    } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
    assert.equal(authoritativeReads, 0);
    assert.equal(projectionDigestReads, 0);
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
