import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDashboard } from '../src/dashboard/service.mjs';
import { createReminderAdapter } from '../src/sources/reminders.mjs';

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
