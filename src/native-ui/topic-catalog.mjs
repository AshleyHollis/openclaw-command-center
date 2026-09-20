const PAGE_SIZE = 50;
const MAX_CATALOG_ENTRIES = 10_000;

/**
 * Load one immutable Topic-file snapshot through its cursor contract.
 * Presentation adapters receive the same complete, bounded snapshot.
 */
export async function loadTopicCatalog({ request, topicId, current, validate, onFirstPage, pageSize = PAGE_SIZE, maxEntries = MAX_CATALOG_ENTRIES }) {
  const notes = [];
  const identities = new Set();
  const paths = new Set();
  let offset = 0;
  let cursor;
  let total;

  for (;;) {
    const response = await request('command-center.v1.notes.browse', {
      schemaVersion: 1, topicId, offset, limit: pageSize, includeDocuments: true, ...(cursor ? { cursor } : {})
    });
    if (!current()) return null;
    const page = response?.result ?? response;
    if (!Array.isArray(page?.notes) || page.offset !== offset || !Number.isSafeInteger(page.total) || page.total < 0 ||
        page.total > maxEntries || typeof page.hasMore !== 'boolean' || typeof page.cursor !== 'string' || !page.cursor ||
        (cursor !== undefined && page.cursor !== cursor) || (total !== undefined && page.total !== total)) {
      throw new Error('The Note catalogue is unavailable; refresh Notes.');
    }
    total ??= page.total;
    cursor ??= page.cursor;
    if (page.notes.length > pageSize || offset + page.notes.length > total || (page.hasMore && page.notes.length === 0)) {
      throw new Error('The exact Note catalogue is unavailable.');
    }
    for (const note of page.notes) {
      validate(note);
      const identity = JSON.stringify([note.sourceReference.referenceId, note.path]);
      if (identities.has(identity) || paths.has(note.path)) throw new Error('The exact Note catalogue is unavailable.');
      identities.add(identity); paths.add(note.path); notes.push(note);
    }
    if (offset === 0) onFirstPage?.({ notes: [...notes], total, cursor, complete: !page.hasMore });
    if (!page.hasMore) {
      if (offset + page.notes.length !== total || notes.length !== total) throw new Error('The exact Note catalogue is unavailable.');
      return { notes, total, cursor };
    }
    const expectedNextOffset = offset + page.notes.length;
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== expectedNextOffset || page.nextOffset >= total) {
      throw new Error('The Note catalogue is unavailable; refresh Notes.');
    }
    offset = page.nextOffset;
  }
}

export const topicCatalogPageSize = PAGE_SIZE;
