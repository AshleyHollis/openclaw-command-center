import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeExplorerCatalogEntries, nativeExplorerCompleteCatalogLimit } from '../src/native-ui/topic-page.mjs';
import { loadTopicCatalog } from '../src/native-ui/topic-catalog.mjs';

test('native explorer keeps complete small catalogs and pages large catalogs', () => {
  const small = Array.from({ length: nativeExplorerCompleteCatalogLimit }, (_, index) => ({ path: `small-${index}.md` }));
  const large = Array.from({ length: nativeExplorerCompleteCatalogLimit + 1 }, (_, index) => ({ path: `large-${index}.md` }));
  const page = large.slice(50, 100);
  assert.equal(nativeExplorerCatalogEntries(small, small.slice(0, 50)), small);
  assert.equal(nativeExplorerCatalogEntries(large, page), page);
  assert.throws(() => nativeExplorerCatalogEntries(large, page, 0), /invalid/u);
});

test('catalog loading exposes each validated snapshot page before completion', async () => {
  const notes = Array.from({ length: 3 }, (_, index) => ({ path: `fictional-${index}.md`, sourceReference: { referenceId: `ref-${index}` } }));
  const pages = [];
  const firstPages = [];
  const result = await loadTopicCatalog({ topicId: 'fictional-topic', pageSize: 2, current: () => true, validate: () => {},
    request: async (_method, input) => ({ result: { notes: notes.slice(input.offset, input.offset + input.limit), offset: input.offset,
      total: notes.length, hasMore: input.offset === 0, nextOffset: input.offset === 0 ? 2 : null, cursor: 'fictional-cursor' } }),
    onFirstPage: page => firstPages.push(page), onPage: page => pages.push(page) });
  assert.deepEqual(pages.map(page => ({ offset: page.offset, count: page.notes.length, complete: page.complete })), [
    { offset: 0, count: 2, complete: false },
    { offset: 2, count: 3, complete: true },
  ]);
  assert.equal(firstPages.length, 1);
  assert.deepEqual(result.notes, notes);
});
