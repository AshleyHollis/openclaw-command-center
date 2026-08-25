import assert from 'node:assert/strict';
import test from 'node:test';
import canonical from '../src/compatibility-tuple.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import { assertDeclarativeMirror, validateCompatibility } from '../src/compatibility.mjs';
import { pinnedHost } from '../src/host-harness.mjs';

const supportedOpenClaw = Object.freeze({
  version: '2026.8.1-beta.3',
  commit: '30f2924e437857935f034ac349bae8cc22ef9fb0'
});

test('accepts the exact canonical compatibility tuple', () => {
  assert.deepEqual(validateCompatibility(structuredClone(canonical)), { ok: true });
  assertDeclarativeMirror(canonical);
  assert.equal(packageJson.openclaw.compat.pluginApi, canonical.pluginApi.range);
  assert.deepEqual(packageJson.openclaw.extensions, ['./dist/plugin.mjs']);
});

test('all runtime declarations target the supported OpenClaw release', () => {
  assert.equal(packageJson.dependencies.openclaw, supportedOpenClaw.version);
  assert.equal(packageJson.openclaw.compat.pluginApi, `=${supportedOpenClaw.version}`);
  assert.equal(canonical.host.range, `=${supportedOpenClaw.version}`);
  assert.equal(canonical.host.commit, supportedOpenClaw.commit);
  assert.equal(canonical.pluginApi.range, `=${supportedOpenClaw.version}`);
  assert.equal(pinnedHost.version, supportedOpenClaw.version);
  assert.equal(pinnedHost.commit, supportedOpenClaw.commit);
});

for (const [name, mutate] of [
  ['host version', (value) => { value.host.range = '=2026.7.2-beta.7'; }],
  ['host commit', (value) => { value.host.commit = '0000000000000000000000000000000000000000'; }],
  ['plugin API range', (value) => { value.pluginApi.range = '=2026.7.2-beta.7'; }],
  ['schema range', (value) => { value.commandCenterSchema.writable.max = 5; }],
  ['Bridge range', (value) => { value.capabilityBridgeProtocol.max = 2; }]
]) test(`rejects a different ${name}`, () => {
  const candidate = structuredClone(canonical);
  mutate(candidate);
  assert.equal(validateCompatibility(candidate).ok, false);
});
