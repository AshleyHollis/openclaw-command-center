import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttentionService } from '../src/attention/service.mjs';
import { createDeveloperWorkService } from '../src/developer-work/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';

const authority = { producerId: 'fictional-dev', role: 'worker', allowedProjects: ['sample-project'] };
const session = { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'fictional-session', lifecycleRevision: 'fictional-lifecycle' };
const instant = '2026-09-26T10:00:00.000Z';
const request = { requestId: 'input-a', kind: 'input', expectedRequestRevision: 0, summary: 'Input required', question: 'Which option?' };
function event(revision, eventType, currentRequest, outcome) {
  return { schemaVersion: 1, eventId: randomUUID(), workId: 'sample-work', workRevision: revision, eventType, occurredAt: instant,
    context: { projectAlias: 'sample-project', phase: 'waiting' }, session,
    request: currentRequest, ...(outcome ? { outcome } : {}) };
}

test('a queued request followed by its resolution produces no push after the announced pass catches up', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-notification-catchup-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { activity: true, attention: true } });
  const attention = createAttentionService({ metadata, now: () => instant });
  const developer = createDeveloperWorkService({ metadata, attention });
  const candidates = [];
  const notification = createNotificationService({ metadata, attentionService: attention, now: () => Date.parse(instant),
    emitter: { async emit(candidate) { candidates.push(candidate); return { status: 'sent' }; }, async clear() { return { status: 'cleared' }; } } });
  const accept = (input, watermark) => developer.accept({ ...authority, event: input, watermark });
  try {
    await accept(event(1, 'human_input_required', request), 2);
    assert.equal(metadata.isDeveloperWorkNotificationReady({ producerId: authority.producerId, workId: 'sample-work' }), false);
    assert.equal(attention.allEpisodes().length, 1);
    await notification.reconcile();
    assert.equal(candidates.length, 0);
    assert.equal(notification.inspect().slots[0].status, 'scheduled');

    await accept(event(2, 'request_resolved', { ...request, expectedRequestRevision: 1 }, { code: 'answered', requestId: request.requestId }), 2);
    assert.equal(metadata.isDeveloperWorkNotificationReady({ producerId: authority.producerId, workId: 'sample-work' }), true);
    assert.equal(attention.allEpisodes()[0].state, 'Resolved');
    await notification.reconcile();
    assert.equal(candidates.length, 0);
    assert.equal(notification.inspect().slots[0].status, 'cancelled');
  } finally {
    notification.close(); developer.close(); attention.close(); metadata.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

for (const quietDrain of [false, true]) test(`expired Developer Work request stays visible but cannot push (quiet drain: ${quietDrain})`, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-notification-expiry-'));
  const initial = quietDrain ? '2026-09-26T23:00:00.000Z' : '2026-09-26T10:00:00.000Z';
  let clock = Date.parse(initial);
  const expiresAt = quietDrain ? '2026-09-26T23:30:00.000Z' : '2026-09-26T09:00:00.000Z';
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { activity: true, attention: true } });
  const attention = createAttentionService({ metadata, now: () => new Date(clock).toISOString() });
  const developer = createDeveloperWorkService({ metadata, attention });
  const candidates = [];
  const notification = createNotificationService({ metadata, attentionService: attention, now: () => clock,
    emitter: { async emit(candidate) { candidates.push(candidate); return { status: 'sent' }; }, async clear() { return { status: 'cleared' }; } } });
  try {
    await developer.accept({ ...authority, event: { ...event(1, 'human_input_required', { ...request, expiresAt }), occurredAt: initial }, watermark: 1 });
    const episode = attention.allEpisodes()[0];
    assert.equal(episode.state, 'Active');
    assert.equal(episode.evidenceFacts.requestExpiresAt, expiresAt);
    await notification.reconcile();
    assert.equal(candidates.length, 0);
    if (quietDrain) {
      assert.equal(notification.inspect().slots[0].status, 'queued');
      clock = Date.parse('2026-09-27T07:00:00.000Z');
      await notification.reconcile();
      assert.equal(candidates.length, 0, 'expired queued requests cannot appear in a quiet summary or a direct push');
      assert.equal(attention.allEpisodes()[0].state, 'Active', 'stale source context remains visible');
    }
  } finally {
    notification.close(); developer.close(); attention.close(); metadata.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
