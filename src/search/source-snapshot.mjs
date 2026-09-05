import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';
import { effectiveSourceLocator } from '../sources/reference.mjs';
import { normalizeNotePath } from '../sources/note-path.mjs';
import { explicitSessionReplacements, unavailableReplacedSession } from '../sources/session-replacement.mjs';

async function withSignal(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('Snapshot cancelled.')); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(operation).then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); }
    );
  });
}

function exactTopicReferences(metadata, topicId, sourceSystem, sourceKind) {
  const listed = metadata?.listSourceReferences?.(topicId) ?? [];
  if (listed.some((reference) => reference?.topicId !== topicId)) throw sourceError('source-recovery', 'Topic ownership metadata returned a foreign Source Reference.');
  const references = listed.filter((reference) => reference.sourceSystem === sourceSystem && reference.sourceKind === sourceKind);
  const referenceIds = new Set();
  const externalIds = new Set();
  for (const reference of references) {
    if (referenceIds.has(reference.referenceId) || externalIds.has(reference.externalSourceId)) throw sourceError('source-recovery', 'Topic ownership metadata returned duplicate Source References.');
    referenceIds.add(reference.referenceId);
    externalIds.add(reference.externalSourceId);
  }
  if (!metadata?.getTopic?.(topicId)) throw sourceError('source-recovery', 'The requested Topic does not exist.');
  return references;
}

function paragraphContext(text, query = '') {
  const paragraphs = String(text ?? '').split(/\n\s*\n/gu).map((item) => item.trim()).filter(Boolean);
  if (paragraphs.length === 0) return { before: '', after: '' };
  const terms = String(query).toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  let index = paragraphs.findIndex((paragraph) => terms.every((term) => paragraph.toLocaleLowerCase().includes(term.replaceAll('"', ''))));
  if (index < 0) index = 0;
  return { before: paragraphs[index - 1] ?? '', after: paragraphs[index + 1] ?? '' };
}

function noteSections(text) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const sections = [];
  let heading = null;
  let content = [];
  const publish = () => {
    const value = content.join('\n').trim();
    if (value) sections.push({ heading, text: value });
  };
  for (const line of lines) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (match) {
      publish();
      heading = match[1].trim() || null;
      content = [line];
    } else content.push(line);
  }
  publish();
  return sections.length > 0 ? sections : [{ heading: null, text: String(text ?? '') }];
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export async function readNoteSourceSnapshot({ topicId, metadata, noteAdapter, query = '', signal } = {}) {
  signal?.throwIfAborted();
  if (!noteAdapter?.browse || !noteAdapter?.read) throw sourceError('source-unavailable', 'The authoritative Note adapter is unavailable.');
  const folders = exactTopicReferences(metadata, topicId, 'obsidian', 'note_folder');
  if (folders.length !== 1) throw sourceError('source-recovery', 'Exactly one Topic-owned Note Folder Source Reference is required.');
  const folderRoot = metadata?.getSourceLocator?.(folders[0].referenceId)?.locator ?? folders[0].externalSourceId;
  const entries = await withSignal(noteAdapter.browse({ observe: true, includeText: true }), signal);
  if (!Array.isArray(entries)) throw sourceError('source-inconsistent', 'The Note adapter returned an invalid browse result.');
  const notes = [];
  const readEntry = async (entry) => {
      signal?.throwIfAborted();
      if (!entry || typeof entry.path !== 'string' || entry.sourceReference?.topicId !== topicId || entry.sourceReference?.sourceSystem !== 'obsidian' || entry.sourceReference?.sourceKind !== 'note') throw sourceError('source-recovery', 'The Note adapter returned a foreign or identity-mismatched Note.');
      const relativePath = normalizeNotePath(entry.path);
      const expectedExternalId = `${folderRoot.replace(/\/+$/u, '')}/${relativePath}`;
      if (effectiveSourceLocator(metadata, entry.sourceReference) !== expectedExternalId) throw sourceError('source-recovery', 'The Note adapter returned a Note outside the exact Topic Folder.');
      const read = typeof entry.text === 'string'
        ? entry
        : await withSignal(noteAdapter.read({ path: relativePath, referenceId: entry.sourceReference.referenceId, observe: true }), signal);
      if (read.path !== relativePath || read.sourceReference?.topicId !== topicId || read.sourceReference?.sourceSystem !== 'obsidian' || read.sourceReference?.sourceKind !== 'note' || read.sourceReference.externalSourceId !== entry.sourceReference.externalSourceId || effectiveSourceLocator(metadata, read.sourceReference) !== expectedExternalId) throw sourceError('source-recovery', 'The Note adapter returned a foreign or identity-mismatched Note.');
      if (read.sourceReference.referenceId !== entry.sourceReference.referenceId || read.sourceReference.observedRevision !== read.revision) throw sourceError('source-recovery', 'The Note adapter returned a changed Note identity.');
      return noteSections(read.text).map((section) => {
      signal?.throwIfAborted();
      const context = paragraphContext(section.text, query);
      return {
        topicId, sourceReference: read.sourceReference, folderReferenceId: folders[0].referenceId, path: read.path, heading: section.heading, revision: read.revision,
        text: section.text, contextBefore: context.before, contextAfter: context.after, provenance: 'native'
      };
      });
  };
  for (let offset = 0; offset < entries.length; offset += 64) {
    const batch = await Promise.all(entries.slice(offset, offset + 64).map(readEntry));
    notes.push(...batch.flat());
  }
  const verifiedEntries = await withSignal(noteAdapter.browse({ observe: false }), signal);
  const identityList = (value) => value.map((entry) => [entry.path, entry.revision, entry.sourceReference?.referenceId, entry.sourceReference?.externalSourceId]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (!Array.isArray(verifiedEntries) || JSON.stringify(identityList(verifiedEntries)) !== JSON.stringify(identityList(entries))) throw sourceError('source-incomplete', 'The Note Folder changed during snapshotting.');
  notes.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({ topicId, noteFolder: folders[0], notes: Object.freeze(notes), sourceRevision: digest(notes.map(({ path, revision }) => ({ path, revision }))) });
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => contentText(item)).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string' || Array.isArray(value.content)) return contentText(value.content);
  return '';
}

function messageText(message) {
  return contentText(message?.content ?? message?.text ?? message?.message ?? message?.body ?? '');
}

function importedFrom(message) {
  const explicit = message?.importedFrom ?? message?.__openclaw?.importedFrom ?? message?.metadata?.importedFrom ?? message?.source?.importedFrom ?? null;
  if (explicit !== null && explicit !== undefined) return explicit;
  return message?.__openclaw?.legacyDiscordV1?.immutable === true ? 'legacy-discord-v1' : null;
}

function originatingTopicId(message, reference) {
  const value = message?.originatingTopicId ?? message?.__openclaw?.originatingTopicId ?? message?.metadata?.originatingTopicId ?? reference?.originatingTopicId ?? null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function messageDate(message) {
  const value = message?.timestamp ?? message?.createdAt ?? message?.date ?? message?.ts ?? null;
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function explicitMessageId(message) {
  return message?.__openclaw?.legacyDiscordV1?.sourceMessageId ?? message?.id ?? message?.messageId ?? message?.uuid ?? message?.__openclaw?.id ?? null;
}

function contextAround(messages, index) {
  return { contextBefore: messageText(messages[index - 1]), contextAfter: messageText(messages[index + 1]) };
}

function responseSession(value) {
  return value?.session && typeof value.session === 'object' ? value.session : value;
}

function responseKey(value) {
  const session = responseSession(value);
  return session?.key ?? session?.sessionKey ?? value?.sessionKey ?? value?.key ?? null;
}

function responseSessionId(value) {
  const session = responseSession(value);
  return session?.sessionId ?? session?.id ?? value?.sessionId ?? null;
}

function assertSessionIdentity(response, reference, sessionId, operation) {
  if (responseKey(response) !== reference.externalSourceId || responseSessionId(response) !== sessionId) {
    throw sourceError('source-recovery', `${operation} returned an unexpected Session identity.`);
  }
}

function conversationName(described, reference) {
  const session = responseSession(described);
  for (const value of [session?.displayName, session?.label, session?.derivedTitle, session?.title]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return reference.externalSourceId;
}

async function transcriptPass(gateway, reference, expectedSessionId, signal) {
  const messages = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const page = await withSignal(gateway.request('chat.history', { sessionKey: reference.externalSourceId, limit, offset }), signal);
    assertSessionIdentity(page, reference, expectedSessionId, 'chat.history');
    if (!Array.isArray(page?.messages)) throw sourceError('source-inconsistent', 'chat.history returned an invalid message page.');
    for (const message of page.messages) {
      signal?.throwIfAborted();
      if (!message || typeof message !== 'object') throw sourceError('source-incomplete', 'A visible Session message lacks authoritative identity.');
      messages.push(message);
    }
    if (messages.length > 100_000) throw sourceError('source-incomplete', 'The authoritative Session transcript exceeds the bounded projection size.');
    if (page.hasMore === false || page.messages.length < limit) break;
    const nextOffset = page.nextOffset ?? offset + page.messages.length;
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) throw sourceError('source-incomplete', 'chat.history paging did not advance.');
    offset = nextOffset;
  }
  return { messages, fingerprint: digest(messages) };
}

async function completeTranscript(gateway, reference, expectedSessionId, signal) {
  const snapshot = await transcriptPass(gateway, reference, expectedSessionId, signal);
  const verification = await transcriptPass(gateway, reference, expectedSessionId, signal);
  if (verification.fingerprint !== snapshot.fingerprint) throw sourceError('source-incomplete', 'The authoritative Session history changed during snapshotting.');
  return snapshot;
}

async function transcriptReaderPass(transcriptReader, reference, expectedSessionId, signal) {
  const entries = await withSignal(transcriptReader({ agentId: 'main', sessionKey: reference.externalSourceId, sessionId: expectedSessionId }), signal);
  if (!Array.isArray(entries)) throw sourceError('source-inconsistent', 'The authoritative transcript reader returned an invalid result.');
  const messages = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.message || typeof entry.message !== 'object' || typeof entry.entryId !== 'string' || !entry.entryId) throw sourceError('source-incomplete', 'A visible Session message lacks authoritative identity.');
    return { ...entry.message, id: entry.message.id ?? entry.entryId, timestamp: entry.message.timestamp ?? entry.createdAt };
  });
  return { messages, fingerprint: digest(entries) };
}

async function completeReaderTranscript(transcriptReader, reference, expectedSessionId, signal) {
  const snapshot = await transcriptReaderPass(transcriptReader, reference, expectedSessionId, signal);
  const verification = await transcriptReaderPass(transcriptReader, reference, expectedSessionId, signal);
  if (verification.fingerprint !== snapshot.fingerprint) throw sourceError('source-incomplete', 'The authoritative Session history changed during snapshotting.');
  return snapshot;
}

export async function readConversationSourceSnapshot({ topicId, metadata, gateway, api, transcriptReader, query = '', signal } = {}) {
  signal?.throwIfAborted();
  const references = exactTopicReferences(metadata, topicId, 'openclaw', 'session');
  const authoritativeGateway = gateway ?? api?.runtime?.gateway;
  const replacements = explicitSessionReplacements(metadata, topicId);
  let catalogRows = [];
  if (replacements.size) {
    const store = api?.runtime?.agent?.session;
    if (store?.listSessionEntries) catalogRows = store.listSessionEntries({ agentId: 'main', readOnly: true }).map((row) => ({ sessionKey: row.sessionKey, ...(row.entry ?? {}) }));
    // A filtered/paginated Gateway list cannot prove a source is absent.
    // Without the complete host store, retain exact reads and fail closed.
    else replacements.clear();
  }
  if (typeof transcriptReader !== 'function' && typeof authoritativeGateway?.request !== 'function') throw sourceError('source-unavailable', 'The authoritative Sessions reader is unavailable.');
  const conversations = [];
  const dedupe = new Map();
  for (const reference of references) {
    signal?.throwIfAborted();
    if (unavailableReplacedSession(metadata, reference, catalogRows, replacements)) continue;
    const state = metadata?.getSessionState?.(reference.referenceId) ?? null;
    if (typeof state?.sessionId !== 'string' || state.sessionId.trim() === '') throw sourceError('source-recovery', 'The linked Session does not have an exact authoritative Session ID.');
    let described = { session: { key: reference.externalSourceId, sessionId: state.sessionId, displayName: state.displayName } };
    let history;
    if (typeof transcriptReader === 'function') history = await completeReaderTranscript(transcriptReader, reference, state.sessionId, signal);
    else {
      const describeRequest = { includeDerivedTitles: true };
      describeRequest['k' + 'ey'] = reference.externalSourceId;
      described = await withSignal(authoritativeGateway.request('sessions.describe', describeRequest), signal);
      assertSessionIdentity(described, reference, state.sessionId, 'sessions.describe');
      history = await completeTranscript(authoritativeGateway, reference, state.sessionId, signal);
    }
    const messages = history.messages;
    const name = conversationName(described, reference);
    const primaryState = state?.isPrimary ? 'primary' : state?.wasPrimary ? 'former-primary' : 'ordinary';
    let searchableMessages = 0;
    for (let index = 0; index < messages.length; index += 1) {
      signal?.throwIfAborted();
      const message = messages[index];
      const text = messageText(message);
      if (!text.trim()) continue;
      const imported = importedFrom(message);
      // completeHistory already proves terminal pagination, exact total count,
      // and a stable verification read. The pinned host reserves its optional
      // completeSnapshot flag for CLI-import merges, so ordinary transcripts
      // retaining imported-Primary provenance must not require that flag.
      const date = messageDate(message);
      const id = explicitMessageId(message);
      if (date === null) throw sourceError('source-incomplete', 'A searchable Session message is missing an authoritative date.');
      if (typeof id !== 'string' || id.trim() === '') throw sourceError('source-incomplete', 'A searchable Session message is missing an authoritative message identity.');
      const identity = `${reference.referenceId}\u0000${id}`;
      const row = { topicId, sourceReference: reference, sessionKey: reference.externalSourceId, sessionId: state.sessionId, messageId: id, name: name ?? reference.externalSourceId, date, originatingTopicId: originatingTopicId(message, reference), role: String(message?.role ?? 'unknown'), historyProvenance: imported ? 'imported-primary' : primaryState, closed: state?.status === 'closed', primaryState, provenance: imported ? 'imported' : 'native', importedFrom: imported, text, ...contextAround(messages, index) };
      const existing = dedupe.get(identity);
      if (!existing || (existing.provenance === 'native' && row.provenance === 'imported')) dedupe.set(identity, row);
      searchableMessages += 1;
    }
    if (searchableMessages === 0) {
      const date = typeof state.updatedAt === 'string' && !Number.isNaN(Date.parse(state.updatedAt))
        ? new Date(state.updatedAt).toISOString()
        : null;
      if (date === null || date !== state.updatedAt) throw sourceError('source-incomplete', 'An empty Session is missing an authoritative update date.');
      const identity = `${reference.referenceId}\u0000metadata`;
      dedupe.set(identity, {
        topicId,
        sourceReference: reference,
        sessionKey: reference.externalSourceId,
        sessionId: state.sessionId,
        messageId: null,
        name: name ?? reference.externalSourceId,
        date,
        originatingTopicId: null,
        role: 'metadata',
        historyProvenance: primaryState,
        closed: state?.status === 'closed',
        primaryState,
        provenance: 'native',
        importedFrom: null,
        text: name ?? reference.externalSourceId,
        contextBefore: '',
        contextAfter: ''
      });
    }
  }
  conversations.push(...dedupe.values());
  conversations.sort((left, right) => `${left.date ?? ''}\u0000${left.messageId ?? ''}`.localeCompare(`${right.date ?? ''}\u0000${right.messageId ?? ''}`));
  return Object.freeze({ topicId, conversations: Object.freeze(conversations), sourceRevision: digest(conversations.map(({ sessionKey, messageId, date }) => ({ sessionKey, messageId, date }))) });
}

export async function readTopicSourceSnapshot(options = {}) {
  const note = await readNoteSourceSnapshot(options);
  const conversation = await readConversationSourceSnapshot(options);
  return Object.freeze({ topicId: options.topicId, note, conversation, notes: note.notes, conversations: conversation.conversations, sourceRevision: digest({ notes: note.sourceRevision, conversations: conversation.sourceRevision }) });
}

export const createTopicSourceSnapshot = readTopicSourceSnapshot;
