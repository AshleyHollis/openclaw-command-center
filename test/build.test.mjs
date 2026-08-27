import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

async function withIsolatedBuild(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-build-'));
  try {
    await cp(path.resolve('src'), path.join(root, 'src'), { recursive: true, verbatimSymlinks: true });
    const buildModule = await import(`${pathToFileURL(path.join(root, 'src', 'build.mjs')).href}?test=${Date.now()}-${Math.random()}`);
    await run(buildModule, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('build is deterministic and bound to its launch digest', async () => {
  await withIsolatedBuild(async ({ assertBuiltDigest, build, digestFileName, distRoot }) => {
    const first = await build();
    const second = await build();
    assert.deepEqual(second, first);
    await assertBuiltDigest(second);
    await writeFile(path.join(distRoot, 'ui', 'index.html'), '<changed>');
    await assert.rejects(assertBuiltDigest(second), /digest drift/);

    const forgedFiles = second.files.map((entry) => entry.path === 'ui/index.html'
      ? { ...entry, sha256: createHash('sha256').update('<changed>').digest('hex') }
      : entry);
    const forgedManifest = {
      formatVersion: 1,
      files: forgedFiles,
      digest: createHash('sha256').update(JSON.stringify(forgedFiles)).digest('hex')
    };
    await writeFile(path.join(distRoot, digestFileName), `${JSON.stringify(forgedManifest)}\n`);
    await assert.rejects(assertBuiltDigest(second), /digest drift/);
    await build();
  });
});

test('asset paths reject traversal and final symlinks', async () => {
  await withIsolatedBuild(async ({ assertBuiltDigest, build, distRoot, safeRelative }) => {
    assert.throws(() => safeRelative('../escape'));
    assert.throws(() => safeRelative('/escape'));
    await build();
    const link = path.join(distRoot, 'unsafe-link');
    await symlink('ui/index.html', link);
    await assert.rejects(assertBuiltDigest(), /Symlinked asset/);
    await rm(link);
    assert.equal((await lstat(distRoot)).isSymbolicLink(), false);
  });
});

test('mounted shell assets resolve beneath the external-tab plugin path', async () => {
  await withIsolatedBuild(async ({ build, distRoot }) => {
    await build();
    await access(path.join(distRoot, 'asset-handler.mjs'));
    await access(path.join(distRoot, 'plugin-service.mjs'));
    await import(`${pathToFileURL(path.join(distRoot, 'plugin-service.mjs')).href}?test=${Date.now()}-${Math.random()}`);
    await access(path.join(distRoot, 'metadata', 'service.mjs'));
    await access(path.join(distRoot, 'metadata', 'schema.mjs'));
    await access(path.join(distRoot, 'metadata', 'modes.mjs'));
    await access(path.join(distRoot, 'metadata', 'path.mjs'));
    await access(path.join(distRoot, 'search', 'service.mjs'));
    await access(path.join(distRoot, 'search', 'source-snapshot.mjs'));
    await access(path.join(distRoot, 'ui', 'app.js'));
    const shell = await readFile(path.join(distRoot, 'ui', 'index.html'), 'utf8');
    assert.match(shell, /href="\/plugins\/command-center\/styles\.css"/);
    assert.match(shell, /src="\/plugins\/command-center\/app\.js"/);
  });
});

test('build rejects intermediate source symlinks', async () => {
  await withIsolatedBuild(async ({ build }, root) => {
    const sourceLink = path.join(root, 'src', 'ui', 'unsafe-source-link');
    await symlink('../compatibility-tuple.json', sourceLink);
    try {
      await assert.rejects(build(), /Symlinked asset/);
    } finally {
      await rm(sourceLink);
    }
  });
});
