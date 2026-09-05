import { openProjectionStore, SEARCH_PROJECTION_VERSIONS } from './projection-store.mjs';
import { validateSearchRequest } from './query.mjs';
import { sourceError } from '../sources/errors.mjs';
import { effectiveSourceLocator } from '../sources/reference.mjs';
import { clearTopicSearchInvalidationMarker, hasTopicSearchInvalidationMarker, markTopicSearchInvalidated } from './freshness.mjs';

function exactReference(metadata, topicId, referenceId) {
  const reference = metadata?.getSourceReference?.(referenceId);
  if (!reference || reference.topicId !== topicId) throw sourceError('cross-topic', 'The result Source Reference is not owned by the requested Topic.');
  return reference;
}

function assertDescriptorReference(descriptorReference, reference) {
  if (!descriptorReference) return;
  for (const field of ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision']) {
    if (descriptorReference[field] !== undefined && descriptorReference[field] !== reference[field]) throw sourceError('source-recovery', 'The navigation Source Reference is stale or foreign.');
  }
}

function currentScope(metadata, topicId) {
  const references = metadata?.listSourceReferences?.(topicId);
  if (!Array.isArray(references) || references.some((reference) => reference?.topicId !== topicId)) return null;
  const folders = references.filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
  return folders.length === 1 ? { folder: folders[0] } : null;
}

function topicIdentity(metadata, topicId) {
  const topic = metadata?.getTopic?.(topicId);
  if (!topic) throw sourceError('source-recovery', 'The requested Topic does not exist.');
  const label = metadata?.getPresentationPreferences?.(topicId)?.displayLabel;
  return Object.freeze({
    topicId,
    displayLabel: typeof label === 'string' && label.trim() ? label : topicId,
    paraCategory: topic.paraCategory
  });
}

function exactSourceReference(reference, { omitExternalId = false } = {}) {
  return Object.freeze({
    version: reference.version ?? 1,
    referenceId: reference.referenceId,
    topicId: reference.topicId,
    sourceSystem: reference.sourceSystem,
    sourceKind: reference.sourceKind,
    ...(omitExternalId ? {} : { externalSourceId: reference.externalSourceId }),
    observedRevision: reference.observedRevision ?? null,
    createdAt: reference.createdAt ?? null,
    updatedAt: reference.updatedAt ?? null
  });
}

function boundedUnit(value, max) {
  return Array.from(String(value ?? '')).slice(0, max).join('');
}

function authoritativeNoteSections(text) {
  const sections = [];
  let heading = null;
  let content = [];
  const publish = () => {
    const value = content.join('\n').trim();
    if (value) sections.push({ heading, text: value });
  };
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (match) { publish(); heading = match[1].trim() || null; content = [line]; }
    else content.push(line);
  }
  publish();
  return sections;
}

function exactHighlights(result, snippet) {
  return Object.freeze((Array.isArray(result.snippetHighlights) ? result.snippetHighlights : [])
    .filter(({ start, end } = {}) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= snippet.length)
    .map(({ start, end }) => Object.freeze({ start, end })));
}

function noteResult(result) {
  const sourceReference = exactSourceReference(result.sourceReference, { omitExternalId: true });
  const snippet = boundedUnit(result.snippet, 240);
  const remaining = 600 - Array.from(snippet).length;
  const contextBefore = boundedUnit(result.context?.before ?? result.contextBefore, Math.floor(remaining / 2));
  const contextAfter = boundedUnit(result.context?.after ?? result.contextAfter, remaining - Array.from(contextBefore).length);
  return Object.freeze({
    kind: 'note',
    topicId: result.topicId,
    sourceReference,
    path: result.path,
    heading: result.heading ?? null,
    snippet,
    highlights: exactHighlights(result, snippet),
    contextBefore,
    contextAfter,
    navigation: Object.freeze({
      kind: 'note',
      topicId: result.topicId,
      referenceId: sourceReference.referenceId,
      path: result.path,
      heading: result.heading ?? null,
      observedRevision: result.revision
    })
  });
}

function conversationResult(result) {
  if (result.messageId !== null && (typeof result.messageId !== 'string' || result.messageId.length === 0)) return null;
  const sourceReference = exactSourceReference(result.sourceReference);
  const snippet = boundedUnit(result.snippet, 240);
  const remaining = 600 - Array.from(snippet).length;
  const contextBefore = boundedUnit(result.context?.before ?? result.contextBefore, Math.floor(remaining / 2));
  const contextAfter = boundedUnit(result.context?.after ?? result.contextAfter, remaining - Array.from(contextBefore).length);
  return Object.freeze({
    kind: 'conversation',
    topicId: result.topicId,
    sourceReference,
    sessionKey: result.sessionKey,
    messageId: result.messageId,
    conversationName: result.name,
    date: result.date ?? null,
    originatingTopicId: result.originatingTopicId ?? null,
    snippet,
    highlights: exactHighlights(result, snippet),
    contextBefore,
    contextAfter,
    provenance: Object.freeze({
      role: result.primaryState === 'primary' ? 'primary' : result.primaryState === 'former-primary' ? 'former-primary' : 'topic-conversation',
      status: result.status,
      importedPrimaryHistory: result.provenance === 'imported'
    }),
    navigation: Object.freeze({
      kind: 'conversation',
      topicId: result.topicId,
      referenceId: sourceReference.referenceId,
      sessionKey: result.sessionKey,
      sessionId: result.sessionId ?? null,
      messageId: result.messageId
    })
  });
}

function isCurrentResult(metadata, topicId, scope, result) {
  try {
    if (!scope) return false;
    if (result.kind === 'note') {
      const reference = metadata?.getSourceReference?.(result.sourceReference?.referenceId ?? result.referenceId);
      if (!reference) return false;
      if (reference.topicId !== topicId || reference.referenceId !== result.sourceReference?.referenceId) return false;
      for (const field of ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision']) if (result.sourceReference?.[field] !== reference[field]) return false;
      const folder = exactReference(metadata, topicId, result.folderReferenceId);
      const folderRoot = metadata?.getSourceLocator?.(folder.referenceId)?.locator ?? folder.externalSourceId;
      const expectedExternalSourceId = `${folderRoot.replace(/\/+$/u, '')}/${result.path}`;
      return reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note'
        && effectiveSourceLocator(metadata, reference) === expectedExternalSourceId
        && folder.referenceId === scope.folder.referenceId
        && folder.externalSourceId === scope.folder.externalSourceId;
    }
    const reference = exactReference(metadata, topicId, result.sourceReference?.referenceId ?? result.referenceId);
    assertDescriptorReference(result.sourceReference, reference);
    if (result.kind !== 'conversation' || reference.sourceSystem !== 'openclaw' || reference.sourceKind !== 'session' || reference.externalSourceId !== result.sessionKey) return false;
    const state = metadata?.getSessionState?.(reference.referenceId) ?? null;
    if (typeof state?.sessionId !== 'string' || state.sessionId.length === 0 || result.sessionId !== state.sessionId) return false;
    const status = state?.status ?? 'open';
    const primaryState = state?.isPrimary ? 'primary' : state?.wasPrimary ? 'former-primary' : 'ordinary';
    return result.status === status && result.primaryState === primaryState;
  } catch {
    return false;
  }
}

export function createTopicSearchService({ stateDir, metadata, sourceService, noteStore, conversationStore, rebuild, preparedRebuild } = {}) {
  let notes = noteStore;
  let conversations = conversationStore;
  let rebuildQueue = Promise.resolve();
  let invalidated = hasTopicSearchInvalidationMarker(stateDir);
  let freshnessEpoch = invalidated ? 1 : 0;
  const stores = async () => {
    notes ??= await openProjectionStore({ stateDir, kind: 'note' });
    conversations ??= await openProjectionStore({ stateDir, kind: 'conversation' });
    return { notes, conversations };
  };
  const enqueueMaintenance = (run) => {
    const queued = rebuildQueue.then(run, run);
    rebuildQueue = queued.catch(() => {});
    return queued;
  };
  const hasCommittedProjectionSet = async () => {
    const opened = await stores();
    if (typeof metadata?.getProjectionBookkeeping !== 'function') return false;
    const projectionIds = new Set();
    for (const store of [opened.notes, opened.conversations]) {
      const manifest = store.manifest?.();
      if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.projectionId !== 'string' || typeof manifest.generation !== 'string' || !Array.isArray(manifest.topicIds)) return false;
      projectionIds.add(manifest.projectionId);
      const checkpoint = metadata.getProjectionBookkeeping(manifest.projectionId);
      if (!checkpoint || checkpoint.sourceRevision !== manifest.sourceRevision || checkpoint.inputDigest !== manifest.inputDigest) return false;
    }
    return projectionIds.size === 2 && Object.values(SEARCH_PROJECTION_VERSIONS).every(({ projectionId }) => projectionIds.has(projectionId));
  };
  const queueRebuildOperation = (runRebuild, input = {}) => {
    if (typeof runRebuild !== 'function') return Promise.reject(sourceError('capability-unavailable', 'Topic Search rebuild is unavailable.', { capability: 'search' }));
    const rebuildEpoch = freshnessEpoch;
    const run = async () => {
      const result = await runRebuild(input);
      if (rebuildEpoch !== freshnessEpoch) return result;
      if (!await hasCommittedProjectionSet()) {
        invalidated = true;
        try { markTopicSearchInvalidated(stateDir); } catch { /* Existing metadata denial remains authoritative. */ }
        throw sourceError('projection-unavailable', 'Topic Search rebuild did not commit both projections and bookkeeping.');
      }
      clearTopicSearchInvalidationMarker(stateDir);
      invalidated = false;
      return result;
    };
    return enqueueMaintenance(run);
  };
  const queueRebuild = (input = {}) => queueRebuildOperation(rebuild, input);
  const service = {
    rebuild: rebuild ? queueRebuild : undefined,
    rebuildPrepared: preparedRebuild ? (input = {}) => queueRebuildOperation(preparedRebuild, input) : undefined,
    async invalidate(input = {}) {
      freshnessEpoch += 1;
      invalidated = true;
      let markerWritten = false;
      let checkpointWritten = false;
      try { markerWritten = markTopicSearchInvalidated(stateDir); } catch { /* Metadata or physical deletion can provide the durable denial. */ }
      try {
        metadata?.setProjectionBookkeepingBatch?.(Object.values(SEARCH_PROJECTION_VERSIONS).map(({ projectionId }) => ({
          projectionId,
          sourceRevision: 'invalidated',
          inputDigest: 'invalidated'
        })));
        checkpointWritten = typeof metadata?.setProjectionBookkeepingBatch === 'function';
      } catch { /* The independent marker and artifact deletion are still attempted. */ }
      if (input?.preserveCommittedProjection === true && (markerWritten || checkpointWritten)) {
        return Object.freeze({ notes: false, conversations: false });
      }
      const disposal = enqueueMaintenance(async () => {
        let opened;
        try { opened = await stores(); }
        catch {
          if (!markerWritten && !checkpointWritten) throw sourceError('projection-unavailable', 'Topic Search invalidation could not be persisted.');
          return Object.freeze({ notes: false, conversations: false });
        }
        const discard = (store) => {
          try { return store.delete(); }
          catch { return false; }
        };
        const result = Object.freeze({ notes: discard(opened.notes), conversations: discard(opened.conversations) });
        if (!markerWritten && !checkpointWritten && (!result.notes || !result.conversations)) throw sourceError('projection-unavailable', 'Topic Search invalidation could not be persisted.');
        return result;
      });
      if (markerWritten || checkpointWritten) {
        // The marker/checkpoints already deny every stale read. Artifact
        // disposal retains queue order, but authoritative mutations must not
        // inherit the latency of an older global rebuild.
        void disposal.catch(() => {});
        return Object.freeze({ notes: false, conversations: false });
      }
      return disposal;
    },
    async query(input = {}) {
      const request = validateSearchRequest(input);
      topicIdentity(metadata, request.topicId);
      if (invalidated || hasTopicSearchInvalidationMarker(stateDir)) throw sourceError('capability-unavailable', 'Topic Search projections are unavailable.', { capability: 'search' });
      const opened = await stores();
      let noteResults;
      let conversationResults;
      try {
        if (typeof metadata?.getProjectionBookkeeping === 'function') {
          for (const store of [opened.notes, opened.conversations]) {
            const manifest = store.manifest();
            const checkpoint = manifest && metadata.getProjectionBookkeeping(manifest.projectionId);
            if (!manifest || !checkpoint || checkpoint.sourceRevision !== manifest.sourceRevision || checkpoint.inputDigest !== manifest.inputDigest) throw sourceError('projection-unavailable', 'Projection metadata does not match the committed Topic Search generation.');
          }
        }
        if ((typeof opened.notes.hasTopic === 'function' && !opened.notes.hasTopic(request.topicId)) || (typeof opened.conversations.hasTopic === 'function' && !opened.conversations.hasTopic(request.topicId))) throw sourceError('projection-unavailable', 'The requested Topic is not covered by the committed projections.');
        const storeRequest = { schemaVersion: 1, topicId: request.topicId, query: request.query, limit: request.limit };
        const scope = currentScope(metadata, request.topicId);
        const queryNotes = typeof opened.notes.queryWithOverflow === 'function' ? opened.notes.queryWithOverflow(storeRequest) : opened.notes.query(storeRequest);
        const queryConversations = typeof opened.conversations.queryWithOverflow === 'function' ? opened.conversations.queryWithOverflow(storeRequest) : opened.conversations.query(storeRequest);
        noteResults = queryNotes.filter((result) => isCurrentResult(metadata, request.topicId, scope, result));
        conversationResults = queryConversations.filter((result) => isCurrentResult(metadata, request.topicId, scope, result));
      } catch (error) {
        if (error?.code === 'projection-unavailable' || error?.code === 'ENOENT') throw sourceError('capability-unavailable', 'Topic Search projections are unavailable.', { capability: 'search' });
        throw error;
      }
      const notesGroup = Object.freeze(noteResults.slice(0, request.limit).map(noteResult));
      const conversationsGroup = Object.freeze(conversationResults.slice(0, request.limit).map(conversationResult).filter(Boolean));
      return Object.freeze({
        schemaVersion: 1,
        topicId: request.topicId,
        query: request.query,
        notes: Object.freeze({ results: notesGroup }),
        conversations: Object.freeze({ results: conversationsGroup })
      });
    },
    async projectionVersions() {
      const opened = await stores();
      const version = (store) => {
        const manifest = store.manifest?.();
        if (!manifest || typeof manifest.projectionId !== 'string' || manifest.schemaVersion !== 1) throw sourceError('capability-unavailable', 'Topic Search projections are unavailable.', { capability: 'search' });
        return Object.freeze({ projectionId: manifest.projectionId, formatVersion: manifest.schemaVersion });
      };
      return Object.freeze({ notes: version(opened.notes), conversations: version(opened.conversations) });
    },
    async navigate(descriptor = {}, navigationOptions = {}) {
      const navigationSourceService = navigationOptions.sourceService ?? sourceService;
      if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw sourceError('invalid-request', 'A navigation descriptor is required.');
      const topicId = String(descriptor.topicId ?? '').trim();
      if (!topicId) throw sourceError('invalid-request', 'Navigation requires topicId.');
      if (descriptor.kind === 'note') {
        for (const key of Object.keys(descriptor)) if (!['kind', 'topicId', 'referenceId', 'path', 'heading', 'observedRevision'].includes(key)) throw sourceError('invalid-request', 'Note navigation contains unsupported fields.');
        const reference = metadata?.getSourceReference?.(descriptor.referenceId);
        if (!reference) throw sourceError('source-recovery', 'The Note navigation Source Reference is missing.');
        if (reference.topicId !== topicId || reference.referenceId !== descriptor.referenceId) throw sourceError('cross-topic', 'The Note navigation Source Reference is invalid.');
        if (reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note') throw sourceError('cross-topic', 'The Note navigation Source Reference is invalid.');
        if (typeof descriptor.path !== 'string' || descriptor.path.trim() === '') throw sourceError('invalid-request', 'Note navigation requires path.');
        if (descriptor.heading !== null && typeof descriptor.heading !== 'string') throw sourceError('invalid-request', 'Note navigation heading is invalid.');
        const opened = await stores();
        const target = opened.notes.resolveNoteTarget?.(descriptor);
        if (!target) throw sourceError('source-recovery', 'The Note navigation target is stale or was not produced by the committed projection.');
        if (!navigationSourceService?.notesRead) throw sourceError('capability-unavailable', 'Authoritative Note navigation is unavailable.', { capability: 'notes' });
        const note = await navigationSourceService.notesRead({ schemaVersion: 1, topicId, path: descriptor.path, referenceId: reference.referenceId, observedRevision: descriptor.observedRevision });
        const sectionMatches = authoritativeNoteSections(note?.text).some((section) => section.heading === target.heading && section.text === target.text);
        if (note?.path !== descriptor.path || note?.sourceReference?.topicId !== topicId || note?.sourceReference?.referenceId !== reference.referenceId || note?.sourceReference?.externalSourceId !== reference.externalSourceId || note?.revision !== descriptor.observedRevision || !sectionMatches) throw sourceError('source-recovery', 'Authoritative Note navigation did not preserve the exact result identity.');
        return Object.freeze({ ...note, heading: descriptor.heading });
      }
      if (descriptor.kind === 'conversation') {
        for (const key of Object.keys(descriptor)) if (!['kind', 'topicId', 'referenceId', 'sessionKey', 'sessionId', 'messageId'].includes(key)) throw sourceError('invalid-request', 'Conversation navigation contains unsupported fields.');
        const reference = exactReference(metadata, topicId, descriptor.referenceId);
        if (reference.sourceSystem !== 'openclaw' || reference.sourceKind !== 'session') throw sourceError('cross-topic', 'The Conversation navigation Source Reference is invalid.');
        if (descriptor.sessionKey !== reference.externalSourceId) throw sourceError('source-recovery', 'The Conversation navigation Session key is stale or foreign.');
        const state = metadata?.getSessionState?.(reference.referenceId);
        if (typeof descriptor.sessionId !== 'string' || !descriptor.sessionId || descriptor.sessionId !== state?.sessionId) throw sourceError('source-recovery', 'The Conversation navigation Session ID is stale or foreign.');
        if (!navigationSourceService?.sessionsNavigate) throw sourceError('capability-unavailable', 'Authoritative Conversation navigation is unavailable.', { capability: 'sessions' });
        const navigation = await navigationSourceService.sessionsNavigate({ schemaVersion: 1, topicId, referenceId: reference.referenceId });
        if (navigation?.sourceReference?.referenceId !== reference.referenceId || navigation?.sessionKey !== reference.externalSourceId || navigation?.sessionId !== descriptor.sessionId) throw sourceError('source-recovery', 'Authoritative Conversation navigation did not preserve the exact linked Session.');
        return Object.freeze({ navigation });
      }
      throw sourceError('invalid-request', 'Unsupported navigation descriptor.');
    }
  };
  return Object.freeze(service);
}

export const createSearchService = createTopicSearchService;
