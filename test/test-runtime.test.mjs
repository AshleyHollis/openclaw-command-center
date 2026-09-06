import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { pinnedHost } from '../src/host-harness.mjs';
import { prepareTestRuntimeEnvironment } from '../scripts/test-runtime.mjs';

// These fixtures test package resolution and subprocess inheritance, not a
// replacement coordinator. Real Note interruption tests qualify lock behavior.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fictional-sdk-resolution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'host');
  await mkdir(path.join(checkout, 'dist'), { recursive: true });
  const wrapper = Buffer.from('// fictional host wrapper\n');
  await writeFile(path.join(checkout, 'openclaw.mjs'), wrapper);
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ name: 'openclaw', version: pinnedHost.packageVersion, type: 'module', exports: { './plugin-sdk/sqlite-runtime': { default: './dist/sqlite-runtime.js' } } }));
  const sdk = path.join(checkout, 'dist', 'sqlite-runtime.js');
  await writeFile(sdk, 'export const fixtureIdentity = "verified-package-export";\n');
  const integrity = { sourceDigest: `sha256:${'a'.repeat(64)}`, executableDigest: `sha256:${createHash('sha256').update(wrapper).digest('hex')}`, contractDigest: `sha256:${'b'.repeat(64)}` };
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify({ schemaVersion: 1, commit: pinnedHost.commit, ...integrity }));
  const descriptor = JSON.stringify({ checkout, executable: 'openclaw.mjs', args: [...pinnedHost.args], commit: pinnedHost.commit, integrity });
  const blob = createHash('sha1').update(`blob ${wrapper.length}\0`).update(wrapper).digest('hex');
  // Only the external Git boundary is synthetic; real descriptor, receipt,
  // filesystem, package exports, loader and child processes are exercised.
  const verification = { gitCommand: async (_checkout, argv) => {
    if (argv[0] === 'rev-parse') return pinnedHost.commit;
    if (argv[0] === 'ls-files') return `100644 ${blob} 0\topenclaw.mjs`;
    if (['cat-file', 'fsck', 'status'].includes(argv[0])) return '';
    throw new Error('Unexpected Git fixture command');
  } };
  return { root, checkout, sdk, descriptor, verification };
}

test('ordinary test setup resolves the verified public SDK in test children and their children', async t => {
  const f = await fixture(t);
  const original = { ...process.env, COMMAND_CENTER_ISOLATED_HOST: f.descriptor, NODE_OPTIONS: '--no-warnings' };
  delete original.COMMAND_CENTER_TEST_SQLITE_RUNTIME;
  const environment = await prepareTestRuntimeEnvironment(original, f.verification);
  assert.equal(original.COMMAND_CENTER_TEST_SQLITE_RUNTIME, undefined);
  assert.equal(original.NODE_OPTIONS, '--no-warnings');
  assert.equal(environment.COMMAND_CENTER_TEST_SQLITE_RUNTIME, pathToFileURL(f.sdk).href);
  const source = 'import { fixtureIdentity } from "openclaw/plugin-sdk/sqlite-runtime"; process.stdout.write(fixtureIdentity);';
  const parent = `import { spawnSync } from 'node:child_process'; ${source} const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(source)}], { encoding: 'utf8' }); if (child.status !== 0) throw new Error(child.stderr); process.stdout.write(':' + child.stdout);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', parent], { env: environment, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'verified-package-export:verified-package-export');
});

test('a verified host refuses conflicting SDK overrides instead of silently substituting behavior', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareTestRuntimeEnvironment({ COMMAND_CENTER_ISOLATED_HOST: f.descriptor, COMMAND_CENTER_TEST_SQLITE_RUNTIME: pathToFileURL(path.join(f.root, 'foreign.js')).href }, f.verification), /override conflicts/);
  const equal = await prepareTestRuntimeEnvironment({ COMMAND_CENTER_ISOLATED_HOST: f.descriptor, COMMAND_CENTER_TEST_SQLITE_RUNTIME: pathToFileURL(f.sdk).href }, f.verification);
  assert.equal(equal.COMMAND_CENTER_TEST_SQLITE_RUNTIME, pathToFileURL(f.sdk).href);
});

test('test setup preserves receipt and exact host pin refusal', async t => {
  const f = await fixture(t);
  const descriptor = JSON.parse(f.descriptor);
  await assert.rejects(prepareTestRuntimeEnvironment({ COMMAND_CENTER_ISOLATED_HOST: JSON.stringify({ ...descriptor, commit: 'c'.repeat(40) }) }, f.verification), error => error.category === 'invalid-commit');
  await writeFile(path.join(f.root, 'receipt.json'), '{}');
  await assert.rejects(prepareTestRuntimeEnvironment({ COMMAND_CENTER_ISOLATED_HOST: f.descriptor }, f.verification), error => error.category === 'host-integrity');
});

test('missing fork SDK fails rather than falling back to the installed upstream package', async t => {
  const f = await fixture(t);
  await rm(f.sdk);
  await assert.rejects(prepareTestRuntimeEnvironment({ COMMAND_CENTER_ISOLATED_HOST: f.descriptor }, f.verification), { code: 'ENOENT' });
});

test('a public SDK export redirected outside the verified checkout is refused', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, 'foreign.js');
  await writeFile(foreign, 'throw new Error("Must not execute");');
  await rm(f.sdk); await symlink(foreign, f.sdk);
  await assert.rejects(prepareTestRuntimeEnvironment({ COMMAND_CENTER_ISOLATED_HOST: f.descriptor }, f.verification), /escapes the verified host|contains a symlink/);
});

test('an SDK export symlink within the verified checkout is also refused', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  const alternate = path.join(f.checkout, 'dist', 'alternate.js');
  await writeFile(alternate, 'throw new Error("Must not execute");');
  await rm(f.sdk); await symlink(alternate, f.sdk);
  await assert.rejects(prepareTestRuntimeEnvironment({ COMMAND_CENTER_ISOLATED_HOST: f.descriptor }, f.verification), /contains a symlink/);
});

test('descriptor-free standalone setup preserves ordinary behavior and explicit focused fixture resolution', async t => {
  assert.deepEqual(await prepareTestRuntimeEnvironment({ PATH: 'fictional-path', NODE_OPTIONS: '--no-warnings' }), { PATH: 'fictional-path', NODE_OPTIONS: '--no-warnings' });
  const f = await fixture(t);
  const environment = await prepareTestRuntimeEnvironment({ COMMAND_CENTER_TEST_SQLITE_RUNTIME: pathToFileURL(f.sdk).href });
  assert.equal(environment.COMMAND_CENTER_TEST_SQLITE_RUNTIME, pathToFileURL(f.sdk).href);
  const source = 'import { fixtureIdentity } from "openclaw/plugin-sdk/sqlite-runtime"; process.stdout.write(fixtureIdentity);';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: environment, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'verified-package-export');
});
