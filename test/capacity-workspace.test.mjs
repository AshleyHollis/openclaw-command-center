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

test('rich obligations cannot be silently completed from the board', () => {
  const bill = { ...loop('bill'), kind: 'payment', paymentState: 'unpaid' };
  assert.throws(() => planOrganizationChange(bill, { schemaVersion: 1, action: 'complete', updatedAt: '2026-09-20T09:00:00Z' }), /specific outcome flow/);
});
