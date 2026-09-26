import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
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
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { createGatewayDeviceIdentity, isGatewayStartupPending, requestAuthenticatedGateway } from '../test/support/real-host-runtime.mjs';

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

async function loopbackPushReceiver(tempRoot) {
  const keyPath = path.join(tempRoot, 'fictional-push.key.pem');
  const certificatePath = path.join(tempRoot, 'fictional-push.cert.pem');
  await new Promise((resolve, reject) => execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certificatePath, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], error => error ? reject(error) : resolve()));
  const deliveries = [];
  const server = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, (request, response) => {
    let bytes = 0;
    request.on('data', chunk => { bytes += chunk.byteLength; });
    request.on('end', () => {
      deliveries.push({ method: request.method, bytes });
      response.writeHead(201);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { certificatePath, endpoint: `https://127.0.0.1:${address.port}/push`, deliveries,
    close: () => new Promise(resolve => server.close(resolve)) };
}

function notificationStatus(world, status) {
  const db = new DatabaseSync(resolveCommandCenterDatabasePath(path.join(world.root, '.openclaw')), { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM notification_emissions WHERE status = ?').get(status).count; }
  finally { db.close(); }
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
    const receiver = await loopbackPushReceiver(world.tempRoot);
    let run;
    try {
      run = await launchCandidateHost({ descriptor, candidatePair: pair, inputTreeReceipt,
        artifactReceipt, buildReceipt, pluginArchivePath: input.pluginArchivePath,
        hostArchivePath: input.hostArchivePath, world, notificationCaPath: receiver.certificatePath });
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
      const bootstrap = await fetchWithRuntimeDispatcher(`${world.gateway.url}${runtimeCapability.bootstrap.path}`,
        { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal: AbortSignal.timeout(10_000) });
      assert.equal(bootstrap.status, 200);
      const bootstrapBody = await bootstrap.json();
      assert.ok(typeof bootstrapBody.serverBuildId === 'string' && bootstrapBody.serverBuildId);
      const deviceIdentity = createGatewayDeviceIdentity();
      const receiverKey = createECDH('prime256v1');
      receiverKey.generateKeys();
      const operator = { gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        scopes: ['operator.read', 'operator.write', 'operator.admin'], deviceIdentity,
        controlUiBuildId: bootstrapBody.serverBuildId };
      await requestAuthenticatedGateway({ ...operator, method: 'push.web.subscribe',
        params: { endpoint: receiver.endpoint, keys: { p256dh: receiverKey.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url') } } });
      const nativePreferences = await requestAuthenticatedGateway({ ...operator, method: 'push.web.preferences.get',
        params: { endpoint: receiver.endpoint } });
      assert.equal(nativePreferences.durableIdentity, true, 'Fictional device lacks a durable operator profile');
      await requestAuthenticatedGateway({ ...operator, method: 'push.web.preferences.set',
        params: { endpoint: receiver.endpoint, scope: 'user', preferences: {
          ...nativePreferences.user, categories: { ...nativePreferences.user.categories, pluginAttention: true }
        } } });
      const boundResponse = await requestAuthenticatedGateway({ ...operator,
        method: 'command-center.v1.dashboard.get',
        params: { schemaVersion: 1, activityOffset: 0, activityLimit: 20 } });
      const boundDashboard = boundResponse?.result ?? boundResponse;
      assert.ok(boundDashboard.notificationSettings?.revision > 0);
      const settingsResponse = await fetchWithRuntimeDispatcher(`${world.gateway.url}/plugins/command-center/api/dashboard/actions`, {
        method: 'POST', headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, action: 'settings.update', logicalOperationId: randomUUID(),
          expectedRevision: boundDashboard.notificationSettings.revision, settings: { quietHoursEnabled: false } }),
        signal: AbortSignal.timeout(10_000)
      });
      assert.equal(settingsResponse.status, 200, 'Fixture notification settings update failed');
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
      assert.ok(notificationStatus(world, 'sent') > 0, 'Installed host did not record a sent notification');
      assert.equal(receiver.deliveries.length, 1, 'Fictional receiver did not get exactly one activation');
      await send({ ...base, eventId: randomUUID(), workRevision: 2,
        eventType: 'request_resolved', occurredAt: new Date().toISOString(),
        request: { ...request, expectedRequestRevision: 1 },
        outcome: { code: 'answered', requestId } }, 2);
      assert.ok(!(await dashboard()).attention.some(card => card.sourceCapabilityId === 'developer-work.v1'),
        'Resolved fictional request remained active in Attention');
      assert.ok(notificationStatus(world, 'cleared') > 0, 'Installed host did not clear the notification');
      assert.equal(receiver.deliveries.length, 2, 'Fictional receiver did not get one activation and one clear');
      await assertRecordedChildTraffic(world);
      assertNoFatalHostOutput(run.diagnostics);
      return { schemaVersion: 1, kind: 'candidate-pair-isolated-smoke',
        candidatePairSeal: pair.seal, hostCommit: pair.openClaw.sourceCommit,
        hostPackageDigest: pair.openClaw.packageDigest,
        pluginBuildDigest: pair.commandCenter.buildDigest, fixtureDigest: pair.fixtureDigest,
        checks: ['isolated-gateway-startup', 'authenticated-plugin-read', 'machine-ingress-projection',
          'attention-lifecycle', 'native-push-delivery-and-clear', 'child-traffic-isolation'],
        releaseQualified: false };
    } finally {
      try {
        if (run) {
          await stopPinnedHost(run.child);
          await run.outputDrained;
          await assertRecordedChildTraffic(world);
          assertNoFatalHostOutput(run.diagnostics);
        }
      } finally { await receiver.close(); }
    }
  }, { candidateRoot: root, machineIngress: true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  // Never copy host output, fixture credentials or local paths into a report.
  process.stderr.write(`Candidate pair smoke failed: ${error?.category ?? error?.code ?? 'unclassified'}\n`);
  process.exitCode = 1;
});
