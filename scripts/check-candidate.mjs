import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCandidatePair } from '../src/candidate-pair.mjs';
import { runRepositoryChecks } from './repository-checks.mjs';

// Run from the isolated staged source tree. This checks build prerequisites;
// the installed integration Gateway, independent review and signed release
// qualification remain separate gates.

async function closedJson(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
    throw new Error('Candidate check input must be an absolute file');
  }
  const status = await lstat(filename);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 64 * 1024) {
    throw new Error('Candidate check input must be a bounded regular file');
  }
  return JSON.parse(await readFile(filename, 'utf8'));
}

if (process.argv.length !== 4) {
  throw new Error('Usage: node scripts/check-candidate.mjs ABSOLUTE_PAIR_JSON ABSOLUTE_STAGING_RECEIPT_JSON');
}

const pair = parseCandidatePair(await closedJson(process.argv[2]));
const inputTreeReceipt = await closedJson(process.argv[3]);
const result = await runRepositoryChecks({ purpose: 'candidate-prerequisites',
  candidatePair: pair, inputTreeReceipt });
process.stdout.write(`${JSON.stringify(result)}\n`);
