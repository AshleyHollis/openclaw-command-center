import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NoteAdapter } from '../src/sources/notes.mjs';

test('rollback preserves two successive external replacements instead of overwriting the newest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'note-rollback-'));
  const target = path.join(root, 'brief.md');
  const lstat = fs.lstat;
  try {
    await fs.writeFile(target, 'original');
    const expected = await lstat(target);
    await fs.rename(target, path.join(root, 'original.md'));
    await fs.writeFile(target, 'external-first');
    // Fault the actual filesystem await where another writer can publish after
    // quarantine. No production-only testing hook or timing-dependent sleep.
    fs.lstat = async (candidate, ...args) => {
      if (String(candidate).includes('.command-center-preserved-')) await fs.writeFile(target, 'external-second', { flag: 'wx' });
      return lstat(candidate, ...args);
    };
    syncBuiltinESMExports();
    await new NoteAdapter({ topicId: 'fictional' }).unlinkIfIdentity(target, expected);
    assert.equal(await fs.readFile(target, 'utf8'), 'external-second');
    const preserved = (await fs.readdir(root)).find((name) => name.includes('.command-center-preserved-'));
    assert.ok(preserved);
    assert.equal(await fs.readFile(path.join(root, preserved), 'utf8'), 'external-first');
  } finally {
    fs.lstat = lstat; syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
