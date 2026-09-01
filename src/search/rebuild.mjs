import { openProjectionStore, SEARCH_PROJECTION_VERSIONS, withGroupedProjectionPublication } from './projection-store.mjs';
import { hasTopicSearchInvalidationMarker } from './freshness.mjs';
import { readTopicSourceSnapshot } from './source-snapshot.mjs';
import { sourceError } from '../sources/errors.mjs';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCommandCenterProjectionRoot } from '../metadata/path.mjs';

function topicIds(metadata, requested) {
  const topics = requested === undefined
    ? (metadata?.listUsableTopics?.() ?? metadata?.listTopics?.()?.filter((topic) => topic.lifecycle === 'active'))
    : metadata?.listTopics?.();
  if (Array.isArray(topics)) {
    const ids = topics.map((topic) => topic.topicId).sort((left, right) => left.localeCompare(right));
    if (requested !== undefined) {
      if (!ids.includes(String(requested))) throw sourceError('source-recovery', 'The requested Topic does not exist.');
      const topic = topics.find((item) => item.topicId === String(requested));
      if (topic?.lifecycle !== undefined && topic.lifecycle !== 'active') throw sourceError('source-recovery', 'The requested Topic is not available for Topic Search.');
      return [String(requested)];
    }
    return ids;
  }
  if (requested !== undefined) return [String(requested)];
  throw sourceError('source-recovery', 'Topic ownership metadata is unavailable.');
}

export async function prepareTopicSearchSnapshot({ metadata, noteAdapterFactory, noteAdapter, api, gateway, topicId, authoritativeSources, sourceSnapshotFactory = readTopicSourceSnapshot, onProgress, signal } = {}) {
  const topics = topicIds(metadata, topicId);
  const notes = [];
  const conversations = [];
  const noteRevisions = [];
  const conversationRevisions = [];
  let completed = 0;
  const suppliedFactory = authoritativeSources && (authoritativeSources.readTopicSnapshot || authoritativeSources.readTopic)
    ? async (input) => authoritativeSources.readTopicSnapshot?.(input) ?? authoritativeSources.readTopic(input)
    : sourceSnapshotFactory;
  for (const id of topics) {
    signal?.throwIfAborted();
    const snapshot = await suppliedFactory({
      topicId: id, metadata, api, gateway,
      noteAdapter: noteAdapterFactory ? await noteAdapterFactory(id) : noteAdapter,
      signal,
    });
    signal?.throwIfAborted();
    notes.push(...(snapshot.notes ?? snapshot.note?.notes ?? []));
    conversations.push(...(snapshot.conversations ?? snapshot.conversation?.conversations ?? []));
    noteRevisions.push([id, snapshot.note?.sourceRevision ?? snapshot.sourceRevision ?? null]);
    conversationRevisions.push([id, snapshot.conversation?.sourceRevision ?? snapshot.sourceRevision ?? null]);
    completed += 1;
    onProgress?.({ phase: 'snapshot', completed, total: topics.length });
  }
  const sourceDigest = (revisions) => `sha256:${createHash('sha256').update(JSON.stringify(revisions)).digest('hex')}`;
  const noteSourceRevision = sourceDigest({ projection: 'notes', revisions: noteRevisions });
  const conversationSourceRevision = sourceDigest({ projection: 'conversations', revisions: conversationRevisions });
  const sourceRevision = sourceDigest({ notes: noteSourceRevision, conversations: conversationSourceRevision });
  return Object.freeze({ topicId: topicId ?? null, topicIds: Object.freeze(topics), notes: Object.freeze(notes), conversations: Object.freeze(conversations), noteSourceRevision, conversationSourceRevision, sourceRevision });
}

export async function publishTopicSearchSnapshot({ stateDir, prepared, metadata, signal } = {}) {
  signal?.throwIfAborted();
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new TypeError('stateDir must be a non-empty string');
  if (!prepared || !Array.isArray(prepared.topicIds) || !Array.isArray(prepared.notes) || !Array.isArray(prepared.conversations) || typeof prepared.noteSourceRevision !== 'string' || typeof prepared.conversationSourceRevision !== 'string') throw sourceError('source-incomplete', 'A complete prepared Topic Search snapshot is required.');
  const noteStore = await openProjectionStore({ stateDir, kind: 'note' });
  const conversationStore = await openProjectionStore({ stateDir, kind: 'conversation' });
  // An empty authoritative workspace is still a complete snapshot. Publish
  // both empty generations so startup never confuses "no Topics" with a lost
  // or partially created projection.
  return withGroupedProjectionPublication({ stateDir }, async (_groupLease) => {
    const notesResult = await noteStore.rebuild({ topicId: prepared.topicId, topicIds: prepared.topicIds, rows: prepared.notes, sourceRevision: prepared.noteSourceRevision, _groupLease, signal });
    signal?.throwIfAborted();
    const conversationsResult = await conversationStore.rebuild({ topicId: prepared.topicId, topicIds: prepared.topicIds, rows: prepared.conversations, sourceRevision: prepared.conversationSourceRevision, _groupLease, signal });
    signal?.throwIfAborted();
    metadata?.setProjectionBookkeepingBatch?.([notesResult, conversationsResult].map((projection) => ({
      projectionId: projection.projectionId,
      sourceRevision: projection.sourceRevision,
      inputDigest: projection.inputDigest
    })));
    return Object.freeze({ notes: notesResult, conversations: conversationsResult, topicIds: prepared.topicIds });
  });
}

export async function reconcileTopicSearchBookkeeping({ stateDir, metadata } = {}) {
  if (!metadata?.setProjectionBookkeepingBatch) return false;
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new TypeError('stateDir must be a non-empty string');
  if (hasTopicSearchInvalidationMarker(stateDir)) return false;
  const checkpoints = Object.values(SEARCH_PROJECTION_VERSIONS).map(({ projectionId }) => metadata.getProjectionBookkeeping?.(projectionId)).filter(Boolean);
  if (checkpoints.some(({ sourceRevision, inputDigest }) => sourceRevision === 'invalidated' || inputDigest === 'invalidated')) return false;
  const existingRoot = path.join(path.resolve(stateDir), 'plugins', 'command-center', 'projections');
  try {
    const stat = lstatSync(existingRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw sourceError('projection-unavailable', 'Topic Search projection root is unsafe.');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const notes = await openProjectionStore({ stateDir, kind: 'note' });
  const conversations = await openProjectionStore({ stateDir, kind: 'conversation' });
  const manifests = [notes.manifest(), conversations.manifest()];
  if (manifests.every((manifest) => manifest === null)) return false;
  if (manifests.some((manifest) => manifest === null)) return false;
  metadata.setProjectionBookkeepingBatch(manifests.map((manifest) => ({ projectionId: manifest.projectionId, sourceRevision: manifest.sourceRevision, inputDigest: manifest.inputDigest })));
  return true;
}

export async function rebuildTopicSearchProjections(options = {}) {
  const prepared = await prepareTopicSearchSnapshot(options);
  options.signal?.throwIfAborted();
  return publishTopicSearchSnapshot({ stateDir: options.stateDir, prepared, metadata: options.metadata, signal: options.signal });
}

export const rebuildSearchProjections = rebuildTopicSearchProjections;

function rebuildIntentDigest(topicId) {
  return `sha256:${createHash('sha256').update(JSON.stringify({ action: 'topic-search.rebuild', topicId })).digest('hex')}`;
}

function receiptPath(stateDir, operationId) {
  return path.join(resolveCommandCenterProjectionRoot(stateDir), `rebuild-operation-${operationId}.json`);
}

function readReceipt(stateDir, operationId) {
  const file = receiptPath(stateDir, operationId);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw sourceError('projection-unavailable', 'A rebuild operation receipt is unsafe.');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.schemaVersion !== 1 || value.logicalOperationId !== operationId || !['pending', 'applied'].includes(value.state) || typeof value.topicId !== 'string' || typeof value.intentDigest !== 'string') throw sourceError('projection-unavailable', 'A rebuild operation receipt is incompatible.');
    if (value.state === 'applied' && (!value.result || !Array.isArray(value.result.topicIds))) throw sourceError('projection-unavailable', 'A committed rebuild receipt is incomplete.');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeReceipt(stateDir, value) {
  const target = receiptPath(stateDir, value.logicalOperationId);
  const temporary = `${target}.writing-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

const MAX_DURABLE_REBUILD_RECEIPTS = 8;

function reserveReceiptSlot(stateDir) {
  const root = resolveCommandCenterProjectionRoot(stateDir);
  const names = readdirSync(root).filter((name) => /^rebuild-operation-[0-9a-f-]{36}\.json$/u.test(name));
  const receipts = names.map((name) => {
    const operationId = name.slice('rebuild-operation-'.length, -'.json'.length);
    return { name, value: readReceipt(stateDir, operationId) };
  });
  const completed = receipts
    .filter(({ value }) => value.state === 'applied')
    .sort((left, right) => String(left.value.updatedAt).localeCompare(String(right.value.updatedAt)) || left.name.localeCompare(right.name));
  while (receipts.length >= MAX_DURABLE_REBUILD_RECEIPTS && completed.length > 0) {
    const expired = completed.shift();
    unlinkSync(path.join(root, expired.name));
    receipts.splice(receipts.indexOf(expired), 1);
  }
  if (receipts.length >= MAX_DURABLE_REBUILD_RECEIPTS) throw sourceError('source-unavailable', 'Too many durable rebuild operations are pending.');
}

export function createSearchRebuildService(options = {}) {
  const operations = new Map();
  const preparedTtlMs = 30_000;
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const prune = () => {
    const now = clock();
    for (const [id, operation] of operations) if (['applied', 'prepared'].includes(operation.status) && operation.expiresAt < now) operations.delete(id);
  };
  return Object.freeze({
    rebuild: (input = {}) => rebuildTopicSearchProjections({ ...options, ...input }),
    rebuildTopic: (topicId) => rebuildTopicSearchProjections({ ...options, topicId }),
    async prepareAuthorized({ topicId, logicalOperationId, gateway } = {}) {
      if (typeof topicId !== 'string' || !topicId.trim()) throw sourceError('invalid-request', 'One exact Topic ID is required for authenticated rebuild preparation.');
      const operationId = assertLogicalOperationId(logicalOperationId);
      const intentDigest = rebuildIntentDigest(topicId);
      topicIds(options.metadata, topicId);
      prune();
      const receipt = readReceipt(options.stateDir, operationId);
      if (receipt) {
        if (receipt.intentDigest !== intentDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused for another Topic rebuild.');
        if (receipt.state === 'applied') return Object.freeze({ schemaVersion: 1, status: 'committed', topicIds: receipt.result.topicIds });
      }
      const existing = operations.get(operationId);
      if (existing) {
        if (existing.intentDigest !== intentDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused for another Topic rebuild.');
        await existing.promise;
        return Object.freeze({ schemaVersion: 1, status: existing.status === 'applied' ? 'committed' : 'prepared', topicIds: existing.prepared?.topicIds ?? existing.result?.topicIds ?? [topicId] });
      }
      if (!existing && operations.size >= 8) throw sourceError('source-unavailable', 'Too many authenticated rebuild operations are active.');
      const operation = { topicId, intentDigest, status: 'preparing', expiresAt: Number.POSITIVE_INFINITY, prepared: null, result: null, promise: null };
      // The requested Topic remains the authorization and idempotency intent,
      // while publication snapshots every active Topic so a rebuild can never
      // narrow the globally committed projection set.
      operation.promise = prepareTopicSearchSnapshot({ ...options, topicId: undefined, gateway }).then((prepared) => {
        operation.prepared = prepared;
        operation.status = 'prepared';
        operation.expiresAt = clock() + preparedTtlMs;
        return prepared;
      }).catch((error) => {
        operations.delete(operationId);
        throw error;
      });
      operations.set(operationId, operation);
      const prepared = await operation.promise;
      return Object.freeze({ schemaVersion: 1, status: 'prepared', topicIds: prepared.topicIds });
    },
    async rebuildPrepared({ topicId, logicalOperationId } = {}) {
      if (typeof topicId !== 'string' || !topicId.trim()) throw sourceError('invalid-request', 'One exact Topic ID is required for HTTP rebuild.');
      const operationId = assertLogicalOperationId(logicalOperationId);
      const intentDigest = rebuildIntentDigest(topicId);
      prune();
      const existing = operations.get(operationId);
      if (existing) {
        if (existing.intentDigest !== intentDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused for another Topic rebuild.');
        await existing.promise;
        if (existing.status === 'applied' || existing.status === 'committing') return existing.promise;
      }
      const receipt = readReceipt(options.stateDir, operationId);
      if (receipt) {
        if (receipt.intentDigest !== intentDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused for another Topic rebuild.');
        if (receipt.state === 'applied') return receipt.result;
      }
      if (options.requireAuthorizedPreparation === true && existing?.status !== 'prepared') throw sourceError('source-unavailable', 'An authenticated source snapshot must be prepared before rebuilding.');
      if (!existing && operations.size >= 8) throw sourceError('source-unavailable', 'Too many authenticated rebuild operations are active.');
      const createdAt = receipt?.createdAt ?? new Date(clock()).toISOString();
      if (!receipt) {
        reserveReceiptSlot(options.stateDir);
        writeReceipt(options.stateDir, { schemaVersion: 1, logicalOperationId: operationId, topicId, intentDigest, state: 'pending', createdAt, updatedAt: createdAt });
      }
      const operation = existing ?? { topicId, intentDigest, status: 'prepared', expiresAt: Number.POSITIVE_INFINITY, prepared: null, result: null, promise: null };
      operation.status = 'committing';
      operation.promise = (operation.prepared
        ? publishTopicSearchSnapshot({ stateDir: options.stateDir, prepared: operation.prepared, metadata: options.metadata })
        : rebuildTopicSearchProjections({ ...options, topicId })).then((result) => {
        operation.result = result;
        operation.status = 'applied';
        operation.expiresAt = clock() + preparedTtlMs;
        writeReceipt(options.stateDir, { schemaVersion: 1, logicalOperationId: operationId, topicId, intentDigest, state: 'applied', result, createdAt, updatedAt: new Date(clock()).toISOString() });
        return result;
      }).catch((error) => {
        operations.delete(operationId);
        try { unlinkSync(receiptPath(options.stateDir, operationId)); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
        throw error;
      });
      operations.set(operationId, operation);
      return operation.promise;
    },
    async delete({ kind } = {}) {
      if (kind !== undefined && !['note', 'notes', 'conversation', 'conversations'].includes(kind)) throw sourceError('invalid-request', 'projection kind must be note or conversation.');
      const note = await openProjectionStore({ stateDir: options.stateDir, kind: 'note' });
      const conversation = await openProjectionStore({ stateDir: options.stateDir, kind: 'conversation' });
      return Object.freeze({ notes: kind === undefined || kind === 'note' || kind === 'notes' ? note.delete() : false, conversations: kind === undefined || kind === 'conversation' || kind === 'conversations' ? conversation.delete() : false });
    }
  });
}
