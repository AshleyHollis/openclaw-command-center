import { readdir } from 'node:fs/promises';
import { readBuiltReceipt } from '../src/build.mjs';
import { selectCapturePreflightTestFiles } from '../src/test-selection.mjs';
import { runRepositoryChecks } from './repository-checks.mjs';
import { prepareTestRuntimeEnvironment } from './test-runtime.mjs';
import { runTestLanes } from './test-lanes.mjs';

// Local facts only. This command cannot authorize or launch a capture. The
// controller must bind these results to its candidate/runtime/attempt identity.
const failures = [];
const collect = async (id, run) => {
  try { return await run(); }
  catch (error) { failures.push(id); console.error(`${id} failed`, error); return null; }
};
const files = selectCapturePreflightTestFiles(await readdir(new URL('../test/', import.meta.url)));
const checks = await collect('repository-checks', () => runRepositoryChecks({ purpose: 'capture-prerequisites' }));
const environment = await collect('test-runtime', () => prepareTestRuntimeEnvironment());
const tests = environment ? runTestLanes(files, { env: environment, collectFailures: true }) : null;
if (tests && tests.status !== 0) failures.push('ordinary-tests');
const artifact = await collect('built-digest', async () => {
  const actual = await readBuiltReceipt();
  if (!checks || actual.digest !== checks.buildDigest) throw new Error('Prerequisite build identity is unavailable or changed');
  return actual;
});
const result = { schemaVersion: 1, kind: 'local-capture-prerequisites', outcome: failures.length ? 'failed' : 'passed',
  performanceQualified: false, buildDigest: artifact?.digest ?? null,
  tests: { files, lanes: tests?.outcomes ?? [] }, checks, failures };
console.info(`capture-local-prerequisites=${JSON.stringify(result)}`);
if (failures.length) process.exitCode = 1;
