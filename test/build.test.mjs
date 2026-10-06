import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

async function withIsolatedBuild(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-build-'));
  try {
    await cp(path.resolve('openclaw.plugin.json'), path.join(root, 'openclaw.plugin.json'));
    await cp(path.resolve('src'), path.join(root, 'src'), { recursive: true, verbatimSymlinks: true });
    // This build-only fixture verifies that sealed assets remain importable
    // beneath an external-tab plugin root. It is not a host-contract test;
    // supply only the public SDK exports imported at module load time instead
    // of making a temporary build accidentally resolve this checkout's SDK.
    const sdkRoot = path.join(root, 'node_modules', 'openclaw');
    await mkdir(path.join(sdkRoot, 'dist', 'plugin-sdk'), { recursive: true });
    await writeFile(path.join(sdkRoot, 'package.json'), JSON.stringify({
      name: 'openclaw', type: 'module', exports: {
        './plugin-sdk/session-store-runtime': './dist/plugin-sdk/session-store-runtime.mjs',
        './plugin-sdk/session-store-paths': './dist/plugin-sdk/session-store-paths.mjs'
      }
    }));
    await writeFile(path.join(sdkRoot, 'dist', 'plugin-sdk', 'session-store-runtime.mjs'), 'export function getSessionEntry() { return null; }\n');
    await writeFile(path.join(sdkRoot, 'dist', 'plugin-sdk', 'session-store-paths.mjs'), 'export function resolveStorePath() { throw new Error("Build-only fixture must not resolve a Session store."); }\n');
    const buildModule = await import(`${pathToFileURL(path.join(root, 'src', 'build.mjs')).href}?test=${Date.now()}-${Math.random()}`);
    await run(buildModule, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('build is deterministic and bound to its launch digest', async () => {
  await withIsolatedBuild(async ({ assertBuiltDigest, build, readBuiltReceipt, digestFileName, distRoot }, root) => {
    await assert.rejects(readBuiltReceipt(), (error) => error.code === 'ENOENT');
    const pluginSource = path.join(root, 'src', 'plugin.mjs');
    const canonicalPlugin = (await readFile(pluginSource, 'utf8')).replace(/\r\n?/gu, '\n');
    await writeFile(pluginSource, canonicalPlugin.replace(/\n/gu, '\r\n'));
    const first = await build();
    await writeFile(pluginSource, canonicalPlugin);
    const second = await build();
    assert.deepEqual(second, first);
    assert.deepEqual(await readBuiltReceipt(), second);
    for (const { path: relative } of second.files.filter((entry) => entry.path.endsWith('.mjs'))) {
      const modulePath = path.join(distRoot, relative);
      const source = await readFile(modulePath, 'utf8');
      for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/gu)) await access(new URL(match[1], pathToFileURL(modulePath)));
    }
    await assertBuiltDigest(second);
    await writeFile(path.join(distRoot, 'native-ui', 'entry.mjs'), '// changed');
    await assert.rejects(assertBuiltDigest(second), /digest drift/);
    await assert.rejects(readBuiltReceipt(), /digest drift/);

    const forgedFiles = second.files.map((entry) => entry.path === 'native-ui/entry.mjs'
      ? { ...entry, sha256: createHash('sha256').update('// changed').digest('hex') }
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

test('built runtime schema is a digest-bound snapshot of the canonical manifest', async () => {
  await withIsolatedBuild(async ({ build, assertBuiltDigest, distRoot }, root) => {
    const manifestPath = path.join(root, 'openclaw.plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const receipt = await build();
    const configPath = path.join(distRoot, 'plugin-config.mjs');
    const { pluginConfigSchema } = await import(pathToFileURL(configPath).href);
    assert.deepEqual(pluginConfigSchema, manifest.configSchema);
    assert.ok(receipt.files.some(entry => entry.path === 'plugin-config.mjs'));
    const original = await readFile(configPath, 'utf8');
    manifest.configSchema.properties.preservedHistorySource.additionalProperties = true;
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.equal(pluginConfigSchema.properties.preservedHistorySource.additionalProperties, false);
    await assertBuiltDigest(receipt);
    await writeFile(configPath, `${original}\n// changed runtime input\n`);
    await assert.rejects(assertBuiltDigest(receipt), /digest drift/);
    assert.notEqual((await build()).digest, receipt.digest);
  });
});

test('asset paths reject traversal and final symlinks', async () => {
  await withIsolatedBuild(async ({ assertBuiltDigest, build, distRoot, safeRelative }) => {
    assert.throws(() => safeRelative('../escape'));
    assert.throws(() => safeRelative('/escape'));
    await build();
    const link = path.join(distRoot, 'unsafe-link');
    await symlink('native-ui/entry.mjs', link);
    await assert.rejects(assertBuiltDigest(), /Symlinked asset/);
    await rm(link);
    assert.equal((await lstat(distRoot)).isSymbolicLink(), false);
  });
});

test('native package retains its runtime closure and excludes the retired shell payload', async () => {
  await withIsolatedBuild(async ({ build, distRoot }, root) => {
    // Rebuild from a pre-existing output so stale retired assets cannot survive.
    await mkdir(path.join(distRoot, 'ui'), { recursive: true });
    await writeFile(path.join(distRoot, 'ui', 'app.js'), '// stale shell');
    await writeFile(path.join(distRoot, 'asset-handler.mjs'), '// stale handler');
    const receipt = await build();
    assert.ok(receipt.files.every(({ path: relative }) => !relative.startsWith('ui/') && relative !== 'asset-handler.mjs'));
    await assert.rejects(access(path.join(distRoot, 'ui')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(distRoot, 'asset-handler.mjs')), { code: 'ENOENT' });
    await access(path.join(distRoot, 'plugin-service.mjs'));
    await access(path.join(distRoot, 'native-ui', 'entry.mjs'));
    await access(path.join(distRoot, 'native-ui', 'topic-navigation.mjs'));
    await import(`${pathToFileURL(path.join(distRoot, 'plugin-service.mjs')).href}?test=${Date.now()}-${Math.random()}`);
    await access(path.join(distRoot, 'metadata', 'service.mjs'));
    await access(path.join(distRoot, 'metadata', 'schema.mjs'));
    await access(path.join(distRoot, 'metadata', 'modes.mjs'));
    await access(path.join(distRoot, 'metadata', 'path.mjs'));
    await access(path.join(distRoot, 'search', 'service.mjs'));
    await access(path.join(distRoot, 'search', 'source-snapshot.mjs'));
    await access(path.join(distRoot, 'http', 'opaque-frame-cors.mjs'));
    // Retained acceptance still reads these authored fixtures directly.
    for (const name of ['app.js', 'index.html', 'markdown.js', 'styles.css']) await access(path.join(root, 'src', 'ui', name));
    await access(path.join(root, 'src', 'asset-handler.mjs'));
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
