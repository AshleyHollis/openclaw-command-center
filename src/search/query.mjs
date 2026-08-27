import { sourceError } from '../sources/errors.mjs';

export const SEARCH_SCHEMA_VERSION = 1;
export const MAX_QUERY_LENGTH = 256;
export const MAX_RESULT_LIMIT = 100;

const requestKeys = Object.freeze(['schemaVersion', 'topicId', 'query', 'limit']);

function invalid(message) {
  throw sourceError('invalid-request', message);
}

function quoteFts(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function parseLexicalQuery(input) {
  if (typeof input !== 'string') invalid('query must be a string.');
  const query = input.trim().normalize('NFC');
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) invalid(`query must be between 1 and ${MAX_QUERY_LENGTH} UTF-16 code units.`);
  const tokens = [];
  let offset = 0;
  while (offset < query.length) {
    while (/\s/u.test(query[offset] ?? '')) offset += 1;
    if (offset >= query.length) break;
    let kind = 'keyword';
    let value = '';
    if (query[offset] === '"') {
      kind = 'phrase';
      const end = query.indexOf('"', offset + 1);
      if (end < 0) invalid('query contains an unmatched quote.');
      value = query.slice(offset + 1, end).trim();
      offset = end + 1;
    } else {
      let end = offset;
      while (end < query.length && !/\s|"/u.test(query[end])) end += 1;
      value = query.slice(offset, end);
      offset = end;
    }
    if (!/[\p{L}\p{N}_]/u.test(value)) invalid('query must contain a searchable token.');
    tokens.push({ kind, value: value.normalize('NFC') });
  }
  if (tokens.length === 0) invalid('query must contain a searchable token.');
  return Object.freeze(tokens.map((token) => Object.freeze(token)));
}

export function buildFtsQuery(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) invalid('query must contain a searchable token.');
  return tokens.map((token) => {
    if (!token || !['keyword', 'phrase'].includes(token.kind) || typeof token.value !== 'string' || token.value.trim() === '') invalid('query tokens are invalid.');
    return quoteFts(token.value.trim());
  }).join(' AND ');
}

export function validateSearchRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Search request must be an object.');
  for (const key of Object.keys(input)) if (!requestKeys.includes(key)) invalid(`Search request contains unsupported field: ${key}`);
  if (input.schemaVersion !== SEARCH_SCHEMA_VERSION) throw sourceError('unsupported-version', 'Search schemaVersion must be 1.');
  if (typeof input.topicId !== 'string' || input.topicId.trim() === '') invalid('topicId must be a non-blank string.');
  const query = typeof input.query === 'string' ? input.query.trim() : invalid('query must be a string.');
  const tokens = parseLexicalQuery(query);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) invalid(`limit must be an integer between 1 and ${MAX_RESULT_LIMIT}.`);
  return Object.freeze({ schemaVersion: SEARCH_SCHEMA_VERSION, topicId: input.topicId.trim(), query, limit, tokens, ftsQuery: buildFtsQuery(tokens) });
}

function displayText(value) {
  return String(value ?? '').replace(/[\u0000\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function snippetText(value, max = 240) {
  return Array.from(displayText(value).split(/\s+/u).filter(Boolean).slice(0, 32).join(' ')).slice(0, max).join('');
}

export function contextText(value, max = 600) {
  return Array.from(displayText(value)).slice(0, max).join('');
}
