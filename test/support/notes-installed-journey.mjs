import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const unwrap = response => response?.result ?? response;
const identity = (value, access) => {
  for (const key of ['schemaVersion', 'logicalOperationId', 'topicId', 'generation']) assert.equal(value[key], access[key], key);
};

// Scenario helper for the existing installed-host runner, not a host launcher.
// The runner supplies authenticated RPC, exact enrolled fictional descriptors,
// restart, and byte reads from its own isolated world. No Note write API exists
// here. A source test or mocked RPC is not installed qualification.
export async function runInstalledNoteProposalRpcJourney({ rpc, request, proposedText, restart, readNoteBytes }) {
  assert.equal(typeof rpc, 'function'); assert.equal(typeof restart, 'function'); assert.equal(typeof readNoteBytes, 'function');
  const input = { ...request, schemaVersion: 1, generation: 1, logicalOperationId: randomUUID() };
  const access = Object.fromEntries(['schemaVersion', 'logicalOperationId', 'topicId', 'generation'].map(key => [key, input[key]]));
  const files = [input.target, ...input.sources];
  const before = await Promise.all(files.map(descriptor => readNoteBytes(descriptor)));
  const assertUnchanged = async () => assert.deepEqual(await Promise.all(files.map(descriptor => readNoteBytes(descriptor))), before, 'review journey changes no Note bytes');
  const restartAndVerify = async () => { await restart(); await assertUnchanged(); };
  const call = async (action, params = access) => { const value = unwrap(await rpc(`command-center.v1.notes.proposals.${action}`, params)); identity(value, access); await assertUnchanged(); return value; };
  const prepared = await call('prepare', input);
  assert.equal(prepared.status, 'prepared'); assert.ok(prepared.basisDigest);
  assert.equal(prepared.snapshot.target.referenceId, input.target.referenceId);
  assert.equal(prepared.snapshot.target.revision, input.target.revision);
  const context = await call('context'); assert.deepEqual(context.snapshot, prepared.snapshot);
  await restartAndVerify();
  const recovered = await call('inspect'); assert.deepEqual(recovered.snapshot, prepared.snapshot);
  const publication = { ...access, basisDigest: prepared.basisDigest, proposedText,
    citations: input.sources.map(({ referenceId, revision }) => ({ referenceId, revision })) };
  const review = await call('publish', publication);
  assert.equal(review.status, 'review-required'); assert.equal(review.proposedText, proposedText);
  assert.deepEqual(review.citations, publication.citations);
  assert.deepEqual(review.comparison, { before: prepared.snapshot.target.text, after: proposedText });
  await restartAndVerify();
  const replay = await call('inspect'); assert.deepEqual(replay, review);
  assert.deepEqual(await Promise.all(files.map(descriptor => readNoteBytes(descriptor))), before, 'review changes no Note bytes');
  const discarded = await call('discard'); assert.equal(discarded.status, 'discarded');
  await restartAndVerify();
  const retired = await call('inspect'); assert.equal(retired.status, 'discarded');
  for (const key of ['snapshot', 'proposedText', 'comparison', 'citations']) assert.equal(retired[key], undefined);
  assert.deepEqual(await Promise.all(files.map(descriptor => readNoteBytes(descriptor))), before, 'discard changes no Note bytes');
  return { logicalOperationId: access.logicalOperationId, statuses: ['prepared', 'review-required', 'discarded'], preservedNoteBytes: true };
}

// Validate the actual native-executed tool result against isolated source bytes.
// The installed runner must independently record the real native tool call and
// context; passing an owner result directly cannot prove native execution.
export function verifyInstalledRecallEvidence(result, { topicId, noteTextByReference }) {
  assert.ok(['available', 'partial'].includes(result.status));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.currentTopic.topicId, topicId);
  assert.equal(result.retrievedTopic.topicId, topicId);
  assert.equal(result.selectionBasis, 'current-topic-notes');
  assert.equal(result.groups.conversations.length, 0);
  const notes = result.groups.notes; assert.ok(notes.length > 0 && notes.length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12 * 1024);
  for (const item of notes) {
    assert.equal(item.originatingTopic.topicId, topicId);
    assert.equal(item.sourceReference.topicId, topicId);
    assert.equal(item.navigation.topicId, topicId);
    assert.equal(item.navigation.kind, 'note');
    assert.ok(Array.from(item.excerpt).length <= 320);
    const source = noteTextByReference.get(item.sourceReference.referenceId);
    assert.ok(source, 'only known same-Topic fictional Notes may appear');
    assert.equal(item.citation.revision, source.revision);
    assert.equal(item.navigation.observedRevision, source.revision);
    assert.equal(item.navigation.path, source.path);
    assert.equal(item.navigation.referenceId, item.sourceReference.referenceId);
    assert.equal(item.redacted, false, 'fixture text contains no credentials');
    assert.ok(Number.isSafeInteger(item.citation.start) && item.citation.start >= 0);
    assert.ok(Number.isSafeInteger(item.citation.end) && item.citation.end > item.citation.start && item.citation.end <= source.text.length);
    assert.equal(source.text.slice(item.citation.start, item.citation.end), item.excerpt);
  }
  return notes;
}


// Closed fixture receipt identity: input paths/JSON cannot select another build.
export function assertNotesQualificationReceipt(receipt, expected) {
  assert.equal(receipt.sourceCommit, expected.sourceCommit);
  assert.equal(receipt.buildDigest, expected.buildDigest);
  assert.equal(receipt.archive?.sha256, expected.archiveSha256);
}

export async function runInstalledNoteProposalNegatives({ rpc, readOnlyRpc, refreshRequest, readNoteBytes, writeFixtureBytes, setFixtureMode, restart }) {
  const fresh = async () => ({ ...await refreshRequest(), schemaVersion: 1, generation: 1, logicalOperationId: randomUUID() });
  const access = input => Object.fromEntries(['schemaVersion', 'logicalOperationId', 'topicId', 'generation'].map(key => [key, input[key]]));
  const noText = value => { for (const key of ['snapshot', 'proposedText', 'comparison', 'citations']) assert.equal(value[key], undefined); };
  const readonly = await fresh();
  await assert.rejects(readOnlyRpc('command-center.v1.notes.proposals.prepare', readonly), error =>
    error.code === 'unauthenticated' || /operator\.write|missing.*scope|insufficient.*scope/iu.test(error.message));
  const statuses = ['read-only-refused'];
  for (const role of ['source', 'target']) {
    const input = await fresh(); const pointer = role === 'source' ? input.sources[0] : input.target;
    const files = [input.target, ...input.sources]; const before = await Promise.all(files.map(readNoteBytes));
    const original = await readNoteBytes(pointer);
    const prepared = unwrap(await rpc('command-center.v1.notes.proposals.prepare', input)); assert.equal(prepared.status, 'prepared');
    try {
      await writeFixtureBytes(pointer, Buffer.concat([original, Buffer.from('\nFictional later edit.\n')]));
      const stale = unwrap(await rpc('command-center.v1.notes.proposals.inspect', access(input)));
      assert.equal(stale.status, 'stale'); noText(stale);
      if (role === 'target') {
        await restart(); const retired = unwrap(await rpc('command-center.v1.notes.proposals.inspect', access(input)));
        assert.equal(retired.status, 'stale'); noText(retired);
      }
    } finally { await writeFixtureBytes(pointer, original); }
    const restored = unwrap(await rpc('command-center.v1.notes.proposals.inspect', access(input)));
    assert.equal(restored.status, 'stale'); noText(restored);
    assert.deepEqual(await Promise.all(files.map(readNoteBytes)), before);
    statuses.push(`stale-${role}-retired`);
  }
  const input = await fresh(); const source = input.sources[0];
  const files = [input.target, ...input.sources]; const before = await Promise.all(files.map(readNoteBytes));
  assert.equal(unwrap(await rpc('command-center.v1.notes.proposals.prepare', input)).status, 'prepared');
  await setFixtureMode(source, 0o000);
  try {
    try {
      const blocked = unwrap(await rpc('command-center.v1.notes.proposals.inspect', access(input)));
      assert.equal(blocked.status, 'blocked'); noText(blocked);
    } catch (error) {
      assert.ok(error.code === 'EACCES' || /failed: EACCES\b/u.test(error.message)); noText(error);
    }
  } finally { await setFixtureMode(source, 0o600); }
  const recovered = unwrap(await rpc('command-center.v1.notes.proposals.inspect', access(input)));
  assert.equal(recovered.status, 'prepared');
  assert.equal(unwrap(await rpc('command-center.v1.notes.proposals.discard', access(input))).status, 'discarded');
  assert.deepEqual(await Promise.all(files.map(readNoteBytes)), before);
  statuses.push('permission-unavailable-and-recovered');
  return statuses;
}
