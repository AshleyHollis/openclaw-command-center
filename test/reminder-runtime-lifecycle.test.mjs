import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAttentionService } from '../src/attention/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';

const now = '2026-09-05T10:01:00.000Z';
const dueAt = '2026-09-05T10:00:00.000Z';
const deliveredState = { lastRunAtMs: Date.parse(dueAt) + 1000, lastRunStatus: 'ok', lastStatus: 'ok' };

async function withReminder(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-reminder-lifecycle-'));
  const capabilities = { notes: true, sessions: true, scheduler: true, attention: true, activity: true };
  let metadata, attention, source;
  let clockMs = Date.parse(now);
  const clock = () => new Date(clockMs).toISOString();
  const row = {
    sourceReference: { version: 1, referenceId: 'fictional-reminder-reference', topicId: 'fictional-topic', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: 'fictional-job', observedRevision: 'revision-1' },
    job: { id: 'fictional-job', configRevision: 'revision-1', enabled: true, schedule: { kind: 'at', at: dueAt }, state: {} }
  };
  const open = () => {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    attention = createAttentionService({ metadata, now: clock, host: 'fictional-host', operatorId: 'fictional-operator', sourceActions: {
      complete: async () => { row.job.enabled = false; row.job.configRevision = 'revision-completed'; return { observedRevision: row.job.configRevision }; },
      verify: async () => { clockMs += 1000; await source.ingestReminderRows(row.sourceReference.topicId, [row]); return row.job.enabled === false; }
    } });
    attention.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', monitoring: true, actions: [], deriveEvidence: (value) => value.evidenceFacts, verifyTransition: (value) => value.transitionEvidence?.verifiedSource === 'scheduler-readback' && value.transitionEvidence.version === value.occurrenceVersion });
    source = createAuthoritativeSourceService({ metadata, attentionService: attention, capabilities, now: clock });
  };
  open();
  metadata.createTopic({ topicId: row.sourceReference.topicId, paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference(row.sourceReference);
  const fixture = {
    row,
    refresh: () => { clockMs += 1000; return source.ingestReminderRows(row.sourceReference.topicId, [row]); },
    episodes: () => attention.list().episodes,
    all: () => attention.allEpisodes(),
    restart: () => { attention.close(); metadata.close(); open(); },
    complete: async () => {
      const episode = attention.list().episodes[0];
      return attention.act({ schemaVersion: 1, logicalOperationId: randomUUID(), episodeId: episode.episodeId, expectedEpisodeRevision: episode.revision, expectedSourceRevision: row.job.configRevision, topicId: episode.topicId, sourceReferenceId: episode.sourceReferenceId, actionId: 'reminder.complete', input: { expectedConfigRevision: row.job.configRevision } });
    }
  };
  try { await run(fixture); }
  finally { attention.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('native delivered one-shot remains the same actionable Reminder across refresh and restart', async () => {
  await withReminder(async (fixture) => {
    await fixture.refresh();
    const episodeId = fixture.episodes()[0].episodeId;
    fixture.row.job.enabled = false;
    fixture.row.job.state = deliveredState;
    for (let index = 0; index < 3; index += 1) await fixture.refresh();
    assert.equal(fixture.episodes().length, 1, 'delivery is not user acknowledgement');
    assert.equal(fixture.episodes()[0].episodeId, episodeId);
    fixture.restart();
    await fixture.refresh();
    assert.equal(fixture.episodes()[0]?.episodeId, episodeId);
  });
});

test('first observation after successful native delivery creates actionable Attention', async () => {
  await withReminder(async (fixture) => {
    fixture.row.job.enabled = false;
    fixture.row.job.state = deliveredState;
    await fixture.refresh();
    assert.equal(fixture.episodes().length, 1);
    assert.equal(fixture.episodes()[0].state, 'Active');
  });
});

test('explicit Complete after delivery stays resolved across verification, refresh and restart', async () => {
  await withReminder(async (fixture) => {
    await fixture.refresh();
    fixture.row.job.enabled = false;
    fixture.row.job.state = deliveredState;
    const result = await fixture.complete();
    assert.equal(result.status, 'applied');
    for (let index = 0; index < 3; index += 1) await fixture.refresh();
    fixture.restart();
    await fixture.refresh();
    assert.equal(fixture.episodes().length, 0);
    assert.equal(fixture.all().length, 1);
    assert.equal(fixture.all()[0].state, 'Resolved');
  });
});

test('disabled schedules without a successful matching execution do not create delivered Attention', async () => {
  for (const state of [{}, { ...deliveredState, lastRunStatus: 'error' }, { ...deliveredState, lastRunAtMs: Date.parse(dueAt) - 1 }, { ...deliveredState, lastRunAtMs: Date.parse(now) + 60_000 }]) {
    await withReminder(async (fixture) => {
      await fixture.refresh();
      fixture.row.job.enabled = false;
      fixture.row.job.state = state;
      fixture.row.job.configRevision = 'revision-disabled';
      await fixture.refresh();
      assert.equal(fixture.episodes().length, 0);
    });
  }
});

test('a newly enabled due schedule still opens a new generation after explicit Complete', async () => {
  await withReminder(async (fixture) => {
    await fixture.refresh();
    await fixture.complete();
    fixture.row.job.enabled = true;
    fixture.row.job.configRevision = 'revision-reenabled';
    await fixture.refresh();
    assert.equal(fixture.episodes().length, 1);
    assert.equal(fixture.all().length, 2);
  });
});
