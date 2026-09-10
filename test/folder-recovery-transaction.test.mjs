import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { TopicRecoveryService } from '../src/topics/recovery.mjs';

const firstIdentity = `note-folder:1:11111111-1111-4111-8111-111111111111:${'1'.repeat(64)}`;
const replacementIdentity = `note-folder:1:22222222-2222-4222-8222-222222222222:${'2'.repeat(64)}`;

async function fixture(run, { bound = true } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'folder-recovery-transaction-'));
  const open = () => openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  let metadata = open(); let competing = open();
  try {
    metadata.createTopic({ topicId: 'fictional-topic', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-folder', topicId: 'fictional-topic', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'note-folder:fictional-topic' });
    const oldLocator = path.join(stateDir, 'original'); const replacement = path.join(stateDir, 'replacement');
    if (bound) metadata.setSourceLocator({ referenceId: 'fictional-folder', locator: oldLocator, observedRevision: firstIdentity, ownership: 'adopted' });
    const intent = { topicId: 'fictional-topic', referenceId: 'fictional-folder', replacementLocator: replacement,
      expectedRevision: metadata.getTopic('fictional-topic').revision, expectedSourceRevision: bound ? firstIdentity : 'unbound:fictional-folder', expectedLocatorVersion: bound ? 1 : 0 };
    const logicalOperationId = randomUUID(); const operationKind = 'topics.recovery.verify';
    metadata.recordTopicOperation({ logicalOperationId, topicId: intent.topicId, operationKind, state: 'pending', currentStep: 'verify-exact-source', intent });
    const recovery = { recoveryId: 'recovery:fictional-folder', topicId: intent.topicId, referenceId: intent.referenceId, sourceKind: 'note_folder', state: 'replaced', lastLocator: replacement, lastIdentity: replacementIdentity, failure: 'explicit replacement', diagnostics: [] };
    const input = { logicalOperationId, operationKind, intent, expectedRevision: intent.expectedRevision, recovery, result: { status: 'replaced', recovery },
      folderBinding: { locator: replacement, observedRevision: replacementIdentity, expectedLocatorVersion: bound ? 1 : 0 } };
    await run({ get metadata() { return metadata; }, competing, input, oldLocator, replacement,
      reopen() { metadata.close(); competing.close(); metadata = open(); competing = open(); } });
  } finally { metadata.close(); competing.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('Folder recovery completion rejects a competing locator generation without changing binding, Topic or receipt', async () => {
  await fixture(async (f) => {
    f.competing.setSourceLocator({ referenceId: 'fictional-folder', locator: f.oldLocator, observedRevision: firstIdentity, locatorVersion: 2, ownership: 'external' });
    await assert.rejects(async () => f.metadata.completeTopicRecoveryMutation(f.input), (error) => error.code === 'conflict');
    f.reopen();
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locator, f.oldLocator);
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locatorVersion, 2);
    assert.equal(f.metadata.getTopic('fictional-topic').revision, f.input.expectedRevision);
    assert.equal(f.metadata.getTopicOperation(f.input.logicalOperationId).state, 'pending');
    assert.deepEqual(f.metadata.listSourceRecovery('fictional-topic'), []);
  });
});

for (const bound of [false, true]) test(`Folder recovery atomically completes ${bound ? 'replacement' : 'initial enrollment'} with its binding, convention and receipt`, async () => {
  await fixture(async (f) => {
    const result = f.metadata.completeTopicRecoveryMutation(f.input);
    f.reopen();
    const locator = f.metadata.getSourceLocator('fictional-folder');
    assert.equal(locator.locator, f.replacement);
    assert.equal(locator.observedRevision, replacementIdentity);
    assert.equal(locator.locatorVersion, bound ? 2 : 1);
    assert.equal(f.metadata.getSourceConventionState('fictional-folder').find((state) => state.aspect === 'location').state, 'customized');
    assert.equal(f.metadata.getTopic('fictional-topic').revision, f.input.expectedRevision + 1);
    assert.equal(f.metadata.listSourceRecovery('fictional-topic')[0].state, 'replaced');
    const operation = f.metadata.getTopicOperation(f.input.logicalOperationId);
    assert.equal(operation.state, 'applied');
    assert.equal(operation.result.topicRevision, result.topic.revision);
  }, { bound });
});

test('Folder recovery rejects a stale source ETag even if a competing writer leaves the same locator generation', async () => {
  await fixture(async (f) => {
    f.competing.setSourceLocator({ referenceId: 'fictional-folder', locator: f.oldLocator, observedRevision: replacementIdentity, locatorVersion: 1 });
    assert.throws(() => f.metadata.completeTopicRecoveryMutation(f.input), (error) => error.code === 'conflict');
    f.reopen();
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locator, f.oldLocator);
    assert.equal(f.metadata.getTopicOperation(f.input.logicalOperationId).state, 'pending');
  });
});

test('Folder recovery never replaces a locator owned by another Source Reference', async () => {
  await fixture(async (f) => {
    f.competing.createTopic({ topicId: 'other-topic', paraCategory: 'area', lifecycle: 'active' });
    f.competing.createSourceReference({ version: 1, referenceId: 'other-folder', topicId: 'other-topic', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'note-folder:other' });
    f.competing.setSourceLocator({ referenceId: 'other-folder', locator: f.replacement, observedRevision: replacementIdentity });
    assert.throws(() => f.metadata.completeTopicRecoveryMutation(f.input), (error) => error.code === 'conflict');
    f.reopen();
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locator, f.oldLocator);
    assert.equal(f.metadata.getSourceLocator('other-folder').locator, f.replacement);
    assert.equal(f.metadata.getTopicOperation(f.input.logicalOperationId).state, 'pending');
  });
});

test('a failed recovery receipt write rolls back the Folder binding and convention in the same SQLite transaction', async () => {
  await fixture(async (f) => {
    f.input.recovery.recoveryId = null;
    assert.throws(() => f.metadata.completeTopicRecoveryMutation(f.input));
    f.reopen();
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locator, f.oldLocator);
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locatorVersion, 1);
    assert.deepEqual(f.metadata.getSourceConventionState('fictional-folder'), []);
    assert.equal(f.metadata.getTopic('fictional-topic').revision, f.input.expectedRevision);
    assert.equal(f.metadata.getTopicOperation(f.input.logicalOperationId).state, 'pending');
  });
});

test('exact Folder verification also fences the approved locator generation before resolving recovery', async () => {
  await fixture(async (f) => {
    const intent = { ...f.input.intent, replacementLocator: null };
    const logicalOperationId = randomUUID();
    f.metadata.recordTopicOperation({ logicalOperationId, topicId: intent.topicId, operationKind: f.input.operationKind, state: 'pending', currentStep: 'verify-exact-source', intent });
    const recovery = { ...f.input.recovery, state: 'resolved', lastLocator: f.oldLocator };
    const input = { ...f.input, logicalOperationId, intent, recovery, result: { status: 'resolved', recovery }, folderBinding: { locator: f.oldLocator, observedRevision: firstIdentity, expectedLocatorVersion: 1 } };
    f.competing.setSourceLocator({ referenceId: 'fictional-folder', locator: f.oldLocator, observedRevision: firstIdentity, locatorVersion: 2 });
    assert.throws(() => f.metadata.completeTopicRecoveryMutation(input), (error) => error.code === 'conflict');
    f.reopen();
    assert.equal(f.metadata.getTopicOperation(logicalOperationId).state, 'pending');
    assert.deepEqual(f.metadata.listSourceRecovery('fictional-topic'), []);
  });
});

test('initial enrollment refuses a binding that appeared after absence was approved', async () => {
  await fixture(async (f) => {
    f.competing.setSourceLocator({ referenceId: 'fictional-folder', locator: f.oldLocator, observedRevision: firstIdentity });
    assert.throws(() => f.metadata.completeTopicRecoveryMutation(f.input), (error) => error.code === 'conflict');
    f.reopen();
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locator, f.oldLocator);
    assert.equal(f.metadata.getTopicOperation(f.input.logicalOperationId).state, 'pending');
  }, { bound: false });
});

test('explicit Source Recovery enrolls a legacy unbound Folder once and replays its durable completed receipt', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async (f) => {
    await mkdir(f.replacement);
    const input = { topicId: 'fictional-topic', referenceId: 'fictional-folder', replacementLocator: f.replacement,
      expectedRevision: f.input.expectedRevision, expectedSourceRevision: 'unbound:fictional-folder', logicalOperationId: randomUUID() };
    let recovery = new TopicRecoveryService({ metadata: f.metadata, noteVaultRoot: path.dirname(f.replacement) });
    const result = await recovery.verify(input);
    assert.equal(result.status, 'replaced');
    const marker = await readFile(path.join(f.replacement, '.command-center-folder-identity'));
    f.reopen();
    recovery = new TopicRecoveryService({ metadata: f.metadata, noteVaultRoot: path.dirname(f.replacement) });
    assert.deepEqual(await recovery.verify(input), result);
    assert.equal(f.metadata.getSourceLocator('fictional-folder').locatorVersion, 1);
    assert.deepEqual(await readFile(path.join(f.replacement, '.command-center-folder-identity')), marker);
  }, { bound: false });
});
