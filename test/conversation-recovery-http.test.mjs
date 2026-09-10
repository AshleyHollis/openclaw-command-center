import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';
import { createTopicPageActionsHandler } from '../src/topics/page-http.mjs';
import { createRequestScopedConversationRuntime } from '../src/bridge/gateway-method-dispatch.mjs';
import { assertFirstLiveTopicAction } from '../src/release-scope.mjs';

// Exercise the real HTTP adapter, request-scoped authority and SQLite owner.
// Only the external native Gateway/catalog is fictional, not the operation owner.
test('authenticated recovery routes restore the original receipt and require explicit acknowledgement before another creation', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'conversation-http-recovery-'));
  const topicId = '44444444-4444-4444-8444-444444444444';
  const rows = new Map([['agent:main:fictional:primary', { sessionId: 'primary-id', updatedAt: 10 }]]);
  let metadata;
  let handler;
  let effects = 0;
  const gatewayContext = {};
  const scope = { pluginId: 'command-center', gatewayMethodDispatchAllowed: true,
    client: { authenticatedUserProfile: { profileId: 'fictional-owner' }, connect: { role: 'operator', scopes: ['operator.write'] } },
    resolveGatewayContext: () => gatewayContext };
  function reopen() {
    metadata?.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    const service = new AuthoritativeSourceService({ metadata, capabilities: { sessions: true, notes: false, scheduler: false },
      sessionStore: { listSessionEntries: () => [...rows].map(([sessionKey, entry]) => ({ sessionKey, entry })), getSessionEntry: ({ sessionKey }) => rows.get(sessionKey) } });
    handler = createTopicPageActionsHandler(service, { assertAction: assertFirstLiveTopicAction,
      createConversationRuntime: () => createRequestScopedConversationRuntime({ getRequestScope: () => scope,
        dispatchGatewayMethod: async (method) => {
          assert.equal(method, 'sessions.create');
          const key = `agent:main:fictional:created-${++effects}`;
          const entry = { sessionId: `created-${effects}`, updatedAt: 20 };
          rows.set(key, entry);
          return { ok: true, payload: { key, sessionId: entry.sessionId, entry } };
        } }) });
  }
  async function post(action, fields = {}) {
    const request = Readable.from([Buffer.from(JSON.stringify({ schemaVersion: 1, action, topicId, ...fields }))]);
    request.method = 'POST'; request.headers = { 'content-type': 'application/json' };
    let body;
    const response = { setHeader() {}, end(value) { body = JSON.parse(value); } };
    await handler(request, response);
    return { status: response.statusCode, body };
  }
  try {
    reopen();
    metadata.createTopic({ topicId, name: 'Fictional recovery', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSessionBinding({ reference: { version: 1, referenceId: 'primary-ref', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional:primary', observedRevision: '10' },
      state: { referenceId: 'primary-ref', sessionId: 'primary-id', status: 'open', isPrimary: true, displayName: 'Fictional recovery' } });
    const clear = await post('conversations.creation.inspect');
    assert.equal(clear.status, 200, JSON.stringify(clear));
    assert.equal(clear.body.status, 'clear');
    const input = { logicalOperationId: randomUUID(), expectedRevision: 0, label: 'Original private intent' };
    const created = await post('conversations.create', input);
    assert.equal(created.body.status, 'applied', JSON.stringify(created));
    const referenceId = created.body.result.referenceId;
    reopen(); // Local activation/request memory must not be the recovery owner.
    const recovered = await post('conversations.creation.inspect');
    assert.equal(recovered.body.status, 'applied', JSON.stringify(recovered));
    assert.equal(recovered.body.logicalOperationId, input.logicalOperationId);
    assert.equal(recovered.body.result.expectedTopicRevision, 0);
    assert.equal(recovered.body.result.label, input.label);
    assert.equal(recovered.body.result.referenceId, referenceId);
    scope.client.authenticatedUserProfile.profileId = 'different-operator';
    const foreign = await post('conversations.creation.inspect');
    assert.deepEqual(foreign.body, { schemaVersion: 1, status: 'blocked', result: { action: 'conversations.creation.inspect', topicId } });
    scope.client.authenticatedUserProfile.profileId = 'fictional-owner';
    const duplicate = await post('conversations.create', { ...input, logicalOperationId: randomUUID(), expectedRevision: metadata.getTopic(topicId).revision });
    assert.notEqual(duplicate.body.status, 'applied');
    assert.equal(effects, 1);
    const reconciled = await post('conversations.creation.reconcile', { logicalOperationId: input.logicalOperationId });
    assert.equal(reconciled.body.status, 'applied', JSON.stringify(reconciled));
    assert.equal(reconciled.body.result.referenceId, referenceId);
    const missing = await post('conversations.creation.reconcile', { logicalOperationId: randomUUID() });
    assert.notEqual(missing.status, 200);
    assert.equal(effects, 1, 'Reconciliation cannot dispatch a missing operation');
    const acknowledged = await post('conversations.creation.acknowledge', { logicalOperationId: input.logicalOperationId, referenceId });
    assert.equal(acknowledged.body.status, 'acknowledged', JSON.stringify(acknowledged));
    reopen();
    assert.equal((await post('conversations.creation.inspect')).body.status, 'clear');
    assert.deepEqual(await post('conversations.create', input), created, 'Acknowledgement cannot replace the original create receipt');
    assert.equal(effects, 1);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
