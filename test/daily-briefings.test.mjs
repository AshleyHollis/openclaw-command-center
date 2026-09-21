import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createDailyWorkspaceService } from '../src/daily-workspace/service.mjs';
import { briefingPublishToolFactory } from '../src/daily-workspace/briefing-tool.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';

function memoryMetadata() {
  const rows = new Map();
  return {
    recordOperation(row) { const prior = rows.get(row.logicalOperationId); if (prior && prior.intentDigest !== row.intentDigest) throw new Error('intent mismatch'); const value = { ...prior, ...row }; rows.set(row.logicalOperationId, value); return value; },
    getOperation(id) { return rows.get(id) ?? null; },
    listOperations() { return [...rows.values()]; },
    commitDailyWorkspaceOperation(input) {
      const prior = rows.get(input.logicalOperationId); if (prior) { if (prior.intentDigest !== input.intentDigest || prior.operationKind !== input.operationKind) throw new Error('intent mismatch'); return prior; }
      const values = [...rows.values()].filter(row => row.operationKind === input.operationKind).map(row => JSON.parse(row.resultIdentity)); let result = structuredClone(input.result);
      if (input.operationKind.endsWith('briefing.publish')) { const bound = values.find(item => item.editionId === input.entityId); if (bound && JSON.stringify(bound) !== JSON.stringify(result)) throw new Error('different content'); result = bound ?? result; }
      if (input.operationKind.endsWith('briefing.read')) result.sequence = values.filter(item => item.editionId === input.entityId).reduce((n, item) => Math.max(n, item.sequence ?? 0), 0) + 1;
      if (input.operationKind.endsWith('routine.decision')) { const matches = values.filter(item => `${item.routineId}:${item.occurrenceDate}` === input.entityId); const revision = matches.reduce((n, item) => Math.max(n, item.revision ?? 0), 0); if (revision !== input.expectedRevision) throw new Error('stale'); const latest = matches.find(item => item.revision === revision); if (latest?.action === 'complete' || latest?.action === 'defer' && Date.parse(latest.until) > Date.parse(result.decidedAt)) throw new Error('not visible'); result.revision = revision + 1; }
      const row = { ...input, transportRequestId: input.logicalOperationId, state: 'applied', resultIdentity: JSON.stringify(result), createdAt: input.createdAt, updatedAt: input.createdAt }; rows.set(input.logicalOperationId, row); return row;
    }
  };
}

test('scheduled briefing publication resolves its exact native session from the host catalog', async () => {
  const published = [];
  const factory = briefingPublishToolFactory({
    getOwner: () => ({ publishBriefing(input) { published.push(input); return input; } }),
    resolveSessionKey: async context => context.sessionId === 'session-id-1' ? 'agent:main:dashboard:briefing' : undefined
  });
  const tool = factory({ sessionId: 'session-id-1', agentId: 'main' });
  const result = await tool.execute('tool-call-1', { briefingId: 'morning', editionId: 'morning:2026-09-21', title: 'Morning briefing', publishedAt: '2026-09-21T20:30:00.000Z', priority: 100, summary: 'The report is ready.' });
  assert.equal(published[0].source.sessionKey, 'agent:main:dashboard:briefing');
  assert.match(result.content[0].text, /"status":"saved"/u);
});

test('scheduled briefing publication fails closed when the native session is ambiguous', async () => {
  const tool = briefingPublishToolFactory({
    getOwner: () => ({ publishBriefing() { throw new Error('must not publish'); } }),
    resolveSessionKey: async () => undefined
  })({ sessionId: 'missing-session' });
  await assert.rejects(() => tool.execute('tool-call-2', { briefingId: 'morning', editionId: 'morning:2026-09-21', title: 'Morning briefing', publishedAt: '2026-09-21T20:30:00.000Z', priority: 100, summary: 'The report is ready.' }), /active native report session/i);
});

test('new briefing editions are unread, can be read and undone without changing the report', () => {
  const metadata = memoryMetadata();
  const service = createDailyWorkspaceService({ metadata, now: () => '2026-09-21T21:00:00.000Z' });
  service.publishBriefing({ schemaVersion: 1, logicalOperationId: 'publish-1', briefingId: 'morning', editionId: 'morning:2026-09-22', title: 'Morning briefing', publishedAt: '2026-09-21T20:30:00.000Z', priority: 100, summary: 'Bins tonight and the day ahead.', source: { kind: 'session', sessionKey: 'agent:main:cron:morning:run:fictional' } });
  assert.deepEqual(service.get().briefings.map(({ editionId, read }) => ({ editionId, read })), [{ editionId: 'morning:2026-09-22', read: false }]);
  service.setBriefingRead({ schemaVersion: 1, logicalOperationId: 'read-1', editionId: 'morning:2026-09-22', read: true });
  assert.equal(service.setBriefingRead({ schemaVersion: 1, logicalOperationId: 'read-1', editionId: 'morning:2026-09-22', read: true }).sequence, 1);
  assert.equal(service.get().briefings.length, 0);
  assert.equal(service.get({ includeRead: true }).briefings[0].read, true);
  service.setBriefingRead({ schemaVersion: 1, logicalOperationId: 'undo-1', editionId: 'morning:2026-09-22', read: false });
  assert.equal(service.get().briefings[0].summary, 'Bins tonight and the day ahead.');
});

test('one briefing edition cannot be replaced by a different publication', () => {
  const service = createDailyWorkspaceService({ metadata: memoryMetadata(), now: () => '2026-09-21T21:00:00.000Z' });
  const first = { schemaVersion: 1, logicalOperationId: 'publish-original', briefingId: 'morning', editionId: 'morning:fixed', title: 'Morning briefing', publishedAt: '2026-09-21T20:30:00.000Z', priority: 100, summary: 'Original report.', source: { kind: 'session', sessionKey: 'agent:main:cron:morning:run:original' } };
  assert.equal(service.publishBriefing(first).summary, 'Original report.');
  assert.equal(service.publishBriefing(first).summary, 'Original report.');
  assert.throws(() => service.publishBriefing({ ...first, logicalOperationId: 'publish-replacement', summary: 'Replacement report.' }), /different content/i);
  assert.equal(service.get().briefings[0].summary, 'Original report.');
});

test('public bridge preserves briefing and routine decision receipts', async () => {
  const briefing = await invokeBridgeMethod({ briefingSetRead: input => ({ schemaVersion: 1, editionId: input.editionId, read: input.read, sequence: 2, decidedAt: '2026-09-21T21:00:00.000Z' }) }, 'command-center.v1.briefings.set-read', { schemaVersion: 1, logicalOperationId: '11111111-1111-4111-8111-111111111111', editionId: 'morning:fixed', read: false });
  assert.deepEqual(briefing, { schemaVersion: 1, editionId: 'morning:fixed', read: false, sequence: 2, decidedAt: '2026-09-21T21:00:00.000Z' });
  const routine = await invokeBridgeMethod({ routineDecide: input => ({ schemaVersion: 1, routineId: input.routineId, occurrenceDate: input.occurrenceDate, action: input.action, revision: 1, decidedAt: '2026-09-21T21:00:00.000Z' }) }, 'command-center.v1.routines.decide', { schemaVersion: 1, logicalOperationId: '22222222-2222-4222-8222-222222222222', routineId: 'bins', occurrenceDate: '2026-09-22', expectedRevision: 0, action: 'complete' });
  assert.deepEqual(routine, { schemaVersion: 1, routineId: 'bins', occurrenceDate: '2026-09-22', action: 'complete', revision: 1, decidedAt: '2026-09-21T21:00:00.000Z' });
});

test('briefing reading list sorts unread editions by priority then recency', () => {
  const service = createDailyWorkspaceService({ metadata: memoryMetadata(), now: () => '2026-09-21T21:00:00.000Z' });
  for (const row of [
    ['weekly-ai', 'weekly-ai:2026-09-21', 'Weekly AI digest', 20, '2026-09-21T20:45:00.000Z'],
    ['morning', 'morning:2026-09-22', 'Morning briefing', 100, '2026-09-21T20:30:00.000Z']
  ]) service.publishBriefing({ schemaVersion: 1, logicalOperationId: `publish-${row[0]}`, briefingId: row[0], editionId: row[1], title: row[2], priority: row[3], publishedAt: row[4], summary: 'Fictional summary.', source: { kind: 'session', sessionKey: `agent:main:cron:${row[0]}:run:fictional` } });
  assert.deepEqual(service.get().briefings.map(item => item.briefingId), ['morning', 'weekly-ai']);
});

test('completing or deferring one routine occurrence leaves its next recurrence available', () => {
  const service = createDailyWorkspaceService({
    metadata: memoryMetadata(),
    now: () => '2026-09-21T12:00:00.000Z',
    routines: [{ id: 'bins', title: 'Take the bins out', variants: ['rubbish and grass', 'rubbish and recycling'], topicId: 'topic-home', sourceReferenceId: 'routine-bins', timeZone: 'Australia/Brisbane', weekday: 2, localTime: '18:00', preparationHours: 24, intervalWeeks: 1, anchorDate: '2026-04-28', priority: 100 }]
  });
  const first = service.get().routineOccurrences[0];
  assert.equal(first.occurrenceDate, '2026-09-22');
  assert.equal(first.title, 'Take the bins out: rubbish and recycling');
  assert.throws(() => service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'wrong-date', routineId: 'bins', occurrenceDate: '2026-09-23', expectedRevision: 0, action: 'complete' }), /exact visible/i);
  service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'complete-1', routineId: 'bins', occurrenceDate: first.occurrenceDate, expectedRevision: 0, action: 'complete' });
  assert.equal(service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'complete-1', routineId: 'bins', occurrenceDate: first.occurrenceDate, expectedRevision: 0, action: 'complete' }).revision, 1);
  assert.throws(() => service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'mutate-complete', routineId: 'bins', occurrenceDate: first.occurrenceDate, expectedRevision: 1, action: 'defer', until: '2026-09-22T07:00:00.000Z' }), /terminal|visible/i);
  assert.equal(service.get().routineOccurrences.length, 0);
  const nextWeek = createDailyWorkspaceService({ metadata: service.metadata, now: () => '2026-09-28T12:00:00.000Z', routines: service.routines });
  assert.equal(nextWeek.decideRoutine({ schemaVersion: 1, logicalOperationId: 'complete-1', routineId: 'bins', occurrenceDate: first.occurrenceDate, expectedRevision: 0, action: 'complete' }).revision, 1);
  assert.equal(nextWeek.get().routineOccurrences[0].occurrenceDate, '2026-09-29');
  nextWeek.decideRoutine({ schemaVersion: 1, logicalOperationId: 'defer-2', routineId: 'bins', occurrenceDate: '2026-09-29', expectedRevision: 0, action: 'defer', until: '2026-09-29T08:00:00.000Z' });
  assert.throws(() => nextWeek.decideRoutine({ schemaVersion: 1, logicalOperationId: 'mutate-defer', routineId: 'bins', occurrenceDate: '2026-09-29', expectedRevision: 1, action: 'complete' }), /deferral|visible/i);
  assert.equal(nextWeek.get().routineOccurrences.length, 0);
});

test('briefing and occurrence decisions survive a real SQLite owner restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-daily-'));
  const capabilities = { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true };
  try {
    let metadata = openCommandCenterMetadataService({ stateDir: root, capabilities });
    const routines = [{ id: 'bins', title: 'Take the bins out', topicId: 'topic-home', sourceReferenceId: 'routine-bins', timeZone: 'Australia/Brisbane', weekday: 2, localTime: '18:00', preparationHours: 24, intervalWeeks: 1, anchorDate: '2026-04-28' }, { id: 'garden', title: 'Garden check', topicId: 'topic-home', sourceReferenceId: 'routine-garden', timeZone: 'Australia/Brisbane', weekday: 2, localTime: '18:00', preparationHours: 24, intervalWeeks: 1, anchorDate: '2026-04-28' }];
    let service = createDailyWorkspaceService({ metadata, routines, now: () => '2026-09-21T21:00:00.000Z' });
    service.publishBriefing({ schemaVersion: 1, logicalOperationId: 'publish-restart', briefingId: 'morning', editionId: 'morning:restart', title: 'Morning briefing', publishedAt: '2026-09-21T20:30:00.000Z', priority: 100, summary: 'Durable fictional report.', source: { kind: 'session', sessionKey: 'agent:main:cron:morning:run:restart' } });
    service.setBriefingRead({ schemaVersion: 1, logicalOperationId: 'read-restart', editionId: 'morning:restart', read: true });
    service.setBriefingRead({ schemaVersion: 1, logicalOperationId: 'undo-restart', editionId: 'morning:restart', read: false });
    service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'complete-restart', routineId: 'bins', occurrenceDate: '2026-09-22', expectedRevision: 0, action: 'complete' });
    service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'defer-restart', routineId: 'garden', occurrenceDate: '2026-09-22', expectedRevision: 0, action: 'defer', until: '2026-09-22T07:00:00.000Z' });
    const competingMetadata = openCommandCenterMetadataService({ stateDir: root, capabilities });
    const competing = createDailyWorkspaceService({ metadata: competingMetadata, routines, now: () => '2026-09-21T21:00:00.000Z' });
    assert.throws(() => competing.decideRoutine({ schemaVersion: 1, logicalOperationId: 'competing-complete', routineId: 'bins', occurrenceDate: '2026-09-22', expectedRevision: 0, action: 'complete' }), /stale|conflict/i);
    competingMetadata.close();
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir: root, capabilities }); service = createDailyWorkspaceService({ metadata, routines, now: () => '2026-09-21T21:05:00.000Z' });
    assert.equal(service.get({ includeRead: true }).briefings[0].read, false);
    assert.equal(service.setBriefingRead({ schemaVersion: 1, logicalOperationId: 'read-restart', editionId: 'morning:restart', read: true }).sequence, 1);
    assert.equal(service.setBriefingRead({ schemaVersion: 1, logicalOperationId: 'undo-restart', editionId: 'morning:restart', read: false }).sequence, 2);
    assert.equal(service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'complete-restart', routineId: 'bins', occurrenceDate: '2026-09-22', expectedRevision: 0, action: 'complete' }).revision, 1);
    assert.equal(service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'defer-restart', routineId: 'garden', occurrenceDate: '2026-09-22', expectedRevision: 0, action: 'defer', until: '2026-09-22T07:00:00.000Z' }).revision, 1);
    assert.throws(() => service.setBriefingRead({ schemaVersion: 1, logicalOperationId: 'read-restart', editionId: 'morning:restart', read: false }), /intent/i);
    assert.throws(() => service.publishBriefing({ schemaVersion: 1, logicalOperationId: 'publish-replacement-restart', briefingId: 'morning', editionId: 'morning:restart', title: 'Morning briefing', publishedAt: '2026-09-21T20:30:00.000Z', priority: 100, summary: 'Changed after restart.', source: { kind: 'session', sessionKey: 'agent:main:cron:morning:run:restart' } }), /different content/i);
    assert.throws(() => service.decideRoutine({ schemaVersion: 1, logicalOperationId: 'mutate-complete-restart', routineId: 'bins', occurrenceDate: '2026-09-22', expectedRevision: 1, action: 'defer', until: '2026-09-22T07:00:00.000Z' }), /terminal/i);
    const future = createDailyWorkspaceService({ metadata, routines, now: () => '2026-09-29T21:05:00.000Z' });
    assert.equal(future.decideRoutine({ schemaVersion: 1, logicalOperationId: 'complete-restart', routineId: 'bins', occurrenceDate: '2026-09-22', expectedRevision: 0, action: 'complete' }).revision, 1);
    metadata.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
