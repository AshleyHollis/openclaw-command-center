import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { validateBridgeRequest } from '../src/bridge/contracts.mjs';

test('Attention and Activity bridge methods are closed, scoped, and redact bounded projections', async () => {
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
  assert.equal(response[0], true);
  assert.equal(response[1].result.buckets[0][0].diagnosis.private, undefined);
  assert.equal(response[1].result.buckets[0][0].evidenceFacts.privateSourceContent, undefined);
  assert.equal(response[1].result.inProgress[0].state, 'Action running');
  const activityHandler = registrations.find(([method]) => method === 'command-center.v1.activity.list')[1];
  response = undefined;
  await activityHandler({ req: { id: 'frame-2' }, params: { schemaVersion: 1, limit: 1 }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], true);
  assert.equal(response[1].result.records[0].privateSourceContent, undefined);
  assert.equal(response[1].result.nextOffset, null);
  assert.equal(response[1].result.hasMore, false);
  const actHandler = registrations.find(([method]) => method === 'command-center.v1.attention.act')[1];
  response = undefined;
  await actHandler({ req: { id: operationId }, params: { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'monitor.retry', input: {}, logicalOperationId: operationId }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false, 'an authenticated request without a real operator identity must fail closed');
  response = undefined;
  await actHandler({ req: { id: operationId }, params: { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'monitor.retry', input: {}, logicalOperationId: operationId }, client: { pairedClientId: 'paired-device-only' }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false, 'a paired device identity is not an operator principal');
  response = undefined;
  await actHandler({ req: { id: operationId }, params: { schemaVersion: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', episodeId: 'episode-1', expectedEpisodeRevision: 1, expectedSourceRevision: 'source-revision-1', actionId: 'monitor.retry', input: {}, logicalOperationId: operationId }, client: { authenticatedUserId: 'operator-bridge' }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.deepEqual(response[1].result.attempt, { attemptId: 'attempt-1', state: 'applied' });
  const getHandler = registrations.find(([method]) => method === 'command-center.v1.attention.get')[1];
  response = undefined;
  await getHandler({ req: { id: 'frame-3' }, params: { schemaVersion: 1, episodeId: 'missing' }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], true);
  assert.deepEqual(response[1].result, { schemaVersion: 1, revision: null, episode: null });
});
