import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyNativeLock, verifyNext2Bundle } from '../scripts/restore-next2-native-source.mjs';

test('native source restore refuses a missing bundle before any Git operation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next2-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(verifyNext2Bundle(path.join(directory, 'missing.bundle')), { code: 'ENOENT' });
});

test('native source restore rejects same-size changed bundle bytes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next2-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changed.bundle');
  await writeFile(file, Buffer.alloc(53893));
  await assert.rejects(verifyNext2Bundle(file), /SHA256 changed/u);
});

test('native source lock check accepts pnpm-only checkout and rejects changed bytes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next2-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'pnpm-lock.yaml');
  const bytes = Buffer.from('lockfileVersion: 9.0\nfictional: true\n');
  await writeFile(file, bytes);
  const expected = createHash('sha256').update(bytes).digest('hex');
  await verifyNativeLock(directory, expected);
  await writeFile(file, 'lockfileVersion: changed\n');
  await assert.rejects(verifyNativeLock(directory, expected), /pnpm lock SHA256 changed/u);
});
