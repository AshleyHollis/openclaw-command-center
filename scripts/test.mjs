import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { ordinaryTestArgv, selectOrdinaryTestFiles } from '../src/test-selection.mjs';

const files = selectOrdinaryTestFiles(readdirSync(new URL('../test/', import.meta.url)));
if (files.length === 0) throw new Error('No ordinary test files were selected.');

const result = spawnSync(process.execPath, ordinaryTestArgv(files), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
