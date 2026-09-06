import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openFixture } from './fixtures/note-process-death.mjs';
import { TopicRecoveryService } from '../src/topics/recovery.mjs';
import { waitForFixtureClose, stopFixtureProcessTree, verifyFixtureGroupStopped } from './support/fixture-process-owner.mjs';

const ownedGroups = new Map();
const runner = new AbortController();
const interrupt = () => { process.exitCode = 130; runner.abort(new Error('Note fixture runner interrupted')); };
const terminate = () => { process.exitCode = 143; runner.abort(new Error('Note fixture runner terminated')); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
after(() => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); });

async function removeFixtureState(stateDir) {
  const child = ownedGroups.get(stateDir);
  await verifyFixtureGroupStopped(child);
  await fs.rm(stateDir, { recursive: true, force: true });
  ownedGroups.delete(stateDir);
}

async function crash(signal, stateDir, operation, boundary, logicalOperationId, revision, seam = 'adapter') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/note-process-death.mjs', import.meta.url)), 'child', stateDir, operation, boundary, logicalOperationId, revision, seam], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  let output = ''; let error = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
  ownedGroups.set(stateDir, child);
  const termination = await waitForFixtureClose(child, { signal: AbortSignal.any([signal, runner.signal]) });
  assert.equal(termination.signal, 'SIGKILL', error);
  assert.match(output, /boundary-reached/);
}

test('a fresh Note save with a stale base conflicts even when an external writer supplied identical desired bytes', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-stale-identical-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' });
    await fs.writeFile(path.join(root, 'original.md'), 'desired by both writers');
    const external = await fs.stat(path.join(root, 'original.md'));
    const logicalOperationId = randomUUID();
    await assert.rejects(() => fixture.adapter.edit({ path: 'original.md', expectedRevision: before.revision, text: 'desired by both writers', logicalOperationId }), (error) => error.code === 'conflict');
    assert.equal(await fs.readFile(path.join(root, 'original.md'), 'utf8'), 'desired by both writers');
    assert.equal((await fs.stat(path.join(root, 'original.md'))).ino, external.ino);
    assert.equal(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`), null);
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('a fresh Note create conflicts with an equal-text destination that has no operation provenance', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-create-external-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'replacement');
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const identity = await fs.stat(path.join(root, 'original.md'));
    const logicalOperationId = randomUUID();
    await assert.rejects(() => fixture.adapter.create({ path: 'original.md', text: 'replacement', logicalOperationId }), (error) => error.code === 'conflict');
    assert.equal((await fs.stat(path.join(root, 'original.md'))).ino, identity.ino);
    assert.equal(await fs.readFile(path.join(root, 'original.md'), 'utf8'), 'replacement');
    assert.equal(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`), null);
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('Note create recovers its exact published inode after process death before the response or metadata receipt', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-create-published-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root);
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID(); await crash(t.signal, stateDir, 'create', 'create-published', logicalOperationId, '-', 'service');
    const identity = await fs.stat(path.join(root, 'original.md'));
    fixture = await openFixture(stateDir);
    const result = await fixture.adapter.create({ path: 'original.md', text: 'replacement', logicalOperationId, referenceId: 'fictional-folder' });
    assert.equal(result.status, 'reconciled');
    assert.equal(result.note.text, 'replacement');
    assert.notEqual(result.note.sourceReference.referenceId, 'fictional-folder');
    assert.equal((await fs.stat(path.join(root, 'original.md'))).ino, identity.ino);
    assert.equal(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).state, 'applied');
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('a published create deleted externally after process death stays unknown and cannot be retried into existence', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-create-published-deleted-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root);
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID(); await crash(t.signal, stateDir, 'create', 'create-published', logicalOperationId, '-', 'service');
    await fs.unlink(path.join(root, 'original.md'));
    const names = await fs.readdir(root);
    fixture = await openFixture(stateDir, { beforePathIo: async ({ operation }) => { if (operation === 'create') throw new Error('Uncertain recovery entered create execution'); } });
    const input = { topicId: 'fictional-recovery', referenceId: 'fictional-folder', path: 'original.md', text: 'replacement', logicalOperationId };
    await assert.rejects(() => fixture.service.notesCreateReconcile(input), (error) => ['unknown', 'conflict'].includes(error.code));
    await assert.rejects(() => fixture.service.notesCreate(input), (error) => ['unknown', 'conflict'].includes(error.code));
    await assert.rejects(fs.lstat(path.join(root, 'original.md')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(root), names);
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('a create interrupted at the publication syscall stays unknown even when no destination is visible', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-create-attempting-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root);
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID(); await crash(t.signal, stateDir, 'create', 'create-attempting', logicalOperationId, '-', 'service');
    const names = await fs.readdir(root);
    fixture = await openFixture(stateDir, { beforePathIo: async ({ operation }) => { if (operation === 'create') throw new Error('Uncertain recovery entered create execution'); } });
    const input = { topicId: 'fictional-recovery', referenceId: 'fictional-folder', path: 'original.md', text: 'replacement', logicalOperationId };
    await assert.rejects(() => fixture.service.notesCreateReconcile(input), (error) => error.code === 'unknown');
    await assert.rejects(() => fixture.service.notesCreate(input), (error) => error.code === 'unknown');
    await assert.rejects(fs.lstat(path.join(root, 'original.md')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(root), names);
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('an older unversioned prepared create cannot gain retry authority merely from an absent destination', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-create-legacy-prepared-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root);
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID(); await crash(t.signal, stateDir, 'create', 'create-prepared', logicalOperationId, '-', 'service');
    fixture = await openFixture(stateDir);
    const record = fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`);
    const { createPublicationProtocol: _protocol, ...legacyResult } = record.result;
    fixture.metadata.recordTopicOperation({ ...record, result: legacyResult });
    fixture.close(); fixture = null;
    const names = await fs.readdir(root);
    fixture = await openFixture(stateDir, { beforePathIo: async ({ operation }) => { if (operation === 'create') throw new Error('Legacy recovery entered create execution'); } });
    const input = { topicId: 'fictional-recovery', referenceId: 'fictional-folder', path: 'original.md', text: 'replacement', logicalOperationId };
    await assert.rejects(() => fixture.service.notesCreateReconcile(input), (error) => error.code === 'unknown');
    await assert.rejects(() => fixture.service.notesCreate(input), (error) => error.code === 'unknown');
    await assert.rejects(fs.lstat(path.join(root, 'original.md')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(root), names);
    assert.deepEqual(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).result, legacyResult);
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('create reconciliation after a prepared process death never publishes; an explicit retry reuses the owned staging inode', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-create-prepared-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root);
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID(); await crash(t.signal, stateDir, 'create', 'create-prepared', logicalOperationId, '-', 'service');
    const names = await fs.readdir(root); const staging = names.find((name) => name.endsWith('.tmp'));
    const identity = await fs.stat(path.join(root, staging));
    fixture = await openFixture(stateDir, { beforePathIo: async ({ operation }) => { if (operation === 'create') throw new Error('Reconciliation entered create execution'); } });
    const input = { topicId: 'fictional-recovery', referenceId: 'fictional-folder', path: 'original.md', text: 'replacement', logicalOperationId };
    const result = await fixture.service.notesCreateReconcile(input);
    assert.equal(result.status, 'not-applied');
    await assert.rejects(fs.lstat(path.join(root, 'original.md')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(root), names);
    fixture.close(); fixture = await openFixture(stateDir);
    const created = await fixture.service.notesCreate(input);
    assert.equal(created.status, 'applied');
    assert.equal((await fs.stat(path.join(root, 'original.md'))).ino, identity.ino);
    assert.equal(created.value.note.sourceReference.referenceId, fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).result.sourceReference.referenceId);
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('create reconciliation without an inode witness stays unknown even when external text matches exactly', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-create-no-witness-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root);
    let createdExternally = false;
    fixture = await openFixture(stateDir, { beforePathIo: async ({ operation }) => {
      if (operation !== 'create') return;
      if (createdExternally) throw new Error('Reconciliation entered create execution');
      createdExternally = true;
      await fs.writeFile(path.join(root, 'original.md'), 'replacement', { flag: 'wx' });
      throw Object.assign(new Error('Synthetic ambiguous delivery before any create preparation'), { code: 'timeout' });
    } });
    fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const input = { topicId: 'fictional-recovery', referenceId: 'fictional-folder', path: 'original.md', text: 'replacement', logicalOperationId: randomUUID() };
    await assert.rejects(() => fixture.service.notesCreate(input), (error) => error.code === 'unknown');
    const identity = await fs.stat(path.join(root, 'original.md'));
    fixture.close(); fixture = await openFixture(stateDir, { beforePathIo: async ({ operation }) => { if (operation === 'create') throw new Error('Reconciliation executed create'); } });
    await assert.rejects(() => fixture.service.notesCreateReconcile(input), (error) => error.code === 'unknown');
    assert.equal(fixture.metadata.getTopicOperation(`notes.fs:${input.logicalOperationId}`), null);
    assert.equal(fixture.metadata.getOperation(input.logicalOperationId).state, 'unknown');
    assert.equal((await fs.stat(path.join(root, 'original.md'))).ino, identity.ino);
    assert.equal(await fs.readFile(path.join(root, 'original.md'), 'utf8'), 'replacement');
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

for (const boundary of ['create-prepared', 'create-published']) test(`create reconciliation rejects a foreign equal-text inode after ${boundary}`, { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-create-foreign-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root);
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID(); await crash(t.signal, stateDir, 'create', boundary, logicalOperationId, '-', 'service');
    const staging = (await fs.readdir(root)).find((name) => name.endsWith('.tmp'));
    const replacedPath = path.join(root, boundary === 'create-prepared' ? staging : 'original.md');
    const preservedPath = path.join(stateDir, 'preserved-owned-inode');
    const owned = await fs.stat(replacedPath);
    await fs.rename(replacedPath, preservedPath);
    await fs.writeFile(replacedPath, 'replacement', { flag: 'wx' });
    const foreign = await fs.stat(replacedPath); assert.notEqual(foreign.ino, owned.ino);
    const names = await fs.readdir(root);
    fixture = await openFixture(stateDir, { beforePathIo: async ({ operation }) => { if (operation === 'create') throw new Error('Reconciliation executed create'); } });
    const proof = fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).result;
    await assert.rejects(() => fixture.service.notesCreateReconcile({ topicId: 'fictional-recovery', referenceId: 'fictional-folder', path: 'original.md', text: 'replacement', logicalOperationId }), (error) => ['conflict', 'unknown'].includes(error.code));
    assert.equal((await fs.stat(replacedPath)).ino, foreign.ino);
    assert.equal((await fs.stat(preservedPath)).ino, owned.ino);
    assert.equal(await fs.readFile(replacedPath, 'utf8'), 'replacement');
    assert.deepEqual(await fs.readdir(root), names);
    assert.deepEqual(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).result, proof);
    assert.notEqual(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).state, 'applied');
    if (boundary === 'create-prepared') await assert.rejects(fs.lstat(path.join(root, 'original.md')), { code: 'ENOENT' });
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('an authorized folder replacement never grants an old interrupted Note claim the new binding generation', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-old-binding-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); fixture.close(); fixture = null;
    const logicalOperationId = randomUUID();
    await crash(t.signal, stateDir, 'edit', 'claimed', logicalOperationId, before.revision);
    fixture = await openFixture(stateDir);
    const originalProof = fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).result;
    const oldBinding = fixture.metadata.getSourceLocator('fictional-folder');
    const recovery = new TopicRecoveryService({ metadata: fixture.metadata, noteVaultRoot: stateDir });
    await recovery.markMissing('fictional-recovery', 'fictional-folder', 'explicit folder replacement requested');
    await recovery.verify({ topicId: 'fictional-recovery', referenceId: 'fictional-folder', replacementLocator: root,
      expectedRevision: fixture.metadata.getTopic('fictional-recovery').revision, expectedSourceRevision: oldBinding.observedRevision, logicalOperationId: randomUUID() });
    assert.equal(fixture.metadata.getSourceLocator('fictional-folder').locatorVersion, oldBinding.locatorVersion + 1);
    await fs.writeFile(path.join(root, 'new.md'), 'authorized replacement content');
    fixture.close(); fixture = await openFixture(stateDir);
    assert.equal((await fixture.adapter.read({ path: 'new.md' })).text, 'authorized replacement content');
    await assert.rejects(() => fixture.adapter.edit({ path: 'original.md', text: 'replacement', expectedRevision: before.revision, logicalOperationId }), (error) => error.code === 'conflict');
    assert.equal(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).state, 'unknown');
    assert.deepEqual(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).result, originalProof);
    await assert.rejects(fs.lstat(path.join(root, 'original.md')), { code: 'ENOENT' });
    const claimName = (await fs.readdir(root)).find((name) => name.includes('.command-center-claim-'));
    assert.equal(await fs.readFile(path.join(root, claimName), 'utf8'), 'original');
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('a copied folder marker and the exact old claim never authorize recovery in a recreated root', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-recreated-root-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); fixture.close(); fixture = null;
    const logicalOperationId = randomUUID(); await crash(t.signal, stateDir, 'edit', 'claimed', logicalOperationId, before.revision);
    const markerName = '.command-center-folder-identity';
    const copiedMarker = await fs.readFile(path.join(root, markerName));
    const claimName = (await fs.readdir(root)).find((name) => name.includes('.command-center-claim-'));
    const savedClaim = path.join(stateDir, 'preserved-claim');
    await fs.rename(path.join(root, claimName), savedClaim);
    const identity = await fs.stat(savedClaim);
    await fs.rm(root, { recursive: true }); await fs.mkdir(root);
    await fs.writeFile(path.join(root, markerName), copiedMarker);
    await fs.rename(savedClaim, path.join(root, claimName));
    await fs.writeFile(path.join(root, 'foreign.md'), 'foreign');
    fixture = await openFixture(stateDir);
    await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), (error) => error.code === 'source-recovery');
    await assert.rejects(fs.lstat(path.join(root, 'original.md')), { code: 'ENOENT' });
    assert.equal((await fs.stat(path.join(root, claimName))).ino, identity.ino);
    assert.equal(await fs.readFile(path.join(root, claimName), 'utf8'), 'original');
    assert.equal(await fs.readFile(path.join(root, 'foreign.md'), 'utf8'), 'foreign');
    assert.notEqual(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).state, 'applied');
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

for (const operation of ['edit', 'move']) for (const boundary of ['claimed', 'published']) test(`${operation}: reopening a Note recovers its proven inode after process death at ${boundary}`, { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-crash-'));
  let fixture;
  try {
    await fs.mkdir(path.join(stateDir, 'vault'));
    await fs.writeFile(path.join(stateDir, 'vault/original.md'), 'original');
    fixture = await openFixture(stateDir);
    fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' });
    const identity = await fs.stat(path.join(stateDir, 'vault/original.md'));
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID();
    await crash(t.signal, stateDir, operation, boundary, logicalOperationId, before.revision);
    const target = boundary === 'published' && operation === 'move' ? 'nested/moved.md' : 'original.md';
    const publishedIdentity = boundary === 'published' ? await fs.stat(path.join(stateDir, 'vault', target)) : identity;
    fixture = await openFixture(stateDir);
    assert.equal((await fixture.adapter.read({ path: target })).text, boundary === 'published' && operation === 'edit' ? 'replacement' : 'original');
    assert.equal((await fs.stat(path.join(stateDir, 'vault', target))).ino, publishedIdentity.ino);
    const retried = await fixture.adapter[operation]({ path: 'original.md', destinationPath: 'nested/moved.md', text: 'replacement', expectedRevision: before.revision, logicalOperationId });
    assert.equal(retried.note.text, operation === 'edit' ? 'replacement' : 'original');
    if (boundary === 'published') assert.equal((await fs.stat(path.join(stateDir, 'vault', target))).ino, publishedIdentity.ino);
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('the public source service completes the same logical move after a published process death', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-service-crash-'));
  let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir);
    fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' });
    const logicalOperationId = randomUUID(); fixture.close(); fixture = null;
    await crash(t.signal, stateDir, 'move', 'published', logicalOperationId, before.revision, 'service');
    fixture = await openFixture(stateDir);
    const result = await fixture.service.notesMove({ topicId: 'fictional-recovery', path: 'original.md', destinationPath: 'nested/moved.md', text: 'replacement', expectedRevision: before.revision, logicalOperationId });
    assert.equal(result.status, 'applied'); assert.equal(result.value.note.path, 'nested/moved.md');
    assert.equal(result.value.note.text, 'original');
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

for (const operation of ['edit', 'move']) test(`${operation}: recovery never adopts a same-bytes foreign inode captured before claim lstat`, { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-foreign-claim-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); const original = await fs.stat(path.join(root, 'original.md'));
    fixture.close(); fixture = null;
    await crash(t.signal, stateDir, operation, 'foreign-claim', randomUUID(), before.revision);
    const claimName = (await fs.readdir(root)).find((name) => name.includes('.command-center-claim-'));
    const foreign = await fs.stat(path.join(root, claimName)); assert.notEqual(foreign.ino, original.ino);
    fixture = await openFixture(stateDir);
    await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), (error) => error.code === 'conflict');
    assert.equal((await fs.stat(path.join(root, claimName))).ino, foreign.ino);
    assert.equal(await fs.readFile(path.join(root, claimName), 'utf8'), 'original');
    assert.equal((await fs.stat(path.join(root, 'external-original.md'))).ino, original.ino);
    await assert.rejects(fs.stat(path.join(root, 'original.md')), { code: 'ENOENT' });
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('recovery preserves a foreign edit replacement at its name after process death inside rollback quarantine', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-rollback-crash-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); fixture.close(); fixture = null;
    await crash(t.signal, stateDir, 'edit', 'rollback-foreign', randomUUID(), before.revision);
    fixture = await openFixture(stateDir);
    await fixture.adapter.read({ path: 'original.md' }).catch((error) => { assert.equal(error.code, 'conflict'); });
    assert.equal(await fs.readFile(path.join(root, 'original.md'), 'utf8'), 'foreign');
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('a Note reader cannot recover a live writer and acquires ownership after SIGKILL without age stealing', { skip: process.platform !== 'linux', timeout: 20_000 }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-live-owner-')); let fixture; let child; let read; let closed;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); fixture.close(); fixture = null;
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/note-process-death.mjs', import.meta.url)), 'child', stateDir, 'edit', 'held', randomUUID(), before.revision], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    ownedGroups.set(stateDir, child);
    closed = waitForFixtureClose(child, { signal: AbortSignal.any([t.signal, runner.signal]) });
    // Readiness may reject first; keep completion handled until the finally joins it.
    closed.catch(() => {});
    let output = ''; let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('writer-held')) resolve(); });
      child.once('error', reject); child.once('exit', () => reject(new Error(errors || 'The writer stopped before holding its claim.')));
    });
    fixture = await openFixture(stateDir);
    read = fixture.adapter.read({ path: 'original.md' });
    assert.equal(await Promise.race([read.then(() => 'completed'), delay(100).then(() => 'blocked')]), 'blocked');
    await assert.rejects(fs.stat(path.join(root, 'original.md')), { code: 'ENOENT' });
    stopFixtureProcessTree(child); await closed;
    assert.equal((await read).text, 'original');
    const lock = await fs.readFile(path.join(path.dirname(fixture.metadata.databasePath), 'note-filesystem-coordinator.sqlite'));
    assert.equal(lock.length, 0);
  } finally { stopFixtureProcessTree(child); await closed?.catch(() => {}); await read?.catch(() => {}); fixture?.close(); await removeFixtureState(stateDir); }
});

test('a proven edit remains committed when the obsolete original changes before metadata and process death', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-metadata-crash-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); fixture.close(); fixture = null;
    await crash(t.signal, stateDir, 'edit', 'metadata', randomUUID(), before.revision);
    fixture = await openFixture(stateDir);
    assert.equal((await fixture.adapter.read({ path: 'original.md' })).text, 'replacement');
    const claim = (await fs.readdir(root)).find((name) => name.includes('.command-center-claim-'));
    assert.equal(await fs.readFile(path.join(root, claim), 'utf8'), 'late original-descriptor write');
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

test('a transient recovery observation failure retains the proven filesystem phase across reopening', { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-observation-retry-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault');
    await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir);
    fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' });
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID();
    await crash(t.signal, stateDir, 'edit', 'metadata', logicalOperationId, before.revision);
    fixture = await openFixture(stateDir, { beforeObservation: async () => { throw new Error('Synthetic observation failure'); } });
    await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), /Synthetic observation failure/);
    fixture.close(); fixture = null;
    fixture = await openFixture(stateDir);
    assert.equal((await fixture.adapter.read({ path: 'original.md' })).text, 'replacement');
    assert.equal(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).state, 'applied');
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});

for (const operation of ['edit', 'move']) test(`${operation}: a claim swapped during restoration never authorizes replay against the foreign inode`, { skip: process.platform !== 'linux' }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-restore-swap-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault');
    await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir);
    fixture.metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' }); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' });
    fixture.close(); fixture = null;
    const logicalOperationId = randomUUID();
    await crash(t.signal, stateDir, operation, 'claimed', logicalOperationId, before.revision);
    fixture = await openFixture(stateDir);
    const restore = fixture.adapter.restoreClaim.bind(fixture.adapter);
    const preserved = path.join(root, 'external-original.md');
    let foreignIdentity;
    fixture.adapter.restoreClaim = async (claim, target) => {
      await fs.rename(claim, preserved);
      await fs.writeFile(claim, 'original', { flag: 'wx' });
      foreignIdentity = await fs.stat(claim);
      return restore(claim, target);
    };
    await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), (error) => error.code === 'conflict');
    assert.equal(fixture.metadata.getTopicOperation(`notes.fs:${logicalOperationId}`).state, 'unknown');
    fixture.adapter.restoreClaim = restore;
    await assert.rejects(() => fixture.adapter[operation]({ path: 'original.md', destinationPath: 'nested/moved.md', text: 'replacement', expectedRevision: before.revision, logicalOperationId }), (error) => error.code === 'conflict');
    assert.equal(await fs.readFile(preserved, 'utf8'), 'original');
    assert.equal(await fs.readFile(path.join(root, 'original.md'), 'utf8'), 'original');
    assert.equal((await fs.stat(path.join(root, 'original.md'))).ino, foreignIdentity.ino);
    await assert.rejects(fs.stat(path.join(root, 'nested/moved.md')), { code: 'ENOENT' });
  } finally { fixture?.close(); await removeFixtureState(stateDir); }
});
