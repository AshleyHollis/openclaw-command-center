import { readdirSync } from 'node:fs';
import { selectOrdinaryTestFiles } from '../src/test-selection.mjs';
import { prepareTestRuntimeEnvironment } from './test-runtime.mjs';
import { runTestLanes } from './test-lanes.mjs';

const files = selectOrdinaryTestFiles(readdirSync(new URL('../test/', import.meta.url)));
if (files.length === 0) throw new Error('No ordinary test files were selected.');
const environment = await prepareTestRuntimeEnvironment();

const result = runTestLanes(files, { env: environment });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status;
