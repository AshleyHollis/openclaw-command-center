import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { assertCandidateArchiveBytes, assertCandidatePairEvidence, candidateRepositories, parseCandidatePair, sealCandidatePair } from '../src/candidate-pair.mjs';
import { stageCandidateInputs } from '../src/candidate-inputs.mjs';
import { parseCandidateHostDescriptor, parseHostDescriptor, pinnedHost, verifyCandidateHost } from '../src/host-harness.mjs';
import { packagedHostDigest } from '../src/packaged-host-integrity.mjs';
import { assertCandidateRepositoryMetadata, assertReleasedHostMetadata } from '../scripts/repository-checks.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => `sha256:${hash(value)}`;
const candidateCommit = 'd'.repeat(40);
const exec = promisify(execFile);

test('candidate descriptor binds both exact artifacts and cannot enter the released host parser', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  const installed = path.join(runtimeRoot, 'node_modules', 'openclaw');
  await mkdir(path.join(installed, 'dist'), { recursive: true });
  await mkdir(checkout);
  const wrapper = '#!/usr/bin/env node\nconsole.log("fictional candidate");\n';
  await writeFile(path.join(checkout, 'openclaw.mjs'), wrapper);
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ version: '2026.9.6' }));
  await writeFile(path.join(installed, 'openclaw.mjs'), wrapper);
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.6' }));
  await writeFile(path.join(installed, 'dist', 'build-info.json'), JSON.stringify({ commit: candidateCommit, version: '2026.9.6' }));
  const pluginArchivePath = path.join(root, 'plugin.tgz');
  const hostArchivePath = path.join(root, 'host.tgz');
  await writeFile(pluginArchivePath, 'fictional plugin archive');
  await writeFile(hostArchivePath, 'fictional host archive');
  const host = {
    repository: candidateRepositories.openClaw, sourceCommit: candidateCommit, packageVersion: '2026.9.6', packageDigest: digest('fictional host archive'),
    runtimeDigest: await packagedHostDigest(runtimeRoot), sourceDigest: digest('fictional source'),
    executableDigest: digest(wrapper), contractDigest: digest('fictional contract')
  };
  const pair = sealCandidatePair({ formatVersion: 1, kind: 'development-candidate',
    commandCenter: { repository: candidateRepositories.commandCenter, sourceCommit: 'c'.repeat(40), inputTreeDigest: digest('fictional input tree'),
      overlayDigest: digest('fictional overlay'), buildDigest: hash('fictional build'), archiveSha256: hash('fictional plugin archive') },
    openClaw: host, fixtureDigest: digest('fictional fixture') });
  const buildReceipt = { formatVersion: 1, digest: pair.commandCenter.buildDigest };
  const inputTreeReceipt = { repository: pair.commandCenter.repository, sourceCommit: pair.commandCenter.sourceCommit,
    inputTreeDigest: pair.commandCenter.inputTreeDigest, overlayDigest: pair.commandCenter.overlayDigest };
  const artifactReceipt = { formatVersion: 1, kind: 'command-center-plugin-artifact', pluginId: 'command-center', sourceCommit: pair.commandCenter.sourceCommit,
    buildDigest: pair.commandCenter.buildDigest, archive: { sha256: pair.commandCenter.archiveSha256 } };
  const raw = JSON.stringify({ schemaVersion: 2, checkout, runtimeRoot, executable: 'node_modules/openclaw/openclaw.mjs',
    args: pinnedHost.args, commit: candidateCommit, integrity: {
      packageDigest: host.packageDigest, runtimeDigest: host.runtimeDigest, sourceDigest: host.sourceDigest,
      executableDigest: host.executableDigest, contractDigest: host.contractDigest
    } });
  assert.throws(() => parseHostDescriptor(raw), error => error.category === 'invalid-commit');
  const descriptor = parseCandidateHostDescriptor(raw, pair);
  assert.equal(assertCandidatePairEvidence(pair, { inputTreeReceipt, buildReceipt, artifactReceipt, hostDescriptor: descriptor }).seal, pair.seal);
  const tuple = { host: { range: '=2026.9.6', commit: candidateCommit }, pluginApi: { range: '=2026.9.5' } };
  const packageJson = { devDependencies: { openclaw: '2026.9.5' }, peerDependencies: { openclaw: '2026.9.5' },
    openclaw: { compat: { pluginApi: '=2026.9.5' } }, commandCenter: { compatibilityTuple: tuple } };
  const packageLock = { packages: { '': { commandCenter: packageJson.commandCenter } } };
  assert.equal(assertCandidateRepositoryMetadata(pair, inputTreeReceipt, tuple, packageJson, packageLock).seal, pair.seal);
  // Candidate staging intentionally overlays the imported compatibility tuple.
  // Exercise the ordinary release guard with its explicit released-host fixture.
  assert.doesNotThrow(() => assertReleasedHostMetadata({
    host: { range: `=${pinnedHost.packageVersion}`, commit: pinnedHost.commit }
  }));
  assert.throws(() => assertReleasedHostMetadata(tuple), /released host identity/u);
  assert.throws(() => assertCandidateRepositoryMetadata(pair, inputTreeReceipt,
    { ...tuple, host: { ...tuple.host, commit: pinnedHost.commit } }, packageJson, packageLock), /host, plugin API/u);
  assert.throws(() => assertCandidateRepositoryMetadata(pair, { ...inputTreeReceipt, overlayDigest: null },
    tuple, packageJson, packageLock), /staging receipt/u);
  assert.throws(() => assertCandidateRepositoryMetadata(pair, inputTreeReceipt, tuple,
    { ...packageJson, devDependencies: { openclaw: '2026.9.6' } }, packageLock), /host, plugin API/u);
  await assertCandidateArchiveBytes(pair, { pluginArchivePath, hostArchivePath });
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(wrapper)}\0`).update(wrapper).digest('hex');
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify({ schemaVersion: 2, commit: candidateCommit, ...descriptor.integrity }));
  const gitCommand = async (_checkout, args) => {
    if (args.join(' ') === 'rev-parse HEAD') return candidateCommit;
    if (args.join(' ') === 'remote get-url origin') return candidateRepositories.openClaw;
    if (args[0] === 'cat-file' || args.join(' ') === 'fsck --full' || args[0] === 'status') return '';
    if (args[0] === 'ls-files') return `100644 ${blob} 0\topenclaw.mjs`;
    throw new Error('Unexpected fixture Git command');
  };
  assert.equal((await verifyCandidateHost(descriptor, pair, { gitCommand })).checkout, installed);

  assert.throws(() => assertCandidatePairEvidence(pair, { inputTreeReceipt, buildReceipt, artifactReceipt: { ...artifactReceipt, buildDigest: hash('other') }, hostDescriptor: descriptor }), /does not match/u);
  assert.throws(() => parseCandidatePair({ ...pair, releaseQualified: true }), /closed development/u);
  assert.throws(() => parseCandidatePair({ ...pair, fixtureDigest: digest('changed fixture') }), /seal differs/u);
  assert.throws(() => parseCandidateHostDescriptor(JSON.stringify({ ...JSON.parse(raw), commit: pinnedHost.commit }), pair), error => error.category === 'invalid-commit');
  await writeFile(hostArchivePath, 'altered host archive');
  await assert.rejects(assertCandidateArchiveBytes(pair, { pluginArchivePath, hostArchivePath }), /archive bytes differ/u);
  await writeFile(hostArchivePath, 'fictional host archive');
  await writeFile(path.join(installed, 'dist', 'build-info.json'), JSON.stringify({ commit: pinnedHost.commit, version: '2026.9.6' }));
  await assert.rejects(verifyCandidateHost(descriptor, pair, { gitCommand }), error => error.category === 'host-integrity');
});

test('candidate input staging seals exact host mirrors and a candidate-only notification gate', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceCheckout = path.join(root, 'source');
  const destination = path.join(root, 'candidate');
  await mkdir(path.join(sourceCheckout, 'src'), { recursive: true });
  const tuple = { host: { range: '=2026.9.5', commit: 'a'.repeat(40) }, pluginApi: { range: '=2026.9.5' } };
  const pkg = { name: 'openclaw-command-center', version: '0.4.0',
    devDependencies: { openclaw: '2026.9.5' }, peerDependencies: { openclaw: '2026.9.5' },
    openclaw: { compat: { pluginApi: '=2026.9.5' } }, commandCenter: { compatibilityTuple: tuple } };
  await writeFile(path.join(sourceCheckout, 'src', 'compatibility-tuple.json'), JSON.stringify(tuple));
  await writeFile(path.join(sourceCheckout, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(sourceCheckout, 'package-lock.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { '': { commandCenter: pkg.commandCenter } }
  }));
  await writeFile(path.join(sourceCheckout, 'src', 'release-scope.mjs'), 'export const FIRST_LIVE_FEATURES = Object.freeze({ notifications: false, noteMaintenance: false });\n');
  await writeFile(path.join(sourceCheckout, 'marker.txt'), 'committed source');
  const git = async (...args) => (await exec('git', ['-C', sourceCheckout, ...args])).stdout.trim();
  await git('init');
  await git('remote', 'add', 'origin', candidateRepositories.commandCenter);
  await git('add', '.');
  await git('-c', 'user.name=Fictional', '-c', 'user.email=fictional@example.test', 'commit', '-m', 'fixture');
  const sourceCommit = await git('rev-parse', 'HEAD');
  await writeFile(path.join(sourceCheckout, 'marker.txt'), 'uncommitted change');
  const receipt = await stageCandidateInputs({ sourceCheckout, sourceCommit, destination,
    hostCommit: candidateCommit, hostPackageVersion: '2026.9.6', pluginApiVersion: '2026.9.5', candidateNotifications: true });
  assert.equal(receipt.repository, candidateRepositories.commandCenter);
  assert.match(receipt.inputTreeDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(receipt.overlayDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(await readFile(path.join(destination, 'marker.txt'), 'utf8'), 'committed source');
  const stagedTuple = JSON.parse(await readFile(path.join(destination, 'src', 'compatibility-tuple.json')));
  const stagedPkg = JSON.parse(await readFile(path.join(destination, 'package.json')));
  const stagedLock = JSON.parse(await readFile(path.join(destination, 'package-lock.json')));
  assert.deepEqual(stagedTuple.host, { range: '=2026.9.6', commit: candidateCommit });
  assert.deepEqual(stagedPkg.commandCenter.compatibilityTuple, stagedTuple);
  assert.deepEqual(stagedLock.packages[''].commandCenter, stagedPkg.commandCenter);
  assert.match(await readFile(path.join(destination, 'src', 'release-scope.mjs'), 'utf8'), /notifications: true/u);
  assert.match(await readFile(path.join(sourceCheckout, 'src', 'release-scope.mjs'), 'utf8'), /notifications: false/u);
  assert.equal((await readFile(path.join(sourceCheckout, 'package.json'), 'utf8')), JSON.stringify(pkg));
  await assert.rejects(stageCandidateInputs({ sourceCheckout, sourceCommit, destination,
    hostCommit: candidateCommit, hostPackageVersion: '2026.9.6', pluginApiVersion: '2026.9.5' }), { code: 'EEXIST' });
  await assert.rejects(stageCandidateInputs({ sourceCheckout, sourceCommit, destination: path.join(root, 'wrong-api'),
    hostCommit: candidateCommit, hostPackageVersion: '2026.9.6', pluginApiVersion: '2026.9.6' }), { code: 'candidate-input-invalid' });
  await assert.rejects(stageCandidateInputs({ sourceCheckout, sourceCommit, destination: path.join(root, 'wrong-gate'),
    hostCommit: candidateCommit, hostPackageVersion: '2026.9.6', pluginApiVersion: '2026.9.5', candidateNotifications: 'true' }), { code: 'candidate-input-invalid' });
  const ordinary = await stageCandidateInputs({ sourceCheckout, sourceCommit, destination: path.join(root, 'ordinary'),
    hostCommit: candidateCommit, hostPackageVersion: '2026.9.6', pluginApiVersion: '2026.9.5' });
  assert.notEqual(ordinary.overlayDigest, receipt.overlayDigest);
  assert.match(await readFile(path.join(root, 'ordinary', 'src', 'release-scope.mjs'), 'utf8'), /notifications: false/u);
  const sdkTuple = structuredClone(tuple);
  sdkTuple.host = { range: '=2026.9.6', commit: candidateCommit };
  sdkTuple.pluginApi.range = '=2026.9.6';
  const sdkPkg = structuredClone(pkg);
  sdkPkg.devDependencies.openclaw = '2026.9.6';
  sdkPkg.peerDependencies.openclaw = '2026.9.6';
  sdkPkg.openclaw.compat.pluginApi = '=2026.9.6';
  sdkPkg.commandCenter.compatibilityTuple = sdkTuple;
  const sdkLock = { name: sdkPkg.name, version: sdkPkg.version, lockfileVersion: 3, packages: {
    '': { name: sdkPkg.name, version: sdkPkg.version, devDependencies: sdkPkg.devDependencies,
      peerDependencies: sdkPkg.peerDependencies },
    'node_modules/openclaw': { version: '2026.9.6',
      resolved: 'https://registry.npmjs.org/openclaw/-/openclaw-2026.9.6.tgz', integrity: 'sha512-YQ==' }
  } };
  const resolvedLockPath = path.join(root, 'resolved-lock.json');
  await writeFile(resolvedLockPath, JSON.stringify(sdkLock));
  const sdkReceipt = await stageCandidateInputs({ sourceCheckout, sourceCommit, destination: path.join(root, 'sdk-candidate'),
    hostCommit: candidateCommit, hostPackageVersion: '2026.9.6', pluginApiVersion: '2026.9.5',
    candidatePluginApiVersion: '2026.9.6', candidateResolvedLockPath: resolvedLockPath });
  assert.notEqual(sdkReceipt.overlayDigest, ordinary.overlayDigest);
  const sdkStaged = JSON.parse(await readFile(path.join(root, 'sdk-candidate', 'package.json')));
  assert.equal(sdkStaged.openclaw.compat.pluginApi, '=2026.9.6');
  assert.equal(sdkStaged.commandCenter.compatibilityTuple.pluginApi.range, '=2026.9.6');
  const stagedSdkLock = JSON.parse(await readFile(path.join(root, 'sdk-candidate', 'package-lock.json')));
  assert.equal(stagedSdkLock.packages['node_modules/openclaw'].integrity, 'sha512-YQ==');
  assert.deepEqual(stagedSdkLock.packages[''].commandCenter, sdkPkg.commandCenter);
  await assert.rejects(stageCandidateInputs({ sourceCheckout, sourceCommit, destination: path.join(root, 'sdk-no-lock'),
    hostCommit: candidateCommit, hostPackageVersion: '2026.9.6', pluginApiVersion: '2026.9.5',
    candidatePluginApiVersion: '2026.9.6' }), { code: 'candidate-input-invalid' });
  sdkLock.packages['node_modules/openclaw'].version = '2026.9.5';
  await writeFile(resolvedLockPath, JSON.stringify(sdkLock));
  await assert.rejects(stageCandidateInputs({ sourceCheckout, sourceCommit, destination: path.join(root, 'sdk-wrong-lock'),
    hostCommit: candidateCommit, hostPackageVersion: '2026.9.6', pluginApiVersion: '2026.9.5',
    candidatePluginApiVersion: '2026.9.6', candidateResolvedLockPath: resolvedLockPath }), { code: 'candidate-input-invalid' });
});
