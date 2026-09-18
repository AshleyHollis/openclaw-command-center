import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { assertVerifiedPreservedHistoryPage } from '../src/migration/preserved-history-import.mjs';

const entry = index => ({ eventId: `fictional-${index}`, parentId: index ? `fictional-${index - 1}` : null, message: { index } });
const prepared = { expectedCount: 3, entries: [entry(0), entry(1), entry(2)] };
const row = { transcriptGeneration: 'fictional-generation', verifiedCount: 3 };
const request = { offset: 0, limit: 3 };
const projected = (index, message = prepared.entries[index].message) => ({
  entryId: prepared.entries[index].eventId, parentId: prepared.entries[index].parentId, seq: index + 1, message
});
const matchesMessage = (actual, expected) => isDeepStrictEqual(actual, expected.message);

test('verified Imported History accepts a byte-bounded contiguous prefix from one exact native snapshot', () => {
  assert.doesNotThrow(() => assertVerifiedPreservedHistoryPage({ row, prepared,
    page: { generation: row.transcriptGeneration, totalMessages: 3, activeLeafEntryId: 'fictional-2', entries: [projected(0)] },
    request, matchesMessage }));
});

test('verified Imported History rejects an empty partial page and a same-count branch switch', () => {
  assert.throws(() => assertVerifiedPreservedHistoryPage({ row, prepared,
    page: { generation: row.transcriptGeneration, totalMessages: 3, activeLeafEntryId: 'fictional-2', entries: [] },
    request, matchesMessage }), { code: 'history-prefix-conflict' });
  assert.throws(() => assertVerifiedPreservedHistoryPage({ row, prepared,
    page: { generation: row.transcriptGeneration, totalMessages: 3, activeLeafEntryId: 'fictional-foreign-leaf', entries: [projected(0)] },
    request, matchesMessage }), { code: 'history-proof-conflict' });
});

test('verified Imported History rejects generation, count, ordering, parent, and message drift', () => {
  const base = { generation: row.transcriptGeneration, totalMessages: 3, activeLeafEntryId: 'fictional-2', entries: [projected(0)] };
  for (const page of [
    { ...base, generation: 'replacement-generation' },
    { ...base, totalMessages: 4 },
    { ...base, entries: [{ ...projected(0), seq: 2 }] },
    { ...base, entries: [{ ...projected(0), parentId: 'fictional-foreign-parent' }] },
    { ...base, entries: [projected(0, { index: 99 })] }
  ]) assert.throws(() => assertVerifiedPreservedHistoryPage({ row, prepared, page, request, matchesMessage }));
});
