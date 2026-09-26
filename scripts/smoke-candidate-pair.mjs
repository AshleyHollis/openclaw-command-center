import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRuntimeDispatcher } from 'openclaw/plugin-sdk/runtime-fetch';
import { assertBuiltDigest, readBuiltReceipt } from '../src/build.mjs';
import { assertCandidateArchiveBytes, assertCandidatePairEvidence, parseCandidatePair } from '../src/candidate-pair.mjs';
import { withIsolatedWorld } from '../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, launchCandidateHost,
  parseCandidateHostDescriptor, stopPinnedHost, waitForConsecutiveReadiness } from '../src/host-harness.mjs';
import { runtimeCapability } from '../src/runtime-capability.mjs';
import { isGatewayStartupPending, requestAuthenticatedGateway } from '../test/support/real-host-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedFields = ['schemaVersion', 'candidatePairPath', 'inputTreeReceiptPath',
  'artifactReceiptPath', 'hostDescriptorPath', 'pluginArchivePath', 'hostArchivePath'];

async function boundedJson(filename) {
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename), 'Candidate evidence path must be absolute');
  const status = await lstat(filename);
  assert.ok(status.isFile() && !status.isSymbolicLink() && status.size <= 64 * 1024,
    'Candidate evidence must be a bounded regular file');
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function main() {
  assert.equal(process.platform, 'linux', 'Candidate Gateway smoke requires Linux isolation');
  assert.equal(process.argv.length, 3, 'Usage: node scripts/smoke-candidate-pair.mjs ABSOLUTE_INPUT_JSON');
  const input = await boundedJson(process.argv[2]);
  assert.deepEqual(Object.keys(input).sort(), expectedFields.sort(), 'Candidate smoke input fields differ');
  assert.equal(input.schemaVersion, 1);
  const pair = parseCandidatePair(await boundedJson(input.candidatePairPath));
  const inputTreeReceipt = await boundedJson(input.inputTreeReceiptPath);
  const artifactReceipt = await boundedJson(input.artifactReceiptPath);
  const hostDescriptor = await boundedJson(input.hostDescriptorPath);
  const descriptor = parseCandidateHostDescriptor(JSON.stringify(hostDescriptor), pair);
  const buildReceipt = await readBuiltReceipt();
  await assertBuiltDigest(buildReceipt);
  assertCandidatePairEvidence(pair, { inputTreeReceipt, buildReceipt, artifactReceipt, hostDescriptor: descriptor });
  await assertCandidateArchiveBytes(pair, input);

  const result = await withIsolatedWorld(async (world) => {
    const run = await launchCandidateHost({ descriptor, candidatePair: pair, inputTreeReceipt,
      artifactReceipt, buildReceipt, pluginArchivePath: input.pluginArchivePath,
      hostArchivePath: input.hostArchivePath, world });
    try {
      await waitForConsecutiveReadiness(async (signal) => {
        try {
          const response = await fetchWithRuntimeDispatcher(
            `${world.gateway.url}${runtimeCapability.bootstrap.path}`,
            { headers: { authorization: `Bearer ${world.gatewayCredential}` },
              signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
          return response.ok;
        } catch (error) {
          signal.throwIfAborted();
          if (error?.name === 'TimeoutError') return false;
          throw error;
        }
      }, run.earlyExit, { required: 2, deadlineMs: 120_000, delayMs: 250 });
      let read;
      await waitForConsecutiveReadiness(async (signal) => {
        try {
          read = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url,
            credential: world.gatewayCredential, method: 'command-center.v1.topics.list',
            params: { schemaVersion: 1 }, signal });
          return true;
        } catch (error) {
          signal.throwIfAborted();
          if (isGatewayStartupPending(error)) return false;
          throw error;
        }
      }, run.earlyExit, { required: 1, deadlineMs: 120_000, delayMs: 250 });
      assert.ok(read && typeof read === 'object', 'Authenticated plugin read returned no response');
      await assertRecordedChildTraffic(world);
      assertNoFatalHostOutput(run.diagnostics);
      return { schemaVersion: 1, kind: 'candidate-pair-isolated-smoke',
        candidatePairSeal: pair.seal, hostCommit: pair.openClaw.sourceCommit,
        hostPackageDigest: pair.openClaw.packageDigest,
        pluginBuildDigest: pair.commandCenter.buildDigest, fixtureDigest: pair.fixtureDigest,
        checks: ['isolated-gateway-startup', 'authenticated-plugin-read', 'child-traffic-isolation'],
        releaseQualified: false };
    } finally {
      await stopPinnedHost(run.child);
      await run.outputDrained;
      await assertRecordedChildTraffic(world);
      assertNoFatalHostOutput(run.diagnostics);
    }
  }, { candidateRoot: root });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  // Never copy host output, fixture credentials or local paths into a report.
  process.stderr.write(`Candidate pair smoke failed: ${error?.category ?? error?.code ?? 'unclassified'}\n`);
  process.exitCode = 1;
});
