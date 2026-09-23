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
  const metadata = { listUsableTopics: () => [{ topicId: 'topic-one', name: 'Fictional Topic', lifecycle: 'active' }], listOpenLoops: () => [loop], getOpenLoopObservation: () => ({ source: { kind: 'email' } }), getQuietAttentionInbox: () => ({ attention: [{ loop, reason: 'due-window', whyNow: loop.attention.whyNow, actions: loop.attention.actions }], inProgress: [], comingUp: [], waiting: [], suggested: [], deferred: [], reconciliation: [], terminal: [] }), projectActiveRenovationStagePrerequisites: () => [] };
  const result = await projectDashboard({ sourceService, metadata, now: () => now });
  assert.equal(result.attention.length, 0, 'the scheduler-owned projection is suppressed');
  assert.equal(result.comingUp.length, 0, 'the scheduler-owned future row is suppressed');
  assert.equal(result.openLoops.attentionTotal, 1);
  assert.equal(result.openLoops.highlighted[0].sourceLabel, 'Email');
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
  assert.deepEqual(result.intakeCoverage.map(row => [row.sourceKind, row.status]), [['email', 'unknown'], ['chat', 'unknown'], ['note', 'unknown'], ['document', 'receipt-current']]);
  assert.equal(result.intakeCoverage[3].lastSuccessfulAt, '2026-09-20T01:00:00.000Z');
  assert.match(result.intakeCoverage[3].explanation, /does not prove automatic email or Note coverage/u);
});

test('Dashboard coverage reports healthy, stale, pending, failed and never-connected producer receipts honestly', async () => {
  const base = { listUsableTopics: () => [], listOpenLoops: () => [], getQuietAttentionInbox: () => ({ attention: [], inProgress: [], comingUp: [], waiting: [], suggested: [], deferred: [], reconciliation: [], terminal: [] }), projectActiveRenovationStagePrerequisites: () => [] };
  const operation = (sourceKind, state, receipt, createdAt) => ({ operationKind: `intake-receipt.${sourceKind}.v1`, state, createdAt, resultIdentity: JSON.stringify({ schemaVersion: 1, sourceKind, runId: `${sourceKind}-run`, checkpoint: 'complete', processedCount: 0, actionableCount: 0, noteCount: 0, ...receipt }) });
  const metadata = { ...base, listOperations: () => [
    operation('email', 'applied', { status: 'healthy-empty', observedAt: '2026-09-20T01:00:00.000Z', lastSuccessfulAt: '2026-09-20T01:00:00.000Z', nextExpectedAt: '2026-09-21T01:00:00.000Z' }, '2026-09-20T01:00:00.000Z'),
    operation('note', 'applied', { status: 'healthy-processed', observedAt: '2026-09-18T01:00:00.000Z', lastSuccessfulAt: '2026-09-18T01:00:00.000Z', nextExpectedAt: '2026-09-19T01:00:00.000Z' }, '2026-09-18T01:00:00.000Z')
  ] };
  let result = await projectDashboard({ metadata, sourceService: {}, now: () => '2026-09-20T02:00:00.000Z' });
  assert.deepEqual(result.intakeCoverage.slice(0, 3).map(row => [row.sourceKind, row.status]), [['email', 'healthy-empty'], ['chat', 'unknown'], ['note', 'stale']]);
  metadata.listOperations = () => [
    operation('email', 'pending', { status: 'pending', observedAt: '2026-09-20T01:00:00.000Z', nextExpectedAt: '2026-09-21T01:00:00.000Z' }, '2026-09-20T01:00:00.000Z'),
    operation('note', 'applied', { status: 'never-connected', observedAt: '2026-09-20T01:00:00.000Z' }, '2026-09-20T01:00:00.000Z')
  ];
  result = await projectDashboard({ metadata, sourceService: {}, now: () => '2026-09-20T02:00:00.000Z' });
  assert.deepEqual(result.intakeCoverage.slice(0, 3).map(row => [row.sourceKind, row.status]), [['email', 'pending'], ['chat', 'unknown'], ['note', 'never-connected']]);
  metadata.listOperations = () => [operation('email', 'not-applied', { status: 'failed', observedAt: '2026-09-20T01:00:00.000Z' }, '2026-09-20T01:00:00.000Z')];
  result = await projectDashboard({ metadata, sourceService: {}, now: () => '2026-09-20T02:00:00.000Z' });
  assert.equal(result.intakeCoverage[0].status, 'failed');
  metadata.listOperations = () => [
    operation('email', 'applied', { status: 'healthy-processed', observedAt: '2026-09-18T01:00:00.000Z', lastSuccessfulAt: '2026-09-18T01:00:00.000Z', nextExpectedAt: '2026-09-19T01:00:00.000Z', scope: { accountBinding: 'fictional-account-a', folders: ['older-folder'], sinceUtc: '2026-09-17T00:00:00.000Z', beforeUtc: '2026-09-18T00:00:00.000Z', maxMessages: 50, batchKind: 'bounded' } }, '2026-09-18T01:00:00.000Z'),
    operation('email', 'not-applied', { status: 'failed', observedAt: '2026-09-20T01:00:00.000Z', scope: { accountBinding: 'fictional-account-a', folders: ['inbox'], sinceUtc: '2026-09-19T00:00:00.000Z', beforeUtc: '2026-09-20T00:00:00.000Z', maxMessages: 50, batchKind: 'bounded' }, enumeration: { scope: 'partial', scannedCount: 50, remainingCount: 4, failedReadCount: 1, scanCapReached: true } }, '2026-09-20T01:00:00.000Z')
  ];
  result = await projectDashboard({ metadata, sourceService: {}, now: () => '2026-09-20T02:00:00.000Z' });
  assert.equal(result.intakeCoverage[0].status, 'failed');
  assert.equal(result.intakeCoverage[0].lastObservedAt, '2026-09-20T01:00:00.000Z');
  assert.equal(result.intakeCoverage[0].lastSuccessfulAt, '2026-09-18T01:00:00.000Z');
  assert.equal(result.intakeCoverage[0].discovery.failedReadCount, 1);
  assert.deepEqual(result.intakeCoverage[0].attemptScope.folders, ['inbox']);
  assert.deepEqual(result.intakeCoverage[0].lastSuccessfulScope.folders, ['older-folder']);
  metadata.listOperations = () => [
    operation('email', 'applied', { status: 'healthy-empty', observedAt: '2026-09-18T01:00:00.000Z', lastSuccessfulAt: '2026-09-18T01:00:00.000Z', scope: { accountBinding: 'fictional-account-b', folders: ['inbox'], sinceUtc: '2026-09-17T00:00:00.000Z', beforeUtc: '2026-09-18T00:00:00.000Z', maxMessages: 50, batchKind: 'bounded' } }, '2026-09-18T01:00:00.000Z'),
    operation('email', 'not-applied', { status: 'failed', observedAt: '2026-09-20T01:00:00.000Z', scope: { accountBinding: 'fictional-account-a', folders: ['inbox'], sinceUtc: '2026-09-19T00:00:00.000Z', beforeUtc: '2026-09-20T00:00:00.000Z', maxMessages: 50, batchKind: 'bounded' } }, '2026-09-20T01:00:00.000Z')
  ];
  result = await projectDashboard({ metadata, sourceService: {}, now: () => '2026-09-20T02:00:00.000Z' });
  assert.equal(result.intakeCoverage[0].lastSuccessfulAt, undefined, 'another bound account cannot supply this account’s success');
});

test('Dashboard distinguishes source accounting from outcome resolution and exposes bounded gaps', async () => {
  const base = { listUsableTopics: () => [], listOpenLoops: () => [], getQuietAttentionInbox: () => ({ attention: [], inProgress: [], comingUp: [], waiting: [], suggested: [], deferred: [], reconciliation: [], terminal: [] }), projectActiveRenovationStagePrerequisites: () => [] };
  const source = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'v7', checkpoint: 'page-2:message-42', observedAt: '2026-09-22T01:00:00.000Z', outcomes: [{ outcomeId: 'pay', kind: 'obligation' }, { outcomeId: 'choose', kind: 'decision' }, { outcomeId: 'reference', kind: 'information' }], enumeration: { scope: 'bounded', scannedCount: 25, remainingCount: 3, failedReadCount: 1, scanCapReached: true, scopeId: 'mailbox-fixture', resumeCursor: 'page-3' } };
  const outcome = (outcomeId, kind, status, extra = {}) => ({ operationKind: 'intake-outcome.email.v1', state: 'applied', resultIdentity: JSON.stringify({ schemaVersion: 1, sourceKind: 'email', sourceExternalId: source.sourceExternalId, sourceVersion: source.sourceVersion, outcomeId, kind, status, summary: `Fictional ${outcomeId}`, recordedAt: '2026-09-22T01:01:00.000Z', ...extra }) });
  const receipt = { operationKind: 'intake-receipt.email.v1', state: 'applied', resultIdentity: JSON.stringify({ schemaVersion: 1, sourceKind: 'email', runId: 'email-run', checkpoint: source.checkpoint, status: 'incomplete', observedAt: '2026-09-22T01:02:00.000Z', nextExpectedAt: '2026-09-23T01:02:00.000Z', processedCount: 1, actionableCount: 2, noteCount: 1, continuation: { scopeId: 'mailbox-fixture', cursor: 'page-3', remainingCount: 3, failedReadCount: 1, scanCapReached: true } }) };
  const metadata = { ...base, listOperations: () => [receipt, { operationKind: 'intake-source.email.v1', state: 'applied', resultIdentity: JSON.stringify(source) }, outcome('pay', 'obligation', 'applied', { loopId: 'loop-pay' }), outcome('choose', 'decision', 'pending-decision', { loopId: 'loop-choose' }), outcome('reference', 'information', 'quiet', { topicId: 'topic-fictional-home', sourceReferenceId: 'note-reference', sourcePath: 'Inbox/reference.md', sourceReferenceVersion: 'note-v1' })], getOpenLoop: id => id === 'loop-choose' ? { loopId: id, state: 'suggested', revision: 1 } : null };
  const result = await projectDashboard({ metadata, sourceService: {}, now: () => '2026-09-22T02:00:00.000Z' });
  const email = result.intakeCoverage[0];
  assert.equal(email.status, 'needs-review');
  assert.deepEqual(email.sourceCounts, { observed: 1, accounted: 1, resolved: 0 });
  assert.deepEqual(email.outcomeCounts, { expected: 3, accounted: 3, pendingDecisions: 1, failed: 0, unresolvedTopics: 0 });
  assert.equal(email.recentSources[0].enumeration.scanCapReached, true);
  assert.equal(email.recentSources[0].enumeration.canResume, true);
  assert.equal(JSON.stringify(email.recentSources).includes(source.sourceExternalId), false);
  assert.equal(JSON.stringify(email.recentSources).includes(source.sourceVersion), false);
  assert.equal(email.recentSources[0].outcomes.find(item => item.kind === 'decision').target.loopId, 'loop-choose');
  assert.equal(email.recentSources[0].outcomes.find(item => item.kind === 'information').target.sourceReferenceId, 'note-reference');
  metadata.getOpenLoop = id => id === 'loop-choose' ? { loopId: id, state: 'confirmed', revision: 2 } : null;
  receipt.resultIdentity = JSON.stringify({ schemaVersion: 1, sourceKind: 'email', runId: 'email-resume', checkpoint: 'complete', status: 'healthy-processed', observedAt: '2026-09-22T01:30:00.000Z', lastSuccessfulAt: '2026-09-22T01:30:00.000Z', nextExpectedAt: '2026-09-23T01:30:00.000Z', processedCount: 1, actionableCount: 0, noteCount: 0 });
  const clarified = await projectDashboard({ metadata, sourceService: {}, now: () => '2026-09-22T02:00:00.000Z' });
  assert.equal(clarified.intakeCoverage[0].status, 'receipt-current');
  assert.equal(clarified.intakeCoverage[0].sourceCounts.resolved, 1);
});
