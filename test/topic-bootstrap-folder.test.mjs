import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as folders from '../src/sources/note-folder-identity.mjs';

test('enrollment cannot accept changed marker bytes after its durability sync', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-marker-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await folders.inspectNoteFolderCandidate(root);
  const options = { expectedDirectoryIdentity: candidate.directoryIdentity, markerId: randomUUID(), expectedIdentity: null, assertCurrent: () => {} };
  await folders.withBootstrapNoteFolder(root, options, () => {});
  const original = fs.promises.open;
  let changed = false;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (path.basename(String(args[0])) === folders.NOTE_FOLDER_IDENTITY_FILE) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync(); changed = true;
        await writeFile(path.join(root, folders.NOTE_FOLDER_IDENTITY_FILE), `${JSON.stringify({ version: 1, id: options.markerId })} \n`);
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(folders.withBootstrapNoteFolder(root, options, () => assert.fail('unsynced changed marker reached completion')), { code: 'source-recovery' });
    assert.equal(changed, true);
  } finally { fs.promises.open = original; syncBuiltinESMExports(); }
});

test('post-publication sync failure resumes by syncing the same marker without replacing it', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-marker-durable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await folders.inspectNoteFolderCandidate(root);
  const options = { expectedDirectoryIdentity: candidate.directoryIdentity, markerId: randomUUID(), expectedIdentity: null, assertCurrent: () => {} };
  const originalSync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('injected directory sync failure'), { code: 'EPERM' });
    return originalSync(fd);
  };
  try {
    await assert.rejects(folders.withBootstrapNoteFolder(root, options, () => assert.fail('failed durability reached completion')), { code: 'helper-failed' });
  } finally { fs.fsyncSync = originalSync; }
  const markerPath = path.join(root, folders.NOTE_FOLDER_IDENTITY_FILE);
  const originalStat = fs.statSync(markerPath, { bigint: true });
  const originalOpen = fs.promises.open;
  let resynced = false;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.basename(String(args[0])) === folders.NOTE_FOLDER_IDENTITY_FILE) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); resynced = true; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await folders.withBootstrapNoteFolder(root, options, () => assert.equal(resynced, true));
    assert.equal(fs.statSync(markerPath, { bigint: true }).ino, originalStat.ino);
  } finally { fs.promises.open = originalOpen; syncBuiltinESMExports(); }
});

test('process death before marker content cannot publish a partial identity or prevent exact bootstrap resume', { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-marker-crash-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const root = path.join(state, 'existing'); await mkdir(root);
  await writeFile(path.join(root, 'Overview.md'), 'Preserve the existing Note.');
  const candidate = await folders.inspectNoteFolderCandidate(root);
  const options = { expectedDirectoryIdentity: candidate.directoryIdentity, markerId: randomUUID(), expectedIdentity: null };
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/folder-enrollment-crash-child.mjs', import.meta.url)), root, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const result = await closed;
    assert.equal(output.trim(), 'interrupted-before-marker-content', errors);
    assert.deepEqual(result, { code: null, signal: 'SIGKILL' });
    await assert.rejects(readFile(path.join(root, folders.NOTE_FOLDER_IDENTITY_FILE)), { code: 'ENOENT' }, 'unfinished bytes must never occupy the final marker name');
    const identity = await folders.withBootstrapNoteFolder(root, { ...options, assertCurrent: () => {} }, witness => witness.identity);
    assert.equal(await folders.readNoteFolderIdentity(root), identity);
    assert.equal(await readFile(path.join(root, 'Overview.md'), 'utf8'), 'Preserve the existing Note.');
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});

test('bootstrap folder enrollment retains exact directory and marker witnesses through completion', { skip: process.platform !== 'linux' }, async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-folder-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const root = path.join(state, 'existing-alias'); await mkdir(root); await writeFile(path.join(root, 'Overview.md'), 'Keep this Note.');
  const candidate = await folders.inspectNoteFolderCandidate(root);
  assert.equal(candidate.path, root); assert.equal(candidate.markerIdentity, null);
  const markerId = randomUUID();
  const options = { expectedDirectoryIdentity: candidate.directoryIdentity, markerId, expectedIdentity: null, assertCurrent: () => {} };
  const enrolled = await folders.withBootstrapNoteFolder(root, options, async witness => {
    witness.assertCurrent();
    assert.equal(await folders.readNoteFolderIdentity(root), witness.identity);
    return witness.identity;
  });
  assert.equal(await readFile(path.join(root, 'Overview.md'), 'utf8'), 'Keep this Note.');
  assert.equal(await folders.withBootstrapNoteFolder(root, options, witness => witness.identity), enrolled, 'same operation can recover enrollment without replacing its marker');
  const markerBytes = await readFile(path.join(root, folders.NOTE_FOLDER_IDENTITY_FILE));
  await folders.withBootstrapNoteFolder(root, { ...options, expectedIdentity: enrolled }, async witness => {
    await rename(root, `${root}-original`); await mkdir(root); await writeFile(path.join(root, folders.NOTE_FOLDER_IDENTITY_FILE), markerBytes);
    assert.throws(() => witness.assertCurrent(), { code: 'source-recovery' });
  });
  await assert.rejects(folders.withBootstrapNoteFolder(root, options, () => assert.fail('rebound folder reached completion')), { code: 'source-recovery' });
});
