import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../src/plugin.mjs';
import { READ_METHODS, WRITE_METHODS } from '../src/bridge/contracts.mjs';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function http(h, routePath, body) {
  const route = h.routes.find(value => value.path === routePath);
  assert.ok(route, routePath);
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.url = routePath; req.headers = { 'content-type': 'application/json' };
  let payload;
  const res = { setHeader() {}, end(value) { payload = JSON.parse(value); } };
  await route.handler(req, res);
  return { status: res.statusCode, ...payload };
}

function host({ flatAgentEvents = false } = {}) {
  const routes = []; const methods = new Map(); const services = []; const tools = []; const agentEventSubscriptions = [];
  const api = {
    pluginConfig: {},
    get notifications() { throw new Error('Optional notifications must not be acquired.'); },
    registerHttpRoute: value => routes.push(value),
    registerGatewayMethod: (name, handler) => methods.set(name, handler),
    registerService: value => services.push(value),
    registerTool: (_factory, declaration) => tools.push(declaration.name),
    ...(flatAgentEvents
      ? { registerAgentEventSubscription: value => agentEventSubscriptions.push(value) }
      : { agent: { events: { registerAgentEventSubscription: value => agentEventSubscriptions.push(value) } } })
  };
  return { api, routes, methods, services, tools, agentEventSubscriptions };
}

test('first-live registration needs no notification authority and preserves core native entry points', () => {
  const h = host();
  plugin.register(h.api);
  assert.equal(h.services.length, 1);
  for (const method of ['topics.list', 'topics.get', 'notes.browse', 'notes.read', 'sessions.browse', 'sessions.navigate', 'sessions.create', 'sessions.resolve-native', 'histories.list', 'histories.read', 'histories.attachment-read', 'reminders.list', 'reminders.create', 'reminders.snooze', 'reminders.complete', 'schedules.list', 'schedules.get', 'schedules.create', 'schedules.update', 'schedules.set-enabled', 'schedules.run']) {
    assert.ok(h.methods.has(`command-center.v1.${method}`), method);
  }
  assert.ok(h.routes.some(route => route.path === '/plugins/command-center/api/topic/actions' && route.auth === 'gateway'));
  assert.ok(!h.tools.includes('command_center_topic_analysis'));
});

test('registered deferred bridge commands are refused before a service or optional binding is acquired', async () => {
  const h = host(); plugin.register(h.api);
  const retained = new Set(['sources.status', 'migration.status', 'migration.review-failures', 'topics.list', 'topics.get', 'topics.recovery.status', 'topics.recovery.verify', 'notes.browse', 'notes.read', 'sessions.browse', 'sessions.navigate', 'sessions.topic-context', 'sessions.group-preview', 'sessions.group', 'sessions.assign-topic', 'sessions.create', 'histories.list', 'histories.read', 'histories.attachment-read', 'reminders.list', 'reminders.create', 'reminders.snooze', 'reminders.complete', 'schedules.list', 'schedules.get', 'schedules.create', 'schedules.update', 'schedules.set-enabled', 'schedules.run'].map(name => `command-center.v1.${name}`));
  for (const method of [...READ_METHODS, ...WRITE_METHODS].filter(name => !retained.has(name))) {
    let response;
    await h.methods.get(method)({ req: { id: 'fixture-request' }, params: {}, context: { authenticated: true },
      respond: (ok, result, error) => { response = { ok, result, error }; } });
    assert.equal(response.ok, false, method);
    assert.equal(response.error.code, 'feature-unavailable', method);
    assert.equal(response.error.details.retryable, false, method);
  }
});

test('first live retains only the authenticated, conditional Note Folder recovery command', async () => {
  const methods = new Map(); const calls = [];
  registerBridgeMethods({ registerGatewayMethod: (name, handler) => methods.set(name, handler) }, {
    topics: { recoveryVerify: async input => { calls.push(input); return { status: 'replaced', recovery: { state: 'replaced' } }; } }
  });
  const params = { schemaVersion: 1, topicId: randomUUID(), referenceId: 'note-folder:fictional', replacementLocator: '/fictional/vault/Cooking', expectedRevision: 0, expectedSourceRevision: 'note-folder:1:fictional', logicalOperationId: randomUUID() };
  let response;
  await methods.get('command-center.v1.topics.recovery.verify')({ req: { id: 'fixture-recovery' }, params, context: { authenticated: true }, respond: (ok, result, error) => { response = { ok, result, error }; } });
  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ...params, requestId: 'fixture-recovery' });
  let blocked;
  await methods.get('command-center.v1.topics.recovery.replace')({ req: { id: 'fixture-recovery-replace' }, params: {}, context: { authenticated: true }, respond: (ok, result, error) => { blocked = { ok, result, error }; } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'feature-unavailable');
});

test('first-live opens only native-backed Reminder and Schedule commands while Attention remains deferred', async () => {
  const methods = new Map();
  const calls = [];
  const nativeCron = Object.freeze([{ id: 'fictional-native-cron', enabled: true, schedule: Object.freeze({ kind: 'every', everyMs: 60_000 }) }]);
  const before = JSON.stringify(nativeCron);
  const owner = {
    remindersList: async input => { calls.push(['reminders.list', input]); return []; },
    schedulesList: async input => { calls.push(['schedules.list', input]); return []; }
  };
  registerBridgeMethods({ registerGatewayMethod: (name, handler) => methods.set(name, handler) }, owner);
  for (const method of ['command-center.v1.reminders.list', 'command-center.v1.schedules.list']) {
    let response;
    await methods.get(method)({ req: { id: 'fictional-native-scheduler-read' }, params: { schemaVersion: 1, topicId: 'fictional-topic' }, context: { authenticated: true }, respond: (ok, result, error) => { response = { ok, result, error }; } });
    assert.equal(response.ok, true, method);
  }
  assert.deepEqual(calls.map(([method]) => method), ['reminders.list', 'schedules.list']);
  let blocked;
  await methods.get('command-center.v1.attention.act')({ req: { id: 'fictional-attention-rejection' }, params: {}, context: { authenticated: true }, respond: (ok, result, error) => { blocked = { ok, result, error }; } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'feature-unavailable');
  assert.equal(JSON.stringify(nativeCron), before);
});

test('deferred HTTP actions are non-retryable and cannot reach services before startup', async () => {
  const h = host(); plugin.register(h.api);
  for (const route of ['attention/actions', 'dashboard', 'dashboard/actions', 'topics/actions', 'search/rebuild', 'topic-analysis', 'topic-analysis/actions']) {
    const result = await http(h, `/plugins/command-center/api/${route}`, {});
    assert.equal(result.code, 'feature-unavailable', route);
    assert.equal(result.retryable, false, route);
  }
  for (const action of ['notes.edit', 'notes.create', 'notes.move', 'notes.rename', 'notes.edit.reconcile', 'notes.create.reconcile', 'conversations.close', 'conversations.reopen', 'chat.send']) {
    const result = await http(h, '/plugins/command-center/api/topic/actions', { schemaVersion: 1, action, topicId: randomUUID(), logicalOperationId: randomUUID() });
    assert.equal(result.code, 'feature-unavailable', action);
    assert.equal(result.retryable, false, action);
    assert.doesNotMatch(result.message, /unknown|could not be confirmed/u);
  }
});

test('the reader MVP manifest keeps filing and maintenance tools/triggers unavailable', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.tools, []);
  assert.deepEqual(manifest.contracts.workspaceSessionTurnScheduling, []);
  const h = host(); plugin.register(h.api);
  assert.deepEqual(h.tools, []);
  assert.equal(h.agentEventSubscriptions.length, 0);
  for (const suffix of ['', '/app.js', '/styles.css', '/markdown.js']) {
    const route = h.routes.find(value => value.path === `/plugins/command-center${suffix}`);
    assert.ok(route);
    let payload;
    const res = { setHeader() {}, end(value) { payload = JSON.parse(value); } };
    await route.handler({ method: 'GET', url: route.path }, res);
    assert.equal(payload.code, 'feature-unavailable');
    assert.equal(res.statusCode, 501);
  }
});

test('the reader MVP leaves the flat host maintenance subscription unavailable', () => {
  const h = host({ flatAgentEvents: true });
  plugin.register(h.api);
  assert.equal(h.agentEventSubscriptions.length, 0);
});

test('first-live bootstrap status preserves failures without advertising a disabled recovery command', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'first-live-status-'));
  const h = host();
  h.api.runtime = { state: { resolveStateDir: () => stateDir } };
  h.api.logger = {};
  h.api.pluginConfig = { legacyDiscordMigration: { schemaVersion: 1, exportPath: path.join(stateDir, 'missing-fictional-export.json'), channels: [{ channelId: 'fictional-channel', topicId: randomUUID(), paraCategory: 'project', noteFolderPath: path.join(stateDir, 'fictional-notes') }] } };
  plugin.register(h.api);
  try {
    await h.services[0].start();
    for (const method of ['command-center.v1.migration.status', 'command-center.v1.migration.review-failures']) {
      let response;
      await h.methods.get(method)({ req: { id: 'fictional-status' }, params: { schemaVersion: 1 }, context: { authenticated: true }, respond: (ok, value, error) => { response = { ok, value, error }; } });
      assert.equal(response.ok, true, JSON.stringify(response.error));
      const result = response.value.result;
      assert.equal(result.phase, 'review');
      assert.equal(result.complete, false);
      assert.ok(result.failures.length > 0);
      assert.deepEqual(result.actions, [{ id: 'review-failures', method: 'command-center.v1.migration.review-failures', scope: 'operator.read' }]);
    }
    // The release projection must not alter the reusable migration owner.
    const unprojected = await h.services[0].sourceService.migrationStatus();
    assert.ok(unprojected.actions.some(action => action.method === 'command-center.v1.migration.resume'));
  } finally { await h.services[0].stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('first-live Conversation creation cannot adopt a caller-supplied legacy Session result', async () => {
  const h = host(); plugin.register(h.api);
  const logicalOperationId = randomUUID();
  const result = await http(h, '/plugins/command-center/api/topic/actions', {
    schemaVersion: 1, action: 'conversations.create', topicId: randomUUID(), logicalOperationId, expectedRevision: 0, label: 'Fictional Conversation',
    authoritativeSession: { key: `agent:main:dashboard:bridge-fictional-${logicalOperationId}`, sessionId: 'fictional-session', revision: '1', idempotencyKey: logicalOperationId, label: 'Fictional Conversation' }
  });
  assert.equal(result.code, 'invalid-request');
  assert.equal(result.message, 'The Topic Page action was not applied.');
});

test('registered Conversation creation requires live native request authority before acquiring its owner', async () => {
  const h = host(); plugin.register(h.api);
  const result = await http(h, '/plugins/command-center/api/topic/actions', {
    schemaVersion: 1, action: 'conversations.create', topicId: randomUUID(), logicalOperationId: randomUUID(),
    expectedRevision: 0, label: 'Fictional Conversation'
  });
  assert.equal(result.code, 'unauthenticated');
});

test('a current connection ID cannot substitute for durable Conversation operator identity', async () => {
  const methods = new Map();
  let ownerAcquisitions = 0;
  const service = new Proxy({}, { get() { ownerAcquisitions += 1; throw new Error('Connection-only authority reached the Conversation owner.'); } });
  registerBridgeMethods({ registerGatewayMethod: (name, handler) => methods.set(name, handler) }, service);
  const client = { connId: 'fictional-current-connection', connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } };
  let response;
  await methods.get('command-center.v1.sessions.create')({
    req: { id: 'fictional-connection-only' },
    params: { schemaVersion: 1, topicId: randomUUID(), logicalOperationId: randomUUID(), expectedRevision: 1, label: 'Must not create', isPrimary: false },
    client,
    context: { authenticated: true, getClientConnIds: predicate => new Set(predicate(client) ? [client.connId] : []) },
    respond: (ok, result, error) => { response = { ok, result, error }; }
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unauthenticated');
  assert.equal(ownerAcquisitions, 0);
});
