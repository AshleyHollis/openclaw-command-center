import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { developerEventRoute } from '../src/developer-work/http-route.mjs';
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
            params: { schemaVersion: 1 }, scopes: ['operator.admin'], signal });
          return true;
        } catch (error) {
          signal.throwIfAborted();
          if (isGatewayStartupPending(error)) return false;
          throw error;
        }
      }, run.earlyExit, { required: 1, deadlineMs: 120_000, delayMs: 250 });
      assert.ok(read && typeof read === 'object', 'Authenticated plugin read returned no response');
      const requestId = 'fictional-input-a';
      const request = { requestId, kind: 'input', expectedRequestRevision: 0,
        summary: 'Fictional input required', question: 'Fictional private question?' };
      const base = { schemaVersion: 1, workId: 'fictional-work',
        context: { projectAlias: 'fictional-project', phase: 'waiting' },
        session: { agentId: 'fictional-agent', sessionKey: 'agent:fictional-agent:main',
          sessionId: 'fictional-session', lifecycleRevision: 'fictional-lifecycle' } };
      const send = async (event, watermark) => {
        const response = await fetchWithRuntimeDispatcher(`${world.gateway.url}${developerEventRoute}`, {
          method: 'POST', headers: { authorization: `Bearer ${world.machineCredential}`,
            'content-type': 'application/json', 'x-forwarded-proto': 'https',
            'x-developer-work-watermark': String(watermark) },
          body: JSON.stringify(event), signal: AbortSignal.timeout(10_000)
        });
        const result = await response.json();
        assert.equal(response.status, 200, `Machine ingress refused: ${result?.code ?? response.status}`);
        assert.equal(result?.receipt?.projectionState, 'projected');
      };
      await send({ ...base, eventId: randomUUID(), workRevision: 1,
        eventType: 'human_input_required', occurredAt: new Date().toISOString(), request }, 1);
      const dashboard = async () => {
        const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url,
          credential: world.gatewayCredential, method: 'command-center.v1.dashboard.get',
          params: { schemaVersion: 1, activityOffset: 0, activityLimit: 20 },
          scopes: ['operator.admin'] });
        return response?.result ?? response;
      };
      assert.ok((await dashboard()).attention.some(card => card.sourceCapabilityId === 'developer-work.v1'),
        'Accepted fictional request did not reach Attention');
      await send({ ...base, eventId: randomUUID(), workRevision: 2,
        eventType: 'request_resolved', occurredAt: new Date().toISOString(),
        request: { ...request, expectedRequestRevision: 1 },
        outcome: { code: 'answered', requestId } }, 2);
      assert.ok(!(await dashboard()).attention.some(card => card.sourceCapabilityId === 'developer-work.v1'),
        'Resolved fictional request remained active in Attention');
      await assertRecordedChildTraffic(world);
      assertNoFatalHostOutput(run.diagnostics);
      return { schemaVersion: 1, kind: 'candidate-pair-isolated-smoke',
        candidatePairSeal: pair.seal, hostCommit: pair.openClaw.sourceCommit,
        hostPackageDigest: pair.openClaw.packageDigest,
        pluginBuildDigest: pair.commandCenter.buildDigest, fixtureDigest: pair.fixtureDigest,
        checks: ['isolated-gateway-startup', 'authenticated-plugin-read', 'machine-ingress-projection',
          'attention-lifecycle', 'child-traffic-isolation'],
        releaseQualified: false };
    } finally {
      await stopPinnedHost(run.child);
      await run.outputDrained;
      await assertRecordedChildTraffic(world);
      assertNoFatalHostOutput(run.diagnostics);
    }
  }, { candidateRoot: root, machineIngress: true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  // Never copy host output, fixture credentials or local paths into a report.
  process.stderr.write(`Candidate pair smoke failed: ${error?.category ?? error?.code ?? 'unclassified'}\n`);
  process.exitCode = 1;
});
