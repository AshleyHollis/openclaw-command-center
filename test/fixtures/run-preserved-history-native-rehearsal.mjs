import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForFixtureClose, verifyFixtureGroupStopped } from '../support/fixture-process-owner.mjs';

// Let the SDK-owning child exit and release its SQLite handles before cleanup.
// No private host cleanup API or production store is used.
const slice = process.argv[2] ?? 'history';
const fixtureFile = { history: './preserved-history-native-rehearsal.mjs', 'native-history': './native-history-import-rehearsal.mjs', bootstrap: './topic-bootstrap-native-rehearsal.mjs', 'bootstrap-crash': './topic-bootstrap-crash-rehearsal.mjs', reconcile: './reconcile-native-rehearsal.mjs', 'cli-discovery': './reconcile-cli-discovery.mjs', 'provisioning-primary': './provisioning-primary-native-rehearsal.mjs', 'provisioning-crash': './topic-bootstrap-crash-rehearsal.mjs', 'migration-startup': './migration-startup-native.mjs' }[slice];
if (!fixtureFile) throw new Error('Unknown isolated rehearsal slice');
if (process.platform === 'win32') throw new Error('Native process-group rehearsals require Linux/WSL');
const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-native-history-'));
let child;
const lifetime = new AbortController();
const cancel = () => lifetime.abort(new Error('Native rehearsal cancelled'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  // Run node:test in this direct child; avoid an implicit extra worker process.
  child = spawn(process.execPath, [fileURLToPath(new URL(fixtureFile, import.meta.url))], {
    env: { ...process.env, COMMAND_CENTER_REHEARSAL_STATE_DIR: stateDir, COMMAND_CENTER_REHEARSAL_PRIMARY_OWNER: slice === 'provisioning-crash' ? 'provisioning' : 'bootstrap' }, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32'
  });
  const { code } = await waitForFixtureClose(child, { timeoutMs: 360_000, signal: lifetime.signal });
  process.exitCode = code ?? 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  // close with inherited stdio joins only the direct child, not its descendants.
  // Uncertain shutdown deliberately retains the owned state for diagnosis.
  await verifyFixtureGroupStopped(child);
  await rm(stateDir, { recursive: true, force: true });
}
