import { sourceError } from '../sources/errors.mjs';
import { SEARCH_PROJECTION_VERSIONS } from './projection-store.mjs';

const MAX_EXCERPTS = 8;
const MAX_EXCERPT_CHARS = 320;
const MAX_EXCERPT_CHARACTERS = MAX_EXCERPTS * MAX_EXCERPT_CHARS;
const MAX_OUTPUT_BYTES = 12 * 1024;
const REDACTED_CREDENTIAL = '[REDACTED CREDENTIAL]';

function redactCredentialText(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu, REDACTED_CREDENTIAL)
    .replace(/\b(authorization)\s*[:=]\s*[^\r\n]+/giu, (_match, label) => `${label}=${REDACTED_CREDENTIAL}`)
    .replace(/\b(set-cookie|cookie)\s*:\s*[^\r\n]+/giu, (_match, label) => `${label}: ${REDACTED_CREDENTIAL}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, (_match, scheme) => `${scheme}${REDACTED_CREDENTIAL}@`)
    .replace(/\b((?:api|access|private)[\s_-]?(?:key|token)|password|passcode|passphrase|passwd|pwd|secret\s+phrase|credential)\b[\s\S]*/giu, (_match, label) => `${label} ${REDACTED_CREDENTIAL}`)
    .replace(/\b(secret|token|key)\b(?=[\s\S]*(?:\b(?:is|was|equals?|reads?)\b|[:=]))[\s\S]*/giu, (_match, label) => `${label} ${REDACTED_CREDENTIAL}`)
    .replace(/(["']?)([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|token|password|passwd|pwd|secret|private[_-]?key|authorization|set[_-]?cookie|cookie)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu, (_match, quote, label, separator) => `${quote}${label}${quote}${separator}${REDACTED_CREDENTIAL}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]{8,}/giu, (_match, scheme) => `${scheme} ${REDACTED_CREDENTIAL}`)
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|npm_|glpat-|sk-|rk-|pk-)[A-Za-z0-9_-]{4,}\b/giu, REDACTED_CREDENTIAL)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, REDACTED_CREDENTIAL)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, REDACTED_CREDENTIAL)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED_CREDENTIAL);
}

function currentTopic(metadata, sessionKey) {
  if (typeof sessionKey !== 'string' || sessionKey.trim() === '') return null;
  const matches = (metadata?.listSourceReferences?.() ?? []).filter((reference) => reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session' && reference.externalSourceId === sessionKey);
  if (matches.length !== 1) return null;
  return metadata.getTopic?.(matches[0].topicId) ?? null;
}

function identity(metadata, topic) {
  return Object.freeze({
    topicId: topic.topicId,
    displayLabel: bounded(redactCredentialText(metadata?.getPresentationPreferences?.(topic.topicId)?.displayLabel || topic.topicId), 256),
    paraCategory: topic.paraCategory
  });
}

function bounded(value, max) { return Array.from(String(value ?? '')).slice(0, max).join(''); }
function assertCredentialFreeIdentity(value) {
  if (typeof value === 'string') {
    if (redactCredentialText(value) !== value) throw sourceError('source-recovery', 'A Topic context source identity contains credential-shaped content.');
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertCredentialFreeIdentity(item); return; }
  if (value && typeof value === 'object') for (const item of Object.values(value)) assertCredentialFreeIdentity(item);
}
function compactReference(reference) {
  if (!reference || typeof reference !== 'object') return null;
  assertCredentialFreeIdentity(reference);
  return Object.freeze({ referenceId: reference.referenceId, topicId: reference.topicId, sourceSystem: reference.sourceSystem, sourceKind: reference.sourceKind });
}
function safeNavigation(navigation) {
  if (!navigation || typeof navigation !== 'object' || Array.isArray(navigation)) return navigation;
  const safe = {};
  for (const [field, value] of Object.entries(navigation)) {
    if (field === 'heading' && typeof value === 'string') safe[field] = redactCredentialText(value);
    else { assertCredentialFreeIdentity(value); safe[field] = value; }
  }
  return Object.freeze(safe);
}
function excerpt(item, group, topicIdentity, metadata) {
  const excerptText = redactCredentialText([item.contextBefore, item.snippet, item.contextAfter]
    .filter((value) => typeof value === 'string' && value)
    .join('\n\n'));
  let originatingTopic = topicIdentity;
  if (group === 'conversations' && typeof item.originatingTopicId === 'string' && item.originatingTopicId !== topicIdentity.topicId) {
    const authoritativeOrigin = metadata?.getTopic?.(item.originatingTopicId);
    if (!authoritativeOrigin) throw sourceError('source-recovery', 'Conversation excerpt has an unknown authoritative originating Topic.');
    originatingTopic = identity(metadata, authoritativeOrigin);
  }
  const common = {
    originatingTopic,
    sourceReference: compactReference(item.sourceReference),
    label: bounded(redactCredentialText(group === 'notes' ? item.heading ?? item.path : item.conversationName), 256),
    excerpt: bounded(excerptText || redactCredentialText(item.snippet), MAX_EXCERPT_CHARS),
    navigation: safeNavigation(item.navigation)
  };
  return group === 'notes' ? common : { ...common, provenance: item.provenance };
}

function byteLength(value) { return Buffer.byteLength(JSON.stringify(value)); }
function fitOutput(value) {
  while (byteLength(value) > MAX_OUTPUT_BYTES && (value.groups.notes.length || value.groups.conversations.length)) {
    const isNotes = value.groups.notes.length >= value.groups.conversations.length;
    const group = isNotes ? value.groups.notes : value.groups.conversations;
    group.pop();
    value.truncation[isNotes ? 'notes' : 'conversations'] = true;
  }
  if (byteLength(value) > MAX_OUTPUT_BYTES) throw sourceError('response-too-large', 'Topic context identity exceeds the 12 KiB output budget.');
  value.groups.notes = Object.freeze(value.groups.notes);
  value.groups.conversations = Object.freeze(value.groups.conversations);
  value.groups = Object.freeze(value.groups);
  value.truncation = Object.freeze(value.truncation);
  return Object.freeze(value);
}

function selectExcerpts(notes, conversations, limit) {
  const selectedNotes = [];
  const selectedConversations = [];
  let noteIndex = 0;
  let conversationIndex = 0;
  while (selectedNotes.length + selectedConversations.length < limit && (noteIndex < notes.length || conversationIndex < conversations.length)) {
    if (noteIndex < notes.length) selectedNotes.push(notes[noteIndex++]);
    if (selectedNotes.length + selectedConversations.length < limit && conversationIndex < conversations.length) selectedConversations.push(conversations[conversationIndex++]);
  }
  return { notes: selectedNotes, conversations: selectedConversations };
}

export function createTopicContextPolicy({ metadata, searchService } = {}) {
  async function retrieve({ query, sessionKey, targetTopicId, crossTopicBasis, limit = MAX_EXCERPTS } = {}) {
    const current = currentTopic(metadata, sessionKey);
    if (!current) throw sourceError('source-recovery', 'Trusted session context does not resolve exactly one current Topic.');
    if (typeof query !== 'string' || query.trim() === '' || query.trim().length > 256) throw sourceError('invalid-request', 'query must be 1–256 UTF-16 code units.');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXCERPTS) throw sourceError('invalid-request', `limit must be an integer between 1 and ${MAX_EXCERPTS}.`);
    const targetId = targetTopicId ?? current.topicId;
    const crossTopic = targetId !== current.topicId;
    if (crossTopic) {
      if (!['explicit-reference', 'task-necessity'].includes(crossTopicBasis)) throw sourceError('cross-topic', 'Cross-Topic retrieval requires an allowed basis.');
    } else if (crossTopicBasis !== undefined) throw sourceError('invalid-request', 'crossTopicBasis is valid only for a different Topic.');
    const topic = metadata?.getTopic?.(targetId);
    if (!topic) throw sourceError('source-recovery', 'The requested Topic does not exist.');
    const currentTopicIdentity = identity(metadata, current);
    const retrievedTopic = identity(metadata, topic);
    const result = await searchService.query({ schemaVersion: 1, topicId: targetId, query: query.trim(), limit });
    const selected = selectExcerpts(result.notes.results, result.conversations.results, limit);
    return fitOutput({ schemaVersion: 1, currentTopic: currentTopicIdentity, originatingTopic: currentTopicIdentity, retrievedTopic, crossTopic, selectionBasis: crossTopic ? crossTopicBasis : 'current-topic', projectionVersions: SEARCH_PROJECTION_VERSIONS, groups: {
      notes: selected.notes.map((item) => excerpt(item, 'notes', retrievedTopic, metadata)),
      conversations: selected.conversations.map((item) => excerpt(item, 'conversations', retrievedTopic, metadata))
    }, truncation: {
      notes: result.notes.results.length > selected.notes.length,
      conversations: result.conversations.results.length > selected.conversations.length
    } });
  }
  return Object.freeze({ retrieve });
}

export const createAutomaticContextPolicy = createTopicContextPolicy;
export const topicContextLimits = Object.freeze({ maxExcerpts: MAX_EXCERPTS, maxExcerptChars: MAX_EXCERPT_CHARS, maxExcerptCharacters: MAX_EXCERPT_CHARACTERS, maxOutputBytes: MAX_OUTPUT_BYTES });
