import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

// The isolated source copy still uses the actual host's public archive facade.
// An explicit source facade is focused diagnostic evidence, not a sealed host.
const archiveUrl = process.env.COMMAND_CENTER_TEST_ARCHIVE_RUNTIME ?? import.meta.resolve('openclaw/plugin-sdk/archive');
const fileAccessUrl = process.env.COMMAND_CENTER_TEST_FILE_ACCESS_RUNTIME ?? import.meta.resolve('openclaw/plugin-sdk/file-access-runtime');
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'openclaw/plugin-sdk/archive') return { url: archiveUrl, shortCircuit: true };
  if (specifier === 'openclaw/plugin-sdk/file-access-runtime') return { url: fileAccessUrl, shortCircuit: true };
  return nextResolve(specifier, context);
} });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['src', 'package.json', 'openclaw.plugin.json', 'LICENSE']) {
    await cp(path.resolve(name), path.join(root, name), { recursive: true, verbatimSymlinks: true });
  }
  const { build } = await import(pathToFileURL(path.join(root, 'src/build.mjs')).href);
  const receipt = await build();
  const artifact = await import(pathToFileURL(path.join(root, 'src/plugin-artifact.mjs')).href);
  return { root, receipt, ...artifact };
}

test('sealed plugin packs deterministically and round trips through the native archive verifier', async t => {
  const { root, receipt, packagePluginArtifact, verifyPluginArtifact } = await fixture(t);
  const first = await packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output-a') });
  const second = await packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output-b') });
  assert.deepEqual(first.receipt, second.receipt);
  assert.deepEqual(await readFile(first.archivePath), await readFile(second.archivePath));
  assert.equal(first.receipt.kind, 'command-center-plugin-artifact');
  assert.equal(first.receipt.buildDigest, receipt.digest);
  assert.ok(first.receipt.files.some(file => file.path === 'dist/.command-center-digest.json'));
  const destination = path.join(root, 'verified');
  const previousMask = process.umask(0o077);
  let verified;
  try {
    verified = await verifyPluginArtifact({ archivePath: first.archivePath, expectedReceipt: first.receipt, destinationDirectory: destination });
  } finally { process.umask(previousMask); }
  assert.equal(verified, destination);
  assert.equal((await lstat(verified)).mode & 0o777, 0o755);
  assert.deepEqual((await readdir(verified)).sort(), ['LICENSE', 'dist', 'openclaw.plugin.json', 'package.json']);
  assert.equal((await lstat(path.join(verified, 'dist'))).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(verified, 'dist/plugin.mjs'))).mode & 0o777, 0o644);
  assert.deepEqual(await readFile(path.join(verified, 'dist/plugin.mjs')), await readFile(path.join(root, 'dist/plugin.mjs')));
  assert.deepEqual(JSON.parse(await readFile(first.receiptPath, 'utf8')), first.receipt);
});

test('pack refuses output inside the sealed build before writing anything', async t => {
  const { root, receipt, packagePluginArtifact } = await fixture(t);
  await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'dist', 'new-package') }), { code: 'artifact-layout-invalid' });
  await assert.rejects(lstat(path.join(root, 'dist', 'new-package')), { code: 'ENOENT' });
});

test('matching build receipt does not authorize a changed root schema or compatibility tuple', async t => {
  const { root, receipt, packagePluginArtifact } = await fixture(t);
  const manifestFile = path.join(root, 'openclaw.plugin.json');
  const original = await readFile(manifestFile);
  const manifest = JSON.parse(original); manifest.configSchema.additionalProperties = true;
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') }), { code: 'artifact-manifest-mismatch' });
  await writeFile(manifestFile, original);
  const packageFile = path.join(root, 'package.json');
  const pkg = JSON.parse(await readFile(packageFile)); pkg.commandCenter.compatibilityTuple.host.commit = '0'.repeat(40);
  await writeFile(packageFile, JSON.stringify(pkg));
  await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') }), { code: 'artifact-manifest-mismatch' });
});

test('the sealed build binds native UI and CLI declarations and the host API range', async t => {
  const { root, receipt, packagePluginArtifact } = await fixture(t);
  const manifestPath = path.join(root, 'openclaw.plugin.json');
  const original = await readFile(manifestPath);
  for (const change of [manifest => { manifest.controlUi.entry = 'dist/native-ui/missing.mjs'; }, manifest => { manifest.cliCommands = []; }]) {
    const manifest = JSON.parse(original); change(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') }), { code: 'artifact-manifest-mismatch' });
  }
  await writeFile(manifestPath, original);
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath)); pkg.openclaw.compat.pluginApi = '=1900.1.1';
  await writeFile(pkgPath, JSON.stringify(pkg));
  await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') }), { code: 'artifact-manifest-mismatch' });
});

test('a forged on-disk build receipt cannot replace the retained build approval', async t => {
  const { root, receipt, packagePluginArtifact } = await fixture(t);
  const changed = Buffer.from('// replaced');
  await writeFile(path.join(root, 'dist/plugin.mjs'), changed);
  const forged = structuredClone(receipt);
  forged.files.find(file => file.path === 'plugin.mjs').sha256 = createHash('sha256').update(changed).digest('hex');
  forged.digest = createHash('sha256').update(JSON.stringify(forged.files)).digest('hex');
  await writeFile(path.join(root, 'dist/.command-center-digest.json'), JSON.stringify(forged));
  await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') }), /digest drift/);
});

test('pack omits source and private files and never runs package lifecycle scripts', async t => {
  const { root, receipt, packagePluginArtifact } = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
  pkg.scripts = { prepack: 'exit 71', prepare: 'exit 72', postpack: 'exit 73' };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(root, '.env'), 'fictional private input');
  const packed = await packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') });
  assert.ok(packed.receipt.files.every(file => file.path.startsWith('dist/') || ['LICENSE', 'package.json', 'openclaw.plugin.json'].includes(file.path)));
});

test('linked manifests are refused and existing output is never overwritten', async t => {
  const { root, receipt, packagePluginArtifact } = await fixture(t);
  await cp(path.join(root, 'package.json'), path.join(root, 'outside-package.json'));
  await rm(path.join(root, 'package.json'));
  await symlink('outside-package.json', path.join(root, 'package.json'));
  await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') }), { code: 'artifact-member-unsafe' });
  await rm(path.join(root, 'package.json'));
  await cp(path.join(root, 'outside-package.json'), path.join(root, 'package.json'));
  await mkdir(path.join(root, 'output')); await writeFile(path.join(root, 'output', 'keep'), 'unchanged');
  await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(root, 'output', 'keep'), 'utf8'), 'unchanged');
});

test('native verification refuses tampered, extra, missing and linked archive content without publishing a directory', async t => {
  const { root, receipt, packagePluginArtifact, verifyPluginArtifact } = await fixture(t);
  const packed = await packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(root, 'output') });
  const archive = path.join(root, 'hostile.tgz');
  await writeFile(archive, 'not the approved archive');
  await assert.rejects(verifyPluginArtifact({ archivePath: archive, expectedReceipt: packed.receipt, destinationDirectory: path.join(root, 'bad-hash') }), { code: 'artifact-archive-mismatch' });
  await assert.rejects(lstat(path.join(root, 'bad-hash')), { code: 'ENOENT' });
  for (const scenario of ['extra', 'missing', 'link', 'duplicate', 'escape']) {
    const staged = path.join(root, scenario); await mkdir(staged, { mode: 0o700 });
    await verifyPluginArtifact({ archivePath: packed.archivePath, expectedReceipt: packed.receipt, destinationDirectory: path.join(staged, 'package') });
    if (scenario === 'extra') await writeFile(path.join(staged, 'package', 'extra.txt'), 'unexpected');
    if (scenario === 'missing') await rm(path.join(staged, 'package', 'dist/plugin.mjs'));
    if (scenario === 'link') await symlink('../package.json', path.join(staged, 'package', 'dist/linked'));
    const members = scenario === 'duplicate' ? ['package', 'package/dist/plugin.mjs'] : ['package'];
    const transform = scenario === 'escape' ? ['--transform=s,^package/dist/plugin.mjs$,../escaped.mjs,'] : [];
    await promisify(execFile)('tar', ['-czf', archive, '-C', staged, ...transform, ...members]);
    const bytes = await readFile(archive);
    const expected = { ...packed.receipt, archive: { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length } };
    const destination = path.join(root, `rejected-${scenario}`);
    await assert.rejects(verifyPluginArtifact({ archivePath: archive, expectedReceipt: expected, destinationDirectory: destination }));
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
  }
});

test('replaced publication parent is refused after packing without writing into its replacement', async t => {
  const { root, receipt, packagePluginArtifact } = await fixture(t);
  const parent = path.join(root, 'publication'); await mkdir(parent, { mode: 0o700 });
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const { stdout } = await promisify(execFile)('which', ['npm']);
  const actualNpm = stdout.trim();
  const wrapper = `#!/usr/bin/env node\nimport fs from 'node:fs'; import { spawnSync } from 'node:child_process';\n` +
    `fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(`${parent}-original`)}); fs.mkdirSync(${JSON.stringify(parent)}, { mode: 0o700 });\n` +
    `const result = spawnSync(${JSON.stringify(actualNpm)}, process.argv.slice(2), { stdio: 'inherit', env: process.env }); process.exit(result.status ?? 1);\n`;
  await writeFile(path.join(bin, 'npm'), wrapper, { mode: 0o755 });
  const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath}`;
  try {
    assert.equal((await promisify(execFile)('which', ['npm'])).stdout.trim(), path.join(bin, 'npm'),
      'publication interruption fixture requires an executable temporary directory');
    await assert.rejects(packagePluginArtifact({ expectedBuildReceipt: receipt, outputDirectory: path.join(parent, 'output') }), { code: 'artifact-parent-changed' });
    assert.deepEqual(await readdir(parent), []);
  } finally { process.env.PATH = previousPath; }
});

test('packaging CLI requires an independently supplied receipt digest and reports verified artifact identity', async t => {
  const { root, receipt } = await fixture(t);
  await mkdir(path.join(root, 'scripts'));
  await cp(path.resolve('scripts/package-plugin.mjs'), path.join(root, 'scripts/package-plugin.mjs'));
  const approval = path.join(root, 'approval.json'); const bytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(approval, bytes);
  const loader = path.join(root, 'sdk-loader.mjs');
  await writeFile(loader, `import { registerHooks } from 'node:module';\n` +
    `const urls = ${JSON.stringify({ 'openclaw/plugin-sdk/archive': archiveUrl, 'openclaw/plugin-sdk/file-access-runtime': fileAccessUrl })};\n` +
    `registerHooks({ resolve(specifier, context, nextResolve) { return urls[specifier] ? { url: urls[specifier], shortCircuit: true } : nextResolve(specifier, context); } });\n`);
  const runtimeArgs = process.execArgv.flatMap((value, index, args) => {
    if (value !== '--import') return [];
    const module = args[index + 1];
    return [value, module.startsWith('.') || path.isAbsolute(module) ? path.resolve(module) : module];
  });
  const base = [...runtimeArgs, '--import', loader, path.join(root, 'scripts/package-plugin.mjs'), '--build-receipt', approval, '--output', path.join(root, 'output'), '--receipt-sha256'];
  await assert.rejects(promisify(execFile)(process.execPath, [...base, '0'.repeat(64)], { cwd: root }), error => {
    assert.match(error.stderr, /artifact-build-approval-mismatch/); return true;
  });
  await assert.rejects(lstat(path.join(root, 'output')), { code: 'ENOENT' });
  const { stdout } = await promisify(execFile)(process.execPath, [...base, createHash('sha256').update(bytes).digest('hex')], { cwd: root, timeout: 60_000 });
  const report = JSON.parse(stdout);
  const published = JSON.parse(await readFile(path.join(root, 'output/receipt.json')));
  assert.deepEqual(report, { status: 'verified', buildDigest: receipt.digest, archiveSha256: published.archive.sha256, files: published.files.length });
  for (const name of ['scripts', 'docs', 'test', 'package-lock.json', 'runtime-capability.source-graph.json']) {
    await cp(path.resolve(name), path.join(root, name), { recursive: true });
  }
  const candidate = [...runtimeArgs, '--import', loader, path.join(root, 'scripts/package-candidate.mjs'), '--output'];
  const { stdout: candidateOutput } = await promisify(execFile)(process.execPath, [...candidate, path.join(root, 'candidate')], { cwd: root, timeout: 60_000 });
  const candidateReport = JSON.parse(candidateOutput);
  const candidateReceipt = JSON.parse(await readFile(path.join(root, 'candidate/receipt.json')));
  assert.deepEqual(candidateReport, { status: 'candidate-packaged', releaseQualified: false,
    buildDigest: receipt.digest, archiveSha256: candidateReceipt.archive.sha256, files: candidateReceipt.files.length });
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath)); pkg.commandCenter.runtimeCapability.id = 'invalid';
  await writeFile(pkgPath, JSON.stringify(pkg));
  await assert.rejects(promisify(execFile)(process.execPath, [...candidate, path.join(root, 'rejected')], { cwd: root, timeout: 60_000 }));
  await assert.rejects(lstat(path.join(root, 'rejected')), { code: 'ENOENT' });
});
