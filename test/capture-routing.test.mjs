import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationTestSink, routeCapturedChange } from '../src/notifications/capture-routing.mjs';

test('routine knowledge stays in Notes/activity and ordinary obligations stay in Attention', () => {
  assert.equal(routeCapturedChange({ schemaVersion: 1, subjectId: 'newsletter-1', kind: 'email', change: 'created', materialFacts: { topic: 'home' } }).lane, 'notes-activity');
  const task = routeCapturedChange({ schemaVersion: 1, subjectId: 'task-1', kind: 'chat', change: 'created', materialFacts: { title: 'Research storage' }, requiresAction: true });
  assert.equal(task.lane, 'attention'); assert.equal(task.outwardEligible, false);
});

test('test sink emits one urgent material change and ignores formatting-only replay', () => {
  const sink = createNotificationTestSink();
  const first = sink.capture({ schemaVersion: 1, subjectId: 'bill-1', kind: 'email', change: 'created', materialFacts: { amount: 12000, dueAt: '2026-09-21T00:00:00Z' }, requiresAction: true, urgent: true });
  const formatted = sink.capture({ schemaVersion: 1, subjectId: 'bill-1', kind: 'email', change: 'formatted', materialFacts: { dueAt: '2026-09-21T00:00:00Z', amount: 12000 }, requiresAction: true, urgent: true });
  assert.equal(first.emitted, true); assert.equal(formatted.emitted, false); assert.equal(sink.list().length, 1);
});

test('processing outages remain visible and terminal decisions do not re-interrupt', () => {
  const sink = createNotificationTestSink();
  assert.equal(sink.capture({ schemaVersion: 1, subjectId: 'outlook-intake', kind: 'email', change: 'failed', materialFacts: { checkpoint: 'cursor-4' }, processingFailure: true }).emitted, true);
  const completed = sink.capture({ schemaVersion: 1, subjectId: 'bill-1', kind: 'email', change: 'completed', materialFacts: { status: 'paid' }, requiresAction: true, urgent: true, completed: true });
  assert.equal(completed.lane, 'activity'); assert.equal(completed.emitted, false);
});
