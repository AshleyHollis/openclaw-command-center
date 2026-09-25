import assert from 'node:assert/strict';
import test from 'node:test';
import canonical from '../src/compatibility-tuple.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import packageLock from '../package-lock.json' with { type: 'json' };
import deployedTuple from './fixtures/deployed-0.4.0-compatibility-tuple.json' with { type: 'json' };
import { assertCapabilityBridgeDeclaration, assertDeclarativeMirror, validateCompatibility } from '../src/compatibility.mjs';
import { pinnedHost } from '../src/host-harness.mjs';

const supportedOpenClaw = Object.freeze({
  version: '2026.9.5',
  commit: '21f1ca697532a9bd9e9cc46322a598a31435de15'
});
const schemaFiveHost = Object.freeze({ version: '2026.8.1-beta.3', commit: '30f2924e437857935f034ac349bae8cc22ef9fb0' });
const controllerIntegrationCommit = '2b222e394d823814b8c08684841ad38beaf265da';
const upstreamCompatibilityCommit = controllerIntegrationCommit;
const controllerPackageVersion = '2026.9.6';
const publishedSdkVersion = controllerPackageVersion;

test('release admission refuses unsupported or missing bridge declarations before activation', () => {
  assert.doesNotThrow(() => assertCapabilityBridgeDeclaration({ protocolVersion: 1 }));
  for (const declaration of [undefined, {}, { protocolVersion: 0 }, { protocolVersion: 2 }, { protocolVersion: '1' }, { protocolVersion: 1.5 }]) assert.throws(() => assertCapabilityBridgeDeclaration(declaration), /requires a capability bridge protocol/u);
});

test('accepts the exact canonical compatibility tuple', () => {
  assert.deepEqual(validateCompatibility(structuredClone(canonical)), { ok: true });
  assertDeclarativeMirror(canonical);
  assert.deepEqual(packageLock.packages[''].commandCenter, packageJson.commandCenter, 'lockfile must retain the complete canonical runtime metadata');
  assert.deepEqual(packageJson.openclaw.extensions, ['./dist/plugin.mjs']);
});

test('pins product compatibility and the controller to the exact stable source boundary', () => {
  assert.equal(canonical.priorRelease.host.range, `=${schemaFiveHost.version}`);
  assert.equal(canonical.priorRelease.host.commit, schemaFiveHost.commit);
  assert.equal(deployedTuple.host.range, `=${supportedOpenClaw.version}`);
  assert.equal(deployedTuple.host.commit, supportedOpenClaw.commit);
  assert.equal(canonical.host.range, `=${controllerPackageVersion}`);
  assert.equal(canonical.host.commit, upstreamCompatibilityCommit);
  assert.equal(canonical.pluginApi.range, `=${controllerPackageVersion}`);
  assert.equal(packageJson.peerDependencies.openclaw, publishedSdkVersion);
  assert.equal(packageJson.devDependencies.openclaw, publishedSdkVersion);
  assert.equal(packageJson.openclaw.compat.pluginApi, `=${controllerPackageVersion}`);
  assert.equal(packageJson.devDependencies['pdfjs-dist'], '6.3.289', 'the sealed build requires the pinned PDF extractor');
  assert.equal(packageJson.dependencies, undefined, 'the installed plugin must not declare unpackaged runtime dependencies');
  assert.equal(packageLock.packages[''].peerDependencies.openclaw, publishedSdkVersion);
  assert.equal(packageLock.packages[''].devDependencies['pdfjs-dist'], packageJson.devDependencies['pdfjs-dist']);
  assert.equal(packageLock.packages[''].devDependencies.openclaw, publishedSdkVersion);
  assert.equal(packageLock.packages['node_modules/openclaw'].version, publishedSdkVersion);
  assert.equal(packageLock.packages['node_modules/openclaw'].dependencies['@openclaw/ai'], publishedSdkVersion);
  assert.equal(packageLock.packages['node_modules/@openclaw/ai'].version, publishedSdkVersion);
  for (const [name, version] of Object.entries(packageLock.packages['node_modules/openclaw'].dependencies)) {
    const locked = packageLock.packages[`node_modules/${name}`] ?? packageLock.packages[`node_modules/openclaw/node_modules/${name}`];
    assert.equal(locked?.version, version, `${name} must match the stable package dependency graph`);
  }
  assert.equal(pinnedHost.packageVersion, controllerPackageVersion);
  assert.equal(pinnedHost.commit, controllerIntegrationCommit);
  assert.equal(canonical.host.commit, upstreamCompatibilityCommit);
  assert.equal(pinnedHost.commit, canonical.host.commit);
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
