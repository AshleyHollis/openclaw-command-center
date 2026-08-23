import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NoteAdapter } from '../src/sources/notes.mjs';
import { createMutationCoordinator } from '../src/sources/mutation-coordinator.mjs';
import { createNoteMaintenanceService } from '../src/maintenance/notes.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const fsSafeRootFactory = async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative), open: async (relative) => ({ handle: await (await import('node:fs/promises')).open(path.join(rootDir, relative), 'r') }) });

function addMaintenanceReference(metadata, { topicId, referenceId, notePath = 'note.md', revision }) {
  return metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `/fictional/${topicId}/${notePath}`, observedRevision: revision });
}

function maintenanceRead(reference, notePath, revision) {
  return { schemaVersion: 1, path: notePath, revision, sourceReference: { ...reference, observedRevision: revision } };
}

test('automatic Note maintenance uses guarded CAS and one deduplicated Activity without push or Attention', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-maintenance-'));
  try {
    const sideEffects = { attention: 0, push: 0 };
    const records = new Map();
    const operations = new Map();
    const references = [];
    const metadata = {
      getTopic: (topicId) => topicId === 'topic-maintenance' ? { topicId } : null,
      listSourceReferences: () => references,
      getSourceReference: (referenceId) => references.find((reference) => reference.referenceId === referenceId) ?? null,
      createSourceReference: (reference) => { references.push(reference); return reference; },
      observeSourceReference: ({ referenceId, observedRevision }) => { const index = references.findIndex((reference) => reference.referenceId === referenceId); references[index] = { ...references[index], observedRevision }; return references[index]; },
      getOperation: (logicalOperationId) => operations.get(logicalOperationId) ?? null,
      recordOperation: (operation) => { const next = { ...operations.get(operation.logicalOperationId), ...operation }; operations.set(operation.logicalOperationId, next); return next; },
      recordActivity: (value) => { if (!records.has(value.logicalOperationId)) records.set(value.logicalOperationId, value); return records.get(value.logicalOperationId); }
    };
    const notes = new NoteAdapter({ fsSafeRootFactory, metadata, topicId: 'topic-maintenance', root });
    const created = await notes.create({ path: 'note.md', text: 'before' });
    const sourceService = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, coordinator: createMutationCoordinator({ metadata }), capabilities: { notes: true }, noteRoot: root, attentionDelivery: () => { sideEffects.attention += 1; }, push: () => { sideEffects.push += 1; } });
    sourceService.forTopic = () => ({ notes });
    const maintenance = createNoteMaintenanceService({ sourceService, metadata });
    const logicalOperationId = 'a8c24e61-7d88-4b74-a8d8-8c3d3c06c3f4';
    const input = { topicId: 'topic-maintenance', referenceId: created.note.sourceReference.referenceId, path: 'note.md', expectedRevision: created.note.revision, text: 'after', logicalOperationId, requestId: 'maintenance-frame' };
    const first = await maintenance.run(input);
    const second = await maintenance.run(input);
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'applied');
    assert.equal(records.size, 1);
    assert.equal(records.get(logicalOperationId).outcome, 'applied');
    assert.equal(Object.hasOwn(records.get(logicalOperationId), 'text'), false);
    assert.deepEqual(sideEffects, { attention: 0, push: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('maintenance rejects missing, foreign, wrong-kind, stale, and path-mismatched Note references before edit', async () => {
  const references = new Map([
    ['note:owned', { version: 1, referenceId: 'note:owned', topicId: 'topic-owned', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic/owned.md', observedRevision: 'revision-current' }],
    ['note:foreign', { version: 1, referenceId: 'note:foreign', topicId: 'topic-foreign', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/foreign/owned.md', observedRevision: 'revision-current' }],
    ['session:wrong', { version: 1, referenceId: 'session:wrong', topicId: 'topic-owned', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'fictional-session', observedRevision: 'revision-current' }],
    ['note:stale', { version: 1, referenceId: 'note:stale', topicId: 'topic-owned', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic/owned.md', observedRevision: 'revision-stale' }],
    ['note:path', { version: 1, referenceId: 'note:path', topicId: 'topic-owned', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/topic/other.md', observedRevision: 'revision-current' }]
  ]);
  const activities = [];
  const metadata = { getSourceReference: (id) => references.get(id) ?? null, recordActivity: (value) => { activities.push(value); return value; } };
  let edits = 0;
  const sourceService = {
    notesRead: async () => ({ schemaVersion: 1, path: 'owned.md', revision: 'revision-current', sourceReference: references.get('note:owned') }),
    notesEdit: async () => { edits += 1; return { status: 'applied' }; }
  };
  const maintenance = createNoteMaintenanceService({ sourceService, metadata });
  for (const referenceId of [undefined, 'note:foreign', 'session:wrong', 'note:stale', 'note:path']) {
    const result = await maintenance.run({ topicId: 'topic-owned', ...(referenceId ? { referenceId } : {}), path: 'owned.md', expectedRevision: 'revision-current', text: 'fictional', logicalOperationId: randomUUID() });
    assert.notEqual(result.status, 'applied');
  }
  assert.equal(edits, 0);
  assert.equal(activities.every((activity) => activity.outcome !== 'applied'), true);
});

test('maintenance repairs one durable Activity from unknown to applied after reopen', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-maintenance-repair-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, activity: true } });
    metadata.createTopic({ topicId: 'topic-maintenance-repair', paraCategory: 'project', lifecycle: 'active' });
    const reference = addMaintenanceReference(metadata, { topicId: 'topic-maintenance-repair', referenceId: 'note:maintenance-repair', revision: 'revision-before' });
    const logicalOperationId = 'f29fc893-50cb-413d-8be7-e1cb46ecbb53';
    const input = { topicId: 'topic-maintenance-repair', referenceId: reference.referenceId, path: 'note.md', expectedRevision: 'revision-before', text: 'after', logicalOperationId, requestId: 'maintenance-first' };
    let maintenance = createNoteMaintenanceService({ sourceService: { notesRead: async () => maintenanceRead(reference, 'note.md', 'revision-before'), notesEdit: async () => { const error = new Error('ambiguous'); error.code = 'unknown'; throw error; } }, metadata, now: () => '2026-08-22T01:00:00.000Z' });
    const first = await maintenance.run(input);
    assert.equal(first.activity.outcome, 'unknown');
    const activityId = first.activity.activityId;
    const createdAt = first.activity.createdAt;
    metadata.close();

    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, activity: true } });
    maintenance = createNoteMaintenanceService({ sourceService: { notesRead: async () => maintenanceRead(reference, 'note.md', 'revision-before'), notesEdit: async () => ({ status: 'applied', value: { revision: 'revision-after' } }) }, metadata, now: () => '2026-08-22T02:00:00.000Z' });
    const repaired = await maintenance.run({ ...input, requestId: 'maintenance-retry' });
    assert.equal(repaired.activity.outcome, 'applied');
    assert.equal(repaired.activity.observedRevision, 'revision-after');
    assert.equal(repaired.activity.activityId, activityId);
    assert.equal(repaired.activity.createdAt, createdAt);
    assert.equal(repaired.activity.updatedAt, '2026-08-22T02:00:00.000Z');
    assert.equal(metadata.listActivity('topic-maintenance-repair').length, 1);
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('maintenance never downgrades an applied Activity when a later replay is ambiguous', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-maintenance-monotonic-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    metadata.createTopic({ topicId: 'topic-maintenance-monotonic', paraCategory: 'project', lifecycle: 'active' });
    const reference = addMaintenanceReference(metadata, { topicId: 'topic-maintenance-monotonic', referenceId: 'note:maintenance-monotonic', notePath: 'routine.md', revision: 'sha256:before' });
    const logicalOperationId = randomUUID();
    let maintenance = createNoteMaintenanceService({ sourceService: { notesRead: async () => maintenanceRead(reference, 'routine.md', 'sha256:before'), notesEdit: async () => ({ status: 'applied', value: { revision: 'sha256:applied' } }) }, metadata, now: () => '2026-08-22T02:00:00.000Z' });
    const first = await maintenance.run({ topicId: 'topic-maintenance-monotonic', referenceId: reference.referenceId, logicalOperationId, path: 'routine.md', expectedRevision: 'sha256:before', text: 'fictional' });
    assert.equal(first.activity.outcome, 'applied');
    metadata.close();

    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    maintenance = createNoteMaintenanceService({ sourceService: { notesRead: async () => maintenanceRead(reference, 'routine.md', 'sha256:before'), notesEdit: async () => { const error = new Error('ambiguous'); error.code = 'unknown'; throw error; } }, metadata, now: () => '2026-08-22T03:00:00.000Z' });
    const replay = await maintenance.run({ topicId: 'topic-maintenance-monotonic', referenceId: reference.referenceId, logicalOperationId, requestId: 'retry-transport', path: 'routine.md', expectedRevision: 'sha256:before', text: 'fictional' });
    assert.equal(replay.activity.outcome, 'applied');
    assert.equal(replay.activity.observedRevision, 'sha256:applied');
    assert.equal(replay.activity.updatedAt, '2026-08-22T02:00:00.000Z');
    assert.equal(metadata.listActivity('topic-maintenance-monotonic').length, 1);
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Activity can advance from not-applied to applied without changing identity', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-activity-replay-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    metadata.createTopic({ topicId: 'topic-activity-replay', paraCategory: 'project', lifecycle: 'active' });
    const logicalOperationId = randomUUID();
    const first = metadata.recordActivity({ activityId: 'activity-original', topicId: 'topic-activity-replay', logicalOperationId, transportRequestId: 'transport-1', operationKind: 'notes.maintenance', outcome: 'not-applied', createdAt: '2026-08-22T04:00:00.000Z', updatedAt: '2026-08-22T04:00:00.000Z' });
    const repaired = metadata.recordActivity({ activityId: 'activity-retry', topicId: 'topic-activity-replay', logicalOperationId, transportRequestId: 'transport-2', operationKind: 'notes.maintenance', outcome: 'applied', observedRevision: 'sha256:applied', createdAt: '2026-08-22T05:00:00.000Z', updatedAt: '2026-08-22T05:00:00.000Z' });
    assert.equal(repaired.activityId, first.activityId);
    assert.equal(repaired.createdAt, first.createdAt);
    assert.equal(repaired.outcome, 'applied');
    assert.equal(repaired.observedRevision, 'sha256:applied');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
