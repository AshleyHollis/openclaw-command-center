import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveCommandCenterDatabasePath, resolveCommandCenterRecoveryMigrationPath } from '../src/metadata/path.mjs';

test('native backup includes exactly the authoritative metadata and complete recovery owner, not external Notes or exclusions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  const state = path.resolve('fictional-state');
  const resources = manifest.backupResources;
  assert.deepEqual(resources, [
    { disposition: 'include', scope: 'state', relativePath: path.relative(state, resolveCommandCenterDatabasePath(state)).split(path.sep).join('/') },
    { disposition: 'include', scope: 'state', relativePath: path.dirname(path.relative(state, resolveCommandCenterRecoveryMigrationPath(state))).split(path.sep).join('/') }
  ]);
});
