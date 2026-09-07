import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openFixture } from './fixtures/first-live-note-read-only.mjs';
import { withNoteFilesystemOwner } from '../src/sources/note-filesystem-owner.mjs';
import { createMetadataService } from '../src/plugin-service.mjs';

async function crash(stateDir, operation, logicalOperationId, revision, boundary = 'claimed') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/first-live-note-read-only.mjs', import.meta.url)), 'child', stateDir, operation, logicalOperationId, revision, boundary], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
  try {
    const termination = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    assert.equal(termination.signal, 'SIGKILL', errors);
    assert.match(output, /boundary-reached/);
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

async function tree(root) {
  const entries = [];
  async function visit(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const target = path.join(directory, name); const stat = await fs.lstat(target);
      const entry = { path: path.relative(root, target), dev: stat.dev, ino: stat.ino, type: stat.isDirectory() ? 'directory' : 'file' };
      if (stat.isDirectory()) { entries.push(entry); await visit(target); }
      else entries.push({ ...entry, nlink: stat.nlink, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, bytes: (await fs.readFile(target)).toString('base64') });
    }
  }
  await visit(root); return entries;
}

for (const operation of ['edit', 'move']) test(`read-only Notes refuse an interrupted ${operation} without restoring its claimed source`, { skip: process.platform !== 'linux' }, async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-live-note-read-only-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); fixture.close(); fixture = null;
    fixture = await openFixture(stateDir, { noteRecoveryEffects: false });
    const catalog = await fixture.adapter.browsePage({ limit: 1 });
    const operationId = randomUUID(); await crash(stateDir, operation, operationId, before.revision);
    const files = await tree(root); const journal = fixture.metadata.listTopicOperations('fictional-read-only');
    await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), (error) => error.code === 'source-recovery');
    await assert.rejects(() => fixture.adapter.browse(), (error) => error.code === 'source-recovery');
    await assert.rejects(() => fixture.adapter.browsePage({ cursor: catalog.cursor }), (error) => error.code === 'source-recovery');
    await withNoteFilesystemOwner(fixture.metadata, async () => {
      await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), (error) => error.code === 'source-recovery');
      await assert.rejects(() => fixture.adapter.browse(), (error) => error.code === 'source-recovery');
      await assert.rejects(() => fixture.adapter.browsePage({ cursor: catalog.cursor }), (error) => error.code === 'source-recovery');
    }, { acquire: fixture.coordinator });
    assert.deepEqual(await tree(root), files);
    assert.deepEqual(fixture.metadata.listTopicOperations('fictional-read-only'), journal);
    fixture.close(); fixture = await openFixture(stateDir, { noteRecoveryEffects: false });
    await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), (error) => error.code === 'source-recovery');
    assert.deepEqual(fixture.metadata.listTopicOperations('fictional-read-only'), journal);
    const record = fixture.metadata.getTopicOperation(`notes.fs:${operationId}`);
    fixture.metadata.recordTopicOperation({ ...record, state: 'unknown' });
    const unknownJournal = fixture.metadata.listTopicOperations('fictional-read-only');
    await assert.rejects(() => fixture.adapter.browse(), (error) => error.code === 'source-recovery');
    assert.deepEqual(fixture.metadata.listTopicOperations('fictional-read-only'), unknownJournal);
    assert.deepEqual(await tree(root), files);
    await assert.rejects(fs.stat(path.join(root, 'original.md')), { code: 'ENOENT' });
    // Omitted policy still permits the historical full owner to finish recovery.
    fixture.close(); fixture = await openFixture(stateDir);
    const restored = await fixture.adapter.read({ path: 'original.md' });
    assert.equal(restored.text, 'original');
    assert.equal(restored.sourceReference.referenceId, before.sourceReference.referenceId);
  } finally { fixture?.close(); await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('ordinary read-only Notes retain stable identities and reject a changed Folder marker without source writes', { skip: process.platform !== 'linux' }, async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-live-note-clean-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir, { noteRecoveryEffects: false }); await fixture.enroll();
    const files = await tree(root);
    const catalog = await fixture.adapter.browsePage({ limit: 1 });
    const before = await fixture.adapter.read({ path: 'original.md' });
    assert.equal(before.sourceReference.referenceId, catalog.notes[0].sourceReference.referenceId);
    assert.deepEqual(await tree(root), files);
    fixture.close(); fixture = await openFixture(stateDir, { noteRecoveryEffects: false });
    const read = await fixture.adapter.read({ path: 'original.md' });
    assert.equal(read.text, 'original');
    assert.equal(read.sourceReference.referenceId, before.sourceReference.referenceId);
    assert.deepEqual(await tree(root), files);
    assert.deepEqual(fixture.metadata.listTopicOperations('fictional-read-only'), []);
    const folder = fixture.metadata.getSourceLocator('fictional-folder');
    const marker = files.find((entry) => entry.type === 'file' && entry.path !== 'original.md');
    assert.ok(marker, 'The fixture must retain its enrolled Folder marker.');
    await fs.writeFile(path.join(root, marker.path), 'foreign marker');
    const replaced = await tree(root);
    await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), (error) => error.code === 'source-recovery');
    assert.deepEqual(await tree(root), replaced);
    assert.deepEqual(fixture.metadata.getSourceLocator('fictional-folder'), folder);
  } finally { fixture?.close(); await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('a published edit awaiting recovery is refused without changing its bytes or completing its receipt', { skip: process.platform !== 'linux' }, async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-live-note-published-')); let fixture;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); fixture.close(); fixture = null;
    const operationId = randomUUID(); await crash(stateDir, 'edit', operationId, before.revision, 'published');
    fixture = await openFixture(stateDir, { noteRecoveryEffects: false });
    const files = await tree(root); const journal = fixture.metadata.listTopicOperations('fictional-read-only');
    assert.equal(await fs.readFile(path.join(root, 'original.md'), 'utf8'), 'replacement');
    await assert.rejects(() => fixture.adapter.read({ path: 'original.md' }), (error) => error.code === 'source-recovery');
    assert.deepEqual(await tree(root), files);
    assert.deepEqual(fixture.metadata.listTopicOperations('fictional-read-only'), journal);
  } finally { fixture?.close(); await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('production first-live startup enforces read-only recovery after a real interrupted Note write', { skip: process.platform !== 'linux' }, async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-live-note-startup-')); let fixture; let service;
  try {
    const root = path.join(stateDir, 'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'original.md'), 'original');
    fixture = await openFixture(stateDir); await fixture.enroll();
    const before = await fixture.adapter.read({ path: 'original.md' }); fixture.close(); fixture = null;
    await crash(stateDir, 'edit', randomUUID(), before.revision);
    fixture = await openFixture(stateDir, { noteRecoveryEffects: false });
    const files = await tree(root); const journal = fixture.metadata.listTopicOperations('fictional-read-only');
    service = createMetadataService({ runtime: { state: { resolveStateDir: () => stateDir } }, pluginConfig: { topics: { noteRoot: root } }, logger: {} });
    await service.start();
    await assert.rejects(() => service.sourceService.notesRead({ schemaVersion: 1, topicId: 'fictional-read-only', path: 'original.md' }), error => error.code === 'source-recovery');
    await assert.rejects(() => service.sourceService.notesBrowse({ schemaVersion: 1, topicId: 'fictional-read-only' }), error => error.code === 'source-recovery');
    assert.deepEqual(await tree(root), files);
    assert.deepEqual(fixture.metadata.listTopicOperations('fictional-read-only'), journal);
  } finally { await service?.stop(); fixture?.close(); await fs.rm(stateDir, { recursive: true, force: true }); }
});
