import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';
import { writeFileSync } from 'node:fs';
import { revisionForBytes } from '../src/sources/reference.mjs';

const release = installHostFileAccessFixture();
test.after(release);
const linux = { skip: process.platform !== 'linux' && 'Descriptor-relative Note publication requires Linux.' };
const bytes = Buffer.from('fictional original attachment bytes');

// CC owner fixture only; the separate SDK integration test uses real admission.
function admissionFixture(publish = effect => effect()) {
  return { originalDigest: revisionForBytes(bytes), sizeBytes: bytes.length,
    getOriginalBytes: () => Buffer.from(bytes), publish: async effect => publish(effect), close: async () => {} };
}

async function prepareOriginal(f) {
  const selection = { entryId: 'fictional-accepted-user', mediaIndex: 0, offset: 0, generation: 'fictional-original-generation' };
  f.service.documents.attachmentReader = { resolve: async () => ({ selection, mediaRef: f.input.mediaRef, fileName: 'original.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, createdAt: '2026-01-01T00:00:00Z' }) };
  const runtime = { principalId: 'fictional-principal', assertCurrent() {}, admitAttachment: async () => admissionFixture() };
  const input = { topicId: 'fictional-filing', sessionKey: f.input.sessionKey, sessionId: f.input.sessionId, logicalOperationId: '00000000-0000-4000-8000-000000000456' };
  await f.service.documents.prepareAttachment({ ...input, selection }, runtime);
  return { input, runtime };
}

test('original filing freezes intent, synchronously publishes once, atomically retains binding and lineage, and reopens after restart', linux, async t => {
  const f = await fixture(t);
  const { input, runtime } = await prepareOriginal(f);
  const result = await f.service.documents.filePreparedAttachment(input, runtime);
  assert.equal(result.status, 'applied');
  assert.equal(result.value.source.entryId, 'fictional-accepted-user');
  assert.equal(f.metadata.getTopicOperation(input.logicalOperationId).currentStep, 'complete');
  assert.ok(f.metadata.getSourceReference(result.value.source.attachmentReferenceId));
  const names = await readdir(path.join(f.root, 'Documents'));
  f.reopen();
  f.service.documents.mediaLoader = async () => { throw new Error('Original is unavailable; reconciliation must not read media'); };
  const checked = await f.service.documents.checkPreparedAttachment(input, runtime);
  assert.deepEqual(checked.value, result.value);
  assert.deepEqual(await readdir(path.join(f.root, 'Documents')), names);
  const reopened = await f.service.documents.reopenPreparedAttachment(input, runtime);
  assert.deepEqual(reopened.source, result.value.source);
  assert.deepEqual(reopened.document, result.value.document);
  assert.deepEqual(await readFile(path.join(f.root, reopened.document.path)), bytes);
  const read = await f.service.notesRead({ schemaVersion: 1, topicId: input.topicId, referenceId: reopened.document.referenceId, path: reopened.document.path, sourceKind: 'document', offset: 0, observedRevision: reopened.document.revision });
  assert.deepEqual(Buffer.from(read.contentBase64, 'base64'), bytes);
});

test('Note publication waits for native admission and expires its retained callback after settlement', linux, async t => {
  const f = await fixture(t);
  const { input, runtime } = await prepareOriginal(f);
  let retained;
  let closed = 0;
  runtime.admitAttachment = async () => ({ ...admissionFixture(async effect => {
    retained = effect;
    await Promise.resolve();
    effect();
  }), close: async () => { closed++; } });
  const result = await f.service.documents.filePreparedAttachment(input, runtime);
  assert.equal(result.status, 'applied');
  assert.equal(closed, 1);
  assert.throws(() => retained(), { code: 'unauthenticated' });
});

test('filing rejects a changed native original copy and closes custody without publishing', linux, async t => {
  const f = await fixture(t);
  const { input, runtime } = await prepareOriginal(f);
  let effects = 0, closed = 0;
  runtime.admitAttachment = async () => ({ ...admissionFixture(() => { effects++; }),
    getOriginalBytes: () => Buffer.alloc(bytes.length), close: async () => { closed++; } });
  await assert.rejects(() => f.service.documents.filePreparedAttachment(input, runtime), { code: 'conflict' });
  assert.equal(effects, 0);
  assert.equal(closed, 1);
  assert.equal(f.metadata.getTopicOperation(input.logicalOperationId).state, 'unknown');
});

test('original filing interrupted after publication recovers the frozen receipt without reading the original or creating again', linux, async t => {
  const f = await fixture(t, { afterAtomicPublish: async () => { throw new Error('fictional interrupted original'); } });
  const { input, runtime } = await prepareOriginal(f);
  await assert.rejects(() => f.service.documents.filePreparedAttachment(input, runtime), /fictional interrupted original/);
  const names = await readdir(path.join(f.root, 'Documents'));
  f.reopen();
  f.service.documents.mediaLoader = async () => { throw new Error('No reread allowed'); };
  const checked = await f.service.documents.checkPreparedAttachment(input, runtime);
  assert.equal(checked.status, 'applied');
  assert.deepEqual(await readdir(path.join(f.root, 'Documents')), names);
});

test('original filing refuses native admission lost during staging and never creates on Check result', linux, async t => {
  let admitted = true;
  const f = await fixture(t, { beforeAtomicCommit: async () => { admitted = false; } });
  const { input, runtime } = await prepareOriginal(f);
  runtime.admitAttachment = async () => admissionFixture(effect => { if (!admitted) throw Object.assign(new Error('fictional retired admission'), { code: 'unauthenticated' }); return effect(); });
  await assert.rejects(() => f.service.documents.filePreparedAttachment(input, runtime), { code: 'unauthenticated' });
  const names = await readdir(path.join(f.root, 'Documents'));
  assert.ok(names.every(name => name.startsWith('.')));
  await assert.rejects(() => f.service.documents.checkPreparedAttachment(input, runtime), { code: 'unknown' });
  assert.deepEqual(await readdir(path.join(f.root, 'Documents')), names);
});

test('prepared replay and reopen refuse equal-byte replacement of the original inode', linux, async t => {
  const f = await fixture(t);
  const { input, runtime } = await prepareOriginal(f);
  const filed = await f.service.documents.filePreparedAttachment(input, runtime);
  const target = path.join(f.root, filed.value.document.path);
  const notes = [...f.service.topicServices.values()][0].notes;
  const read = notes.read.bind(notes); let replace = true;
  notes.read = async command => {
    const document = await read(command);
    if (replace && command.observe === false) {
      replace = false;
      await rename(target, path.join(f.directory, 'retained-causal-original.pdf'));
      await writeFile(target, bytes);
    }
    return document;
  };
  await assert.rejects(() => f.service.documents.reopenPreparedAttachment(input, runtime), { code: 'conflict' });
  f.service.documents.attachmentReader = { resolve: async () => { throw new Error('Retained preparation must not reread attachment'); } };
  const selection = { entryId: 'fictional-accepted-user', mediaIndex: 0, offset: 0, generation: 'fictional-original-generation' };
  await assert.rejects(() => f.service.documents.prepareAttachment({ ...input, selection }, runtime), { code: 'source-recovery' });
  await assert.rejects(() => f.service.notesRead({ schemaVersion: 1, topicId: input.topicId, referenceId: filed.value.document.referenceId, path: filed.value.document.path, sourceKind: 'document', offset: 0, observedRevision: filed.value.document.revision }), { code: 'conflict' });
});

test('original filing refuses a Folder marker retired inside its final publication callback', linux, async t => {
  const f = await fixture(t);
  const { input, runtime } = await prepareOriginal(f);
  runtime.admitAttachment = async () => admissionFixture(effect => {
    writeFileSync(path.join(f.root, '.command-center-folder-identity'), 'fictional retired marker');
    return effect();
  });
  await assert.rejects(() => f.service.documents.filePreparedAttachment(input, runtime), { code: 'source-recovery' });
  assert.ok((await readdir(path.join(f.root, 'Documents'))).every(name => name.startsWith('.')));
});

test('original filing retains its verified Folder witness through awaited staging', linux, async t => {
  let retired = false;
  const f = await fixture(t, { beforePathIo: async ({ operation }) => {
    if (operation !== 'create' || retired) return;
    retired = true;
    await writeFile(path.join(f.root, '.command-center-folder-identity'), 'fictional retired staging marker');
  } });
  const { input, runtime } = await prepareOriginal(f);
  await assert.rejects(() => f.service.documents.filePreparedAttachment(input, runtime), { code: 'source-recovery' });
  assert.ok((await readdir(path.join(f.root, 'Documents'))).every(name => name.startsWith('.')));
});

async function fixture(t, hooks = {}) {
  const { mediaLoader, ...noteHooks } = hooks;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'topic-filing-recovery-'));
  const root = path.join(directory, 'vault');
  const stateDir = path.join(directory, 'state');
  await mkdir(root);
  const topicId = 'fictional-filing';
  const sessionKey = 'agent:main:fictional-filing';
  const sessionId = 'fictional-filing-incarnation';
  const input = { sessionKey, sessionId, mediaRef: 'media://inbound/fictional-original' };
  let metadata;
  let service;
  const open = () => {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    service = createAuthoritativeSourceService({ metadata, root, noteRecoveryEffects: false, ...noteHooks, capabilities: { notes: true, sessions: true },
      sessionStore: { getSessionEntry: () => ({ sessionId, updatedAt: 10 }), listSessionEntries: () => [{ sessionKey, entry: { sessionId, updatedAt: 10 } }] },
      api: { runtime: { media: { loadWebMedia: mediaLoader ?? (async () => ({ buffer: bytes, contentType: 'application/pdf', fileName: 'original.pdf' })) } } } });
  };
  const close = () => { for (const topic of service.topicServices.values()) topic.notes?.close(); metadata.close(); };
  open();
  metadata.createTopic({ topicId, name: 'Fictional filing', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-filing', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root, observedRevision: null });
  await enrollFixtureFolder(metadata, 'folder:fictional-filing', root);
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'session:fictional-filing', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: '10' }, state: { referenceId: 'session:fictional-filing', sessionId, status: 'open', isPrimary: true, displayName: 'Fictional' } });
  t.after(async () => { close(); await rm(directory, { recursive: true, force: true }); });
  return { root, directory, input, get metadata() { return metadata; }, get service() { return service; }, reopen() { close(); open(); } };
}

test('filing retry refuses an equal-byte foreign replacement after durable restart', linux, async t => {
  const f = await fixture(t);
  const filed = await f.service.documentsFileAttachment(f.input);
  const original = path.join(f.root, filed.value.document.path);
  await rename(original, path.join(f.directory, 'retained-original.pdf'));
  await writeFile(original, bytes);
  f.reopen();
  await assert.rejects(() => f.service.documentsFileAttachment(f.input), { code: 'conflict' });
  assert.deepEqual(await readFile(original), bytes);
  assert.deepEqual(await readFile(path.join(f.directory, 'retained-original.pdf')), bytes);
});

test('filing retry completes its interrupted publication and missing attachment binding after restart', linux, async t => {
  let interrupt = true;
  const f = await fixture(t, { afterAtomicPublish: async () => {
    if (interrupt) { interrupt = false; throw new Error('fictional publication interruption'); }
  } });
  await assert.rejects(() => f.service.documentsFileAttachment(f.input), /fictional publication interruption/);
  const names = await readdir(path.join(f.root, 'Documents'));
  f.reopen();
  const recovered = await f.service.documentsFileAttachment(f.input);
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.value.status, 'filed');
  assert.deepEqual(await readFile(path.join(f.root, recovered.value.document.path)), bytes);
  assert.deepEqual(await readdir(path.join(f.root, 'Documents')), names);
  const retry = await f.service.documentsFileAttachment(f.input);
  assert.equal(retry.logicalOperationId, recovered.logicalOperationId);
  assert.deepEqual(retry.value, recovered.value);
});

test('filing refuses an already foreign-owned attachment before creating a second Topic document', linux, async t => {
  const f = await fixture(t);
  const filed = await f.service.documentsFileAttachment(f.input);
  const otherRoot = path.join(f.directory, 'other-vault');
  await mkdir(otherRoot);
  const topicId = 'fictional-other-topic';
  const sessionKey = 'agent:main:fictional-other-topic';
  const sessionId = 'fictional-other-incarnation';
  f.metadata.createTopic({ topicId, name: 'Fictional other', paraCategory: 'project', lifecycle: 'active' });
  f.metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-other', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: otherRoot, observedRevision: null });
  await enrollFixtureFolder(f.metadata, 'folder:fictional-other', otherRoot);
  f.metadata.createSessionBinding({ reference: { version: 1, referenceId: 'session:fictional-other', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: '10' }, state: { referenceId: 'session:fictional-other', sessionId, status: 'open', isPrimary: true, displayName: 'Fictional other' } });
  const other = createAuthoritativeSourceService({ metadata: f.metadata, root: otherRoot, noteRecoveryEffects: false, capabilities: { notes: true, sessions: true },
    sessionStore: { getSessionEntry: () => ({ sessionId, updatedAt: 10 }), listSessionEntries: () => [{ sessionKey, entry: { sessionId, updatedAt: 10 } }] },
    api: { runtime: { media: { loadWebMedia: async () => ({ buffer: bytes, contentType: 'application/pdf', fileName: 'original.pdf' }) } } } });
  t.after(() => { for (const topic of other.topicServices.values()) topic.notes?.close(); });
  await assert.rejects(() => other.documentsFileAttachment({ sessionKey, sessionId, mediaRef: f.input.mediaRef }), { code: 'cross-topic' });
  await assert.rejects(readFile(path.join(otherRoot, filed.value.document.path)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(f.root, filed.value.document.path)), bytes);
});

test('retained filing with proven unpublished staging reconciles not-applied without creating a file', linux, async t => {
  let interrupt = true;
  const f = await fixture(t, { beforeAtomicCommit: async () => {
    if (interrupt) { interrupt = false; throw new Error('fictional prepared interruption'); }
  } });
  await assert.rejects(() => f.service.documentsFileAttachment(f.input), /fictional prepared interruption/);
  const names = await readdir(path.join(f.root, 'Documents'));
  f.reopen();
  const reconciled = await f.service.documentsFileAttachment(f.input);
  assert.equal(reconciled.status, 'not-applied');
  assert.equal(reconciled.value, null);
  assert.deepEqual(await readdir(path.join(f.root, 'Documents')), names);
  assert.ok(names.every(name => name.startsWith('.')));
});

test('an uncertain retained filing without Note effect evidence remains unknown across restart', linux, async t => {
  let reads = 0;
  const f = await fixture(t, { mediaLoader: async () => {
    if (++reads === 2) throw Object.assign(new Error('fictional media interruption'), { code: 'delivery-unknown' });
    return { buffer: bytes, contentType: 'application/pdf', fileName: 'original.pdf' };
  } });
  await assert.rejects(() => f.service.documentsFileAttachment(f.input), { code: 'unknown' });
  f.reopen();
  await assert.rejects(() => f.service.documentsFileAttachment(f.input), { code: 'unknown' });
  await assert.rejects(readdir(path.join(f.root, 'Documents')), { code: 'ENOENT' });
});

test('simultaneous identical filing requests retain one original document and causal receipt', linux, async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.service.documentsFileAttachment(f.input), f.service.documentsFileAttachment(f.input)]);
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'applied');
  assert.equal(first.logicalOperationId, second.logicalOperationId);
  assert.deepEqual(first.value, second.value);
  const names = await readdir(path.join(f.root, 'Documents'));
  assert.deepEqual(names.filter(name => !name.startsWith('.')), [path.basename(first.value.document.path)]);
});

test('filing alone does not schedule disabled automatic Note maintenance', linux, async t => {
  let scheduled = 0;
  const f = await fixture(t, { maintenanceSchedule: { schedule: async () => { scheduled++; } } });
  const result = await f.service.documentsFileAttachment(f.input);
  assert.equal(result.status, 'applied');
  assert.equal(scheduled, 0);
});
