import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';

async function fixture(run, initialTime = '2026-08-27T12:00:00.000Z') {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-notification-lifecycle-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  let clock = Date.parse(initialTime);
  const episode = { episodeId: 'episode-lifecycle', sourceCapabilityId: 'monitor', sourceKind: 'operational', state: 'Active', severity: 'High', attentionSince: new Date(clock).toISOString(), evidenceFacts: {} };
  const episodes = [episode];
  const attention = { allEpisodes: () => episodes, list: () => ({}) };
  const candidates = []; const clears = [];
  const devices = new Map([['device-a', new Set()], ['device-b', new Set()]]);
  const binding = {
    async emit(candidate) { candidates.push(candidate); for (const notifications of devices.values()) notifications.add(candidate.logicalOperationId); return { status: 'sent' }; },
    async clear(input) { clears.push(input); for (const notifications of devices.values()) notifications.delete(input.logicalOperationId); return { status: 'cleared', attempted: devices.size, cleared: devices.size, failed: 0, ambiguous: 0 }; }
  };
  const service = createNotificationService({ metadata, attentionService: attention, emitter: binding, now: () => clock });
  try { return await run({ metadata, service, episode, episodes, candidates, clears, devices, advance(ms) { clock += ms; } }); }
  finally { service.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('notification lifecycle emits High activation and one active-hour repeat, then clears both devices by exact candidate identity', async () => {
  await fixture(async ({ service, episode, candidates, clears, devices, advance }) => {
    await service.reconcile();
    await service.reconcile();
    assert.equal(candidates.length, 1);
    advance(4 * 60 * 60 * 1000);
    await service.reconcile();
    assert.equal(candidates.length, 2);
    await service.reconcile();
    assert.equal(candidates.length, 2);
    assert.equal(devices.size, 2);
    for (const notifications of devices.values()) assert.deepEqual([...notifications], candidates.map((candidate) => candidate.logicalOperationId));
    episode.state = 'Action running';
    await service.reconcile();
    assert.equal(clears.length, 2);
    assert.deepEqual(clears.map((request) => request.logicalOperationId).sort(), candidates.map((candidate) => candidate.logicalOperationId).sort());
    assert.equal([...devices.values()].every((notifications) => notifications.size === 0), true);
    assert.equal(service.inspect().clears.every((operation) => operation.logical_operation_id.startsWith('clear-') && operation.status === 'cleared'), true);
    assert.equal(service.inspect().slots.every((slot) => slot.status === 'cancelled' || slot.status === 'emitted'), true);
  });
});

test('Critical policy never exceeds immediate plus three repeats and uses distinct emission identities', async () => {
  await fixture(async ({ service, episode, candidates, advance }) => {
    episode.severity = 'Critical';
    await service.reconcile();
    for (const minutes of [15, 120, 120]) { advance(minutes * 60 * 1000); await service.reconcile(); }
    advance(2 * 60 * 60 * 1000);
    await service.reconcile();
    assert.equal(candidates.length, 4);
    assert.equal(new Set(candidates.map((candidate) => candidate.emissionId)).size, 4);
  });
});

test('quiet High slots collapse into one deterministic summary', async () => {
  await fixture(async ({ service, episode, episodes, candidates, clears, advance }) => {
    const second = { ...episode, episodeId: 'episode-lifecycle-second' };
    episodes.push(second);
    await service.reconcile();
    assert.equal(candidates.length, 0);
    advance(9 * 60 * 60 * 1000);
    await service.reconcile();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].preview.body, '2 items need review.');
    assert.equal(service.inspect().slots.filter((slot) => slot.status === 'emitted').length, 4);
    await service.reconcile();
    assert.equal(candidates.length, 1);
    episode.state = 'Action running';
    await service.reconcile();
    assert.deepEqual(clears.map((item) => item.logicalOperationId), [candidates[0].logicalOperationId]);
  }, '2026-08-27T22:00:00.000Z');
});

test('notification settings suppress delivery without rewriting fixed policy slots', async () => {
  await fixture(async ({ service, episode, candidates, advance }) => {
    await service.reconcile();
    assert.equal(candidates.length, 1);
    const changed = service.updateSettings({ schemaVersion: 1, logicalOperationId: '84444444-4444-4444-8444-444444444444', expectedRevision: 1, settings: { importantItems: false } });
    assert.equal(changed.revision, 2);
    advance(4 * 60 * 60 * 1000);
    await service.reconcile();
    assert.equal(candidates.length, 1);
    assert.equal(service.inspect().slots.find((slot) => slot.slot_kind === 'high-repeat').status, 'scheduled');
    service.updateSettings({ schemaVersion: 1, logicalOperationId: '85555555-5555-4555-8555-555555555555', expectedRevision: 2, settings: { importantItems: true } });
    await service.reconcile();
    assert.equal(candidates.length, 2);
  });
});

test('snoozing cancels repeat slots and excludes snoozed time from High active hours', async () => {
  await fixture(async ({ service, episode, candidates, clears, advance }) => {
    await service.reconcile();
    assert.equal(candidates.length, 1);
    advance(60 * 60 * 1000);
    episode.state = 'Snoozed';
    episode.snoozedUntil = '2026-08-27T14:00:00.000Z';
    episode.updatedAt = '2026-08-27T13:00:00.000Z';
    await service.reconcile();
    assert.equal(clears.length, 1);
    advance(60 * 60 * 1000);
    episode.state = 'Active';
    episode.snoozedUntil = null;
    episode.updatedAt = '2026-08-27T14:00:00.000Z';
    await service.reconcile();
    assert.equal(candidates.length, 2);
    assert.match(candidates.at(-1).preview.title, /High/i);
    advance(3 * 60 * 60 * 1000);
    await service.reconcile();
    assert.equal(candidates.length, 3);
  });
});
