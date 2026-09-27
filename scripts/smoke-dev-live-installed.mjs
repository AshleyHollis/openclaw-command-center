/** Two installed, isolated Gateways: DEV producer to LIVE Attention and DEV resolver. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRuntimeDispatcher } from 'openclaw/plugin-sdk/runtime-fetch';
import { assertBuiltDigest, readBuiltReceipt } from '../src/build.mjs';
import { assertCandidateArchiveBytes, assertCandidatePairEvidence, parseCandidatePair } from '../src/candidate-pair.mjs';
import { withIsolatedWorld } from '../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, launchCandidateHost,
  parseCandidateHostDescriptor, stopPinnedHost, waitForConsecutiveReadiness } from '../src/host-harness.mjs';
import { runtimeCapability } from '../src/runtime-capability.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { isGatewayStartupPending, requestAuthenticatedGateway } from '../test/support/real-host-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedFields = ['schemaVersion', 'candidatePairPath', 'inputTreeReceiptPath',
  'artifactReceiptPath', 'hostDescriptorPath', 'pluginArchivePath', 'hostArchivePath'];
let phase = 'input';

async function boundedJson(filename) {
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename));
  const info = await lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024);
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function fictionalCertificate(tempRoot) {
  const key = path.join(tempRoot, 'fictional-dev-live.key.pem');
  const certificate = path.join(tempRoot, 'fictional-dev-live.cert.pem');
  await new Promise((resolve, reject) => execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], error => error ? reject(error) : resolve()));
  return { key: await readFile(key), certificate: await readFile(certificate), certificatePath: certificate };
}

async function tlsLoopbackProxy(target, certificate) {
  let upstreamRequests = 0;
  const server = createHttpsServer({ key: certificate.key, cert: certificate.certificate }, (request, response) => {
    upstreamRequests += 1;
    const destination = new URL(request.url, target);
    const upstream = httpRequest(destination, { method: request.method,
      headers: { ...request.headers, host: destination.host, 'x-forwarded-proto': 'https' } }, reply => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `https://127.0.0.1:${server.address().port}`, count: () => upstreamRequests,
    close: () => new Promise(resolve => server.close(resolve)) };
}

async function configure(world, mutate) {
  const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
  mutate(config);
  await writeFile(world.manifest.configPath, `${JSON.stringify(config)}\n`);
}

async function ready(world, run) {
  await waitForConsecutiveReadiness(async signal => {
    try {
      const response = await fetchWithRuntimeDispatcher(`${world.gateway.url}${runtimeCapability.bootstrap.path}`,
        { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal });
      if (!response.ok) return false;
      await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.topics.list', params: { schemaVersion: 1 }, scopes: ['operator.admin'], signal });
      return true;
    } catch (error) {
      signal.throwIfAborted();
      if (isGatewayStartupPending(error)) return false;
      throw error;
    }
  }, run.earlyExit, { required: 1, deadlineMs: 120_000, delayMs: 250 });
}

async function stop(run, world) {
  if (!run) return;
  await stopPinnedHost(run.child);
  await run.outputDrained;
  await assertRecordedChildTraffic(world);
  assertNoFatalHostOutput(run.diagnostics);
}

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.argv.length, 3, 'Usage: node scripts/smoke-dev-live-installed.mjs ABSOLUTE_INPUT_JSON');
  const input = await boundedJson(process.argv[2]);
  assert.deepEqual(Object.keys(input).sort(), expectedFields.sort());
  assert.equal(input.schemaVersion, 1);
  const pair = parseCandidatePair(await boundedJson(input.candidatePairPath));
  const inputTreeReceipt = await boundedJson(input.inputTreeReceiptPath);
  const artifactReceipt = await boundedJson(input.artifactReceiptPath);
  const descriptor = parseCandidateHostDescriptor(JSON.stringify(await boundedJson(input.hostDescriptorPath)), pair);
  const buildReceipt = await readBuiltReceipt();
  await assertBuiltDigest(buildReceipt);
  assertCandidatePairEvidence(pair, { inputTreeReceipt, buildReceipt, artifactReceipt, hostDescriptor: descriptor });
  await assertCandidateArchiveBytes(pair, input);
  phase = 'worlds';
  return withIsolatedWorld(live => withIsolatedWorld(async originalDev => {
    const dev = { ...originalDev, machineCredential: live.machineCredential };
    assert.notEqual(dev.root, live.root);
    assert.notEqual(dev.gateway.port, live.gateway.port);
    assert.notEqual(dev.gatewayCredential, live.gatewayCredential);
    const certificate = await fictionalCertificate(dev.tempRoot);
    const receiver = await tlsLoopbackProxy(live.gateway.url, certificate);
    const handoff = await tlsLoopbackProxy(dev.gateway.url, certificate);
    let liveRun;
    let devRun;
    try {
      await configure(live, config => { config.plugins.entries['command-center'].config.developerWork.devBaseUrl = handoff.url; });
      await configure(dev, config => {
        config.cron = { enabled: true };
        config.plugins.entries['command-center'].config.developerWorkProducer = {
          enabled: true, producerId: 'fictional-dev', allowedProjects: ['fictional-project'],
          allowedAgentIds: ['main'], receiverBaseUrl: receiver.url,
          tokenEnv: 'COMMAND_CENTER_FIXTURE_DEV_BEARER'
        };
      });
      phase = 'live-start';
      liveRun = await launchCandidateHost({ descriptor, candidatePair: pair, inputTreeReceipt,
        artifactReceipt, buildReceipt, pluginArchivePath: input.pluginArchivePath,
        hostArchivePath: input.hostArchivePath, world: live });
      await ready(live, liveRun);
      phase = 'dev-start';
      devRun = await launchCandidateHost({ descriptor, candidatePair: pair, inputTreeReceipt,
        artifactReceipt, buildReceipt, pluginArchivePath: input.pluginArchivePath,
        hostArchivePath: input.hostArchivePath, world: dev, notificationCaPath: certificate.certificatePath });
      await ready(dev, devRun);
      phase = 'session';
      const sessionKey = `agent:main:command-center:acceptance-dev:${randomUUID()}`;
      const createdResponse = await requestAuthenticatedGateway({ gatewayUrl: dev.gateway.url,
        credential: dev.gatewayCredential, method: 'sessions.create',
        params: { agentId: 'main', key: sessionKey, label: 'Fictional DEV work' },
        scopes: ['operator.read', 'operator.write'] });
      const created = createdResponse?.result ?? createdResponse;
      assert.equal(created.key, sessionKey);
      assert.ok(created.sessionId);
      await assert.rejects(() => requestAuthenticatedGateway({ gatewayUrl: dev.gateway.url,
        credential: live.gatewayCredential, method: 'command-center.v1.topics.list',
        params: { schemaVersion: 1 }, scopes: ['operator.read'] }));
      phase = 'producer';
      const workId = 'fictional-installed-dev-work';
      const requestId = 'fictional-installed-input';
      const invoke = async (eventType, request, outcome) => {
        const response = await requestAuthenticatedGateway({ gatewayUrl: dev.gateway.url,
          credential: dev.gatewayCredential, method: 'tools.invoke',
          params: { name: 'command_center_report_developer_work', agentId: 'main', sessionKey,
            idempotencyKey: `${workId}-${eventType}`, args: { workId, eventType,
              context: { projectAlias: 'fictional-project', phase: 'waiting' }, request,
              ...(outcome ? { outcome } : {}) } }, scopes: ['operator.read', 'operator.write'] });
        const value = response?.result ?? response;
        assert.equal(value?.ok, true, 'Installed DEV tool failed');
        return value;
      };
      await invoke('human_input_required', { requestId, kind: 'input', expectedRequestRevision: 0,
        summary: 'Fictional DEV question', question: 'Fictional question?' });
      const db = new DatabaseSync(resolveCommandCenterDatabasePath(path.join(dev.root, '.openclaw')), { readOnly: true });
      try {
        const persisted = db.prepare('SELECT count(*) AS count FROM developer_work_producer_requests WHERE producer_id = ? AND work_id = ? AND request_id = ?').get('fictional-dev', workId, requestId);
        assert.equal(persisted.count, 1, 'Installed DEV producer did not retain the exact request');
        const joined = db.prepare(`SELECT count(*) AS count FROM developer_work_producer_requests r
          JOIN developer_work_outbox e ON e.producer_id = r.producer_id AND e.event_id = r.last_event_id
          WHERE r.producer_id = ? AND r.work_id = ? AND r.request_id = ?`).get('fictional-dev', workId, requestId);
        assert.equal(joined.count, 1, 'Installed DEV producer request lost its event lineage');
      } finally { db.close(); }
      phase = 'attention';
      const dashboardResponse = await requestAuthenticatedGateway({ gatewayUrl: live.gateway.url,
        credential: live.gatewayCredential, method: 'command-center.v1.dashboard.get',
        params: { schemaVersion: 1, activityOffset: 0, activityLimit: 20 }, scopes: ['operator.admin'] });
      const dashboard = dashboardResponse?.result ?? dashboardResponse;
      const card = dashboard.attention.find(item => item.sourceCapabilityId === 'developer-work.v1');
      assert.ok(card);
      const link = new URL(card.evidence.devHandoffUrl);
      assert.equal(link.origin, handoff.url);
      assert.equal(link.searchParams.get('p.workId'), workId);
      assert.equal(link.searchParams.get('p.requestId'), requestId);
      assert.ok(receiver.count() > 0, 'DEV did not use the independent HTTPS receiver');
      phase = 'handoff';
      const currentResponse = await requestAuthenticatedGateway({ gatewayUrl: dev.gateway.url,
        credential: dev.gatewayCredential, method: 'command-center.v1.developer-work.resolve',
        params: { schemaVersion: 1, workId }, scopes: ['operator.read'] });
      const current = currentResponse?.result ?? currentResponse;
      assert.equal(current.status, 'current-work');
      assert.ok(current.requests.some(row => row.requestId === requestId),
        'DEV resolver did not enumerate its retained producer request');
      const resolvedResponse = await requestAuthenticatedGateway({ gatewayUrl: dev.gateway.url,
        credential: dev.gatewayCredential, method: 'command-center.v1.developer-work.resolve',
        params: { schemaVersion: 1, workId, requestId }, scopes: ['operator.read'] });
      const resolved = resolvedResponse?.result ?? resolvedResponse;
      assert.equal(resolved.status, 'ready', `DEV resolver status ${resolved.status}:${resolved.reason ?? 'none'}`);
      assert.equal(resolved.sessionKey, sessionKey);
      assert.equal(resolved.sessionId, created.sessionId);
      assert.ok(resolved.lifecycleRevision);
      phase = 'resolution';
      await invoke('request_resolved', { requestId, kind: 'input', expectedRequestRevision: 1 },
        { code: 'answered', requestId });
      const finalResponse = await requestAuthenticatedGateway({ gatewayUrl: live.gateway.url,
        credential: live.gatewayCredential, method: 'command-center.v1.dashboard.get',
        params: { schemaVersion: 1, activityOffset: 0, activityLimit: 20 }, scopes: ['operator.admin'] });
      const final = finalResponse?.result ?? finalResponse;
      assert.ok(!final.attention.some(card => card.sourceCapabilityId === 'developer-work.v1'));
      return { schemaVersion: 1, kind: 'installed-dev-live-session-smoke', candidatePairSeal: pair.seal,
        hostCommit: pair.openClaw.sourceCommit, pluginBuildDigest: pair.commandCenter.buildDigest,
        checks: ['two-isolated-installed-gateways', 'separate-authentication',
          'dev-session-bound-producer-tool', 'https-machine-receipt', 'live-attention',
          'exact-dev-session-resolution', 'request-resolution'], releaseQualified: false };
    } finally {
      try { await stop(devRun, dev); } finally {
        try { await stop(liveRun, live); } finally {
          try { await handoff.close(); } finally { await receiver.close(); }
        }
      }
    }
  }, { candidateRoot: root }), { candidateRoot: root, machineIngress: true });
}

main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  const line = /smoke-dev-live-installed\.mjs:(\d+)/u.exec(error?.stack ?? '')?.[1] ?? 'unknown';
  process.stderr.write(`Installed DEV/LIVE smoke failed at ${phase}, line ${line}: ${error?.category ?? error?.code ?? error?.name ?? 'unclassified'}\n`);
  process.exitCode = 1;
});
