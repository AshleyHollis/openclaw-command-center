import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validatePackageBinding } from '../scripts/qualification-package.mjs';

const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('qualification requires an exact package selection for its source commit', async t => {
  const binding = {
    runId: '1234', sourceCommit: 'a'.repeat(40), buildDigest: 'b'.repeat(64),
    archiveSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64)
  };
  assert.deepEqual(validatePackageBinding(binding, binding.sourceCommit), binding);
  assert.throws(() => validatePackageBinding(binding, 'e'.repeat(40)));
  assert.throws(() => validatePackageBinding({ ...binding, runId: '1234\nCC_PACKAGE_RUN=5678' }, binding.sourceCommit));
  assert.throws(() => validatePackageBinding({ ...binding, archiveSha256: '' }, binding.sourceCommit));

  const root = await mkdtemp(path.join(os.tmpdir(), 'qualification-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const githubEnv = path.join(root, 'github-env');
  const select = sourceCommit => run(process.execPath, ['scripts/qualification-package.mjs', 'select'], {
    env: { ...process.env, GITHUB_SHA: sourceCommit, CC_PACKAGE_BINDING: JSON.stringify(binding), GITHUB_ENV: githubEnv }
  });
  await assert.rejects(select('e'.repeat(40)), /Selected candidate source differs/u);
  await assert.rejects(lstat(githubEnv), { code: 'ENOENT' });
  await select(binding.sourceCommit);
  assert.equal(await readFile(githubEnv, 'utf8'), `CC_PACKAGE_RUN=1234\nCC_PACKAGE_ARTIFACT=command-center-candidate-${binding.sourceCommit}\n`);
});

test('qualification installs the selected archive and refuses a different valid package', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qualification-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const runnerTemp = path.join(root, 'runner');
  await mkdir(path.join(checkout, 'scripts'), { recursive: true });
  await mkdir(runnerTemp, { mode: 0o700 });
  for (const entry of ['.gitignore', 'src', 'package.json', 'openclaw.plugin.json', 'LICENSE', 'scripts/qualification-package.mjs']) {
    await cp(path.resolve(entry), path.join(checkout, entry), { recursive: true });
  }
  await symlink(path.resolve('node_modules'), path.join(checkout, 'node_modules'), 'dir');
  const git = args => run('git', args, { cwd: checkout });
  await git(['init', '--quiet']);
  const commit = async message => {
    await git(['add', '--all']);
    await git(['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message]);
    return (await git(['rev-parse', 'HEAD'])).stdout.trim();
  };
  const sourceCommit = await commit('Fictional candidate');

  const importFixture = relative => import(pathToFileURL(path.join(checkout, relative)).href);
  const { build, assertBuiltDigest } = await importFixture('src/build.mjs');
  const { packagePluginArtifact } = await importFixture('src/plugin-artifact.mjs');
  const selectedDirectory = path.join(runnerTemp, 'selected-cc-package');
  const expectedBuildReceipt = await build();
  const selected = await packagePluginArtifact({ expectedBuildReceipt, outputDirectory: selectedDirectory, sourceCommit });

  await appendFile(path.join(checkout, 'src/release-scope.mjs'), '\n// Fictional alternate candidate.\n');
  const alternateCommit = await commit('Fictional alternate candidate');
  const alternate = await packagePluginArtifact({
    expectedBuildReceipt: await build(), outputDirectory: path.join(root, 'alternate'), sourceCommit: alternateCommit
  });
  assert.notEqual(alternate.receipt.archive.sha256, selected.receipt.archive.sha256);
  await git(['switch', '--detach', sourceCommit]);
  const dist = path.join(checkout, 'dist');
  await rm(dist, { recursive: true });

  const binding = {
    runId: '1234', sourceCommit, buildDigest: expectedBuildReceipt.digest,
    archiveSha256: selected.receipt.archive.sha256, receiptSha256: digest(await readFile(selected.receiptPath))
  };
  await writeFile(path.join(runnerTemp, 'selected-cc-package-run.json'), JSON.stringify({
    id: Number(binding.runId), head_sha: sourceCommit, path: '.github/workflows/package-candidate.yml', conclusion: 'success'
  }));
  const install = () => run(process.execPath, ['scripts/qualification-package.mjs', 'install'], {
    cwd: checkout, timeout: 60_000,
    env: {
      ...process.env, GITHUB_SHA: sourceCommit, CC_PACKAGE_BINDING: JSON.stringify(binding),
      RUNNER_TEMP: runnerTemp
    }
  });

  const savedArchive = path.join(root, 'selected.tgz');
  await rename(selected.archivePath, savedArchive);
  await cp(alternate.archivePath, selected.archivePath);
  await assert.rejects(install(), error => {
    assert.match(error.stderr, /artifact-archive-mismatch/u);
    return true;
  });
  await assert.rejects(lstat(dist), { code: 'ENOENT' });

  await rm(selected.archivePath);
  await rename(savedArchive, selected.archivePath);
  const { stdout } = await install();
  assert.deepEqual(JSON.parse(stdout), { status: 'qualification-package-verified', ...binding });
  await assertBuiltDigest(expectedBuildReceipt);
  for (const file of selected.receipt.files) {
    assert.equal(digest(await readFile(path.join(checkout, file.path))), file.sha256, file.path);
  }
});
