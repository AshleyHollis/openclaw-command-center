import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { ordinaryTestLanes, selectOrdinaryTestFiles } from '../src/test-selection.mjs';

const files = selectOrdinaryTestFiles(readdirSync(new URL('../test/', import.meta.url)));
if (files.length === 0) throw new Error('No ordinary test files were selected.');

for (const lane of ordinaryTestLanes(files)) {
  const result = spawnSync(process.execPath, lane.argv, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
