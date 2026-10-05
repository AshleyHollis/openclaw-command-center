import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectDashboard } from '../src/dashboard/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { seedAttentionLoops, attentionTransportProbe, setAttentionTopicAvailable } from './support/first-live-native-attention.mjs';

test('installed Attention seed uses real owners and yields bounded actionable and suggested cards', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-native-attention-seed-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    for (const topicId of ['fictional-first', 'fictional-peer']) metadata.createTopic({ topicId, name: 'Fictional duplicate', paraCategory: 'area', lifecycle: 'active' });
    const loops = await seedAttentionLoops(metadata, 'fictional-first', 'fictional-peer');
    assert.equal(loops.length, 7); assert.equal(new Set(loops.map(loop => loop.loopId)).size, 7);
    assert.equal(loops[5].state, 'suggested'); assert.equal(loops[6].topicId, 'fictional-peer');
    assert.ok(loops.every(loop => loop.revision === 2 && loop.evidenceObservationIds.length === 1));
    const inbox = metadata.getQuietAttentionInbox();
    assert.equal(inbox.attention.length, 6); assert.equal(inbox.suggested.length, 1);
    assert.equal(metadata.listOpenLoopUserActionReceiptsPage({ limit: 50 }).actions.length, 0);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('transport probe withholds genuine replies without fabricating success and records immutable request inputs', () => {
  const probe = attentionTransportProbe(); let delivered = 0;
  const request = { type: 'req', id: 'fictional-1', method: 'command-center.v1.open-loops.decide', params: { logicalOperationId: 'fictional-operation', expectedRevision: 2, decision: 'confirm' } };
  probe.discardNextDecision(); probe.request(request);
  assert.equal(probe.response({ type: 'res', id: request.id, ok: false }, () => delivered++), true, 'A real failure is never hidden');
  probe.request({ ...request, id: 'fictional-2' });
  assert.equal(probe.response({ type: 'res', id: 'fictional-2', ok: true }, () => delivered++), false);
  assert.equal(delivered, 0); request.params.decision = 'dismiss';
  assert.equal(probe.writes[0].params.decision, 'confirm');
  probe.holdNextDashboard(); probe.request({ type: 'req', id: 'fictional-read', method: 'command-center.v1.dashboard.get', params: { schemaVersion: 1 } });
  assert.equal(probe.response({ type: 'res', id: 'fictional-read', ok: true }, () => delivered++), false);
  assert.equal(probe.hasHeldDashboard(), true); probe.releaseDashboard(); assert.equal(delivered, 1);
  assert.equal(probe.hasHeldDashboard(), false); assert.equal(probe.writes.length, 2);
});


test('installed Attention visibility fixture retires and reactivates a Topic through the real metadata contract', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-native-attention-lifecycle-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    const topicId = 'fictional-lifecycle';
    metadata.createTopic({ topicId, name: 'Fictional private name', paraCategory: 'area', lifecycle: 'active' });
    assert.ok((await projectDashboard({ metadata })).topics.some(topic => topic.topicId === topicId));
    const original = metadata.getTopic(topicId);
    setAttentionTopicAvailable(metadata, topicId, false);
    assert.equal(metadata.getTopic(topicId).lifecycle, 'retired');
    assert.equal(metadata.getTopic(topicId).revision, original.revision + 1);
    assert.equal((await projectDashboard({ metadata })).topics.some(topic => topic.topicId === topicId), false);
    assert.equal(JSON.stringify((await projectDashboard({ metadata })).topics).includes('Fictional private name'), false);
    setAttentionTopicAvailable(metadata, topicId, true);
    assert.equal(metadata.getTopic(topicId).lifecycle, 'active');
    assert.equal(metadata.getTopic(topicId).revision, original.revision + 2);
    assert.ok((await projectDashboard({ metadata })).topics.some(topic => topic.topicId === topicId));
    assert.equal(metadata.listOpenLoopUserActionReceiptsPage({ limit: 50 }).actions.length, 0);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});
