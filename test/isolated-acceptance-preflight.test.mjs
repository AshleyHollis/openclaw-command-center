import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pinnedHost } from '../src/host-harness.mjs';
import { assertBoundCronSchema, assertCandidatePluginPermissions, assertFastHostAdmission, assertSafePluginMode } from './support/isolated-acceptance-preflight.mjs';

const digest = char => `sha256:${char.repeat(64)}`;
const integrity = { sourceDigest: digest('a'), executableDigest: digest('b'), contractDigest: digest('c'),
  packageDigest: pinnedHost.packageDigest, runtimeDigest: digest('d') };
const descriptor = { schemaVersion: 2, checkout: '/fixture/checkout', runtimeRoot: '/fixture/runtime',
  commit: pinnedHost.commit, integrity };
const files = new Map([
  [path.join('/fixture', 'receipt.json'), { schemaVersion: 2, commit: pinnedHost.commit, ...integrity }],
  [path.join('/fixture/runtime', 'node_modules/openclaw/dist/build-info.json'), { commit: pinnedHost.commit, version: pinnedHost.packageVersion }],
  [path.join('/fixture/runtime', 'node_modules/openclaw/package.json'), { name: 'openclaw', version: pinnedHost.packageVersion }]
]);
const read = async file => JSON.stringify(files.get(file));

test('the exact draft-host profile is limited to its diagnostic', () => {
  const command = ['--input-type=module', '-e', "import {pinnedHost} from './src/host-harness.mjs'; console.log(pinnedHost.commit)"];
  const env = { ...process.env, COMMAND_CENTER_DIAGNOSTIC_HOST_PROFILE: 'conditional-cron-id-pr53',
    COMMAND_CENTER_ACCEPTANCE_SCENARIO: 'diagnostic-clarification-worker' };
  const allowed = spawnSync(process.execPath, command, { cwd: path.resolve('.'), env, encoding: 'utf8' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), 'e603f08382dfb3cbe8245b673fcbd793bad9ce9d');
  const release = spawnSync(process.execPath, command, { cwd: path.resolve('.'),
    env: { ...env, COMMAND_CENTER_ACCEPTANCE_SCENARIO: 'release' }, encoding: 'utf8' });
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /limited to the clarification-worker diagnostic/u);
});

test('preflight rejects a mismatched installed host before starting the Gateway', async () => {
  const options = { read, readCommit: async () => pinnedHost.commit, loadCronValidator: async () => () => true };
  assert.equal((await assertFastHostAdmission(descriptor, { ...options, requireBoundCron: true })).boundCronId, 'accepted');
  await assert.rejects(assertFastHostAdmission({ ...descriptor, commit: 'wrong' }, options), error => error.code === 'preflight-identity');
  await assert.rejects(assertFastHostAdmission(descriptor, { ...options, read: async file => JSON.stringify(file.endsWith('build-info.json')
    ? { commit: 'wrong', version: pinnedHost.packageVersion } : files.get(file)) }), error => error.code === 'preflight-identity');
});

test('preflight rejects the deployed Cron schema that does not accept explicit IDs', async () => {
  assert.throws(() => assertBoundCronSchema(() => false), error => error.code === 'preflight-capability');
  await assert.rejects(assertFastHostAdmission(descriptor, { requireBoundCron: true, read,
    readCommit: async () => pinnedHost.commit, loadCronValidator: async () => () => false }), error => error.code === 'preflight-capability');
});

test('preflight identifies unsafe plugin modes before host startup', async () => {
  assert.throws(() => assertSafePluginMode(0o100777, 'plugin entry'), error => error.code === 'preflight-unsafe-path');
  if (process.platform !== 'linux') return;
  const root = await mkdtemp(path.join(homedir(), 'command-center-permissions-'));
  try {
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'openclaw.plugin.json'), '{}');
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(path.join(root, 'dist/plugin.mjs'), 'export default {}');
    assert.equal((await assertCandidatePluginPermissions(root)).candidatePermissions, 'safe');
    await chmod(path.join(root, 'dist/plugin.mjs'), 0o666);
    await assert.rejects(assertCandidatePluginPermissions(root), error => error.code === 'preflight-unsafe-path');
  } finally { await rm(root, { recursive: true, force: true }); }
});
