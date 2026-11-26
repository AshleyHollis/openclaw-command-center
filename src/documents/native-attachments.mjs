import { sourceError, assertNoUnexpectedKeys, nonBlank } from '../sources/errors.mjs';

const MAX_MESSAGES = 50;
const MAX_BYTES = 1024 * 1024;

function exactIdentity(identity) {
  assertNoUnexpectedKeys(identity, ['agentId', 'sessionKey', 'sessionId'], 'Native attachment scope');
  const agentId = nonBlank(identity.agentId, 'agentId');
  const sessionKey = nonBlank(identity.sessionKey, 'sessionKey');
  const sessionId = nonBlank(identity.sessionId, 'sessionId');
  if (!sessionKey.startsWith(`agent:${agentId}:`)) throw sourceError('invalid-request', 'The native attachment agent and Conversation must match.');
  return { agentId, sessionKey, sessionId };
}
function offset(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0) throw sourceError('invalid-request', 'A non-negative native message offset is required.');
  return value;
}
function managedRef(value) {
  if (typeof value !== 'string' || !/^media:\/\/inbound\/[^/?#]+$/u.test(value)) return null;
  let id;
  try { id = decodeURIComponent(value.slice('media://inbound/'.length)); } catch { return null; }
  if (!id || id === '.' || id === '..' || /[\\/\x00-\x1f\x7f]/u.test(id) || value !== `media://inbound/${encodeURIComponent(id)}`) return null;
  return value;
}
function attachments(page, position) {
  const result = [];
  for (const entry of page.entries) {
    if (entry?.role !== 'user' || entry.message?.role !== 'user' || typeof entry.entryId !== 'string' || !entry.entryId) continue;
    const facts = entry.message.__openclaw?.media;
    if (!Array.isArray(facts)) continue;
    for (const [mediaIndex, fact] of facts.entries()) {
      const mediaRef = managedRef(fact?.url);
      if (!mediaRef) continue;
      result.push(Object.freeze({
        selection: Object.freeze({ entryId: entry.entryId, mediaIndex, offset: position, generation: page.generation }),
        mediaRef,
        fileName: typeof fact.fileName === 'string' ? fact.fileName.slice(0, 180).replace(/[\x00-\x1f\x7f]/gu, '_') : null,
        contentType: typeof fact.contentType === 'string' ? fact.contentType.slice(0, 100) : null,
        sizeBytes: Number.isSafeInteger(fact.sizeBytes) && fact.sizeBytes >= 0 ? fact.sizeBytes : null,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
      }));
    }
  }
  return result;
}

// Reads the existing native projection directly. No attachment index, parsed
// display text or plugin transcript persistence can manufacture source authority.
export function createNativeAttachmentReader({ readPage } = {}) {
  const read = readPage ?? (async input => {
    const { readSessionTranscriptVisibleMessageDelta } = await import('openclaw/plugin-sdk/session-transcript-runtime');
    if (typeof readSessionTranscriptVisibleMessageDelta !== 'function') throw sourceError('capability-unavailable', 'The pinned bounded native attachment reader is unavailable.');
    return readSessionTranscriptVisibleMessageDelta(input);
  });
  const list = async (identity, input = {}) => {
    assertNoUnexpectedKeys(input, ['offset'], 'Native attachment page');
    const position = offset(input.offset);
    const page = await read({ ...exactIdentity(identity), offset: position, maxMessages: MAX_MESSAGES, maxBytes: MAX_BYTES });
    if (page?.kind !== 'page') throw sourceError('source-recovery', 'The exact native attachment page is unavailable or changed.');
    if (typeof page.generation !== 'string' || !page.generation || !Array.isArray(page.entries) || page.entries.length > MAX_MESSAGES ||
        !Number.isSafeInteger(page.serializedBytes) || page.serializedBytes > MAX_BYTES || page.serializedBytes < 0 ||
        page.requiredBytes !== undefined || page.hasMore && page.entries.length === 0) {
      throw sourceError('response-too-large', 'The native attachment page cannot be safely read within its bounds.');
    }
    return Object.freeze({ schemaVersion: 1, generation: page.generation, offset: position,
      nextOffset: page.hasMore ? position + page.entries.length : null, attachments: Object.freeze(attachments(page, position)) });
  };
  return Object.freeze({ list, async resolve(identity, selection = {}) {
    assertNoUnexpectedKeys(selection, ['entryId', 'mediaIndex', 'offset', 'generation'], 'Native attachment selection');
    nonBlank(selection.entryId, 'entryId'); nonBlank(selection.generation, 'generation'); offset(selection.offset);
    if (!Number.isSafeInteger(selection.mediaIndex) || selection.mediaIndex < 0) throw sourceError('invalid-request', 'A native media array position is required.');
    const page = await list(identity, { offset: selection.offset });
    if (page.generation !== selection.generation) throw sourceError('conflict', 'The native message generation changed. Select the attachment again.');
    const attachment = page.attachments.find(item => item.selection.entryId === selection.entryId && item.selection.mediaIndex === selection.mediaIndex);
    if (!attachment) throw sourceError('source-recovery', 'The selected accepted user attachment is no longer available in this exact Conversation.');
    return attachment;
  } });
}
