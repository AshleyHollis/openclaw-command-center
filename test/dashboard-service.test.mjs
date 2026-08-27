import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDashboard } from '../src/dashboard/service.mjs';

test('dashboard partitions current and future Reminder occurrences and pages Activity', async () => {
  const serverTime = '2026-08-27T12:00:00.000Z';
  const topics = [{ topicId: 'topic-one', name: 'Fictional Topic', paraCategory: 'project', lifecycle: 'active' }];
  const sourceService = {
    async refreshReminderAttention() {},
    async attentionList() {
      return {
        episodes: [
          { episodeId: 'attention-1', sourceCapabilityId: 'monitor', stableSubjectId: 'subject-1', state: 'Active', severity: 'High', topicId: 'topic-one', sourceReferenceId: 'source-attention', actions: [{ actionId: 'one' }, { actionId: 'two' }, { actionId: 'three' }, { actionId: 'four' }] },
          { episodeId: 'reminder-due', sourceCapabilityId: 'reminders', stableSubjectId: 'reminder-1', state: 'Active', severity: 'Reminder', topicId: 'topic-one', sourceReferenceId: 'source-due', actions: [] },
          { episodeId: 'routine', sourceCapabilityId: 'monitor', stableSubjectId: 'routine', state: 'Active', severity: 'Routine', topicId: 'topic-one', sourceReferenceId: 'source-routine' }
        ],
        inProgress: [{ episodeId: 'running', state: 'Action running', severity: 'High', topicId: 'topic-one', actions: [{ actionId: 'ignored' }] }]
      };
    },
    forTopic() { return { reminders: { list: async () => [
      { topicId: 'topic-one', sourceReference: { referenceId: 'source-due', sourceKind: 'reminder_schedule' }, job: { id: 'job-due', enabled: true, schedule: { kind: 'at', at: '2026-08-27T12:00:00.000Z' } } },
      { topicId: 'topic-one', sourceReference: { referenceId: 'source-future', sourceKind: 'reminder_schedule' }, job: { id: 'job-future', enabled: true, schedule: { kind: 'at', at: '2026-08-28T09:00:00.000Z' } } }
    ] } }; },
    async activityList({ offset, limit }) { return { records: Array.from({ length: Math.min(limit, 50) }, (_, index) => ({ activityId: `activity-${offset + index}`, outcome: 'applied' })), nextOffset: offset === 0 ? 50 : null, hasMore: offset === 0 }; }
  };
  const result = await projectDashboard({ sourceService, metadata: { listUsableTopics: () => topics }, now: () => serverTime, activityOffset: 0, activityLimit: 50 });
  assert.equal(result.attention.length, 2);
  assert.equal(result.attention.some((item) => item.episodeId === 'reminder-due'), true);
  assert.equal(result.comingUp.length, 1);
  assert.equal(result.comingUp[0].context, 'Fictional Topic');
  assert.equal(result.inProgress.length, 1);
  assert.equal(result.attentionBadgeCount, 2);
  assert.equal(result.attention[0].actions.length <= 3, true);
  assert.equal(result.activity.records.length, 50);
  assert.equal(result.activity.nextOffset, 50);
});
