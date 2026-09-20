import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDashboard } from '../src/dashboard/service.mjs';
import { createReminderAdapter } from '../src/sources/reminders.mjs';
import { openLoopReminderReferenceId } from '../src/open-loops/reminder-coordinator.mjs';

test('dashboard partitions current and future Reminder occurrences and pages Activity', async () => {
  const serverTime = '2026-08-27T12:00:00.000Z';
  const topics = [{ topicId: 'topic-one', name: 'Fictional Topic', paraCategory: 'project', lifecycle: 'active' }];
  const activityRecords = Array.from({ length: 51 }, (_, index) => ({ activityId: `activity-${index}`, outcome: 'applied' }));
  const sourceService = {
    async refreshReminderAttention() {},
    async attentionList() {
      return {
        episodes: [
          { episodeId: 'attention-1', sourceCapabilityId: 'monitor', stableSubjectId: 'subject-1', state: 'Active', severity: 'High', topicId: 'topic-one', sourceReferenceId: 'source-attention', actions: [{ actionId: 'one' }, { actionId: 'two' }, { actionId: 'three' }, { actionId: 'four' }] },
          { episodeId: 'attention-2', sourceCapabilityId: 'monitor', stableSubjectId: 'subject-2', state: 'Active', severity: 'High', topicId: 'topic-one', sourceReferenceId: 'source-attention-2', actions: [{ actionId: 'one' }] },
          { episodeId: 'reminder-due', sourceCapabilityId: 'reminders', stableSubjectId: 'reminder-1', state: 'Active', severity: 'Reminder', topicId: 'topic-one', sourceReferenceId: 'source-due', actions: [] },
          { episodeId: 'topic-review', sourceCapabilityId: 'topic-review', stableSubjectId: 'topic-review:global', state: 'Active', severity: 'Routine', actions: [] },
          { episodeId: 'routine', sourceCapabilityId: 'monitor', stableSubjectId: 'routine', state: 'Active', severity: 'Routine', topicId: 'topic-one', sourceReferenceId: 'source-routine' }
        ],
        inProgress: [{ episodeId: 'running', state: 'Action running', severity: 'High', topicId: 'topic-one', actions: [{ actionId: 'ignored' }] }]
      };
    },
    forTopic() { return { reminders: { list: async () => [
      { topicId: 'topic-one', sourceReference: { referenceId: 'source-due', sourceKind: 'reminder_schedule' }, job: { id: 'job-due', enabled: true, schedule: { kind: 'at', at: '2026-08-27T12:00:00.000Z' } } },
      { topicId: 'topic-one', sourceReference: { referenceId: 'source-future', sourceKind: 'reminder_schedule' }, job: { id: 'job-future', enabled: true, schedule: { kind: 'at', at: '2026-08-28T09:00:00.000Z' } } }
    ] } }; },
    async activityList({ offset, limit }) {
      const records = activityRecords.slice(offset, offset + limit);
      const nextOffset = offset + records.length < activityRecords.length ? offset + records.length : null;
      return { records, nextOffset, hasMore: nextOffset !== null };
    }
  };
  const result = await projectDashboard({ sourceService, metadata: { listUsableTopics: () => topics }, now: () => serverTime, activityOffset: 0, activityLimit: 50 });
  assert.equal(result.attention.length, 4);
  assert.equal(result.attention.some((item) => item.episodeId === 'topic-review'), true);
  assert.equal(result.attention.some((item) => item.episodeId === 'reminder-due'), true);
  assert.equal(result.comingUp.length, 1);
  assert.equal(result.comingUp[0].context, 'Fictional Topic');
  assert.equal(result.inProgress.length, 1);
  assert.equal(result.attentionBadgeCount, 4);
  assert.equal(result.attention[0].actions.length <= 3, true);
  assert.equal(result.activity.records.length, 50);
  assert.equal(result.activity.nextOffset, 50);
  const secondPage = await projectDashboard({ sourceService, metadata: { listUsableTopics: () => topics }, now: () => serverTime, activityOffset: result.activity.nextOffset, activityLimit: 50 });
  assert.equal(secondPage.activity.records.length, 1);
  assert.equal(secondPage.activity.hasMore, false);
});

test('Dashboard Coming Up uses native recurring state through the Reminder adapter', async () => {
  const instant = (hour) => Date.parse(`2026-08-27T${hour}:00:00.000Z`);
  const topic = { topicId: 'topic-native-dates', name: 'Fictional Schedule', lifecycle: 'active' };
  const jobs = [
    { id: 'every', schedule: { kind: 'every', everyMs: 60_000 }, state: { nextRunAtMs: instant('13') }, nextRunAtMs: instant('20') },
    { id: 'cron', schedule: { kind: 'cron', expr: '0 0 * * *', tz: 'Australia/Brisbane' }, state: { nextRunAtMs: instant('14') } },
    { id: 'once', schedule: { kind: 'at', at: new Date(instant('15')).toISOString() }, state: { nextRunAtMs: instant('21') } },
    { id: 'missing', schedule: { kind: 'every', everyMs: 60_000 }, state: {}, nextRunAtMs: instant('22') },
    { id: 'past', schedule: { kind: 'every', everyMs: 60_000 }, state: { nextRunAtMs: instant('11') } },
    { id: 'disabled', enabled: false, schedule: { kind: 'cron', expr: '0 0 * * *' }, state: { nextRunAtMs: instant('16') } }
  ].map((job) => ({ enabled: true, configRevision: 'config-native', ...job }));
  const references = jobs.map((job) => ({ referenceId: `reference-${job.id}`, topicId: topic.topicId, sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: job.id, observedRevision: job.configRevision }));
  const reminders = createReminderAdapter({ topicId: topic.topicId,
    metadata: { listSourceReferences: () => references },
    gateway: { request: async (method, params) => {
      assert.equal(method, 'cron.list'); assert.deepEqual(params, { includeDisabled: true });
      return { jobs: [...jobs.toReversed(), jobs[0]] };
    } }
  });
  const result = await projectDashboard({
    metadata: { listUsableTopics: () => [topic] },
    sourceService: { forTopic: () => ({ reminders }) },
    now: () => instant('12'), timeZone: 'UTC'
  });
  assert.deepEqual(result.comingUp.map((item) => item.dueAt), [
    '2026-08-27T13:00:00.000Z', '2026-08-27T14:00:00.000Z', '2026-08-27T15:00:00.000Z'
  ]);
  assert.deepEqual(result.comingUp.map((item) => item.time), ['1:00 PM', '2:00 PM', '3:00 PM']);
  assert.equal(result.attentionBadgeCount, 0);
});

test('Dashboard presents an open-loop obligation once when its owned native Reminder also fires', async () => {
  const now = '2026-09-20T01:00:00.000Z';
  const loop = { schemaVersion: 1, loopId: 'loop-one-obligation', kind: 'payment', stableSubjectId: 'invoice:one', title: 'Pay fictional invoice', topicId: 'topic-one', state: 'confirmed', paymentState: 'unpaid', dueAt: now, attention: { reason: 'due-window', whyNow: 'The accepted payment date is due.', actions: ['Open bill'], activated: true, currentEvidence: true }, evidenceObservationIds: ['evidence-one'], revision: 1 };
  const referenceId = openLoopReminderReferenceId(loop.loopId);
  const sourceService = {
    async attentionList() { return { episodes: [{ episodeId: 'native-reminder-episode', sourceCapabilityId: 'reminders', sourceKind: 'reminder', stableSubjectId: 'native-job', state: 'Active', severity: 'Reminder', topicId: 'topic-one', sourceReferenceId: referenceId, actions: [], evidenceFacts: { reminderDue: true, dueAt: now } }], inProgress: [] }; },
    async listReminderOccurrences() { return [{ topicId: 'topic-one', sourceReference: { referenceId, sourceKind: 'reminder_schedule' }, job: { id: 'native-job', enabled: true, schedule: { kind: 'at', at: now } } }]; }
  };
  const metadata = { listUsableTopics: () => [{ topicId: 'topic-one', name: 'Fictional Topic', lifecycle: 'active' }], listOpenLoops: () => [loop], getQuietAttentionInbox: () => ({ attention: [{ loop, reason: 'due-window', whyNow: loop.attention.whyNow, actions: loop.attention.actions }], inProgress: [], comingUp: [], waiting: [], suggested: [], deferred: [], reconciliation: [], terminal: [] }), projectActiveRenovationStagePrerequisites: () => [] };
  const result = await projectDashboard({ sourceService, metadata, now: () => now });
  assert.equal(result.attention.length, 0, 'the scheduler-owned projection is suppressed');
  assert.equal(result.comingUp.length, 0, 'the scheduler-owned future row is suppressed');
  assert.equal(result.openLoops.attentionTotal, 1);
  assert.equal(result.attentionBadgeCount, 1);
});

test('Dashboard does not hide an enabled Reminder that conflicts with a terminal open loop', async () => {
  const now = '2026-09-20T01:00:00.000Z';
  const loop = { schemaVersion: 1, loopId: 'loop-paid-obligation', kind: 'payment', stableSubjectId: 'invoice:paid', title: 'Paid fictional invoice', topicId: 'topic-one', state: 'resolved', paymentState: 'paid', dueAt: now, attention: { actions: [], activated: false, currentEvidence: true }, evidenceObservationIds: ['evidence-paid'], revision: 2 };
  const referenceId = openLoopReminderReferenceId(loop.loopId);
  const sourceService = { async attentionList() { return { episodes: [{ episodeId: 'conflicting-native-reminder', sourceCapabilityId: 'reminders', sourceKind: 'reminder', stableSubjectId: 'native-paid-job', state: 'Active', severity: 'Reminder', topicId: 'topic-one', sourceReferenceId: referenceId, actions: [], evidenceFacts: { reminderDue: true, dueAt: now } }], inProgress: [] }; }, async listReminderOccurrences() { return []; } };
  const metadata = { listUsableTopics: () => [{ topicId: 'topic-one', name: 'Fictional Topic', lifecycle: 'active' }], listOpenLoops: () => [loop], getQuietAttentionInbox: () => ({ attention: [], inProgress: [], comingUp: [], waiting: [], suggested: [], deferred: [], reconciliation: [], terminal: [{ loop }] }), projectActiveRenovationStagePrerequisites: () => [] };
  const result = await projectDashboard({ sourceService, metadata, now: () => now });
  assert.equal(result.attention.some(item => item.episodeId === 'conflicting-native-reminder'), true);
  assert.equal(result.attentionBadgeCount, 1);
});

test('Dashboard coverage distinguishes maintained receipts from unknown email and Note intake', async () => {
  const metadata = {
    listUsableTopics: () => [], listOpenLoops: () => [], getQuietAttentionInbox: () => ({ attention: [], inProgress: [], comingUp: [], waiting: [], suggested: [], deferred: [], reconciliation: [], terminal: [] }), projectActiveRenovationStagePrerequisites: () => [],
    listOperations: () => [{ operationKind: 'selected-source-intake-root', state: 'applied', resultIdentity: JSON.stringify({ freshness: { status: 'available', lastObservedAt: '2026-09-20T01:00:00.000Z', lastAvailableAt: '2026-09-20T01:00:00.000Z' } }) }]
  };
  const result = await projectDashboard({ metadata, sourceService: {}, now: () => '2026-09-20T02:00:00.000Z' });
  assert.deepEqual(result.intakeCoverage.map(row => [row.sourceKind, row.status]), [['email', 'unknown'], ['note', 'unknown'], ['document', 'receipt-current']]);
  assert.equal(result.intakeCoverage[2].lastSuccessfulAt, '2026-09-20T01:00:00.000Z');
  assert.match(result.intakeCoverage[2].explanation, /does not prove automatic email or Note coverage/u);
});
