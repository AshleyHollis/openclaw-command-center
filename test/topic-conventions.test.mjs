import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { conventionalFolderPath, ensureConventionalFolder, findConventionalFolder, validateTopicName } from '../src/topics/conventions.mjs';

test('the PARA convention is exact, plural for active categories, trimmed, and rejects unsafe or guessed names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-convention-'));
  try {
    assert.equal(conventionalFolderPath(root, 'project', '  Exact Name  '), path.join(root, 'Projects', 'Exact Name'));
    assert.equal(conventionalFolderPath(root, 'archive', 'Exact Name'), path.join(root, 'Archive', 'Exact Name'));
    assert.equal(validateTopicName('é'.repeat(127)), 'é'.repeat(127));
    assert.throws(() => validateTopicName('é'.repeat(128)), /255-byte/i);
    assert.throws(() => validateTopicName('a/b'), /path separators/i);
    assert.throws(() => validateTopicName('..'), /safe exact/i);
    assert.throws(() => conventionalFolderPath(root, 'Projects', 'Exact Name'), /Unsupported PARA/);
    assert.throws(() => conventionalFolderPath('relative-vault', 'project', 'Exact Name'), /absolute noteVaultRoot/i);
    await mkdir(path.join(root, 'Projects', 'Exact Name'), { recursive: true });
    const adopted = await findConventionalFolder({ noteVaultRoot: root, paraCategory: 'project', name: 'Exact Name' });
    assert.equal(adopted.ownership, 'adopted');
    assert.match(adopted.revision, /^fs:\d+:\d+:/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('case/Unicode aliases, symlinked candidates, and foreign ownership are visible conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-convention-conflict-'));
  try {
    await mkdir(path.join(root, 'Areas', 'exact name'), { recursive: true });
    await assert.rejects(findConventionalFolder({ noteVaultRoot: root, paraCategory: 'area', name: 'Exact Name' }), /similar/i);
    await mkdir(path.join(root, 'Resources'), { recursive: true });
    await symlink(path.join(root, 'Areas'), path.join(root, 'Resources', 'Alias')).catch(() => {});
    await assert.rejects(ensureConventionalFolder({ noteVaultRoot: root, paraCategory: 'resource', name: 'Alias' }), /real directory|alias|symlink/i);
    await mkdir(path.join(root, 'projects'), { recursive: true });
    await assert.rejects(ensureConventionalFolder({ noteVaultRoot: root, paraCategory: 'project', name: 'Exact Name' }), /similar PARA directory/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configured Note roots are ordered, normalized, unique, and refuse multiple exact matches', async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), 'command-center-primary-root-'));
  const second = await mkdtemp(path.join(os.tmpdir(), 'command-center-secondary-root-'));
  try {
    const normalized = validateTopicName('  Cafe\u0301  ');
    assert.equal(normalized, 'Café');
    const missing = await findConventionalFolder({ noteVaultRoots: [first, second], paraCategory: 'project', name: normalized });
    assert.equal(missing.path, path.join(first, 'Projects', normalized));
    await mkdir(path.join(second, 'Projects', normalized), { recursive: true });
    assert.equal((await findConventionalFolder({ noteVaultRoots: [first, second], paraCategory: 'project', name: normalized })).path, path.join(second, 'Projects', normalized));
    await mkdir(path.join(first, 'Projects', normalized), { recursive: true });
    await assert.rejects(findConventionalFolder({ noteVaultRoots: [first, second], paraCategory: 'project', name: normalized }), /Multiple configured Note roots/i);
    await assert.rejects(findConventionalFolder({ noteVaultRoots: [first, first], paraCategory: 'project', name: normalized }), /unique/i);
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
});
