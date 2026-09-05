import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rename as fsRename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createSourceReference } from '../src/sources/reference.mjs';
import { createTopicService } from '../src/topics/service.mjs';
import { createSessionAdapter } from '../src/sources/sessions.mjs';
import { NoteAdapter } from '../src/sources/notes.mjs';
import { readConversationSourceSnapshot, readNoteSourceSnapshot } from '../src/search/source-snapshot.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';

function pluginSessionBoundary({ sessionId = () => randomUUID(), updatedAt = () => Date.now() } = {}) {
  const entries = new Map();
  let ordinal = 0;
  const sessionStore = {
    listSessionEntries: () => [...entries].map(([sessionKey, entry]) => ({ sessionKey, entry })),
    getSessionEntry: ({ sessionKey }) => entries.get(sessionKey),
    async patchSessionEntry({ sessionKey, fallbackEntry, replaceEntry, update }) {
      const existingEntry = entries.get(sessionKey);
      const current = existingEntry ?? fallbackEntry;
      if (!current) return null;
      const patch = await update(current, { existingEntry });
      if (!patch) return null;
      const next = replaceEntry ? patch : { ...current, ...patch };
      entries.set(sessionKey, next);
      return next;
    }
  };
  const gateway = { async request(method, params) {
    if (method === 'sessions.create') {
      assert.equal(params.agentId, 'main');
      assert.equal(params.key, undefined);
      assert.match(params.idempotencyKey, /^[0-9a-f-]{36}$/u);
      assert.equal(params.category, undefined);
      const key = `agent:main:dashboard:command-center-${++ordinal}`;
      const entry = {
        sessionId: sessionId({ key, ordinal, params }),
        updatedAt: updatedAt({ key, ordinal, params }),
        label: params.label,
        category: null,
        pluginOwnerId: 'command-center'
      };
      entries.set(key, entry);
      return { key, entry };
    }
    if (method === 'sessions.list') return { sessions: [...entries].map(([key, entry]) => ({ key, sessionId: entry.sessionId, updatedAt: entry.updatedAt, label: entry.label, category: entry.category })) };
    throw new Error(`Unexpected ${method}`);
  } };
  return { entries, gateway, sessionStore };
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-topics-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault, { recursive: true });
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(root, 'state'), capabilities: { notes: true, sessions: true, scheduler: true } });
  try {
    const sessionAdapterFactory = ({ metadata: store, topicId }) => ({
      async create({ label, isPrimary }) {
        const sessionHandle = `agent:main:command-center:${topicId}`;
        const reference = createSourceReference({ referenceId: `session:${topicId}`, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionHandle });
        if (!store.getSourceReference(reference.referenceId)) store.createSourceReference(reference);
        store.setSessionState({ referenceId: reference.referenceId, sessionId: `session-id:${topicId}`, status: 'open', isPrimary });
        return { sessionKey: sessionHandle, sessionId: `session-id:${topicId}`, sourceReference: reference, label };
      }
    });
    const enabled = new Map();
    const revisions = new Map();
    const dispositionReceipts = new Map();
    const dispositionCalls = [];
    const failures = { unknownAfterDisableOnce: false };
    const schedulerFactory = (topicId) => ({
      async list() {
        return metadata.listSourceReferences(topicId).filter((item) => item.sourceSystem === 'scheduler')
          .map((reference) => ({ sourceReference: reference, job: { id: reference.externalSourceId, enabled: enabled.get(reference.referenceId) ?? true, configRevision: revisions.get(reference.referenceId) ?? reference.observedRevision } }));
      },
      async setEnabled(input) {
        if (dispositionReceipts.has(input.logicalOperationId)) return dispositionReceipts.get(input.logicalOperationId);
        dispositionCalls.push(['disable', input.referenceId]);
        enabled.set(input.referenceId, input.enabled);
        revisions.set(input.referenceId, `${input.expectedConfigRevision}:disabled`);
        const receipt = { status: 'applied', logicalOperationId: input.logicalOperationId };
        dispositionReceipts.set(input.logicalOperationId, receipt);
        if (failures.unknownAfterDisableOnce) { failures.unknownAfterDisableOnce = false; throw new Error('fictional unknown disable outcome'); }
        return receipt;
      },
      async complete(input) {
        if (dispositionReceipts.has(input.logicalOperationId)) return dispositionReceipts.get(input.logicalOperationId);
        dispositionCalls.push(['complete', input.referenceId]);
        enabled.set(input.referenceId, false);
        revisions.set(input.referenceId, `${input.expectedConfigRevision}:completed`);
        const receipt = { status: 'applied', logicalOperationId: input.logicalOperationId };
        dispositionReceipts.set(input.logicalOperationId, receipt);
        if (failures.unknownAfterDisableOnce) { failures.unknownAfterDisableOnce = false; throw new Error('fictional unknown disable outcome'); }
        return receipt;
      },
      async retain(input) { enabled.set(input.referenceId, false); return { status: 'applied' }; }
    });
    const topics = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory, schedulerFactory, sessionRenamer: async () => ({ status: 'applied' }) });
    await run({ root, vault, metadata, topics, sessionAdapterFactory, schedulerFactory, enabled, dispositionCalls, failures });
  } finally { metadata.close(); await rm(root, { recursive: true, force: true }); }
}

test('Topic provisioning is durable, grouped only when usable, and preserves identity through rename and recategorization', async () => {
  await fixture(async ({ vault, metadata, topics, sessionAdapterFactory }) => {
    const logicalOperationId = randomUUID();
    const created = await topics.create({ name: 'Fictional Context', paraCategory: 'project', logicalOperationId });
    assert.equal(created.status, 'applied');
    const topicId = created.topic.topicId;
    const referenceIds = metadata.listSourceReferences(topicId).map((item) => item.referenceId).sort();
    assert.equal(topics.listGrouped().project.length, 1);
    assert.equal(topics.listGrouped().area.length, 0);
    const destinationTopic = topics.listDestination().activeGroups.project[0];
    assert.equal(destinationTopic.noteFolderReferenceId, metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'note_folder').referenceId);
    assert.equal(destinationTopic.sourceReferences, undefined);
    assert.equal(destinationTopic.locators, undefined);
    const before = topics.get(topicId);
    assert.equal(Number.isInteger(before.revision), true);
    const initialLocatorVersion = before.locators.find((item) => item.referenceId.startsWith('note-folder:')).locatorVersion;
    let interruptRename = true;
    const restartSafeTopics = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory, sessionRenamer: async () => { if (interruptRename) { interruptRename = false; throw new Error('fictional rename interruption'); } return { status: 'applied' }; } });
    const renameOperationId = randomUUID();
    const renameInput = { topicId, name: 'Renamed Context', expectedRevision: before.revision, logicalOperationId: renameOperationId };
    await assert.rejects(restartSafeTopics.rename(renameInput), /fictional rename interruption/);
    await restartSafeTopics.rename(renameInput);
    const afterRename = topics.get(topicId);
    assert.equal(afterRename.revision, before.revision + 1);
    assert.equal(afterRename.name, 'Renamed Context');
    assert.equal(afterRename.locators.find((item) => item.referenceId.startsWith('note-folder:')).locatorVersion, initialLocatorVersion + 1);
    const preview = topics.recategorizationPreview({ topicId, paraCategory: 'area' });
    assert.equal(metadata.getTopic(topicId).paraCategory, 'project');
    await assert.rejects(topics.recategorizationConfirm({ topicId, paraCategory: 'area', preview: { ...preview, changes: [{ aspect: 'note-folder-location', from: '/fictional/source', to: '/fictional/private', managed: true }] }, previewDigest: 'sha256:forged', expectedRevisions: preview.expectedRevisions, logicalOperationId: randomUUID() }), /digest|stale|canonical/i);
    const recategorizationInput = { topicId, preview, structuralChangeId: preview.structuralChangeId, previewDigest: preview.digest, expectedRevisions: preview.expectedRevisions, logicalOperationId: randomUUID() };
    await topics.recategorizationConfirm(recategorizationInput);
    assert.equal(topics.get(topicId).paraCategory, 'area');
    assert.equal(topics.get(topicId).revision, afterRename.revision + 1);
    assert.equal(topics.get(topicId).locators.find((item) => item.referenceId.startsWith('note-folder:')).locatorVersion, initialLocatorVersion + 2);
    assert.deepEqual(metadata.listSourceReferences(topicId).map((item) => item.referenceId).sort(), referenceIds);
    metadata.close();
    let reopened = openCommandCenterMetadataService({ stateDir: path.join(vault, '..', 'state'), capabilities: { notes: true, sessions: true, scheduler: true } });
    assert.notEqual(reopened.getOperatingStatus().mode, 'recovery-only', JSON.stringify(reopened.getOperatingStatus()));
    assert.ok(reopened.getTopic(topicId));
    reopened.close();
  });
});

test('Topic rename preserves a nested Note reference across adapter reopen', async () => {
  await fixture(async ({ metadata, topics }) => {
    const created = await topics.create({ name: 'Fictional Note Identity', paraCategory: 'project', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const folder = metadata.listSourceReferences(topicId).find((reference) => reference.sourceKind === 'note_folder');
    const options = { metadata, topicId, noteFolderReferenceId: folder.referenceId };
    const adapter = new NoteAdapter(options);
    let reopened;
    try {
      const original = (await adapter.create({ path: 'nested/evidence.md', text: 'Fictional durable evidence' })).note;
      await topics.rename({ topicId, name: 'Fictional Note Identity Renamed', expectedRevision: topics.get(topicId).revision, logicalOperationId: randomUUID() });
      adapter.close();
      reopened = new NoteAdapter(options);
      const note = (await reopened.browse()).find((entry) => entry.path === original.path);
      assert.deepEqual({ referenceId: note.sourceReference.referenceId, revision: note.revision, path: note.path }, { referenceId: original.sourceReference.referenceId, revision: original.revision, path: original.path });
      const read = await reopened.read({ path: note.path, referenceId: original.sourceReference.referenceId });
      assert.equal(read.text, original.text);
      const snapshot = await readNoteSourceSnapshot({ topicId, metadata, noteAdapter: reopened });
      assert.equal(snapshot.notes[0].sourceReference.referenceId, original.sourceReference.referenceId);
      assert.equal(snapshot.notes[0].sourceReference.externalSourceId, original.sourceReference.externalSourceId);
      const service = Object.assign(Object.create(AuthoritativeSourceService.prototype), { metadata });
      assert.equal(service.assertExactNoteReference({ topicId, referenceId: original.sourceReference.referenceId, path: original.path }).referenceId, original.sourceReference.referenceId);
      assert.throws(() => service.assertExactNoteReference({ topicId, referenceId: original.sourceReference.referenceId, path: 'unrelated.md' }), /does not match/);
    } finally { adapter.close(); reopened?.close(); }
  });
});

test('structural changes reject a symlinked Note-root ancestor before moving', async () => {
  await fixture(async ({ root, vault, topics }) => {
    const created = await topics.create({ name: 'Ancestor Guard', paraCategory: 'project', logicalOperationId: randomUUID() });
    const sourceCategory = path.join(vault, 'Projects');
    const escapedCategory = path.join(root, 'escaped-project');
    await fsRename(sourceCategory, escapedCategory);
    await symlink(escapedCategory, sourceCategory, 'dir');
    const preview = topics.recategorizationPreview({ topicId: created.topic.topicId, paraCategory: 'area' });
    await assert.rejects(topics.recategorizationConfirm({ topicId: created.topic.topicId, preview, structuralChangeId: preview.structuralChangeId, previewDigest: preview.digest, expectedRevisions: preview.expectedRevisions, logicalOperationId: randomUUID() }), /canonical|unsafe|proven|unavailable/i);
    assert.equal(topics.get(created.topic.topicId).paraCategory, 'project');
  });
});

test('Topic provisioning activates through the pinned public Session store and verifies the exact durable identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-runtime-session-'));
  const vault = path.join(root, 'vault');
  const boundary = pluginSessionBoundary();
  await mkdir(vault, { recursive: true });
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(root, 'state'), capabilities: { notes: true, sessions: true } });
  try {
    const topics = createTopicService({
      metadata,
      noteVaultRoot: vault,
      gateway: boundary.gateway,
      sessionStore: boundary.sessionStore,
      schedulerFactory: () => ({ async list() { return []; } })
    });
    const logicalOperationId = randomUUID();
    const created = await topics.create({ name: 'Runtime Session Context', paraCategory: 'project', logicalOperationId });
    const sessionKey = metadata.listSourceReferences(created.topic.topicId).find((item) => item.sourceKind === 'session').externalSourceId;

    assert.equal(created.topic.lifecycle, 'active');
    assert.equal(boundary.entries.get(sessionKey).label, 'Runtime Session Context');
    assert.equal(boundary.entries.get(sessionKey).category, null);
    assert.equal(boundary.entries.get(sessionKey).pluginOwnerId, 'command-center');
    assert.equal((await topics.listDestinationVerified()).activeGroups.project[0].topicId, created.topic.topicId);
    const archive = await topics.archivePreview({ topicId: created.topic.topicId });
    assert.deepEqual(archive.commitments, []);
  } finally {
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('archive accounting is explicit and restore preserves identity without re-enabling commitments', async () => {
  await fixture(async ({ vault, metadata, topics, enabled, dispositionCalls, failures }) => {
    const created = await topics.create({ name: 'Commitment Context', paraCategory: 'project', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const reference = createSourceReference({ referenceId: `a-reminder:${topicId}`, topicId, sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: `job:${topicId}`, observedRevision: 'revision-1' });
    const disabledSchedule = createSourceReference({ referenceId: `z-schedule:${topicId}`, topicId, sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: `job-disabled:${topicId}`, observedRevision: 'revision-disabled' });
    metadata.createSourceReference(reference);
    metadata.createSourceReference(disabledSchedule);
    const archive = await topics.archivePreview({ topicId });
    assert.deepEqual(archive.commitments, [
      { referenceId: reference.referenceId, revision: 'revision-1', kind: 'reminder_schedule', enabled: true, disposition: 'disable-and-retain' },
      { referenceId: disabledSchedule.referenceId, revision: 'revision-disabled', kind: 'schedule', enabled: true, disposition: 'disable-and-retain' }
    ]);
    enabled.set(reference.referenceId, false);
    await assert.rejects(topics.archiveConfirm({ topicId, preview: archive, structuralChangeId: archive.structuralChangeId, previewDigest: archive.digest, expectedRevisions: archive.expectedRevisions, logicalOperationId: randomUUID() }), /stale|accounting changed/i);
    enabled.set(reference.referenceId, true);
    const archiveOperationId = randomUUID();
    failures.unknownAfterDisableOnce = true;
    await assert.rejects(topics.archiveConfirm({ topicId, preview: archive, structuralChangeId: archive.structuralChangeId, previewDigest: archive.digest, expectedRevisions: archive.expectedRevisions, logicalOperationId: archiveOperationId }), /fictional unknown disable outcome/);
    await topics.archiveConfirm({ topicId, preview: archive, structuralChangeId: archive.structuralChangeId, previewDigest: archive.digest, expectedRevisions: archive.expectedRevisions, logicalOperationId: archiveOperationId });
    assert.deepEqual(dispositionCalls, [['disable', reference.referenceId], ['disable', disabledSchedule.referenceId]]);
    await topics.archiveConfirm({ topicId, preview: archive, structuralChangeId: archive.structuralChangeId, previewDigest: archive.digest, expectedRevisions: archive.expectedRevisions, logicalOperationId: archiveOperationId });
    assert.equal(topics.get(topicId).paraCategory, 'archive');
    await assert.rejects(topics.rename({ topicId, name: 'Forbidden Archived Rename', expectedRevision: topics.get(topicId).revision, logicalOperationId: randomUUID() }), /active Topic|read-only/i);
    assert.equal(topics.listDestination().archived.some((topic) => topic.topicId === topicId), true);
    const folder = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'note_folder');
    await topics.markSourceMissing(topicId, folder.referenceId, 'archived exact folder unavailable');
    await topics.recoveryVerify({ topicId, referenceId: folder.referenceId, expectedRevision: topics.get(topicId).revision, expectedSourceRevision: metadata.getSourceLocator(folder.referenceId).observedRevision, replacementLocator: metadata.getSourceLocator(folder.referenceId).locator, logicalOperationId: randomUUID() });
    assert.equal(enabled.get(reference.referenceId), false);
    const restore = topics.restorePreview({ topicId, paraCategory: 'resource' });
    await topics.restoreConfirm({ topicId, preview: restore, structuralChangeId: restore.structuralChangeId, previewDigest: restore.digest, expectedRevisions: restore.expectedRevisions, logicalOperationId: randomUUID() });
    assert.equal(topics.get(topicId).paraCategory, 'resource');
    assert.equal(enabled.get(reference.referenceId), false);
  });
});

test('archive preview refuses a linked commitment without an authoritative revision', async () => {
  await fixture(async ({ metadata, topics }) => {
    const created = await topics.create({ name: 'Unrevisioned Commitment', paraCategory: 'area', logicalOperationId: randomUUID() });
    metadata.createSourceReference(createSourceReference({ referenceId: `schedule:${created.topic.topicId}`, topicId: created.topic.topicId, sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: `job:${created.topic.topicId}` }));
    await assert.rejects(topics.archivePreview({ topicId: created.topic.topicId }), /exact revision/i);
  });
});

test('missing exact Note Folder enters visible recovery and never silently recreates it', async () => {
  await fixture(async ({ metadata, topics }) => {
    const created = await topics.create({ name: 'Recovery Context', paraCategory: 'resource', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const folder = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'note_folder');
    const locator = metadata.getSourceLocator(folder.referenceId).locator;
    await rm(locator, { recursive: true });
    const detected = await topics.listDestinationVerified();
    const detectedTopic = detected.recovery.find((topic) => topic.topicId === topicId);
    assert.equal(detectedTopic.health, 'source-recovery');
    assert.equal(detectedTopic.recovery.some((item) => item.referenceId === folder.referenceId && item.state === 'required'), true);
    assert.deepEqual(metadata.listSourceRecovery(topicId), [], 'side-effect-free reads must not persist recovery state');
    const recovery = await topics.markSourceMissing(topicId, folder.referenceId, 'exact folder missing');
    assert.equal(recovery.state, 'required');
    assert.throws(() => topics.assertWritable(topicId, 'Note write'), /Source Recovery/);
    assert.doesNotThrow(() => topics.assertWritable(topicId, 'independent Session write', ['session']));
    await mkdir(locator, { recursive: true });
    const verifyInput = { topicId, referenceId: folder.referenceId, expectedRevision: topics.get(topicId).revision, expectedSourceRevision: metadata.getSourceLocator(folder.referenceId).observedRevision, logicalOperationId: randomUUID() };
    await assert.rejects(topics.recoveryVerify(verifyInput), /identity|verification failed/i);
    const replacementInput = { ...verifyInput, replacementLocator: locator, logicalOperationId: randomUUID() };
    const verified = await topics.recoveryVerify(replacementInput);
    assert.equal(verified.status, 'replaced');
    assert.deepEqual(await topics.recoveryVerify(replacementInput), verified);
    await assert.rejects(topics.recoveryVerify({ ...replacementInput, referenceId: 'different-reference' }), /different Source Recovery intent/i);
    assert.doesNotThrow(() => topics.assertWritable(topicId, 'Note write'));
    assert.equal(topics.listGrouped().resource.some((topic) => topic.topicId === topicId), true);
  });
});

test('a provisioning retry refuses a different directory recreated at its bound locator', async () => {
  await fixture(async ({ vault, metadata, sessionAdapterFactory }) => {
    let interrupt = true;
    const topics = createTopicService({
      metadata,
      noteVaultRoot: vault,
      sessionAdapterFactory: (options) => {
        const adapter = sessionAdapterFactory(options);
        return { ...adapter, async create(input) { if (interrupt) throw new Error('fictional provisioning interruption'); return adapter.create(input); } };
      }
    });
    const logicalOperationId = randomUUID();
    await assert.rejects(topics.create({ name: 'Recreated Provisioning Folder', paraCategory: 'project', logicalOperationId }), /provisioning interruption/);
    const topicId = metadata.getTopicOperation(logicalOperationId).topicId;
    const referenceId = `note-folder:${topicId}`;
    const locator = metadata.getSourceLocator(referenceId);
    await rm(locator.locator, { recursive: true });
    await mkdir(locator.locator);
    interrupt = false;
    await assert.rejects(topics.retry({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId }), /recovery|identity|changed/i);
    assert.equal(metadata.getSourceLocator(referenceId).observedRevision, locator.observedRevision);
    assert.equal(metadata.listSourceRecovery(topicId).some((item) => item.referenceId === referenceId && item.state === 'required'), true);
    assert.equal(metadata.getTopic(topicId).lifecycle, 'provisioning');
  });
});

test('lifecycle mutations refuse a replacement directory recreated at the exact locator', async () => {
  await fixture(async ({ metadata, topics }) => {
    const created = await topics.create({ name: 'Recreated Active Folder', paraCategory: 'project', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const referenceId = `note-folder:${topicId}`;
    const locator = metadata.getSourceLocator(referenceId);
    await rm(locator.locator, { recursive: true });
    await mkdir(locator.locator);
    await assert.rejects(topics.rename({ topicId, name: 'Must Not Rename', expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId: randomUUID() }), /recovery|identity|unavailable/i);
    assert.equal(metadata.getTopicName(topicId), 'Recreated Active Folder');
    assert.equal(metadata.getSourceLocator(referenceId).observedRevision, locator.observedRevision);
    assert.equal(metadata.listSourceRecovery(topicId).some((item) => item.referenceId === referenceId && item.state === 'required'), true);
  });
});

test('archive confirmation detects a recreated folder before disabling commitments', async () => {
  await fixture(async ({ metadata, topics, dispositionCalls }) => {
    const created = await topics.create({ name: 'Archive Identity Fence', paraCategory: 'project', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const referenceId = `note-folder:${topicId}`;
    const locator = metadata.getSourceLocator(referenceId);
    metadata.createSourceReference(createSourceReference({ referenceId: `schedule:${topicId}`, topicId, sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: `job:${topicId}`, observedRevision: 'archive-fence-revision' }));
    const preview = await topics.archivePreview({ topicId });
    await rm(locator.locator, { recursive: true });
    await mkdir(locator.locator);
    await assert.rejects(topics.archiveConfirm({ topicId, structuralChangeId: preview.structuralChangeId, previewDigest: preview.digest, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId: randomUUID() }), /recovery|identity|changed/i);
    assert.deepEqual(dispositionCalls, []);
    assert.equal(metadata.getTopic(topicId).paraCategory, 'project');
    assert.equal(metadata.listSourceRecovery(topicId).some((item) => item.referenceId === referenceId && item.state === 'required'), true);
  });
});

test('Topics destination assigns each lifecycle exception to one collection', async () => {
  await fixture(async ({ metadata, topics }) => {
    const active = await topics.create({ name: 'Exclusive Recovery Context', paraCategory: 'resource', logicalOperationId: randomUUID() });
    const activeFolder = metadata.listSourceReferences(active.topic.topicId).find((item) => item.sourceKind === 'note_folder');
    await topics.markSourceMissing(active.topic.topicId, activeFolder.referenceId, 'exact folder missing');

    const provisioning = createTopicService({
      metadata,
      noteVaultRoot: topics.noteVaultRoot,
      sessionAdapterFactory: () => ({ async create() { throw new Error('fictional Session interruption'); } })
    });
    const provisioningOperationId = randomUUID();
    await assert.rejects(provisioning.create({ name: 'Exclusive Provisioning Context', paraCategory: 'area', logicalOperationId: provisioningOperationId }), /interruption/);
    const provisioningTopicId = metadata.getTopicOperation(provisioningOperationId).topicId;
    const provisioningFolder = metadata.listSourceReferences(provisioningTopicId).find((item) => item.sourceKind === 'note_folder');
    metadata.recordSourceRecovery({
      recoveryId: `recovery:${provisioningFolder.referenceId}`,
      topicId: provisioningTopicId,
      referenceId: provisioningFolder.referenceId,
      sourceKind: 'note_folder',
      state: 'required',
      failure: 'provisioning source requires exact verification',
      diagnostics: []
    });
    metadata.createTopic({ topicId: 'retired-topic', name: 'Retired Topic', paraCategory: 'resource', lifecycle: 'retired' });
    const destination = topics.listDestination();
    assert.deepEqual(destination.provisioning.map((topic) => topic.topicId), [provisioningTopicId]);
    assert.deepEqual(destination.recovery.map((topic) => topic.topicId), [active.topic.topicId]);
    assert.deepEqual(destination.retired.map((topic) => topic.topicId), ['retired-topic']);
    assert.deepEqual((await topics.listDestinationVerified()).retired.map((topic) => topic.topicId), ['retired-topic']);
    assert.deepEqual((await topics.listDestinationPageVerified({ limit: 100 })).retired.map((topic) => topic.topicId), ['retired-topic']);
    assert.equal([...Object.values(destination.activeGroups), destination.archived, destination.provisioning, destination.recovery, destination.retired]
      .flat().filter((topic) => topic.topicId === provisioningTopicId).length, 1);
  });
});

test('Source Recovery accepts only an explicit exact replacement and keeps the reference identity', async () => {
  await fixture(async ({ vault, metadata, topics }) => {
    const created = await topics.create({ name: 'Replacement Context', paraCategory: 'resource', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const folder = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'note_folder');
    const originalReferenceId = folder.referenceId;
    const originalLocator = metadata.getSourceLocator(originalReferenceId).locator;
    await rm(originalLocator, { recursive: true });
    const detected = await topics.listDestinationVerified();
    assert.deepEqual(detected.recovery.map((topic) => topic.topicId), [topicId]);
    assert.equal(metadata.listSourceRecovery(topicId).length, 0);
    const replacement = path.join(vault, 'Custom', 'Replacement Context');
    await mkdir(replacement, { recursive: true });
    const beforeRevision = topics.get(topicId).revision;
    const result = await topics.recoveryVerify({ topicId, referenceId: originalReferenceId, replacementLocator: replacement, expectedRevision: beforeRevision, expectedSourceRevision: metadata.getSourceLocator(originalReferenceId).observedRevision, logicalOperationId: randomUUID() });
    assert.equal(result.status, 'replaced');
    assert.equal(topics.get(topicId).revision, beforeRevision + 1);
    assert.equal(metadata.getSourceLocator(originalReferenceId).locator, replacement);
    assert.equal(metadata.getSourceConventionState(originalReferenceId).find((item) => item.aspect === 'location')?.state, 'customized');
    assert.equal(metadata.getSourceReference(originalReferenceId).referenceId, originalReferenceId);
  });
});

test('Source Recovery reconciles an interrupted folder binding before preserving customized location state', async () => {
  await fixture(async ({ vault, metadata, topics }) => {
    await mkdir(path.join(vault, 'Areas', 'Interrupted Folder Recovery'), { recursive: true });
    const created = await topics.create({ name: 'Interrupted Folder Recovery', paraCategory: 'area', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const reference = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'note_folder');
    const original = metadata.getSourceLocator(reference.referenceId);
    assert.equal(original.ownership, 'adopted');
    assert.match(original.observedRevision, /^fs:/u);
    await rm(original.locator, { recursive: true });
    await topics.markSourceMissing(topicId, reference.referenceId, 'interrupted exact folder recovery');
    const replacement = path.join(vault, 'Custom', 'Interrupted Folder Recovery');
    await mkdir(replacement, { recursive: true });
    metadata.setSourceLocator({ referenceId: reference.referenceId, locator: replacement, locatorVersion: original.locatorVersion + 1, ownership: 'external', observedRevision: null });
    assert.equal(metadata.getSourceConventionState(reference.referenceId).find((item) => item.aspect === 'location').state, 'managed');
    await topics.recoveryReplace({ topicId, referenceId: reference.referenceId, replacementLocator: replacement, expectedRevision: topics.get(topicId).revision, expectedSourceRevision: original.observedRevision, logicalOperationId: randomUUID() });
    assert.equal(metadata.getSourceConventionState(reference.referenceId).find((item) => item.aspect === 'location').state, 'customized');
  });
});

test('interrupted provisioning retries exact identities and rollback preserves the durable operation record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-provisioning-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault, { recursive: true });
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(root, 'state'), capabilities: { notes: true, sessions: true, scheduler: true } });
  let failSession = true;
  const sessionAdapterFactory = ({ metadata: store, topicId }) => ({
    async create() {
      if (failSession) throw new Error('fictional session interruption');
      const sessionHandle = `agent:main:command-center:${topicId}`;
      const reference = createSourceReference({ referenceId: `session:${topicId}`, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionHandle });
      store.createSourceReference(reference);
      store.setSessionState({ referenceId: reference.referenceId, sessionId: `session-id:${topicId}`, status: 'open', isPrimary: true });
      return { sessionKey: sessionHandle, sessionId: `session-id:${topicId}`, sourceReference: reference };
    }
  });
  const logicalOperationId = randomUUID();
  try {
    const topics = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory });
    await assert.rejects(topics.create({ name: 'Interrupted Context', paraCategory: 'project', logicalOperationId }), /interruption/);
    const interrupted = metadata.getTopicOperation(logicalOperationId);
    assert.equal(interrupted.state, 'unknown');
    assert.equal(interrupted.topicId !== null, true);
    const topicId = interrupted.topicId;
    assert.equal(metadata.getTopic(topicId).lifecycle, 'provisioning');
    const folderReferenceId = `note-folder:${topicId}`;
    const folderLocator = metadata.getSourceLocator(folderReferenceId).locator;
    failSession = false;
    await assert.rejects(topics.retry({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId: randomUUID() }), /not found/i);
    await assert.rejects(topics.retry({ topicId, expectedRevision: metadata.getTopic(topicId).revision + 1, logicalOperationId }), /revision is stale/i);
    const retried = await topics.retry({ topicId: interrupted.topicId, expectedRevision: metadata.getTopic(interrupted.topicId).revision, logicalOperationId });
    assert.equal(retried.topic.topicId, topicId);
    assert.equal(metadata.getSourceLocator(folderReferenceId).locator, folderLocator);
    assert.deepEqual(metadata.listSourceReferences(topicId).map((item) => item.referenceId).sort(), [`note-folder:${topicId}`, `session:${topicId}`].sort());

    const rollbackFailure = true;
    const rollbackOperationId = randomUUID();
    const rollbackTopics = createTopicService({
      metadata,
      noteVaultRoot: vault,
      sessionAdapterFactory: ({ metadata: store, topicId: rollbackTopicId }) => ({
        async create() {
          if (rollbackFailure) throw new Error('rollback interruption');
          const sessionHandle = `agent:main:command-center:${rollbackTopicId}`;
          const reference = createSourceReference({ referenceId: `session:${rollbackTopicId}`, topicId: rollbackTopicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionHandle });
          store.createSourceReference(reference);
          store.setSessionState({ referenceId: reference.referenceId, sessionId: `session-id:${rollbackTopicId}`, status: 'open', isPrimary: true });
          return { sourceReference: reference, sessionKey: sessionHandle };
        }
      })
    });
    await assert.rejects(rollbackTopics.create({ name: 'Rollback Context', paraCategory: 'area', logicalOperationId: rollbackOperationId }), /rollback interruption/);
    const rollbackTopicId = metadata.getTopicOperation(rollbackOperationId).topicId;
    const rollbackFolder = metadata.getSourceLocator(`note-folder:${rollbackTopicId}`).locator;
    await assert.rejects(rollbackTopics.rollback({ topicId: rollbackTopicId, expectedRevision: metadata.getTopic(rollbackTopicId).revision + 1, logicalOperationId: rollbackOperationId }), /revision is stale/i);
    const rolledBack = await rollbackTopics.rollback({ topicId: rollbackTopicId, expectedRevision: metadata.getTopic(rollbackTopicId).revision, logicalOperationId: rollbackOperationId });
    assert.equal(rolledBack.status, 'not-applied');
    assert.deepEqual(await rollbackTopics.rollback({ topicId: rollbackTopicId, expectedRevision: 0, logicalOperationId: rollbackOperationId }), rolledBack);
    assert.equal(metadata.getTopic(rollbackTopicId), null);
    assert.equal(metadata.getTopicOperation(rollbackOperationId).state, 'not-applied');
    await assert.rejects(access(rollbackFolder));

    const unsafeRollbackId = randomUUID();
    await assert.rejects(rollbackTopics.create({ name: 'Changed Rollback Context', paraCategory: 'area', logicalOperationId: unsafeRollbackId }), /rollback interruption/);
    const unsafeTopicId = metadata.getTopicOperation(unsafeRollbackId).topicId;
    const unsafeFolder = metadata.getSourceLocator(`note-folder:${unsafeTopicId}`).locator;
    await rm(unsafeFolder, { recursive: true });
    await mkdir(unsafeFolder);
    await assert.rejects(rollbackTopics.rollback({ topicId: unsafeTopicId, expectedRevision: metadata.getTopic(unsafeTopicId).revision, logicalOperationId: unsafeRollbackId }), /not proven safe/);
    assert.equal(metadata.getTopic(unsafeTopicId).lifecycle, 'provisioning');
  } finally {
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('interrupted secondary-root adoption converges after metadata restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-secondary-root-'));
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  const stateDir = path.join(root, 'state');
  const exactFolder = path.join(secondary, 'Projects', 'Secondary Context');
  await mkdir(primary, { recursive: true });
  await mkdir(exactFolder, { recursive: true });
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  let interrupt = true;
  const sessionAdapterFactory = ({ metadata: store, topicId }) => ({
    async create() {
      if (interrupt) throw new Error('secondary adoption interruption');
      const reference = createSourceReference({ referenceId: `session:${topicId}`, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: `agent:main:secondary:${topicId}` });
      if (!store.getSourceReference(reference.referenceId)) store.createSourceReference(reference);
      store.setSessionState({ referenceId: reference.referenceId, sessionId: `session-id:${topicId}`, status: 'open', isPrimary: true });
      return { sourceReference: reference, sessionId: `session-id:${topicId}` };
    }
  });
  const logicalOperationId = randomUUID();
  try {
    let topics = createTopicService({ metadata, noteVaultRoots: [primary, secondary], sessionAdapterFactory });
    await assert.rejects(topics.create({ name: 'Secondary Context', paraCategory: 'project', logicalOperationId }), /secondary adoption interruption/);
    const topicId = metadata.getTopicOperation(logicalOperationId).topicId;
    assert.equal(metadata.getSourceLocator(`note-folder:${topicId}`).locator, exactFolder);
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    interrupt = false;
    topics = createTopicService({ metadata, noteVaultRoots: [primary, secondary], sessionAdapterFactory });
    const result = await topics.retry({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId });
    assert.equal(result.topic.lifecycle, 'active');
    assert.equal(metadata.getSourceLocator(`note-folder:${topicId}`).locator, exactFolder);
  } finally {
    metadata?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('provisioning verifies exact authoritative bindings before activation and retries safely', async () => {
  await fixture(async ({ vault, metadata }) => {
    let failVerification = true;
    let interruptCompletion = true;
    const sessionAdapterFactory = ({ metadata: store, topicId }) => ({
      async create() {
        const sessionHandle = `agent:main:command-center:verification-${topicId}`;
        const referenceId = `session:${topicId}`;
        let reference = store.getSourceReference(referenceId);
        if (!reference) {
          reference = createSourceReference({ referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionHandle });
          store.createSourceReference(reference);
          store.setSessionState({ referenceId, sessionId: `session-id:${topicId}`, status: 'open', isPrimary: true });
        }
        return { sessionKey: sessionHandle, sessionId: `session-id:${topicId}`, sourceReference: reference };
      },
      async resolveExact({ referenceId }) {
        if (failVerification) throw new Error('fictional exact Session verification interruption');
        return store.getSourceReference(referenceId);
      }
    });
    const interruptingMetadata = {
      ...metadata,
      completeTopicProvisioning(input) {
        if (interruptCompletion) { interruptCompletion = false; throw new Error('fictional atomic completion interruption'); }
        return metadata.completeTopicProvisioning(input);
      }
    };
    let topics = createTopicService({ metadata: interruptingMetadata, noteVaultRoot: vault, sessionAdapterFactory });
    const logicalOperationId = randomUUID();
    await assert.rejects(topics.create({ name: 'Verified Activation', paraCategory: 'project', logicalOperationId }), /exact Session verification interruption/);
    const operation = metadata.getTopicOperation(logicalOperationId);
    const topicId = operation.topicId;
    assert.equal(operation.currentStep, 'verify-bindings');
    assert.equal(metadata.getTopic(topicId).lifecycle, 'provisioning');
    const referenceIds = metadata.listSourceReferences(topicId).map((item) => item.referenceId).sort();

    failVerification = false;
    await assert.rejects(topics.retry({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId }), /atomic completion interruption/);
    assert.equal(metadata.getTopic(topicId).lifecycle, 'provisioning');
    assert.notEqual(metadata.getTopicOperation(logicalOperationId).state, 'applied');
    topics = createTopicService({ metadata: interruptingMetadata, noteVaultRoot: vault, sessionAdapterFactory });
    const retried = await topics.retry({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId });
    assert.equal(retried.status, 'applied');
    assert.equal(retried.topic.lifecycle, 'active');
    assert.deepEqual(metadata.listSourceReferences(topicId).map((item) => item.referenceId).sort(), referenceIds);
  });
});

test('provisioning accepts the pinned host entry identity through durable metadata', async () => {
  await fixture(async ({ vault, metadata }) => {
    const boundary = pluginSessionBoundary({ sessionId: () => 'pinned-entry-session', updatedAt: () => 42 });
    const topics = createTopicService({ metadata, noteVaultRoot: vault, gateway: boundary.gateway, sessionStore: boundary.sessionStore });
    const created = await topics.create({ name: 'Pinned Entry Shape', paraCategory: 'area', logicalOperationId: randomUUID() });
    assert.equal(created.topic.lifecycle, 'active');
    const session = metadata.listSourceReferences(created.topic.topicId).find((item) => item.sourceKind === 'session');
    assert.equal(metadata.getSessionState(session.referenceId).sessionId, 'pinned-entry-session');
    assert.equal(metadata.getSourceLocator(session.referenceId).observedRevision, '42');
  });
});

test('concurrent same-intent provisioning retries converge without downgrading applied state', async () => {
  await fixture(async ({ vault, metadata }) => {
    let verificationFailure = true;
    let releaseVerification;
    let signalVerificationEntered;
    const verificationEntered = new Promise((resolve) => { signalVerificationEntered = resolve; });
    const verificationRelease = new Promise((resolve) => { releaseVerification = resolve; });
    let deferVerification = false;
    const sessionAdapterFactory = ({ metadata: store, topicId }) => ({
      async create() {
        const referenceId = `session:${topicId}`;
        let reference = store.getSourceReference(referenceId);
        if (!reference) {
          reference = createSourceReference({ referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: `agent:main:command-center:concurrent-${topicId}` });
          store.createSourceReference(reference);
          store.setSessionState({ referenceId, sessionId: `session-id:${topicId}`, status: 'open', isPrimary: true });
        }
        return { sourceReference: reference, sessionId: `session-id:${topicId}` };
      },
      async resolveExact({ referenceId }) {
        if (verificationFailure) throw new Error('fictional initial verification failure');
        if (deferVerification) {
          deferVerification = false;
          signalVerificationEntered();
          await verificationRelease;
        }
        return store.getSourceReference(referenceId);
      }
    });
    const topics = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory });
    const logicalOperationId = randomUUID();
    await assert.rejects(topics.create({ name: 'Concurrent Provisioning', paraCategory: 'resource', logicalOperationId }), /initial verification failure/);
    const topicId = metadata.getTopicOperation(logicalOperationId).topicId;
    verificationFailure = false;
    deferVerification = true;
    const input = { topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId };
    const firstPending = topics.retry(input);
    await verificationEntered;
    const secondPending = topics.retry(input);
    releaseVerification();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'applied');
    assert.equal(metadata.getTopic(topicId).lifecycle, 'active');
    assert.equal(metadata.getTopicOperation(logicalOperationId).state, 'applied');
    assert.deepEqual(await topics.retry(input), first);
    assert.deepEqual(await topics.create({ name: 'Concurrent Provisioning', paraCategory: 'resource', logicalOperationId }), first);
  });
});

test('provisioning rollback preserves an unverifiable created Session after activation interruption', async () => {
  await fixture(async ({ vault, metadata }) => {
    const boundary = pluginSessionBoundary({ sessionId: () => 'rollback-session-id', updatedAt: () => 73 });
    let interruptActivation = true;
    const interruptingMetadata = {
      ...metadata,
      completeTopicProvisioning(input) {
        if (interruptActivation) { interruptActivation = false; throw new Error('fictional activation interruption'); }
        return metadata.completeTopicProvisioning(input);
      }
    };
    const topics = createTopicService({ metadata: interruptingMetadata, noteVaultRoot: vault, gateway: boundary.gateway, sessionStore: boundary.sessionStore });
    const logicalOperationId = randomUUID();
    await assert.rejects(topics.create({ name: 'Post Session Rollback', paraCategory: 'project', logicalOperationId }), /activation interruption/);
    const topicId = metadata.getTopicOperation(logicalOperationId).topicId;
    const sessionReference = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'session');
    const locator = metadata.getSourceLocator(sessionReference.referenceId);
    metadata.setSourceLocator({ ...locator, observedRevision: null });
    assert.equal(metadata.getSourceLocator(sessionReference.referenceId).observedRevision, null);
    await assert.rejects(topics.rollback({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId }), /lacks an authoritative creation revision/);
    assert.equal(metadata.getTopic(topicId).lifecycle, 'provisioning');
    assert.equal(metadata.getSourceReference(sessionReference.referenceId).externalSourceId, sessionReference.externalSourceId);
  });
});

test('concurrent distinct provisioning operations cannot claim one conventional Note Folder', async () => {
  await fixture(async ({ vault, metadata, sessionAdapterFactory }) => {
    await mkdir(path.join(vault, 'Projects', 'Exclusive Folder Claim'), { recursive: true });
    const left = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory });
    const right = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory });
    const results = await Promise.allSettled([
      left.create({ name: 'Exclusive Folder Claim', paraCategory: 'project', logicalOperationId: randomUUID() }),
      right.create({ name: 'Exclusive Folder Claim', paraCategory: 'project', logicalOperationId: randomUUID() })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && /owned|locator|conflict/i.test(result.reason?.message)).length, 1);
    const claims = metadata.listSourceLocators().filter((locator) => locator.locator === path.join(vault, 'Projects', 'Exclusive Folder Claim'));
    assert.equal(claims.length, 1);
  });
});

async function withInterruptedPluginSessionProvisioning(run) {
  await fixture(async ({ vault, metadata }) => {
    const boundary = pluginSessionBoundary();
    let interrupted = false;
    const interruptingMetadata = {
      ...metadata,
      completeTopicProvisioning(input) {
        if (!interrupted) { interrupted = true; throw new Error('fictional post-session activation interruption'); }
        return metadata.completeTopicProvisioning(input);
      }
    };
    const logicalOperationId = randomUUID();
    const first = createTopicService({ metadata: interruptingMetadata, noteVaultRoot: vault, gateway: boundary.gateway, sessionStore: boundary.sessionStore });
    await assert.rejects(first.create({ name: 'Restart Rollback Context', paraCategory: 'project', logicalOperationId }), /activation interruption/);
    const topicId = metadata.getTopicOperation(logicalOperationId).topicId;
    const sessionReference = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'session');
    await run({ boundary, logicalOperationId, metadata, sessionKey: sessionReference.externalSourceId, topicId, vault });
  });
}

test('provisioning rollback refuses an exact Session when history proof is unavailable', async () => {
  await withInterruptedPluginSessionProvisioning(async ({ boundary, logicalOperationId, metadata, sessionKey, topicId, vault }) => {
    let removalAttempted = false;
    const unverifiable = createTopicService({
      metadata,
      noteVaultRoot: vault,
      gateway: boundary.gateway,
      sessionStore: boundary.sessionStore,
      sessionRemover: async () => { removalAttempted = true; }
    });
    await assert.rejects(unverifiable.rollback({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId }), /authoritative proof.*no history/i);
    assert.equal(removalAttempted, false);
    assert.equal(boundary.entries.has(sessionKey), true);
  });
});

test('provisioning rollback refuses an exact Session that contains history', async () => {
  await withInterruptedPluginSessionProvisioning(async ({ boundary, logicalOperationId, metadata, sessionKey, topicId, vault }) => {
    let removalAttempted = false;
    const nonempty = createTopicService({
      metadata,
      noteVaultRoot: vault,
      gateway: boundary.gateway,
      sessionStore: boundary.sessionStore,
      sessionMessages: async () => ({ messages: [{ role: 'user', content: 'must be retained' }] }),
      sessionRemover: async () => { removalAttempted = true; }
    });
    await assert.rejects(nonempty.rollback({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId }), /contains history/i);
    assert.equal(removalAttempted, false);
    assert.equal(boundary.entries.has(sessionKey), true);
  });
});

test('provisioning rollback removes an exact unchanged Session through the public store seam after restart', async () => {
  await withInterruptedPluginSessionProvisioning(async ({ boundary, logicalOperationId, metadata, sessionKey, topicId, vault }) => {
    const restarted = createTopicService({
      metadata,
      noteVaultRoot: vault,
      gateway: boundary.gateway,
      sessionStore: boundary.sessionStore,
      sessionMessages: async () => ({ messages: [] }),
      sessionRemover: async ({ sessionKey: exactKey, sessionId, expectedRevision }) => {
        const entry = boundary.entries.get(exactKey);
        assert.equal(exactKey, sessionKey);
        assert.equal(entry.sessionId, sessionId);
        assert.equal(String(entry.updatedAt), expectedRevision);
        boundary.entries.delete(exactKey);
      }
    });
    const rolledBack = await restarted.rollback({ topicId, expectedRevision: metadata.getTopic(topicId).revision, logicalOperationId });
    assert.equal(rolledBack.status, 'not-applied');
    assert.equal(boundary.entries.has(sessionKey), false);
    assert.equal(metadata.getTopic(topicId), null);
  });
});

test('activated Topics refuse permanent deletion', async () => {
  await fixture(async ({ metadata, topics }) => {
    const created = await topics.create({ name: 'Protected Context', paraCategory: 'area', logicalOperationId: randomUUID() });
    assert.throws(() => metadata.deleteTopic(created.topic.topicId), /permanently deleted/i);
  });
});

test('Primary Session replacement preserves the former reference and Topic identity', async () => {
  await fixture(async ({ vault, metadata, topics }) => {
    const created = await topics.create({ name: 'Replacement Context', paraCategory: 'area', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const former = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'session');
    const replacementService = createTopicService({
      metadata,
      noteVaultRoot: vault,
      sessionAdapterFactory: ({ topicId: exactTopicId }) => ({
        async create({ logicalOperationId, isPrimary, label }) {
          const reference = createSourceReference({ referenceId: `session:${exactTopicId}:${logicalOperationId}`, topicId: exactTopicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: `agent:main:command-center:${logicalOperationId}` });
          metadata.createSourceReference(reference);
          metadata.setSessionState({ referenceId: reference.referenceId, sessionId: logicalOperationId, status: 'open', isPrimary });
          return { sourceReference: reference, sessionId: logicalOperationId, label };
        }
      })
    });
    const before = replacementService.get(topicId);
    const replaced = await replacementService.replacePrimarySession({ topicId, expectedRevision: before.revision, logicalOperationId: randomUUID() });
    assert.equal(replaced.topicId, topicId);
    assert.equal(replaced.revision, before.revision + 1);
    assert.equal(metadata.getSessionState(former.referenceId).isPrimary, false);
    assert.equal(metadata.listSourceReferences(topicId).some((item) => item.referenceId === former.referenceId), true);
    assert.equal(metadata.listSourceReferences(topicId).filter((item) => metadata.getSessionState(item.referenceId)?.isPrimary).length, 1);
  });
});

test('missing replacement Primary recovers the exact reference and resumes lifecycle writes', async () => {
  await fixture(async ({ vault, metadata, topics }) => {
    let rows = [];
    const patches = [];
    const gateway = { async request(method, params) {
      if (method === 'sessions.list') return { sessions: rows };
      if (method === 'sessions.patch') { patches.push(params); return { ['k' + 'ey']: params['k' + 'ey'], sessionId: params.expectedSessionId }; }
      throw new Error(`Unexpected ${method}`);
    } };
    const created = await topics.create({ name: 'Replacement Recovery', paraCategory: 'project', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const former = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'session');
    const replacementService = createTopicService({
      metadata,
      noteVaultRoot: vault,
      gateway,
      sessionAdapterFactory: ({ topicId: exactTopicId }) => ({
        async create({ logicalOperationId, isPrimary, label }) {
          const reference = createSourceReference({ referenceId: `session:${exactTopicId}:${logicalOperationId}`, topicId: exactTopicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: `agent:main:command-center:${logicalOperationId}` });
          metadata.createSourceReference(reference);
          metadata.setSessionState({ referenceId: reference.referenceId, sessionId: logicalOperationId, status: 'open', isPrimary });
          return { sourceReference: reference, sessionId: logicalOperationId, label };
        }
      })
    });
    await replacementService.replacePrimarySession({ topicId, expectedRevision: replacementService.get(topicId).revision, logicalOperationId: randomUUID() });
    const replacement = metadata.listSourceReferences(topicId).find((item) => metadata.getSessionState(item.referenceId)?.isPrimary);
    assert.notEqual(replacement.referenceId, former.referenceId);

    await assert.rejects(
      replacementService.rename({ topicId, name: 'Blocked While Missing', expectedRevision: replacementService.get(topicId).revision, logicalOperationId: randomUUID() }),
      /Primary Session is unavailable/i
    );
    const required = metadata.listSourceRecovery(topicId).filter((item) => item.state === 'required');
    assert.deepEqual(required.map((item) => item.referenceId), [replacement.referenceId]);
    assert.equal(required.some((item) => item.referenceId === former.referenceId), false);

    const replacementState = metadata.getSessionState(replacement.referenceId);
    rows = [{ ['k' + 'ey']: replacement.externalSourceId, sessionId: replacementState.sessionId, lifecycleRevision: 'replacement-recovery-revision', label: 'Replacement Recovery' }];
    await replacementService.recoveryVerify({ topicId, referenceId: replacement.referenceId, expectedRevision: replacementService.get(topicId).revision, expectedSourceRevision: `unbound:${replacement.referenceId}`, logicalOperationId: randomUUID() });
    const renamed = await replacementService.rename({ topicId, name: 'Replacement Recovery Resumed', expectedRevision: replacementService.get(topicId).revision, logicalOperationId: randomUUID() });
    assert.equal(renamed.name, 'Replacement Recovery Resumed');
    assert.equal(metadata.listSourceRecovery(topicId).some((item) => item.state === 'required'), false);
    assert.equal(patches.length, 1);
    assert.equal(patches[0]['k' + 'ey'], replacement.externalSourceId);
  });
});

test('Session Source Recovery relinks or replaces exact identities while retaining Topic, former reference, and recovery history', async (t) => {
  await fixture(async ({ vault, metadata, sessionAdapterFactory }) => {
    let sessions = [];
    const gateway = { request: async (method) => method === 'sessions.list' ? { sessions } : (() => { throw new Error(`Unexpected ${method}`); })() };
    const topics = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory, gateway });
    const created = await topics.create({ name: 'Session Recovery Context', paraCategory: 'project', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const reference = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'session');
    await topics.markSourceMissing(topicId, reference.referenceId, 'exact Session missing');
    sessions = [{ ['k' + 'ey']: 'agent:main:command-center:replacement', sessionId: 'fictional-replacement-id' }];
    const beforeRelinkRevision = topics.get(topicId).revision;
    const expectedSourceRevision = metadata.getSessionState(reference.referenceId).sessionId;
    const interruptedLocator = metadata.getSourceLocator(reference.referenceId);
    metadata.setSourceLocator({ referenceId: reference.referenceId, locator: sessions[0].key, locatorVersion: interruptedLocator.locatorVersion + 1, ownership: 'external', observedRevision: sessions[0].sessionId });
    assert.equal(metadata.getSessionState(reference.referenceId).sessionId, expectedSourceRevision);
    const result = await topics.recoveryRelink({ topicId, referenceId: reference.referenceId, sessionKey: sessions[0].key, sessionId: sessions[0].sessionId, expectedRevision: beforeRelinkRevision, expectedSourceRevision, logicalOperationId: randomUUID() });
    assert.equal(result.status, 'relinked');
    assert.equal(topics.get(topicId).revision, beforeRelinkRevision + 1);
    assert.equal(metadata.getSourceReference(reference.referenceId).referenceId, reference.referenceId);
    assert.equal(metadata.getSourceLocator(reference.referenceId).locator, sessions[0].key);
    assert.equal(topics.get(topicId).usable, true);
    assert.equal(topics.get(topicId).recovery.at(-1).state, 'replaced');
    await topics.markSourceMissing(topicId, reference.referenceId, 'replacement requested for missing Primary Session');
    sessions = [{ ['k' + 'ey']: 'agent:main:command-center:replacement-two', sessionId: 'fictional-replacement-id-two' }];
    const beforeReplaceRevision = topics.get(topicId).revision;
    const replacement = await topics.recoveryReplace({ topicId, referenceId: reference.referenceId, sessionKey: sessions[0].key, sessionId: sessions[0].sessionId, expectedRevision: beforeReplaceRevision, expectedSourceRevision: metadata.getSourceLocator(reference.referenceId).observedRevision, logicalOperationId: randomUUID() });
    assert.equal(topics.get(topicId).revision, beforeReplaceRevision + 1);
    assert.notEqual(replacement.replacementReferenceId, reference.referenceId);
    assert.equal(metadata.getSourceReference(reference.referenceId).referenceId, reference.referenceId);
    assert.equal(metadata.getSessionState(reference.referenceId).isPrimary, false);
    assert.equal(metadata.getSessionState(replacement.replacementReferenceId).isPrimary, true);
    assert.equal(metadata.listSourceReferences(topicId).filter((item) => item.sourceKind === 'session').length, 2);
    assert.equal(topics.get(topicId).recovery.at(-1).state, 'replaced');
    const recoveryRows = metadata.listSourceRecovery(topicId);
    assert.equal(recoveryRows.length, 1);
    assert.equal(recoveryRows[0].state, 'replaced');
    assert.match(recoveryRows[0].failure, /replacement/);
    await t.test('browse retains replaced history without blocking the exact replacement', async () => {
      const sessionStore = { listSessionEntries: () => sessions.map(({ key, ...entry }) => ({ sessionKey: key, entry })) };
      const adapter = createSessionAdapter({ metadata, topicId, gateway, sessionStore });
      const listed = await adapter.list();
      const former = listed.conversations.find((row) => row.referenceId === reference.referenceId);
      assert.equal(former.availability, 'replaced-unavailable');
      assert.equal(former.isPrimary, false);
      assert.equal(listed.conversations.find((row) => row.isPrimary).referenceId, replacement.replacementReferenceId);
      await assert.rejects(adapter.navigate({ referenceId: reference.referenceId }), /missing or replaced/);
      await assert.rejects(adapter.history({ referenceId: reference.referenceId }), /missing or replaced/);
      await assert.rejects(adapter.send({ referenceId: reference.referenceId, logicalOperationId: randomUUID(), message: 'must not dispatch' }), /missing or replaced/);
    });
    await t.test('search snapshots exclude unavailable replaced content, not live sources', async () => {
      const reads = [];
      const api = { runtime: { agent: { session: { listSessionEntries: () => sessions.map(({ key, ...entry }) => ({ sessionKey: key, entry })) } } } };
      const snapshot = await readConversationSourceSnapshot({ metadata, topicId, gateway, api, transcriptReader: async ({ sessionKey }) => {
        reads.push(sessionKey);
        assert.equal(sessionKey, sessions[0].key, 'deleted former Session must not be read or represented as empty history');
        return [];
      } });
      assert.equal(snapshot.conversations.length, 1);
      assert.equal(snapshot.conversations[0].sourceReference.referenceId, replacement.replacementReferenceId);
      assert.equal(reads.length, 2, 'replacement history retains its independent verification read');
    });
  });
});

test('Session recovery relink rejects another Topic effective locator without changing Topic or recovery state', async () => {
  await fixture(async ({ vault, metadata, sessionAdapterFactory }) => {
    const rows = [];
    const gateway = { request: async (method) => method === 'sessions.list' ? { sessions: rows } : (() => { throw new Error(`Unexpected ${method}`); })() };
    const topics = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory, gateway });
    const first = await topics.create({ name: 'Recovery Owner One', paraCategory: 'project', logicalOperationId: randomUUID() });
    const second = await topics.create({ name: 'Recovery Owner Two', paraCategory: 'area', logicalOperationId: randomUUID() });
    const firstSession = metadata.listSourceReferences(first.topic.topicId).find((item) => item.sourceKind === 'session');
    const secondSession = metadata.listSourceReferences(second.topic.topicId).find((item) => item.sourceKind === 'session');
    const secondState = metadata.getSessionState(secondSession.referenceId);
    const secondLocator = metadata.getSourceLocator(secondSession.referenceId);
    const alternateOwnedKey = 'agent:main:command-center:owned-alternate';
    metadata.setSourceLocator({ ...secondLocator, locator: alternateOwnedKey, locatorVersion: secondLocator.locatorVersion + 1 });
    rows.push(
      { ['k' + 'ey']: secondSession.externalSourceId, sessionId: secondState.sessionId },
      { ['k' + 'ey']: alternateOwnedKey, sessionId: secondState.sessionId }
    );
    await topics.markSourceMissing(first.topic.topicId, firstSession.referenceId, 'exact Session missing');
    const before = topics.get(first.topic.topicId);
    const beforeRecovery = metadata.listSourceRecovery(first.topic.topicId);
    const beforeLocator = metadata.getSourceLocator(firstSession.referenceId);
    const expectedSourceRevision = beforeLocator.observedRevision ?? metadata.getSessionState(firstSession.referenceId).sessionId;

    metadata.createTopic({ topicId: 'topic-reverse-owner', name: 'Reverse Owner', paraCategory: 'resource', lifecycle: 'active' });
    assert.throws(
      () => metadata.createSourceReference(createSourceReference({ referenceId: 'session:reverse-owner', topicId: 'topic-reverse-owner', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: alternateOwnedKey })),
      (error) => error.code === 'conflict' && /another Source Reference locator/i.test(error.message)
    );
    assert.equal(metadata.listSourceReferences('topic-reverse-owner').length, 0);

    for (const sessionKey of [secondSession.externalSourceId, alternateOwnedKey]) {
      await assert.rejects(
        topics.recoveryRelink({ topicId: first.topic.topicId, referenceId: firstSession.referenceId, sessionKey, sessionId: secondState.sessionId, expectedRevision: before.revision, expectedSourceRevision, logicalOperationId: randomUUID() }),
        (error) => error.code === 'conflict' && /another Source Reference/i.test(error.message)
      );
      assert.equal(topics.get(first.topic.topicId).revision, before.revision);
      assert.deepEqual(metadata.getSourceLocator(firstSession.referenceId), beforeLocator);
      assert.deepEqual(metadata.listSourceRecovery(first.topic.topicId), beforeRecovery);
    }
  });
});

test('Session recovery relink uses the effective locator for the next lifecycle mutation', async () => {
  await fixture(async ({ vault, metadata, sessionAdapterFactory }) => {
    let row;
    const patches = [];
    const gateway = { async request(method, params) {
      if (method === 'sessions.list') return { sessions: row ? [row] : [] };
      if (method === 'sessions.patch') { patches.push(params); row = { ...row, label: params.label }; return { ['k' + 'ey']: row['k' + 'ey'], sessionId: row.sessionId }; }
      throw new Error(`Unexpected ${method}`);
    } };
    const topics = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory, gateway });
    const created = await topics.create({ name: 'Recovery Lifecycle', paraCategory: 'project', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const reference = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'session');
    const replacementKey = 'agent:main:command-center:relinked-lifecycle';
    const replacementId = 'fictional-relinked-lifecycle-id';
    row = { ['k' + 'ey']: replacementKey, sessionId: replacementId, lifecycleRevision: 'fictional-relinked-revision', label: 'Recovery Lifecycle' };
    await topics.markSourceMissing(topicId, reference.referenceId, 'exact Session missing');
    const beforeRelink = topics.get(topicId);
    await topics.recoveryRelink({ topicId, referenceId: reference.referenceId, sessionKey: replacementKey, sessionId: replacementId, expectedRevision: beforeRelink.revision, expectedSourceRevision: metadata.getSourceLocator(reference.referenceId).observedRevision ?? metadata.getSessionState(reference.referenceId).sessionId, logicalOperationId: randomUUID() });

    const beforeRename = topics.get(topicId);
    const renamed = await topics.rename({ topicId, name: 'Recovery Lifecycle Renamed', expectedRevision: beforeRename.revision, logicalOperationId: randomUUID() });
    assert.equal(renamed.name, 'Recovery Lifecycle Renamed');
    assert.equal(metadata.getSourceLocator(reference.referenceId).locator, replacementKey);
    assert.equal(patches.length, 1);
    assert.equal(patches[0]['k' + 'ey'], replacementKey);
  });
});

test('managed Session rename is fenced by exact Session identity and lifecycle revision', async () => {
  await fixture(async ({ metadata, vault, sessionAdapterFactory }) => {
    const calls = [];
    let row;
    const gateway = { async request(method, params) {
      calls.push([method, params]);
      if (method === 'sessions.list') return { sessions: [row] };
      if (method === 'sessions.patch') return { ['k' + 'ey']: row['k' + 'ey'], sessionId: row.sessionId };
      throw new Error(`unexpected method ${method}`);
    } };
    const topics = createTopicService({ metadata, noteVaultRoot: vault, sessionAdapterFactory, gateway });
    const created = await topics.create({ name: 'Session Fence Context', paraCategory: 'project', logicalOperationId: randomUUID() });
    const topicId = created.topic.topicId;
    const session = metadata.listSourceReferences(topicId).find((item) => item.sourceKind === 'session');
    const state = metadata.getSessionState(session.referenceId);
    row = { ['k' + 'ey']: session.externalSourceId, sessionId: state.sessionId, lifecycleRevision: 'fictional-session-revision' };
    await topics.rename({ topicId, name: 'Session Fence Renamed', expectedRevision: topics.get(topicId).revision, logicalOperationId: randomUUID() });
    assert.deepEqual(calls.at(-1), ['sessions.patch', { ['k' + 'ey']: row['k' + 'ey'], expectedSessionId: row.sessionId, expectedLifecycleRevision: row.lifecycleRevision, label: 'Session Fence Renamed' }]);

    row = { ...row, sessionId: 'replacement-session-id' };
    await assert.rejects(topics.rename({ topicId, name: 'Must Not Rename Replacement', expectedRevision: topics.get(topicId).revision, logicalOperationId: randomUUID() }), /identity and revision cannot be verified|Primary Session is unavailable/i);
    assert.equal(calls.filter(([method]) => method === 'sessions.patch').length, 1);
  });
});

test('managed Session rename uses the public Session store with exact identity and revision fencing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-runtime-rename-'));
  const vault = path.join(root, 'vault');
  const boundary = pluginSessionBoundary();
  await mkdir(vault, { recursive: true });
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(root, 'state'), capabilities: { notes: true, sessions: true } });
  try {
    const topics = createTopicService({ metadata, noteVaultRoot: vault, gateway: boundary.gateway, sessionStore: boundary.sessionStore });
    const created = await topics.create({ name: 'Runtime Rename', paraCategory: 'project', logicalOperationId: randomUUID() });
    const session = metadata.listSourceReferences(created.topic.topicId).find((item) => item.sourceKind === 'session');
    await topics.rename({ topicId: created.topic.topicId, name: 'Runtime Renamed', expectedRevision: created.topic.revision, logicalOperationId: randomUUID() });
    assert.equal(boundary.entries.get(session.externalSourceId).label, 'Runtime Renamed');
    boundary.entries.set(session.externalSourceId, { ...boundary.entries.get(session.externalSourceId), label: 'Customized Session Label' });
    await topics.rename({ topicId: created.topic.topicId, name: 'Topic Renamed Again', expectedRevision: topics.get(created.topic.topicId).revision, logicalOperationId: randomUUID() });
    assert.equal(boundary.entries.get(session.externalSourceId).label, 'Customized Session Label');
    assert.equal(metadata.getSourceConventionState(session.referenceId).find((item) => item.aspect === 'display_label').state, 'customized');
  } finally {
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
});
