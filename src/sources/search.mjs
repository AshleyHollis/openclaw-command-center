import { sourceError } from './errors.mjs';
import { validateSearchRequest } from '../search/query.mjs';

const resultKeys = Object.freeze({
  note: ['kind', 'topicId', 'sourceReference', 'path', 'heading', 'snippet', 'highlights', 'contextBefore', 'contextAfter', 'navigation'],
  conversation: ['kind', 'topicId', 'sourceReference', 'sessionKey', 'messageId', 'conversationName', 'date', 'originatingTopicId', 'snippet', 'highlights', 'contextBefore', 'contextAfter', 'provenance', 'navigation']
});

function fail(message) { throw sourceError('unavailable', message); }
function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains an unsupported field.`);
}
function nonBlank(value, label) { if (typeof value !== 'string' || !value.trim()) fail(`${label} is invalid.`); }
function codePoints(value) { return Array.from(String(value ?? '')).length; }
function validateReference(reference, topicId, kind) {
  exactKeys(reference, ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt', 'updatedAt'], 'Source Reference');
  if (reference.version !== 1 || reference.topicId !== topicId) fail('Source Reference Topic identity is invalid.');
  if (kind === 'note' && (reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note')) fail('Note result requires its authoritative Note Source Reference.');
  if (kind === 'conversation' && (reference.sourceSystem !== 'openclaw' || reference.sourceKind !== 'session')) fail('Conversation result requires its authoritative Session Source Reference.');
  nonBlank(reference.referenceId, 'Source Reference identity');
  if (kind === 'conversation') nonBlank(reference.externalSourceId, 'Source Reference external identity');
}
function validateNavigation(navigation, row, kind) {
  const allowed = kind === 'note' ? ['kind', 'topicId', 'referenceId', 'path', 'heading', 'observedRevision'] : ['kind', 'topicId', 'referenceId', 'sessionKey', 'sessionId', 'messageId'];
  exactKeys(navigation, allowed, 'Navigation');
  if (navigation.kind !== kind || navigation.topicId !== row.topicId || navigation.referenceId !== row.sourceReference.referenceId) fail('Navigation authority is invalid.');
  if (kind === 'note' && navigation.path !== row.path) fail('Note navigation path is invalid.');
  if (kind === 'conversation' && (row.sessionKey !== row.sourceReference.externalSourceId || navigation.sessionKey !== row.sessionKey || navigation.messageId !== row.messageId || typeof navigation.sessionId !== 'string' || !navigation.sessionId)) fail('Conversation navigation identity is invalid.');
}
function validateResult(row, kind, topicId) {
  exactKeys(row, resultKeys[kind], `${kind} result`);
  if (row.kind !== kind || row.topicId !== topicId) fail(`${kind} result Topic identity is invalid.`);
  validateReference(row.sourceReference, topicId, kind);
  if (typeof row.snippet !== 'string' || codePoints(row.snippet) > 240) fail(`${kind} snippet exceeds 240 code points.`);
  if (typeof row.contextBefore !== 'string' || typeof row.contextAfter !== 'string' || codePoints(row.snippet) + codePoints(row.contextBefore) + codePoints(row.contextAfter) > 600) fail(`${kind} context exceeds 600 code points.`);
  if (!Array.isArray(row.highlights) || row.highlights.some(({ start, end } = {}) => !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > row.snippet.length)) fail(`${kind} highlights are invalid.`);
  if (kind === 'note') {
    nonBlank(row.path, 'Note path');
    if (row.heading !== null && typeof row.heading !== 'string') fail('Note heading is invalid.');
  } else {
    for (const [value, label] of [[row.sessionKey, 'Session key'], [row.conversationName, 'Conversation name'], [row.date, 'Conversation date']]) nonBlank(value, label);
    if (row.messageId !== null) nonBlank(row.messageId, 'Message ID');
    if (Number.isNaN(Date.parse(row.date)) || new Date(row.date).toISOString() !== row.date) fail('Conversation date is invalid.');
    exactKeys(row.provenance, ['role', 'status', 'importedPrimaryHistory'], 'Conversation provenance');
    if (!['primary', 'former-primary', 'topic-conversation'].includes(row.provenance.role) || !['open', 'closed'].includes(row.provenance.status) || typeof row.provenance.importedPrimaryHistory !== 'boolean') fail('Conversation provenance is invalid.');
  }
  validateNavigation(row.navigation, row, kind);
  return Object.freeze({ ...row });
}

export class SearchAdapter {
  constructor({ provider } = {}) { this.provider = provider; }
  async query(input = {}) {
    const request = validateSearchRequest(input);
    if (typeof this.provider?.query !== 'function') throw sourceError('capability-unavailable', 'Derived search capability is unavailable.', { capability: 'search' });
    const response = await this.provider.query({ schemaVersion: 1, topicId: request.topicId, query: request.query, limit: request.limit });
    exactKeys(response, ['schemaVersion', 'topicId', 'query', 'notes', 'conversations'], 'Search response');
    if (response.schemaVersion !== 1 || response.topicId !== request.topicId || response.query !== request.query) fail('Search response identity is invalid.');
    const group = (value, kind) => {
      exactKeys(value, ['results'], `${kind} group`);
      if (!Array.isArray(value.results) || value.results.length > request.limit) fail(`${kind} group exceeds its independent limit.`);
      return Object.freeze({ results: Object.freeze(value.results.map((row) => validateResult(row, kind, request.topicId))) });
    };
    return Object.freeze({ schemaVersion: 1, topicId: request.topicId, query: request.query, notes: group(response.notes, 'note'), conversations: group(response.conversations, 'conversation') });
  }
}

export function createSearchAdapter(options) { return new SearchAdapter(options); }
