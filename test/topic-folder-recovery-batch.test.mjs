import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopicFolderRecoveryBatch } from '../src/topics/folder-recovery-batch.mjs';

const operationId = '11111111-1111-4111-8111-111111111111';
const bindings = [{ topicId: 'fictional-topic', referenceId: 'folder:fictional', mode: 'enroll', replacementLocator: '/fictional/vault/Projects/Example', expectedRevision: 7, expectedSourceRevision: 'legacy-folder-revision', expectedLocatorVersion: 1, logicalOperationId: operationId }];

function fixture({ inspection = { available: false, failure: 'exact-folder-identity-unverified' }, verify = async () => ({ status: 'replaced', recovery: { state: 'replaced' } }), operation = null, recoveryRequired = true, sourceRevision = 'legacy-folder-revision' } = {}) {
  const topic = { topicId: 'fictional-topic', lifecycle: 'active', revision: 7 };
  const reference = { referenceId: 'folder:fictional', topicId: topic.topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', observedRevision: sourceRevision };
  const locator = { locator: '/fictional/vault/Projects/Example', observedRevision: sourceRevision, locatorVersion: 1 };
  const calls = [];
  const metadata = { getTopic: id => id === topic.topicId ? topic : null, getSourceReference: id => id === reference.referenceId ? reference : null, getSourceLocator: id => id === reference.referenceId ? locator : null,
    getTopicOperation: id => id === operationId ? operation : null, listSourceRecovery: () => recoveryRequired ? [{ referenceId: reference.referenceId, state: 'required' }] : [] };
  const topics = { recoveryInspect: async input => { calls.push(['inspect', input]); return inspection; }, recoveryVerify: async input => { calls.push(['verify', input]); return verify(input); } };
  return { batch: createTopicFolderRecoveryBatch({ metadata, topics }), calls, locator };
}

test('controlled Note Folder batch recovers only an explicit pinned binding with original conditional evidence', async () => {
  const f = fixture(); const result = await f.batch.recover({ bindings });
  assert.equal(result.status, 'completed'); assert.equal(result.receipts[0].status, 'recovered');
  assert.deepEqual(f.calls, [['inspect', { topicId: 'fictional-topic', referenceId: 'folder:fictional' }], ['verify', { topicId: 'fictional-topic', referenceId: 'folder:fictional', replacementLocator: f.locator.locator, expectedRevision: 7, expectedSourceRevision: 'legacy-folder-revision', logicalOperationId: operationId }]]);
});

test('controlled Note Folder batch clears a persisted recovery record when its exact folder is already healthy', async () => {
  const f = fixture({ inspection: { available: true, folderIdentity: 'note-folder:healthy' } });
  const verifyBinding = [{ ...bindings[0], mode: 'verify', replacementLocator: undefined }];
  const result = await f.batch.recover({ bindings: verifyBinding });
  assert.equal(result.status, 'completed'); assert.equal(result.receipts[0].status, 'recovered'); assert.equal(f.calls[1][1].replacementLocator, undefined);
});

test('controlled Note Folder batch replays a pending durable recovery after marker publication instead of inspecting a newer identity', async () => {
  const f = fixture({ inspection: { available: false, failure: 'exact-folder-identity-mismatch' }, operation: { logicalOperationId: operationId, state: 'pending', operationKind: 'topics.recovery.verify', intent: { topicId: 'fictional-topic', referenceId: 'folder:fictional', expectedRevision: 7, expectedSourceRevision: 'legacy-folder-revision', expectedLocatorVersion: 1, replacementLocator: '/fictional/vault/Projects/Example' } } });
  const result = await f.batch.recover({ bindings });
  assert.equal(result.status, 'completed'); assert.equal(result.receipts[0].status, 'replayed');
  assert.deepEqual(f.calls, [['verify', { topicId: 'fictional-topic', referenceId: 'folder:fictional', replacementLocator: f.locator.locator, expectedRevision: 7, expectedSourceRevision: 'legacy-folder-revision', logicalOperationId: operationId }]]);
});

test('an applied rebind is only verified healthy when its pinned current identity still holds', async () => {
  const currentIdentity = 'note-folder:1:11111111-1111-4111-8111-111111111111:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const sourceRevision = 'note-folder:1:11111111-1111-4111-8111-111111111111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const operation = { logicalOperationId: operationId, state: 'applied', operationKind: 'topics.recovery.verify', intent: { topicId: 'fictional-topic', referenceId: 'folder:fictional', expectedRevision: 7, expectedSourceRevision: sourceRevision, expectedLocatorVersion: 1, replacementLocator: '/fictional/vault/Projects/Example', expectedReplacementIdentity: currentIdentity } };
  const rebind = { ...bindings[0], mode: 'rebind', expectedSourceRevision: sourceRevision, expectedReplacementIdentity: currentIdentity };
  const f = fixture({ sourceRevision, operation, inspection: { available: true, folderIdentity: currentIdentity } });
  assert.equal((await f.batch.preflight(rebind)).status, 'already-healthy');
  const changed = fixture({ sourceRevision, operation, inspection: { available: true, folderIdentity: currentIdentity.replace(/b/g, 'c') } });
  assert.equal((await changed.batch.preflight(rebind)).reason, 'applied-recovery-no-longer-healthy');
});

test('controlled Note Folder batch halts before a mismatched marker can be rebound', async () => {
  const f = fixture({ inspection: { available: false, failure: 'exact-folder-identity-mismatch' } }); const result = await f.batch.recover({ bindings });
  assert.equal(result.status, 'halted'); assert.equal(result.receipts[0].reason, 'exact-folder-identity-mismatch'); assert.equal(f.calls.length, 1);
});

test('controlled Note Folder batch permits only an operator-pinned same-locator rebind with both identities', async () => {
  const currentIdentity = 'note-folder:1:11111111-1111-4111-8111-111111111111:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const sourceRevision = 'note-folder:1:11111111-1111-4111-8111-111111111111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const f = fixture({ sourceRevision, inspection: { available: false, failure: 'exact-folder-identity-mismatch', locator: '/fictional/vault/Projects/Example', folderIdentity: currentIdentity } });
  const result = await f.batch.recover({ bindings: [{ ...bindings[0], mode: 'rebind', expectedSourceRevision: sourceRevision, expectedReplacementIdentity: currentIdentity }] });
  assert.equal(result.status, 'completed'); assert.equal(result.receipts[0].status, 'recovered');
  assert.deepEqual(f.calls[1][1], { topicId: 'fictional-topic', referenceId: 'folder:fictional', replacementLocator: f.locator.locator, expectedReplacementIdentity: currentIdentity, expectedRevision: 7, expectedSourceRevision: 'note-folder:1:11111111-1111-4111-8111-111111111111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', logicalOperationId: operationId });
});

test('controlled Note Folder batch refuses a rebind with another marker UUID', async () => {
  const currentIdentity = 'note-folder:1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const sourceRevision = 'note-folder:1:11111111-1111-4111-8111-111111111111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const f = fixture({ sourceRevision, inspection: { available: false, failure: 'exact-folder-identity-mismatch', locator: '/fictional/vault/Projects/Example', folderIdentity: currentIdentity } });
  const result = await f.batch.recover({ bindings: [{ ...bindings[0], mode: 'rebind', expectedSourceRevision: sourceRevision, expectedReplacementIdentity: currentIdentity }] });
  assert.equal(result.status, 'halted'); assert.equal(result.receipts[0].reason, 'exact-folder-identity-mismatch'); assert.equal(f.calls.length, 1);
});

test('controlled Note Folder batch preserves the original conditional input after an interrupted reply', async () => {
  const f = fixture({ verify: async () => { const error = new Error('interrupted'); error.code = 'unknown'; throw error; } });
  const result = await f.batch.recover({ bindings }); assert.equal(result.status, 'halted'); assert.equal(result.receipts[0].reason, 'unknown');
  assert.deepEqual(f.calls[1][1], { topicId: 'fictional-topic', referenceId: 'folder:fictional', replacementLocator: f.locator.locator, expectedRevision: 7, expectedSourceRevision: 'legacy-folder-revision', logicalOperationId: operationId });
});

test('controlled Note Folder batch refuses empty, duplicate, stale, and foreign bindings before recovery', async () => {
  const f = fixture();
  await assert.rejects(f.batch.recover({ bindings: [] }), { code: 'invalid-request' });
  await assert.rejects(f.batch.recover({ bindings: [bindings[0], { ...bindings[0], topicId: 'foreign' }] }), { code: 'invalid-request' });
  const stale = await f.batch.recover({ bindings: [{ ...bindings[0], expectedRevision: 6 }] }); assert.equal(stale.receipts[0].reason, 'conditional-binding-changed');
  const foreign = await f.batch.recover({ bindings: [{ ...bindings[0], topicId: 'foreign', referenceId: 'folder:foreign' }] }); assert.equal(foreign.receipts[0].reason, 'exact-persisted-note-folder-binding-unavailable');
});

test('controlled Note Folder batch blocks a reused operation ID with another durable intent', async () => {
  const f = fixture({ operation: { logicalOperationId: operationId, state: 'pending', operationKind: 'topics.recovery.verify', intent: { topicId: 'fictional-topic', referenceId: 'folder:fictional', expectedRevision: 7, expectedSourceRevision: 'other', expectedLocatorVersion: 1, replacementLocator: '/fictional/vault/Projects/Example' } } });
  const result = await f.batch.recover({ bindings });
  assert.equal(result.status, 'halted'); assert.equal(result.receipts[0].reason, 'logical-operation-intent-mismatch'); assert.equal(f.calls.length, 0);
});

test('controlled Note Folder batch checks cancellation between bindings', async () => {
  let cancelled = false; const calls = [];
  const references = new Map([['folder:first', { referenceId: 'folder:first', topicId: 'first', sourceSystem: 'obsidian', sourceKind: 'note_folder', observedRevision: 'r1' }], ['folder:second', { referenceId: 'folder:second', topicId: 'second', sourceSystem: 'obsidian', sourceKind: 'note_folder', observedRevision: 'r2' }]]);
  const metadata = { getTopic: topicId => ({ topicId, lifecycle: 'active', revision: 1 }), getSourceReference: id => references.get(id) ?? null,
    getSourceLocator: id => id === 'folder:first' ? { locator: '/fictional/vault/First', observedRevision: 'r1', locatorVersion: 1 } : { locator: '/fictional/vault/Second', observedRevision: 'r2', locatorVersion: 1 }, getTopicOperation: () => null, listSourceRecovery: () => [{ state: 'required' }] };
  const topics = { recoveryInspect: async input => { calls.push(['inspect', input.referenceId]); return { available: false, failure: 'exact-folder-identity-unverified' }; }, recoveryVerify: async input => { calls.push(['verify', input.referenceId]); cancelled = true; return { status: 'replaced', recovery: {} }; } };
  const batch = createTopicFolderRecoveryBatch({ metadata, topics });
  const result = await batch.recover({ bindings: [
    { topicId: 'first', referenceId: 'folder:first', mode: 'enroll', replacementLocator: '/fictional/vault/First', expectedRevision: 1, expectedSourceRevision: 'r1', expectedLocatorVersion: 1, logicalOperationId: operationId },
    { topicId: 'second', referenceId: 'folder:second', mode: 'enroll', replacementLocator: '/fictional/vault/Second', expectedRevision: 1, expectedSourceRevision: 'r2', expectedLocatorVersion: 1, logicalOperationId: '22222222-2222-4222-8222-222222222222' }
  ], assertCurrent: () => { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); } });
  assert.equal(result.status, 'halted'); assert.equal(result.receipts[0].reason, 'cancelled');
  assert.deepEqual(calls, [['inspect', 'folder:first'], ['verify', 'folder:first']]);
});
