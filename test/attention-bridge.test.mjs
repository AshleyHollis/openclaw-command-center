import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { sanitizeBridgeResult, validateBridgeRequest } from '../src/bridge/contracts.mjs';

test('deferred Attention actions reject every historical identity shape before service acquisition', async (t) => {
  for (const [name, client] of [
    ['HTTP profile', { authenticatedUserProfile: { profileId: 'profile-operator' } }],
    ['WebSocket profile and login identity', { authenticatedUserProfile: { profileId: 'profile-operator' }, authenticatedUserId: 'login@example.test' }],
    ['profile and legacy operator identity', { authenticatedUserProfile: { profileId: 'profile-operator' }, authenticatedOperatorId: 'legacy-operator' }],
    ['invalid profile with login identity', { authenticatedUserProfile: { profileId: '' }, authenticatedUserId: 'login@example.test' }],
    ['display name', { authenticatedUserProfile: { displayName: 'Operator' } }]
  ]) await t.test(name, async () => {
    let handler;
    let seen;
    registerBridgeMethods({ registerGatewayMethod(method, value) { if (method === 'command-center.v1.attention.act') handler = value; } }, {
      attentionAct(input) { seen = input.authenticatedOperatorId; return { schemaVersion: 1, status: 'applied' }; }
    });
    let response;
    await handler({ req: { id: 'profile-request' }, client, context: { authenticated: true }, params: {
      schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1',
      expectedEpisodeRevision: 1, expectedSourceRevision: 'revision-1', actionId: 'monitor.retry', input: {}, logicalOperationId: randomUUID()
    }, respond: (...args) => { response = args; } });
    assert.equal(response[0], false);
    assert.equal(response[2].code, 'feature-unavailable');
    assert.equal(response[2].details.retryable, false);
    assert.equal(seen, undefined);
  });
});

test('Attention and Activity contracts stay closed while first-live handlers reject before effects', async () => {
  const operationId = randomUUID();
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.attention.list', { schemaVersion: 1, limit: 50 }));
  assert.throws(() => validateBridgeRequest('command-center.v1.attention.list', { schemaVersion: 1, cursor: 'not-allowed' }), /unsupported/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.activity.list', { schemaVersion: 1, limit: 50 }));
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.activity.list', { schemaVersion: 1, limit: 100 }));
  assert.throws(() => validateBridgeRequest('command-center.v1.activity.list', { schemaVersion: 1, limit: 101 }), /limit|maximum/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.activity.list', { schemaVersion: 1, offset: 0 }));
  assert.throws(() => validateBridgeRequest('command-center.v1.activity.list', { schemaVersion: 1, cursor: 'not-allowed' }), /unsupported/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.attention.act', { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'monitor.retry', input: {}, logicalOperationId: operationId }));
  assert.throws(() => validateBridgeRequest('command-center.v1.attention.act', { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'approval.approve', input: {}, logicalOperationId: operationId }), /approvalId/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.attention.act', { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'approval.approve', approvalId: 'approval-1', input: {}, logicalOperationId: operationId }));
  assert.throws(() => validateBridgeRequest('command-center.v1.attention.act', { schemaVersion: 1, episodeId: 'episode-1', expectedEpisodeRevision: 1, actionId: 'monitor.retry', input: {}, logicalOperationId: operationId }), /requires/i);
  const sanitizedAttention = sanitizeBridgeResult('command-center.v1.attention.list', { schemaVersion: 1, revision: 2, buckets: [[{ episodeId: 'episode-1', state: 'Active', severity: 'High', diagnosis: { reason: 'blocked-work', private: 'redact' }, evidenceFacts: { facts: ['blocked-work'], privateSourceContent: 'redact' }, actions: [] }], [], [], []], episodes: [], inProgress: [{ episodeId: 'episode-running', state: 'Action running', severity: 'Routine', actions: [] }] });
  assert.equal(sanitizedAttention.buckets[0][0].diagnosis.private, undefined);
  assert.equal(sanitizedAttention.buckets[0][0].evidenceFacts.privateSourceContent, undefined);
  assert.equal(sanitizedAttention.inProgress[0].state, 'Action running');
  const sanitizedActivity = sanitizeBridgeResult('command-center.v1.activity.list', { schemaVersion: 1, records: [{ activityId: 'activity-1', episodeId: 'episode-1', logicalOperationId: operationId, outcome: 'applied', privateSourceContent: 'redact' }], nextOffset: null, hasMore: false });
  assert.equal(sanitizedActivity.records[0].privateSourceContent, undefined);
  assert.equal(sanitizedActivity.nextOffset, null);
  assert.equal(sanitizedActivity.hasMore, false);
  const registrations = [];
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, {
    attentionList: () => ({ schemaVersion: 1, revision: 2, buckets: [[{ episodeId: 'episode-1', state: 'Active', severity: 'High', diagnosis: { reason: 'blocked-work', private: 'redact' }, evidenceFacts: { facts: ['blocked-work'], privateSourceContent: 'redact' }, actions: [] }], [], [], []], episodes: [], inProgress: [{ episodeId: 'episode-running', state: 'Action running', severity: 'Routine', actions: [] }] }),
    attentionGet: () => ({ schemaVersion: 1, revision: null, episode: null }),
    attentionAct: () => ({ schemaVersion: 1, status: 'applied', attempt: { attemptId: 'attempt-1', state: 'applied', target: { private: true }, parameters: { private: true }, disclosureDigest: 'forensic' } }),
    activityList: () => ({ schemaVersion: 1, records: [{ activityId: 'activity-1', episodeId: 'episode-1', logicalOperationId: operationId, outcome: 'applied', privateSourceContent: 'redact' }], nextOffset: null, hasMore: false })
  });
  const listHandler = registrations.find(([method]) => method === 'command-center.v1.attention.list')[1];
  let response;
  await listHandler({ req: { id: 'frame-1' }, params: { schemaVersion: 1, limit: 50 }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false);
  assert.equal(response[2].code, 'feature-unavailable');
  const activityHandler = registrations.find(([method]) => method === 'command-center.v1.activity.list')[1];
  response = undefined;
  await activityHandler({ req: { id: 'frame-2' }, params: { schemaVersion: 1, limit: 1 }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false);
  assert.equal(response[2].code, 'feature-unavailable');
  const actHandler = registrations.find(([method]) => method === 'command-center.v1.attention.act')[1];
  response = undefined;
  await actHandler({ req: { id: operationId }, params: { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'monitor.retry', input: {}, logicalOperationId: operationId }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false, 'an authenticated request without a real operator identity must fail closed');
  response = undefined;
  await actHandler({ req: { id: operationId }, params: { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'monitor.retry', input: {}, logicalOperationId: operationId }, client: { pairedClientId: 'paired-device-only' }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false, 'a paired device identity is not an operator principal');
  response = undefined;
  await actHandler({ req: { id: operationId }, params: { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'monitor.retry', input: {}, logicalOperationId: operationId }, client: { authenticatedUserId: 'operator-bridge' }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false);
  assert.equal(response[2].code, 'feature-unavailable');
  const getHandler = registrations.find(([method]) => method === 'command-center.v1.attention.get')[1];
  response = undefined;
  await getHandler({ req: { id: 'frame-3' }, params: { schemaVersion: 1, episodeId: 'missing' }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false);
  assert.equal(response[2].code, 'feature-unavailable');
});
