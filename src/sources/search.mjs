import { sourceError, assertNoUnexpectedKeys, nonBlank } from './errors.mjs';

export class SearchAdapter {
  constructor({ provider } = {}) {
    this.provider = provider;
  }

  async query(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'requestId', 'query', 'limit'], 'Search request');
    const query = nonBlank(input.query, 'query');
    if (query.length > 256) throw sourceError('invalid-request', 'query must be at most 256 characters.');
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw sourceError('invalid-request', 'limit must be an integer between 1 and 100.');
    if (typeof this.provider?.query !== 'function') throw sourceError('capability-unavailable', 'Derived search capability is unavailable.', { capability: 'search' });
    const response = await this.provider.query({ ...input, query, limit });
    const rows = Array.isArray(response) ? response : response?.results ?? [];
    const allowed = new Set(['kind', 'referenceId', 'path', 'title', 'snippet', 'score']);
    const results = rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw sourceError('unavailable', 'Derived search provider returned an invalid result.');
      for (const key of Object.keys(row)) if (!allowed.has(key)) throw sourceError('unavailable', 'Derived search provider returned an unsupported result field.');
      nonBlank(row.kind, 'result.kind');
      return Object.freeze({ ...row });
    });
    return Object.freeze({ schemaVersion: 1, query, limit, results: Object.freeze(results) });
  }
}

export function createSearchAdapter(options) {
  return new SearchAdapter(options);
}
