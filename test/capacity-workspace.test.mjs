import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCapacityWorkspace, planOrganizationChange } from '../src/open-loops/capacity-workspace.mjs';

const loop = (id, overrides = {}) => ({ schemaVersion: 1, loopId: id, kind: 'general', stableSubjectId: `subject:${id}`, title: id, topicId: overrides.topicId ?? 'topic-home', state: 'confirmed', attention: { actions: ['Plan'], activated: false, currentEvidence: true, importance: 'normal', importanceOrigin: 'processing', contexts: [], dependencies: [], someday: false, ...(overrides.attention ?? {}) }, evidenceObservationIds: [`obs:${id}`], revision: 1, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'attention' && key !== 'topicId')) });

test('Today is uncapped for deadlines while capacity stays quiet and filterable', () => {
  const deadlines = Array.from({ length: 8 }, (_, i) => loop(`due-${i}`, { dueAt: '2026-09-20T10:00:00Z' }));
  const backlog = Array.from({ length: 200 }, (_, i) => loop(`backlog-${String(i).padStart(3, '0')}`, { attention: { importance: i === 199 ? 'high' : 'low', importanceOrigin: 'processing', effortMinutes: i % 2 ? 30 : 90, contexts: ['home'] } }));
  const result = projectCapacityWorkspace([...deadlines, ...backlog], { now: '2026-09-20T08:00:00Z', maxEffortMinutes: 30, context: 'home' });
  assert.equal(result.today.mandatory.length, 8);
  assert.equal(result.capacity.length, 100);
  assert.equal(result.review.batch.length, 5);
  assert.equal(result.review.remaining, 203);
});

test('busy and returning journeys keep every mandatory item in honest, non-overlapping groups', () => {
  const overdue = Array.from({ length: 20 }, (_, i) => loop(`overdue-${i}`, { dueAt: '2026-09-13T10:00:00Z' }));
  const dueToday = Array.from({ length: 3 }, (_, i) => loop(`today-${i}`, { dueAt: '2026-09-20T10:00:00Z', attention: { reason: 'response-requested' } }));
  const decision = loop('undated-decision', { attention: { reason: 'decision-requested', whyNow: 'A choice is required before work can continue.' } });
  const review = loop('accepted-review', { reviewAt: '2026-09-20T08:00:00Z' });
  const backlog = Array.from({ length: 200 }, (_, i) => loop(`optional-${String(i).padStart(3, '0')}`, { attention: { importance: 'low' } }));
  const result = projectCapacityWorkspace([...overdue, ...dueToday, decision, review, ...backlog], { now: '2026-09-20T09:00:00Z' });
  assert.equal(result.today.mandatoryTotal, 25);
  assert.deepEqual(Object.fromEntries(Object.entries(result.today.groups).map(([key, values]) => [key, values.length])), { overdue: 20, dueToday: 3, decisions: 1, reviews: 1 });
  assert.equal(new Set(Object.values(result.today.groups).flat().map(item => item.loopId)).size, 25);
  assert.equal(result.capacity.length, 200);
  assert.equal(result.today.groups.decisions[0].dueAt, undefined, 'an actionable undated request must not gain a fabricated deadline');
});

test('upcoming work is chronological across planned, review and due meanings', () => {
  const result = projectCapacityWorkspace([
    loop('due-later', { dueAt: '2026-09-25T10:00:00Z', attention: { importance: 'critical' } }),
    loop('review-first', { reviewAt: '2026-09-21T10:00:00Z', attention: { importance: 'low' } }),
    loop('planned-middle', { attention: { plannedAt: '2026-09-22T10:00:00Z', importance: 'normal' } })
  ], { now: '2026-09-20T09:00:00Z' });
  assert.deepEqual(result.upcoming.map(item => item.loopId), ['review-first', 'planned-middle', 'due-later']);
});

test('review rotation is deterministic and only decisions mark consideration', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => loop(id));
  const first = projectCapacityWorkspace(items, { now: '2026-09-20T08:00:00Z', reviewLimit: 2 });
  assert.deepEqual(first.review.batch.map(item => item.loopId), ['a', 'b']);
  const reviewed = items.map(item => item.loopId === 'a' ? planOrganizationChange(item, { schemaVersion: 1, action: 'keep', updatedAt: '2026-09-20T09:00:00Z' }) : item);
  const next = projectCapacityWorkspace(reviewed, { now: '2026-09-21T08:00:00Z', reviewLimit: 2 });
  assert.deepEqual(next.review.batch.map(item => item.loopId), ['b', 'c']);
});

test('board, agenda and list retain the same identity and distinct date meanings', () => {
  const item = loop('same-item', { dueAt: '2026-09-23T10:00:00Z', reviewAt: '2026-09-22T10:00:00Z', attention: { plannedAt: '2026-09-21T10:00:00Z' } });
  const result = projectCapacityWorkspace([item], { now: '2026-09-20T08:00:00Z' });
  assert.equal(result.board.ready[0].loopId, 'same-item');
  assert.deepEqual(result.agenda.map(entry => entry.kind), ['planned', 'review', 'deadline']);
  assert.ok(result.agenda.every(entry => entry.loop.loopId === 'same-item'));
});

test('accepted future planning removes an item from capacity until its chosen time', () => {
  const planned = loop('planned-future', { attention: { plannedAt: '2026-09-22T01:00:00Z' } });
  const workspace = projectCapacityWorkspace([planned], { now: '2026-09-20T01:00:00Z' });
  assert.equal(workspace.capacity.length, 0);
  assert.equal(workspace.upcoming[0].loopId, planned.loopId);
  assert.equal(workspace.agenda[0].kind, 'planned');
});

test('an accepted review later today stays quiet until its exact time', () => {
  const later = loop('review-later-today', { reviewAt: '2026-09-20T10:00:00Z' });
  const before = projectCapacityWorkspace([later], { now: '2026-09-20T09:59:59Z' });
  assert.equal(before.today.mandatory.length, 0);
  assert.deepEqual(before.upcoming.map(item => item.loopId), ['review-later-today']);
  const atTime = projectCapacityWorkspace([later], { now: '2026-09-20T10:00:00Z' });
  assert.deepEqual(atTime.today.groups.reviews.map(item => item.loopId), ['review-later-today']);
  assert.equal(atTime.upcoming.length, 0);
});

test('rich obligations cannot be silently completed from the board', () => {
  const bill = { ...loop('bill'), kind: 'payment', paymentState: 'unpaid' };
  assert.throws(() => planOrganizationChange(bill, { schemaVersion: 1, action: 'complete', updatedAt: '2026-09-20T09:00:00Z' }), /specific outcome flow/);
});
