import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../src/plugin.mjs';
import { createDeveloperEventHandler, developerEventRoute } from '../src/developer-work/http-route.mjs';

const credential = 'a'.repeat(48);
const principal = { producerId: 'sample-dev', role: 'worker', tokenEnv: 'SAMPLE_DEV_BEARER', allowedProjects: ['sample-project'], families: ['human-request'] };

function response() {
  return { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(value) { this.body = value ? JSON.parse(value) : null; } };
}

function request(overrides = {}) {
  return {
    method: 'POST', socket: { encrypted: true },
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: { schemaVersion: 1, eventType: 'feature_ready_for_review' },
    ...overrides
  };
}

test('the registered machine endpoint uses exact plugin-owned routing', () => {
  const routes = [];
  plugin.register({
    pluginConfig: { developerWork: { principals: [principal] } },
    runtime: {},
    registerHttpRoute: route => routes.push(route),
    registerGatewayMethod() {}, registerTool() {}, registerService() {},
    registerSessionCatalog() {}
  });
  const route = routes.find(row => row.path === developerEventRoute);
  assert.ok(route);
  assert.equal(route.auth, 'plugin');
  assert.equal(route.match, 'exact');
  assert.equal(routes.filter(row => row.path === developerEventRoute).length, 1);
});

test('DEV tool registration is explicit and cannot share one activation with LIVE receiver principals', () => {
  const register = pluginConfig => {
    const tools = [];
    plugin.register({
      pluginConfig, runtime: {},
      registerHttpRoute() {}, registerGatewayMethod() {}, registerTool: (_factory, options) => tools.push(options.name), registerService() {}, registerSessionCatalog() {}
    });
    return tools;
  };
  assert.equal(register({}).includes('command_center_report_developer_work'), false);
  const producerConfig = { enabled: true, producerId: 'sample-dev', allowedProjects: ['sample-project'], allowedAgentIds: ['sample-agent'], receiverBaseUrl: 'https://live.example.test', tokenEnv: 'SAMPLE_DEV_BEARER' };
  assert.equal(register({ developerWorkProducer: producerConfig }).includes('command_center_report_developer_work'), true);
  assert.equal(register({ developerWorkProducer: producerConfig }).includes('command_center_flush_developer_work'), true);
  assert.throws(() => register({ developerWorkProducer: producerConfig, developerWork: { principals: [principal] } }), /separate Gateway activations/u);
});

test('machine bearer binds producer authority and rejects browser or insecure ingress', async () => {
  const calls = [];
  const handler = createDeveloperEventHandler({
    service: { accept: async input => { calls.push(input); return { schemaVersion: 1, projectionState: 'projected' }; } },
    principals: [principal], env: { SAMPLE_DEV_BEARER: credential }
  });
  const accepted = response();
  await handler(request(), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(calls[0].producerId, principal.producerId);
  assert.equal(calls[0].role, 'worker');
  assert.deepEqual(calls[0].allowedProjects, ['sample-project']);
  for (const [input, status] of [
    [request({ headers: { authorization: `Bearer ${'b'.repeat(48)}`, 'content-type': 'application/json' } }), 401],
    [request({ headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', origin: 'https://sample.invalid' } }), 403],
    [request({ socket: { encrypted: false } }), 403],
    [request({ body: { eventType: 'deployment_succeeded' } }), 403],
    [request({ method: 'GET' }), 405]
  ]) {
    const result = response();
    await handler(input, result);
    assert.equal(result.statusCode, status);
  }
  assert.equal(calls.length, 1);
});

test('the receiver bounds body size and per-principal request rate', async () => {
  let count = 0;
  const handler = createDeveloperEventHandler({ service: { accept: async () => { count++; return { projectionState: 'pending' }; } }, principals: [principal], env: { SAMPLE_DEV_BEARER: credential }, limitPerMinute: 2 });
  const first = response();
  await handler(request(), first);
  assert.equal(first.statusCode, 202);
  const oversized = response();
  await handler(request({ body: 'x'.repeat(17_000) }), oversized);
  assert.equal(oversized.statusCode, 400);
  const limited = response();
  await handler(request(), limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(count, 1);
});
