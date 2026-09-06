import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { ordinaryTestLanes, selectOrdinaryTestFiles } from '../src/test-selection.mjs';
import { prepareTestRuntimeEnvironment } from './test-runtime.mjs';

const files = selectOrdinaryTestFiles(readdirSync(new URL('../test/', import.meta.url)));
if (files.length === 0) throw new Error('No ordinary test files were selected.');
const environment = await prepareTestRuntimeEnvironment();

for (const lane of ordinaryTestLanes(files)) {
  const result = spawnSync(process.execPath, lane.argv, { stdio: 'inherit', env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
