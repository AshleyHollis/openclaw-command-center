import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, open, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { NoteProposalService } from '../src/maintenance/proposals.mjs';
import { revisionForBytes } from '../src/sources/reference.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { BRIDGE_CONTRACTS, sanitizeBridgeResult } from '../src/bridge/contracts.mjs';
import { invokeBridgeMethod, registerBridgeMethods } from '../src/bridge/register.mjs';
import { NOTE_PROPOSAL_METHODS } from '../src/bridge/note-proposal-contracts.mjs';
import { FIRST_LIVE_FEATURES, assertFirstLiveCommand } from '../src/release-scope.mjs';
import { runInstalledNoteProposalRpcJourney, runInstalledNoteProposalNegatives } from './support/notes-installed-journey.mjs';
import { errorResult } from '../src/sources/errors.mjs';

async function fixture(t, real = false) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cc-note-proposals-'));
  const root = path.join(parent, 'notes'); await mkdir(root);
  const stateDir = path.join(parent, 'state');
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  let releaseHost = () => {};
  if (real) { const { installHostFileAccessFixture } = await import('./support/host-file-access-fixture.mjs'); releaseHost = installHostFileAccessFixture(); }
  metadata.createTopic({ topicId: 'fictional-topic', name: 'Fictional Topic', paraCategory: 'area', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'fictional-folder', topicId: 'fictional-topic', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root });
  if (real) await enrollFixtureFolder(metadata, 'fictional-folder', root);
  else metadata.setSourceLocator({ referenceId: 'fictional-folder', locator: root, observedRevision: 'fictional-folder-witness', ownership: 'external' });
  const documents = [['target.md', '# User note\nKeep my edited sentence.\n'], ['source.md', '# Selected source\nA fictional observation.\n']];
  const descriptors = [];
  for (const [name, text] of documents) {
    await writeFile(path.join(root, name), text);
    const descriptor = { referenceId: `fictional-${name}`, path: name, revision: revisionForBytes(Buffer.from(text)) };
    metadata.createSourceReference({ version: 1, referenceId: descriptor.referenceId, topicId: 'fictional-topic', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${root}/${name}`, observedRevision: descriptor.revision });
    descriptors.push(descriptor);
  }
  let current = true; let unavailable = false; let afterRead = () => {}; let source;
  const runtime = { proposalAuthority: { role: 'operator', principalId: 'fictional-operator', canWrite: true, assertCurrent() { if (!current) throw Object.assign(new Error('authority unavailable'), { code: 'unauthenticated' }); } } };
  function pureSource() {
    return { metadata, requireTopicService() { if (unavailable) throw Object.assign(new Error('source unavailable'), { code: 'capability-unavailable' }); return { notes: { resolveRoot: async () => root, assertCurrentRoot() {} } }; },
      assertExactNoteReference() {}, async notesRead(input) { const text = await readFile(path.join(root, input.path), 'utf8'); await afterRead(input); return { path: input.path, text, revision: revisionForBytes(Buffer.from(text)), sourceReference: metadata.getSourceReference(input.referenceId) }; } };
  }
  let factory = pureSource;
  if (real) {
    const { createAuthoritativeSourceService } = await import('../src/sources/service.mjs');
    factory = () => createAuthoritativeSourceService({ metadata, root, capabilities: { notes: true }, fsSafeRootFactory: async rootDir => ({ rootDir, rootReal: rootDir,
      resolve: async relative => path.join(rootDir, relative), open: async relative => ({ handle: await open(path.join(rootDir, relative), 'r') }) }) });
  }
  source = factory();
  const owner = () => new NoteProposalService({ sourceService: source, metadata });
  const request = { schemaVersion: 1, topicId: 'fictional-topic', logicalOperationId: randomUUID(), generation: 1, expectedTopicRevision: metadata.getTopic('fictional-topic').revision, target: descriptors[0], sources: [descriptors[1]] };
  const access = () => ({ schemaVersion: 1, topicId: request.topicId, logicalOperationId: request.logicalOperationId, generation: 1 });
  const publication = prepared => ({ ...access(), basisDigest: prepared.basisDigest, proposedText: '# Proposed review\nKeep my edited sentence.\nA fictional observation.\n', citations: request.sources.map(({ referenceId, revision }) => ({ referenceId, revision })) });
  t.after(async () => { source.close?.(); releaseHost(); metadata.close(); await rm(parent, { recursive: true, force: true }); });
  return { root, request, access, publication, runtime, owner, metadata: () => metadata, source: () => source,
    revoke: () => { current = false; }, restore: () => { current = true; }, unavailable: value => { unavailable = value; }, afterRead: callback => { afterRead = callback; },
    reopen() { source.close?.(); metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } }); source = factory(); } };
}

test('installed scenario helper exercises the source owner lifecycle without claiming installed transport', async t => {
  const f = await fixture(t, process.platform === 'linux');
  const result = await runInstalledNoteProposalRpcJourney({ request: f.request, proposedText: '# Fictional staged review\nKeep my edited sentence.\n',
    rpc: async (method, params) => f.owner()[method.split('.').at(-1)](params, f.runtime),
    restart: async () => f.reopen(), readNoteBytes: descriptor => readFile(path.join(f.root, descriptor.path)) });
  assert.deepEqual(result.statuses, ['prepared', 'review-required', 'discarded']);
  assert.equal(result.preservedNoteBytes, true);
});

test('prepare freezes revision and snapshots before operator staging; reopen replays exact publication and preserves Note bytes', async t => {
  const f = await fixture(t); const before = await readFile(path.join(f.root, 'target.md'));
  const prepared = await f.owner().prepare(f.request, f.runtime); assert.equal(prepared.status, 'prepared'); assert.match(prepared.snapshot.target.text, /edited sentence/);
  f.reopen(); const published = await f.owner().publish(f.publication(prepared), f.runtime); assert.equal(published.status, 'review-required');
  f.reopen(); assert.deepEqual(await f.owner().publish(f.publication(prepared), f.runtime), published);
  await assert.rejects(f.owner().publish({ ...f.publication(prepared), proposedText: 'changed' }, f.runtime), { code: 'intent-mismatch' });
  assert.deepEqual(await readFile(path.join(f.root, 'target.md')), before);
});

test('malformed staging and citations remain prepared; exact principal and generation are mandatory', async t => {
  const f = await fixture(t); const p = await f.owner().prepare(f.request, f.runtime);
  await assert.rejects(f.owner().publish({ ...f.publication(p), citations: [] }, f.runtime), { code: 'invalid-request' });
  assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId).currentStep, 'prepared');
  await assert.rejects(f.owner().inspect({ ...f.access(), generation: 2 }, f.runtime), { code: 'invalid-request' });
  await assert.rejects(f.owner().inspect(f.access(), { proposalAuthority: { ...f.runtime.proposalAuthority, principalId: 'other-operator' } }), { code: 'unauthenticated' });
});

test('concurrent explicit preparation replays one durable reading claim and converges on the same snapshot', async t => {
  const f = await fixture(t);
  const [one, two] = await Promise.all([f.owner().prepare(f.request, f.runtime), f.owner().prepare(f.request, f.runtime)]);
  assert.deepEqual(one, two); assert.equal(f.metadata().listTopicOperations(f.request.topicId).filter(row => row.operationKind === 'notes.proposal.v1').length, 1);
});

test('interrupted admitted reading keeps no private text and explicit inspection after restart resumes the same intent', async t => {
  const f = await fixture(t); f.afterRead(() => f.revoke());
  await assert.rejects(f.owner().prepare(f.request, f.runtime), { code: 'unauthenticated' });
  assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId).currentStep, 'reading');
  assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId).result.snapshot, undefined);
  f.restore(); f.afterRead(() => {}); f.reopen();
  assert.equal((await f.owner().inspect(f.access(), f.runtime)).status, 'prepared');
  assert.equal(f.metadata().listTopicOperations(f.request.topicId).length, 1);
});

test('two selected Note references and revisions survive publication without inventing upstream lineage', async t => {
  const f = await fixture(t); const text = 'Second fictional source.\n'; const revision = revisionForBytes(Buffer.from(text));
  await writeFile(path.join(f.root, 'second.md'), text);
  f.metadata().createSourceReference({ version: 1, referenceId: 'fictional-second', topicId: f.request.topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: `${f.root}/second.md`, observedRevision: revision });
  f.request.sources.push({ referenceId: 'fictional-second', path: 'second.md', revision });
  const p = await f.owner().prepare(f.request, f.runtime); const review = await f.owner().publish(f.publication(p), f.runtime);
  assert.deepEqual(review.citations, f.request.sources.map(({ referenceId, revision }) => ({ referenceId, revision })));
  assert.equal(review.snapshot.sources[1].text, text); assert.equal(review.upstreamSource, undefined);
});

test('file and Folder locator generations are frozen even when bytes and paths stay identical', async t => {
  for (const referenceId of ['fictional-folder', 'fictional-target.md']) {
    const f = await fixture(t); await f.owner().prepare(f.request, f.runtime);
    const reference = f.metadata().getSourceReference(referenceId);
    const locator = f.metadata().getSourceLocator(referenceId);
    f.metadata().setSourceLocator({ referenceId, locator: locator?.locator ?? reference.externalSourceId,
      observedRevision: locator?.observedRevision ?? reference.observedRevision, locatorVersion: (locator?.locatorVersion ?? 0) + 1 });
    assert.equal((await f.owner().inspect(f.access(), f.runtime)).status, 'stale');
  }
});

test('optional native panel freezes actual open Session state and binding generation; rebind cannot reuse the tuple', async t => {
  const f = await fixture(t); const referenceId = 'fictional-session'; const sessionKey = 'agent:main:fictional-proposal';
  f.metadata().createSourceReference({ version: 1, referenceId, topicId: f.request.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey });
  f.metadata().setSessionState({ referenceId, sessionId: 'fictional-incarnation', status: 'open', isPrimary: true });
  f.metadata().setSourceLocator({ referenceId, locator: sessionKey, observedRevision: 'fictional-incarnation' });
  f.request.panel = { referenceId, sessionKey, sessionId: 'fictional-incarnation' };
  f.source().sessionTopicContext = async () => ({ status: 'bound', topicId: f.request.topicId, ...f.request.panel });
  assert.equal((await f.owner().prepare(f.request, f.runtime)).status, 'prepared');
  f.metadata().setSourceLocator({ referenceId, locator: sessionKey, observedRevision: 'fictional-incarnation', locatorVersion: 2 });
  assert.equal((await f.owner().inspect(f.access(), f.runtime)).status, 'stale');
});

test('failed over-limit read stores no text and cannot resurrect after smaller bytes replace the source', async t => {
  const f = await fixture(t); const text = 'x'.repeat(256 * 1024 + 1); const revision = revisionForBytes(Buffer.from(text));
  await writeFile(path.join(f.root, 'target.md'), text); f.request.target.revision = revision;
  f.metadata().updateSourceReference({ version: 1, referenceId: f.request.target.referenceId, observedRevision: revision });
  assert.equal((await f.owner().prepare(f.request, f.runtime)).status, 'failed');
  await writeFile(path.join(f.root, 'target.md'), '# Smaller replacement\n');
  assert.equal((await f.owner().prepare(f.request, f.runtime)).status, 'failed');
  assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId).result.snapshot, undefined);
});

test('revocation after source await exposes no private response and preserves prepared state', async t => {
  const f = await fixture(t); await f.owner().prepare(f.request, f.runtime); f.afterRead(() => f.revoke());
  await assert.rejects(f.owner().context(f.access(), f.runtime), { code: 'unauthenticated' });
  assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId).currentStep, 'prepared');
});

test('temporary source capability loss is text-free blocked and resumes without losing snapshots', async t => {
  const f = await fixture(t); await f.owner().prepare(f.request, f.runtime); f.unavailable(true);
  const blocked = await f.owner().inspect(f.access(), f.runtime); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.snapshot, undefined);
  assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId).currentStep, 'prepared'); f.unavailable(false);
  assert.equal((await f.owner().context(f.access(), f.runtime)).status, 'prepared');
});

test('confirmed byte drift retires proposal and atomically strips every private result field across reopen', async t => {
  const f = await fixture(t); const p = await f.owner().prepare(f.request, f.runtime); await f.owner().publish(f.publication(p), f.runtime);
  await writeFile(path.join(f.root, 'target.md'), '# New user edit\n');
  const stale = await f.owner().inspect(f.access(), f.runtime); assert.equal(stale.status, 'stale'); assert.equal(stale.snapshot, undefined);
  f.reopen(); const row = f.metadata().getTopicOperation(f.request.logicalOperationId);
  assert.deepEqual(Object.keys(row.result).sort(), ['basisDigest', 'publicationDigest', 'status', 'verifiedAt']);
  assert.equal(JSON.stringify(row.intent).includes('edited sentence'), false);
  assert.equal((await f.owner().prepare(f.request, f.runtime)).status, 'stale');
});

test('discard needs current ownership but no source reread and cannot resurrect terminal text', async t => {
  const f = await fixture(t); const p = await f.owner().prepare(f.request, f.runtime); await f.owner().publish(f.publication(p), f.runtime); f.unavailable(true);
  assert.equal((await f.owner().discard(f.access(), f.runtime)).status, 'discarded'); f.reopen();
  assert.equal((await f.owner().publish(f.publication(p), f.runtime)).status, 'discarded');
  assert.deepEqual(Object.keys(f.metadata().getTopicOperation(f.request.logicalOperationId).result).sort(), ['basisDigest', 'publicationDigest', 'status', 'verifiedAt']);
});

test('concurrent publication and discard converge to stripped discard using SQL prior-state fences', async t => {
  const f = await fixture(t); const p = await f.owner().prepare(f.request, f.runtime);
  let release; const pending = new Promise(resolve => { release = resolve; }); let reached; const started = new Promise(resolve => { reached = resolve; });
  f.afterRead(async () => { reached(); await pending; });
  const publishing = f.owner().publish(f.publication(p), f.runtime); await started;
  await f.owner().discard(f.access(), f.runtime); release(); assert.equal((await publishing).status, 'discarded');
  assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId).result.snapshot, undefined);
});

test('generic journal insertion, changed-kind replacement and completion APIs cannot overwrite reserved proposals', async t => {
  const f = await fixture(t); await f.owner().prepare(f.request, f.runtime);
  for (const operationKind of ['notes.proposal.v1', 'topics.create']) {
    assert.throws(() => f.metadata().recordTopicOperation({ logicalOperationId: f.request.logicalOperationId, operationKind }), { code: 'note-proposal-owner-required' });
    assert.throws(() => f.metadata().completeTopicProvisioning({ logicalOperationId: f.request.logicalOperationId, topicId: f.request.topicId, operationKind }), { code: 'note-proposal-owner-required' });
    assert.throws(() => f.metadata().completeTopicRecoveryMutation({ logicalOperationId: f.request.logicalOperationId, operationKind }), { code: 'note-proposal-owner-required' });
  }
  assert.throws(() => f.metadata().recordTopicOperation({ logicalOperationId: randomUUID(), operationKind: 'notes.proposal.v1' }), { code: 'note-proposal-owner-required' });
  assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId).currentStep, 'prepared');
});

test('TEST review bridge admits only closed operator proposal methods and fences awaited owner results', async t => {
  const f = await fixture(t); assert.equal(FIRST_LIVE_FEATURES.noteProposals, true);
  for (const method of NOTE_PROPOSAL_METHODS) { assert.equal(BRIDGE_CONTRACTS[method].scope, 'operator.write'); assert.equal(BRIDGE_CONTRACTS[method].closed, true); assert.doesNotThrow(() => assertFirstLiveCommand('bridge', method)); }
  const source = { notesProposalPrepare: (input, runtime) => f.owner().prepare(input, runtime) };
  const result = await invokeBridgeMethod(source, NOTE_PROPOSAL_METHODS[0], f.request, 'fictional-request', 'fictional-operator', f.runtime);
  assert.equal(result.status, 'prepared');
  const sanitized = sanitizeBridgeResult(NOTE_PROPOSAL_METHODS[0], { ...result, principalId: 'fictional-private-actor', snapshot: { ...result.snapshot, unexpectedField: 'fictional-private-value' } });
  assert.equal(sanitized.principalId, undefined); assert.equal(sanitized.snapshot.unexpectedField, undefined);
  await assert.rejects(invokeBridgeMethod({ async notesProposalInspect() { f.revoke(); return result; } }, NOTE_PROPOSAL_METHODS[3], f.access(), null, null, f.runtime), { code: 'unauthenticated' });
  const registered = new Map(); registerBridgeMethods({ registerGatewayMethod(method, handler) { registered.set(method, handler); } }, source);
  let response; await registered.get(NOTE_PROPOSAL_METHODS[0])({ params: f.request, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false); assert.equal(response[1], null);
  assert.equal(response[2].code, 'unauthenticated', 'enabling review does not grant caller authority');
});

test('real Linux Note owner verifies enrolled Folder and preserves actual Markdown bytes through review and reopen', { skip: process.platform !== 'linux' && 'Descriptor-anchored Note owner requires Linux' }, async t => {
  const f = await fixture(t, true); const before = await readFile(path.join(f.root, 'target.md'));
  const p = await f.owner().prepare(f.request, f.runtime); await f.owner().publish(f.publication(p), f.runtime); f.reopen();
  assert.equal((await f.owner().inspect(f.access(), f.runtime)).status, 'review-required');
  assert.deepEqual(await readFile(path.join(f.root, 'target.md')), before); await f.owner().discard(f.access(), f.runtime);
  assert.deepEqual(await readFile(path.join(f.root, 'target.md')), before);
  f.request.logicalOperationId = randomUUID(); await f.owner().prepare(f.request, f.runtime);
  await rename(f.root, `${f.root}-displaced`); await mkdir(f.root); await writeFile(path.join(f.root, 'target.md'), before);
  const blocked = await f.owner().inspect(f.access(), f.runtime); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.snapshot, undefined);
});


test('installed negative helper uses the real Note owner for stale, permission and restart cases', { skip: process.platform !== 'linux' && 'Linux Note permissions' }, async t => {
  const f = await fixture(t, true);
  const rpc = (method, input) => f.owner()[method.split('.').at(-1)](input, f.runtime);
  const result = await runInstalledNoteProposalNegatives({ rpc,
    readOnlyRpc: (method, input) => f.owner()[method.split('.').at(-1)](input, { proposalAuthority: { ...f.runtime.proposalAuthority, canWrite: false } }),
    refreshRequest: async () => f.request, readNoteBytes: pointer => readFile(path.join(f.root, pointer.path)),
    writeFixtureBytes: (pointer, bytes) => writeFile(path.join(f.root, pointer.path), bytes),
    setFixtureMode: (pointer, mode) => chmod(path.join(f.root, pointer.path), mode), restart: async () => f.reopen() });
  assert.deepEqual(result, ['read-only-refused', 'stale-source-retired', 'stale-target-retired', 'permission-unavailable-and-recovered']);
});

function negativeOptions(f, rpc) {
  return { rpc,
    readOnlyRpc: (method, input) => f.owner()[method.split('.').at(-1)](input, { proposalAuthority: { ...f.runtime.proposalAuthority, canWrite: false } }),
    refreshRequest: async () => f.request, readNoteBytes: pointer => readFile(path.join(f.root, pointer.path)),
    writeFixtureBytes: (pointer, bytes) => writeFile(path.join(f.root, pointer.path), bytes),
    setFixtureMode: (pointer, mode) => chmod(path.join(f.root, pointer.path), mode), restart: async () => f.reopen() };
}

test('installed negatives survive the real bridge error sanitizer and restore exact snapshots', { skip: process.platform !== 'linux' && 'Linux Note permissions' }, async t => {
  const f = await fixture(t, true); let refusals = 0;
  const before = await Promise.all([f.request.target, ...f.request.sources].map(pointer => readFile(path.join(f.root, pointer.path))));
  const service = Object.fromEntries(['prepare', 'inspect', 'discard'].map(action =>
    [`notesProposal${action[0].toUpperCase()}${action.slice(1)}`, (input, runtime) => f.owner()[action](input, runtime)]));
  const transport = runtime => async (method, input) => {
    try { return await invokeBridgeMethod(service, method, input, null, null, runtime); }
    catch (error) {
      const wire = errorResult(error);
      assert.deepEqual(Object.keys(wire).sort(), ['code', 'details', 'message']);
      for (const key of ['snapshot', 'proposedText', 'comparison', 'citations']) assert.equal(wire.details[key], undefined);
      if (runtime === f.runtime) {
        assert.equal(error.code, 'EACCES'); assert.equal(wire.code, 'unavailable');
        assert.equal(wire.message, 'The authoritative source request is unavailable.'); refusals++;
      } else {
        assert.equal(wire.code, 'unauthenticated');
        assert.equal(f.metadata().getTopicOperation(input.logicalOperationId), null);
        assert.deepEqual(await Promise.all([f.request.target, ...f.request.sources].map(pointer => readFile(path.join(f.root, pointer.path)))), before);
      }
      throw new Error(`Authenticated ${method} failed: ${wire.code} (${wire.message})`);
    }
  };
  assert.deepEqual(await runInstalledNoteProposalNegatives({ ...negativeOptions(f, transport(f.runtime)),
    readOnlyRpc: transport({ proposalAuthority: { ...f.runtime.proposalAuthority, canWrite: false } }) }),
    ['read-only-refused', 'stale-source-retired', 'stale-target-retired', 'permission-unavailable-and-recovered']);
  assert.equal(refusals, 1);
});

for (const [name, outcome, expected] of [
  ['successful private response', () => ({ status: 'prepared', snapshot: { target: { text: 'fictional cached text' } } }), { code: 'ERR_ASSERTION', actual: 'prepared', expected: 'blocked' }],
  ['blocked private response', () => ({ status: 'blocked', snapshot: { target: { text: 'fictional cached text' } } }), { code: 'ERR_ASSERTION' }],
  ['missing response', () => undefined, { code: 'ERR_ASSERTION' }],
  ['transport timeout', () => { throw new Error('method-response timed out'); }, { message: 'method-response timed out' }],
  ['wrong method refusal', () => { throw new Error('Authenticated other.method failed: unavailable (The authoritative source request is unavailable.)'); }, { message: 'Authenticated other.method failed: unavailable (The authoritative source request is unavailable.)' }],
  ['authority refusal', () => { throw Object.assign(new Error('operator authority ended'), { code: 'unauthenticated' }); }, { code: 'unauthenticated' }],
  ['assertion failure', () => { assert.equal('prepared', 'blocked'); }, { code: 'ERR_ASSERTION' }],
  ['assertion impersonating refusal', () => { assert.fail('Authenticated command-center.v1.notes.proposals.inspect failed: unavailable (The authoritative source request is unavailable.)'); }, { code: 'ERR_ASSERTION' }]
]) {
  test(`permission negative rejects ${name} and still restores fixture access`, { skip: process.platform !== 'linux' && 'Linux Note permissions' }, async t => {
    const f = await fixture(t, true);
    const rpc = async (method, input) => {
      try { return await f.owner()[method.split('.').at(-1)](input, f.runtime); }
      catch (error) { if (error.code !== 'EACCES') throw error; return outcome(); }
    };
    await assert.rejects(runInstalledNoteProposalNegatives(negativeOptions(f, rpc)), expected);
    assert.ok((await readFile(path.join(f.root, f.request.sources[0].path))).length > 0);
  });
}

for (const [name, refusal, expected] of [
  ['timeout mentioning scope', () => { throw new Error('operator.write method-response timed out'); }, { message: 'operator.write method-response timed out' }],
  ['assertion impersonating refusal', () => { assert.fail('Authenticated command-center.v1.notes.proposals.prepare failed: unauthenticated (The exact Note proposal is unavailable or changed.)'); }, { code: 'ERR_ASSERTION' }]
]) {
  test(`read-only negative rejects ${name} without creating a proposal`, async t => {
    const f = await fixture(t);
    await assert.rejects(runInstalledNoteProposalNegatives({ ...negativeOptions(f, () => assert.fail('write RPC must not run')),
      readOnlyRpc: refusal }), expected);
    assert.equal(f.metadata().getTopicOperation(f.request.logicalOperationId), null);
  });
}
