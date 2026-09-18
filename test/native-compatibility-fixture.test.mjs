import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCommandCenterDatabasePath, resolveCommandCenterRecoveryMigrationPath } from '../src/metadata/path.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { prepareNativeReleaseMismatchState } from './support/first-live-native-compatibility.mjs';

// The acceptance producer must actually reach a retained owner contract. In
// particular, the bridge variant cannot silently mutate obsolete source text.
for (const kind of ['host', 'build', 'bridge-protocol']) test(`native ${kind} fixture reaches recovery admission without changing retained data`, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-native-compatibility-'));
  try {
    const topicId = '88888888-8888-4888-8888-888888888888';
    const before = await prepareNativeReleaseMismatchState(stateDir, kind, topicId);
    const manifest = JSON.parse(before.manifest.toString('utf8'));
    if (kind === 'host') assert.equal(manifest.targetRelease.host.commit, '0000000000000000000000000000000000000000');
    if (kind === 'build') assert.match(manifest.targetRelease.package.build, /-fictional-mismatch$/u);
    if (kind === 'bridge-protocol') assert.deepEqual(manifest.targetRelease.capabilityBridgeProtocol, { min: 2, max: 2 });
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    try {
      const status = metadata.getOperatingStatus();
      assert.equal(status.mode, 'recovery-only');
      assert.ok(status.diagnostics.some(entry => entry.code === 'recovery-manifest-invalid'));
      assert.throws(() => metadata.createTopic({ topicId: 'fictional-refused', paraCategory: 'project', lifecycle: 'active' }), error => error.code === 'recovery-only');
    } finally { metadata.close(); }
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    const recoveryPath = resolveCommandCenterRecoveryMigrationPath(stateDir);
    assert.deepEqual(await readFile(databasePath), before.database);
    assert.deepEqual(await readFile(path.join(recoveryPath, 'metadata.sqlite.snapshot')), before.snapshot);
    assert.deepEqual(await readFile(path.join(recoveryPath, 'manifest.json')), before.manifest);
    assert.deepEqual((await readdir(recoveryPath)).sort(), before.artifacts);
    assert.deepEqual((await readdir(path.dirname(databasePath))).filter(name => name.startsWith(`${path.basename(databasePath)}-`)).sort(), before.sidecars);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
