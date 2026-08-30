import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { selectTopicPageTicketTestFiles } from '../src/test-selection.mjs';

const files = selectTopicPageTicketTestFiles(readdirSync(new URL('../test/', import.meta.url)));
if (files.length === 0) throw new Error('No Topic Page ticket tests were selected.');

const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
