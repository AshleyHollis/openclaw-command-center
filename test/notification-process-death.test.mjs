import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';
import { fictionalEpisodes, openFictionalProvider, RELEASE_MS } from './fixtures/notification-process-death-provider.mjs';

async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}

test('a killed CC quiet-summary sender replays one durable fictional delivery by its original operation', { timeout: 25_000 }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-notification-process-death-'));
  const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/notification-process-death-child.mjs', import.meta.url)), stateDir],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let childClosed = false;
  const closed = new Promise(resolve => child.once('close', (code, signal) => { childClosed = true; resolve({ code, signal }); }));
  let stderr = '';
  child.stderr.on('data', part => { stderr = (stderr + part).slice(0, 2000); });
  let metadata; let service; let provider;
  try {
    const boundary = await bounded(new Promise((resolve, reject) => {
      function cleanup() { child.off('message', onMessage); child.off('error', onError); child.off('exit', onExit); }
      function onMessage(message) { cleanup(); resolve(message); }
      function onError(error) { cleanup(); reject(error); }
      function onExit(code, signal) { cleanup(); reject(new Error('Child exited before provider boundary (' + code + '/' + signal + '): ' + stderr)); }
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    }), 10_000, 'Fictional provider boundary timed out: ' + stderr);
    assert.equal(boundary.phase, 'provider-committed');
    assert.equal(boundary.gcForced, true);
    assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await bounded(closed, 5_000, 'Killed notification child did not exit.'), { code: null, signal: 'SIGKILL' });

    provider = openFictionalProvider(stateDir);
    const delivered = provider.delivered();
    assert.equal(delivered.length, 1, 'fictional provider effect must survive SIGKILL');
    assert.equal(delivered[0].logical_operation_id, boundary.logicalOperationId);
    assert.equal(delivered[0].emission_id, boundary.emissionId);
    assert.equal(delivered[0].cleared, 0);

    metadata = openCommandCenterMetadataService({ stateDir });
    const episodes = fictionalEpisodes();
    const attention = { allEpisodes: () => episodes, list: () => ({}) };
    let replayCalls = 0;
    const clears = [];
    const emitter = {
      async emit(candidate) {
        replayCalls++;
        assert.equal(candidate.logicalOperationId, boundary.logicalOperationId);
        assert.equal(candidate.emissionId, boundary.emissionId);
        assert.equal(provider.record(candidate), 'replay', 'same intent must not cause a second fictional delivery');
        return { status: 'sent' }; // a separately durable fictional host receipt, not an inferred CC send
      },
      async clear(request) { clears.push(request.logicalOperationId); return provider.clear(request.logicalOperationId); }
    };
    service = createNotificationService({ metadata, attentionService: attention, emitter, now: () => RELEASE_MS });
    const before = service.inspect();
    assert.equal(before.emissions.length, 1);
    assert.equal(before.emissions[0].status, 'ambiguous', 'CC cannot claim sent before the host replay response');
    const prepared = before.slots.filter(slot => slot.emission_id === boundary.emissionId);
    assert.equal(prepared.length, 2);
    assert.equal(new Set(prepared.map(slot => slot.episode_id)).size, 2);
    assert.equal(prepared.every(slot => slot.status === 'queued' && slot.logical_operation_id === boundary.logicalOperationId), true);

    await service.reconcile();
    assert.equal(replayCalls, 1);
    assert.equal(provider.delivered().length, 1);
    assert.equal(service.inspect().emissions[0].status, 'sent');
    const cohortIds = new Set(prepared.map(slot => slot.slot_id));
    assert.equal(service.inspect().slots.filter(slot => cohortIds.has(slot.slot_id)).every(slot => slot.status === 'emitted' && slot.logical_operation_id === boundary.logicalOperationId), true);
    await service.reconcile();
    assert.equal(replayCalls, 1, 'settled slots must not re-enter the host');

    episodes.find(episode => episode.episodeId === 'episode-a').state = 'Action running';
    await service.reconcile();
    assert.deepEqual(clears, [boundary.logicalOperationId]);
    assert.equal(provider.delivered()[0].cleared, 1);
    assert.equal(service.inspect().clears[0].status, 'cleared');
  } finally {
    service?.close();
    metadata?.close();
    provider?.close();
    if (!childClosed) {
      child.kill('SIGKILL');
      await bounded(closed, 5_000, 'Notification child could not be stopped for cleanup.');
    }
    if (path.dirname(stateDir) !== os.tmpdir() || !path.basename(stateDir).startsWith('cc-notification-process-death-')) throw new Error('Refusing unsafe test cleanup path.');
    await rm(stateDir, { recursive: true, force: true });
  }
});
