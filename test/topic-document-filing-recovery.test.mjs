import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

const release = installHostFileAccessFixture();
test.after(release);
const linux = { skip: process.platform !== 'linux' && 'Descriptor-relative Note publication requires Linux.' };
const bytes = Buffer.from('fictional original attachment bytes');

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
