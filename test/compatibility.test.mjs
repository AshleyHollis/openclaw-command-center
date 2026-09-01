import assert from 'node:assert/strict';
import test from 'node:test';
import canonical from '../src/compatibility-tuple.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import packageLock from '../package-lock.json' with { type: 'json' };
import { assertDeclarativeMirror, validateCompatibility } from '../src/compatibility.mjs';
import { pinnedHost } from '../src/host-harness.mjs';

const supportedOpenClaw = Object.freeze({
  version: '2026.8.1-beta.3',
  commit: ['30f2924e437857935f03', '4ac349bae8cc22ef9fb0'].join('')
});
const controllerIntegrationCommit = '6d542e6a0c5743a22a19c3226e754bf94cbf35b1';
const controllerPackageVersion = '2026.8.1';

test('accepts the exact canonical compatibility tuple', () => {
  assert.deepEqual(validateCompatibility(structuredClone(canonical)), { ok: true });
  assertDeclarativeMirror(canonical);
  assert.deepEqual(packageJson.openclaw.extensions, ['./dist/plugin.mjs']);
});

test('keeps product compatibility distinct from the controller package boundary', () => {
  assert.equal(canonical.host.range, `=${supportedOpenClaw.version}`);
  assert.equal(canonical.host.commit, supportedOpenClaw.commit);
  assert.equal(canonical.pluginApi.range, `=${supportedOpenClaw.version}`);
  assert.equal(packageJson.dependencies.openclaw, controllerPackageVersion);
  assert.equal(packageJson.openclaw.compat.pluginApi, `=${controllerPackageVersion}`);
  assert.equal(packageLock.packages[''].dependencies.openclaw, controllerPackageVersion);
  assert.equal(packageLock.packages['node_modules/openclaw'].version, controllerPackageVersion);
  assert.equal(packageLock.packages['node_modules/openclaw'].dependencies['@openclaw/ai'], controllerPackageVersion);
  assert.equal(packageLock.packages['node_modules/@openclaw/ai'].version, controllerPackageVersion);
  for (const [name, version] of Object.entries(packageLock.packages['node_modules/openclaw'].dependencies)) {
    assert.equal(packageLock.packages[`node_modules/${name}`]?.version, version, `${name} must match the stable package dependency graph`);
  }
  assert.equal(pinnedHost.packageVersion, controllerPackageVersion);
  assert.equal(pinnedHost.commit, controllerIntegrationCommit);
  assert.notEqual(pinnedHost.commit, canonical.host.commit);
});

for (const [name, mutate] of [
  ['host version', (value) => { value.host.range = '=2026.7.2-beta.7'; }],
  ['host commit', (value) => { value.host.commit = '0000000000000000000000000000000000000000'; }],
  ['plugin API range', (value) => { value.pluginApi.range = '=2026.7.2-beta.7'; }],
  ['schema range', (value) => { value.commandCenterSchema.writable.max += 1; }],
  ['Bridge range', (value) => { value.capabilityBridgeProtocol.max = 2; }]
]) test(`rejects a different ${name}`, () => {
  const candidate = structuredClone(canonical);
  mutate(candidate);
  assert.equal(validateCompatibility(candidate).ok, false);
});
