import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeExplorerCatalogEntries, nativeExplorerCompleteCatalogLimit } from '../src/native-ui/topic-page.mjs';

test('native explorer keeps complete small catalogs and pages large catalogs', () => {
  const small = Array.from({ length: nativeExplorerCompleteCatalogLimit }, (_, index) => ({ path: `small-${index}.md` }));
  const large = Array.from({ length: nativeExplorerCompleteCatalogLimit + 1 }, (_, index) => ({ path: `large-${index}.md` }));
  const page = large.slice(50, 100);
  assert.equal(nativeExplorerCatalogEntries(small, small.slice(0, 50)), small);
  assert.equal(nativeExplorerCatalogEntries(large, page), page);
  assert.throws(() => nativeExplorerCatalogEntries(large, page, 0), /invalid/u);
});
