import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, access, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { enrollNoteFolderIdentity } from '../src/sources/note-folder-identity.mjs';
import { createTopicLifecycleService } from '../src/topics/lifecycle.mjs';

const capabilities = { notes: true, sessions: true, scheduler: true };
const sessionStore = { listSessionEntries: () => [{ sessionKey: 'fixture:session', entry: { sessionId: 'fixture-session-id' } }] };
async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'structural-completion-'));
  const vault = path.join(stateDir, 'vault'); const folder = path.join(vault, 'Projects', 'Fictional');
  await mkdir(folder, { recursive: true });
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  try {
    metadata.createTopic({ topicId: 'fictional-topic', name: 'Fictional', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'fixture-folder', topicId: 'fictional-topic', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folder });
    metadata.setSourceLocator({ referenceId: 'fixture-folder', locator: folder, ownership: 'created', observedRevision: await enrollNoteFolderIdentity(folder) });
    metadata.setSourceConventionState({ referenceId: 'fixture-folder', aspect: 'location', state: 'managed', expectedValue: folder });
    metadata.createSourceReference({ version: 1, referenceId: 'fixture-session', topicId: 'fictional-topic', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'fixture:session' });
    metadata.setSessionState({ referenceId: 'fixture-session', sessionId: 'fixture-session-id', status: 'open', isPrimary: true });
    const reopen = () => { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities }); return metadata; };
    const lifecycle = () => createTopicLifecycleService({ metadata, noteVaultRoot: vault, sessionStore, commitmentProvider: async () => [] });
    await run({ stateDir, vault, folder, metadata, reopen, lifecycle });
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('Structural Change resumes its own interrupted folder move after reopening SQLite', async () => {
  await fixture(async ({ stateDir, vault, folder, metadata, reopen, lifecycle }) => {
    const preview = lifecycle().recategorizePreview({ topicId: 'fictional-topic', paraCategory: 'area' });
    const input = { topicId: 'fictional-topic', paraCategory: 'area', logicalOperationId: randomUUID(), previewDigest: preview.digest, structuralChangeId: preview.structuralChangeId };
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/structural-interrupted-move.mjs', stateDir, vault, JSON.stringify(input)], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    await assert.rejects(access(folder), { code: 'ENOENT' });
    assert.equal(metadata.getTopic('fictional-topic').paraCategory, 'project');
    const reopened = reopen();
    const completed = await lifecycle().recategorizeConfirm(input);
    assert.equal(completed.paraCategory, 'area');
    assert.equal(completed.revision, preview.expectedRevisions[0].revision + 1);
    assert.equal(reopened.getTopicOperation(input.logicalOperationId).state, 'applied');
    assert.equal(reopened.getSourceLocator('fixture-folder').locator, preview.changes.find(change => change.aspect === 'note-folder-location').to);
    assert.equal(reopened.getSourceConventionState('fixture-folder').find(item => item.aspect === 'location').expectedValue, reopened.getSourceLocator('fixture-folder').locator);
  });
});

test('Topic rename replay returns its immutable owned result despite a later unrelated Topic edit', async () => {
  await fixture(async ({ metadata, reopen, lifecycle }) => {
    const input = { topicId: 'fictional-topic', name: 'Renamed', expectedRevision: 0, logicalOperationId: randomUUID() };
    const result = await lifecycle().rename(input);
    metadata.setTopicName({ topicId: input.topicId, name: 'Later name', expectedRevision: result.revision });
    const reopened = reopen();
    assert.deepEqual(await lifecycle().rename(input), result);
    assert.equal(reopened.getTopicName(input.topicId), 'Later name');
    await assert.rejects(lifecycle().rename({ ...input, expectedRevision: result.revision }), { code: 'intent-mismatch' });
  });
});

test('Primary replacement does not publish a new Primary when its original Topic base changes during creation', async () => {
  await fixture(async ({ metadata, vault }) => {
    const lifecycle = createTopicLifecycleService({ metadata, noteVaultRoot: vault, sessionStore, sessionAdapterFactory: () => ({
      async create({ isPrimary }) {
        metadata.createSourceReference({ version: 1, referenceId: 'replacement-session', topicId: 'fictional-topic', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'fixture:replacement' });
        metadata.setSessionState({ referenceId: 'replacement-session', sessionId: 'replacement-id', status: 'open', isPrimary });
        metadata.setTopicName({ topicId: 'fictional-topic', name: 'Competing edit', expectedRevision: 0 });
        return { sourceReference: metadata.getSourceReference('replacement-session') };
      }
    }) });
    await assert.rejects(lifecycle.replacePrimarySession({ topicId: 'fictional-topic', expectedRevision: 0, logicalOperationId: randomUUID() }), { code: 'conflict' });
    assert.equal(metadata.getSessionState('fixture-session').isPrimary, true);
    assert.equal(metadata.getSessionState('replacement-session').isPrimary, false);
  });
});

test('pending Structural Change cannot be replayed through another Topic or mutated preview target', async () => {
  await fixture(async ({ stateDir, vault, metadata, lifecycle }) => {
    const preview = lifecycle().recategorizePreview({ topicId: 'fictional-topic', paraCategory: 'area' });
    const logicalOperationId = randomUUID();
    const authorized = { topicId: preview.topicId, paraCategory: 'area', logicalOperationId, previewDigest: preview.digest, structuralChangeId: preview.structuralChangeId };
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/structural-interrupted-move.mjs', stateDir, vault, JSON.stringify(authorized)], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const input = { topicId: 'different-topic', paraCategory: 'area', logicalOperationId, previewDigest: preview.digest, structuralChangeId: preview.structuralChangeId };
    await assert.rejects(lifecycle().recategorizeConfirm(input), { code: 'intent-mismatch' });
    await assert.rejects(lifecycle().recategorizeConfirm({ ...input, topicId: preview.topicId, paraCategory: 'resource' }), { code: 'intent-mismatch' });
    assert.equal(metadata.getTopic(preview.topicId).paraCategory, 'project');
  });
});

test('concurrent duplicate renames cannot downgrade their completed receipt', async () => {
  await fixture(async ({ metadata, lifecycle }) => {
    const input = { topicId: 'fictional-topic', name: 'Renamed', expectedRevision: 0, logicalOperationId: randomUUID() };
    const results = await Promise.all([lifecycle().rename(input), lifecycle().rename(input)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(metadata.getTopicOperation(input.logicalOperationId).state, 'applied');
    assert.equal(metadata.getTopic('fictional-topic').revision, 1);
  });
});

for (const kind of ['archive', 'restore']) test(`${kind} resumes its owned move and retains an immutable receipt`, async () => {
  await fixture(async ({ stateDir, vault, metadata, reopen, lifecycle }) => {
    if (kind === 'restore') metadata.updateTopic({ topicId: 'fictional-topic', paraCategory: 'archive', expectedRevision: 0 });
    const preview = await lifecycle()[`${kind}Preview`]({ topicId: 'fictional-topic', paraCategory: 'area' });
    const input = { topicId: preview.topicId, ...(kind === 'restore' ? { paraCategory: 'area' } : {}), logicalOperationId: randomUUID(), previewDigest: preview.digest, structuralChangeId: preview.structuralChangeId };
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/structural-interrupted-move.mjs', stateDir, vault, JSON.stringify(input), `${kind}Confirm`], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const reopened = reopen();
    const result = await lifecycle()[`${kind}Confirm`](input);
    assert.equal(result.paraCategory, kind === 'restore' ? 'area' : 'archive');
    reopened.setTopicName({ topicId: input.topicId, name: 'Later change', expectedRevision: result.revision });
    assert.deepEqual(await lifecycle()[`${kind}Confirm`](input), result);
    assert.equal(reopened.getTopic(input.topicId).name, 'Later change');
  });
});

test('recategorization never replaces its original Topic base with a newer revision after source preparation', async () => {
  await fixture(async ({ metadata, vault, lifecycle }) => {
    const preview = lifecycle().recategorizePreview({ topicId: 'fictional-topic', paraCategory: 'area' });
    const current = metadata.getSourceLocator('fixture-folder');
    const owner = createTopicLifecycleService({ metadata, noteVaultRoot: vault, gateway: { async request(method) {
      assert.equal(method, 'sessions.list');
      metadata.setTopicName({ topicId: preview.topicId, name: 'Competing edit', expectedRevision: 0 });
      return [{ sessionKey: 'fixture:session', sessionId: 'fixture-session-id' }];
    } } });
    await assert.rejects(owner.recategorizeConfirm({ topicId: preview.topicId, paraCategory: 'area', logicalOperationId: randomUUID(), previewDigest: preview.digest, structuralChangeId: preview.structuralChangeId }), { code: 'conflict' });
    assert.equal(metadata.getTopic(preview.topicId).name, 'Competing edit');
    assert.equal(metadata.getTopic(preview.topicId).paraCategory, 'project');
    assert.deepEqual(metadata.getSourceLocator('fixture-folder'), current);
  });
});

test('process death before Structural completion commit leaves every local field and receipt retryable together', async () => {
  await fixture(async ({ stateDir, vault, metadata, reopen, lifecycle }) => {
    const before = lifecycle().snapshot('fictional-topic');
    const preview = lifecycle().recategorizePreview({ topicId: before.topicId, paraCategory: 'area' });
    const input = { topicId: before.topicId, paraCategory: 'area', logicalOperationId: randomUUID(), previewDigest: preview.digest, structuralChangeId: preview.structuralChangeId };
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/structural-interrupted-move.mjs', stateDir, vault, JSON.stringify(input), 'recategorizeConfirm', 'before-metadata-commit'], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const reopened = reopen();
    assert.deepEqual(lifecycle().snapshot(before.topicId), before);
    assert.equal(reopened.getTopicOperation(input.logicalOperationId).state, 'pending');
    const result = await lifecycle().recategorizeConfirm(input);
    assert.equal(result.paraCategory, 'area');
    assert.equal(reopened.getTopicOperation(input.logicalOperationId).state, 'applied');
  });
});

test('managed folder rename resumes its exact move before publishing name and conventions', async () => {
  await fixture(async ({ stateDir, vault, metadata, reopen, lifecycle }) => {
    metadata.setSourceConventionState({ referenceId: 'fixture-folder', aspect: 'name', state: 'managed', expectedValue: 'Fictional' });
    const input = { topicId: 'fictional-topic', name: 'Renamed', expectedRevision: 0, logicalOperationId: randomUUID() };
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/structural-interrupted-move.mjs', stateDir, vault, JSON.stringify(input), 'rename'], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const reopened = reopen();
    assert.equal(reopened.getTopicName(input.topicId), 'Fictional');
    const result = await lifecycle().rename(input);
    assert.equal(result.name, 'Renamed');
    assert.equal(path.basename(reopened.getSourceLocator('fixture-folder').locator), 'Renamed');
    assert.equal(reopened.getSourceConventionState('fixture-folder').find(item => item.aspect === 'name').expectedValue, 'Renamed');
  });
});

test('Primary replacement uses real Session creation ownership and replays its atomic selection receipt', async () => {
  await fixture(async ({ metadata, vault, reopen }) => {
    let created; let disabled = false;
    const gateway = { async request(method, params) {
      assert.equal(disabled, false, 'Completed replay must not repeat native Session work.');
      if (method === 'sessions.create') return created = { key: 'fixture:replacement', sessionId: 'replacement-id', updatedAt: 5, label: params.label };
      if (method === 'sessions.list') return { sessions: created ? [created] : [] };
      throw new Error(`Unexpected native boundary: ${method}`);
    } };
    const input = { topicId: 'fictional-topic', expectedRevision: 0, logicalOperationId: randomUUID() };
    const owner = createTopicLifecycleService({ metadata, noteVaultRoot: vault, gateway, sessionStore });
    const result = await owner.replacePrimarySession(input);
    assert.equal(result.revision, 1);
    assert.equal(metadata.getSessionState('fixture-session').isPrimary, false);
    const replacement = metadata.listSessionStates().find(item => item.sessionId === 'replacement-id');
    assert.equal(replacement.isPrimary, true);
    metadata.setTopicName({ topicId: input.topicId, name: 'Later edit', expectedRevision: result.revision });
    disabled = true;
    const reopened = reopen();
    assert.deepEqual(await createTopicLifecycleService({ metadata: reopened, noteVaultRoot: vault, gateway, sessionStore }).replacePrimarySession(input), result);
    assert.equal(reopened.getTopicName(input.topicId), 'Later edit');
  });
});

test('Structural completion rejects Source Recovery published while source work was awaiting', async () => {
  await fixture(async ({ metadata, vault }) => {
    const owner = createTopicLifecycleService({ metadata, noteVaultRoot: vault, gateway: { async request() {
      metadata.recordSourceRecovery({ recoveryId: 'fixture-recovery', referenceId: 'fixture-folder', topicId: 'fictional-topic', sourceKind: 'note_folder', state: 'required', failure: 'Fictional ownership review required.' });
      return [{ sessionKey: 'fixture:session', sessionId: 'fixture-session-id' }];
    } } });
    await assert.rejects(owner.rename({ topicId: 'fictional-topic', name: 'Renamed', expectedRevision: 0, logicalOperationId: randomUUID() }), { code: 'source-recovery' });
    assert.equal(metadata.getTopicName('fictional-topic'), 'Fictional');
    assert.equal(metadata.getTopic('fictional-topic').revision, 0);
  });
});

test('duplicate Primary replacement resumes after the first caller has already committed selection', async () => {
  await fixture(async ({ metadata, vault }) => {
    let created; let listings = 0;
    const firstCompleted = Promise.withResolvers();
    const gateway = { async request(method, params) {
      if (method === 'sessions.create') return created = { key: 'fixture:replacement', sessionId: 'replacement-id', updatedAt: 5, label: params.label };
      if (method === 'sessions.list') {
        if (++listings > 1) await firstCompleted.promise;
        return { sessions: created ? [created] : [] };
      }
      throw new Error(`Unexpected native boundary: ${method}`);
    } };
    const input = { topicId: 'fictional-topic', expectedRevision: 0, logicalOperationId: randomUUID() };
    const owner = () => createTopicLifecycleService({ metadata, noteVaultRoot: vault, gateway, sessionStore });
    const first = owner().replacePrimarySession(input).finally(() => firstCompleted.resolve());
    const duplicate = owner().replacePrimarySession(input);
    const results = await Promise.all([first, duplicate]);
    assert.deepEqual(results[1], results[0]);
    assert.equal(metadata.getTopic(input.topicId).revision, 1);
    assert.equal(metadata.getTopicOperation(input.logicalOperationId).state, 'applied');
    assert.equal(metadata.listSessionStates().filter(item => item.isPrimary).length, 1);
    assert.equal(metadata.listSessionStates().find(item => item.isPrimary).sessionId, 'replacement-id');
  });
});

test('delayed Primary creation cannot adopt a different operation completion or its newer Topic base', async () => {
  await fixture(async ({ metadata, vault }) => {
    const pendingId = randomUUID(); const siblingId = randomUUID();
    const entered = Promise.withResolvers(); const release = Promise.withResolvers();
    const entries = new Map();
    const gateway = { async request(method, params) {
      if (method === 'sessions.create') {
        if (params.idempotencyKey === pendingId) { entered.resolve(); await release.promise; }
        const entry = { key: `fixture:${params.idempotencyKey}`, sessionId: `fixture-id:${params.idempotencyKey}`, updatedAt: 5, label: params.label };
        entries.set(entry.key, entry); return entry;
      }
      if (method === 'sessions.list') return { sessions: [...entries.values()] };
      throw new Error(`Unexpected native boundary: ${method}`);
    } };
    const owner = () => createTopicLifecycleService({ metadata, noteVaultRoot: vault, gateway, sessionStore });
    const pending = owner().replacePrimarySession({ topicId: 'fictional-topic', expectedRevision: 0, logicalOperationId: pendingId });
    const rejected = assert.rejects(pending, { code: 'conflict' });
    try {
      await entered.promise;
      const sibling = await owner().replacePrimarySession({ topicId: 'fictional-topic', expectedRevision: 0, logicalOperationId: siblingId });
      release.resolve(); await rejected;
      assert.equal(metadata.getTopic('fictional-topic').revision, sibling.revision);
      assert.equal(metadata.getTopicOperation(siblingId).state, 'applied');
      assert.notEqual(metadata.getTopicOperation(pendingId).state, 'applied');
      assert.equal(metadata.listSessionStates().find(item => item.isPrimary).sessionId, `fixture-id:${siblingId}`);
    } finally { release.resolve(); await pending.catch(() => {}); }
  });
});

test('archive preview waits for an owned folder move instead of publishing false Source Recovery', async () => {
  await fixture(async ({ metadata, vault, lifecycle }) => {
    metadata.setSourceConventionState({ referenceId: 'fixture-folder', aspect: 'name', state: 'managed', expectedValue: 'Fictional' });
    metadata.setSourceConventionState({ referenceId: 'fixture-session', aspect: 'display_label', state: 'managed', expectedValue: 'Fictional' });
    const entered = Promise.withResolvers(); const release = Promise.withResolvers();
    const owner = createTopicLifecycleService({ metadata, noteVaultRoot: vault, sessionStore, sessionRenamer: async () => { entered.resolve(); await release.promise; return { status: 'applied' }; } });
    const renaming = owner.rename({ topicId: 'fictional-topic', name: 'Renamed', expectedRevision: 0, logicalOperationId: randomUUID() });
    const renameOutcome = renaming.then(value => ({ value }), error => ({ error }));
    let previewing;
    try {
      await entered.promise;
      previewing = lifecycle().archivePreview({ topicId: 'fictional-topic' }).then(value => ({ value }), error => ({ error }));
      // The held external Session reply leaves a real move/publication window.
      await delay(100);
      assert.deepEqual(metadata.listSourceRecovery('fictional-topic'), []);
      release.resolve();
      const renamed = await renameOutcome;
      assert.equal(renamed.error, undefined);
      const preview = await previewing;
      assert.equal(preview.error, undefined);
      assert.equal(preview.value.expectedRevisions.find(item => item.source === 'topic').revision, renamed.value.revision);
      assert.equal(path.basename(preview.value.changes.find(change => change.aspect === 'note-folder-location').from), 'Renamed');
      assert.deepEqual(metadata.listSourceRecovery('fictional-topic'), []);
    } finally { release.resolve(); await renameOutcome; await previewing; }
  });
});

test('archive preview refuses an old snapshot instead of attaching a newer Topic revision after awaiting commitments', async () => {
  await fixture(async ({ metadata, vault }) => {
    const owner = createTopicLifecycleService({ metadata, noteVaultRoot: vault, sessionStore, commitmentProvider: async () => {
      metadata.setTopicName({ topicId: 'fictional-topic', name: 'Competing edit', expectedRevision: 0 });
      return [];
    } });
    await assert.rejects(owner.archivePreview({ topicId: 'fictional-topic' }), { code: 'conflict' });
    assert.deepEqual(metadata.listSourceRecovery('fictional-topic'), []);
  });
});

test('readiness rejects a changed snapshot before recording missing Session evidence against it', async () => {
  await fixture(async ({ metadata, vault }) => {
    const owner = createTopicLifecycleService({ metadata, noteVaultRoot: vault, gateway: { async request() {
      metadata.setTopicName({ topicId: 'fictional-topic', name: 'Competing edit', expectedRevision: 0 });
      return [];
    } }, commitmentProvider: async () => [] });
    await assert.rejects(owner.archivePreview({ topicId: 'fictional-topic' }), { code: 'conflict' });
    assert.deepEqual(metadata.listSourceRecovery('fictional-topic'), []);
  });
});

test('archive preview still records genuine missing Folder evidence after acquiring the shared owner', async () => {
  await fixture(async ({ metadata, vault, folder, lifecycle }) => {
    await rename(folder, path.join(vault, 'unrelated-displacement'));
    await assert.rejects(lifecycle().archivePreview({ topicId: 'fictional-topic' }), { code: 'source-recovery' });
    const recovery = metadata.listSourceRecovery('fictional-topic');
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].state, 'required');
    assert.equal(recovery[0].referenceId, 'fixture-folder');
    assert.equal(recovery[0].lastLocator, folder);
  });
});

test('legacy pending Primary replacement without an original completion basis refuses before native creation', async () => {
  await fixture(async ({ metadata, vault }) => {
    const input = { topicId: 'fictional-topic', expectedRevision: 0, logicalOperationId: randomUUID() };
    metadata.recordTopicOperation({ logicalOperationId: input.logicalOperationId, topicId: input.topicId, operationKind: 'topics.replace-primary-session', state: 'pending', currentStep: 'create-session', intent: { topicId: input.topicId, expectedRevision: 0 } });
    const references = metadata.listSourceReferences(input.topicId);
    const original = metadata.getTopicOperation(input.logicalOperationId);
    const calls = []; let created;
    const gateway = { async request(method, params) {
      calls.push(method);
      if (method === 'sessions.create') return created = { key: 'fixture:legacy-replacement', sessionId: 'legacy-replacement-id', updatedAt: 5, label: params.label };
      if (method === 'sessions.list') return { sessions: created ? [created] : [] };
      throw new Error(`Unexpected native boundary: ${method}`);
    } };
    const owner = createTopicLifecycleService({ metadata, noteVaultRoot: vault, gateway, sessionStore });
    const outcome = await owner.replacePrimarySession(input).then(value => ({ value }), error => ({ error }));
    assert.deepEqual(calls, []);
    assert.deepEqual(metadata.listSourceReferences(input.topicId), references);
    assert.deepEqual(metadata.getTopicOperation(input.logicalOperationId), original);
    assert.equal(metadata.getOperation(input.logicalOperationId), null);
    assert.equal(outcome.error?.code, 'source-recovery');
    assert.equal(metadata.getSessionState('fixture-session').isPrimary, true);
  });
});
