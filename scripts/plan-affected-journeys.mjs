import { execFileSync } from 'node:child_process';
import { planAffectedJourneyEvidence } from '../src/qualification-evidence.mjs';

const base = process.argv[2];
if (!base || process.argv.length !== 3 || base.startsWith('-')) throw new Error('Usage: node scripts/plan-affected-journeys.mjs <base-ref>');
const output = execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], { encoding: 'utf8' });
const changedPaths = output.split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/'));
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, base, changedPaths,
  ...planAffectedJourneyEvidence(changedPaths) }, null, 2)}\n`);
