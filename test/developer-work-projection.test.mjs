import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttentionService } from '../src/attention/service.mjs';
import { normalizeDeveloperEvent } from '../src/developer-work/contract.mjs';
import { createDeveloperWorkService, developerHandoffUrl } from '../src/developer-work/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const authority = { producerId: 'sample-dev', role: 'worker', allowedProjects: ['sample-project'] };
const capabilities = { notes: false, sessions: false, scheduler: false, activity: true, analysis: false, attention: true, search: false };
const session = { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'session-1', lifecycleRevision: 'lifecycle-1' };

test('LIVE constructs the exact DEV page URL locally without session credentials', () => {
  const href = developerHandoffUrl('https://dev.example.test/ui', 'feature-1', 'review:one');
  const target = new URL(href);
  assert.equal(target.pathname, '/ui/plugin');
  assert.deepEqual([...target.searchParams], [['plugin', 'command-center'], ['id', 'developer-work'], ['p.workId', 'feature-1'], ['p.requestId', 'review:one']]);
  assert.equal(href.includes(session.sessionKey), false);
  assert.throws(() => developerHandoffUrl('http://dev.example.test', 'feature-1', 'review-one'), /HTTPS/u);
});

test('LIVE Attention evidence exposes a handoff URL without the DEV session binding', async () => fixture(async ({ metadata, attention }) => {
  const work = createDeveloperWorkService({ metadata, attention, devBaseUrl: 'https://dev.example.test/ui' });
  await work.accept({ ...authority, event: event({ revision: 1, requestId: 'review-a' }) });
  const [episode] = attention.list().episodes;
  assert.equal(episode.evidenceFacts.devHandoffUrl, developerHandoffUrl('https://dev.example.test/ui', 'sample-feature', 'review-a'));
  assert.equal(Object.hasOwn(episode.evidenceFacts, 'session'), false);
  assert.equal(JSON.stringify(episode).includes(session.sessionKey), false);
  work.close();
}));

function event({ revision, requestId, kind = 'review', expected = 0, eventType = 'feature_ready_for_review', occurredAt = '2026-09-26T10:00:00.000Z' }) {
  return {
    schemaVersion: 1, eventId: randomUUID(), workId: 'sample-feature', workRevision: revision, eventType, occurredAt,
    context: { projectAlias: 'sample-project', phase: 'reviewing' },
    ...(eventType.startsWith('request_') ? {} : { session }),
    request: { requestId, kind, expectedRequestRevision: expected, summary: `Review ${requestId}`, question: 'Is this ready?' },
    ...(eventType.startsWith('request_') ? { outcome: { code: eventType === 'request_resolved' ? 'reviewed' : 'withdrawn', requestId } } : {})
  };
}

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-developer-projection-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const attention = createAttentionService({ metadata, now: () => '2026-09-26T11:00:00.000Z' });
  try { await run({ metadata, attention }); }
  finally { attention.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('startup backlog keeps a resolved review out of Attention while preserving its outcome', async () => fixture(async ({ metadata, attention }) => {
  const a = event({ revision: 1, requestId: 'review-a' });
  const b = event({ revision: 2, requestId: 'review-b' });
  const resolvedA = event({ revision: 3, requestId: 'review-a', expected: 1, eventType: 'request_resolved' });
  for (const value of [a, b, resolvedA]) metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: normalizeDeveloperEvent(value, authority) });
  const work = createDeveloperWorkService({ metadata, attention });
  await work.drain();
  const active = attention.list().episodes;
  assert.equal(active.length, 1);
  assert.equal(active[0].evidenceFacts.requestId, 'review-b');
  assert.equal(active[0].severity, 'Routine');
  assert.equal(metadata.listPendingDeveloperEvents({}).length, 0);
  assert.deepEqual(attention.listActivity({ limit: 20 }).records.map(row => row.operationKind), ['attention.resolved']);
  assert.equal((await work.accept({ ...authority, event: b })).duplicate, true);
  assert.equal(attention.list().episodes.length, 1);
  work.close();
}));

test('per-request revision wins over earlier occurrence time and unrelated work revisions', async () => fixture(async ({ metadata, attention }) => {
  const work = createDeveloperWorkService({ metadata, attention });
  const first = event({ revision: 1, requestId: 'review-a', occurredAt: '2026-09-26T10:00:00.000Z' });
  const revised = event({ revision: 2, requestId: 'review-a', expected: 1, occurredAt: '2026-09-26T09:00:00.000Z' });
  const other = event({ revision: 3, requestId: 'review-b' });
  const terminal = event({ revision: 4, requestId: 'review-a', expected: 2, eventType: 'request_resolved', occurredAt: '2026-09-26T09:00:00.000Z' });
  for (const value of [first, revised, other, terminal]) await work.accept({ ...authority, event: value });
  const active = attention.list().episodes;
  assert.deepEqual(active.map(row => row.evidenceFacts.requestId), ['review-b']);
  const all = attention.listActivity({ limit: 20 });
  assert.equal(all.records.filter(row => row.operationKind === 'attention.resolved').length, 1);
  assert.equal(all.records.filter(row => row.operationKind === 'developer-work.request_resolved').length, 0);
  assert.equal(metadata.getDeveloperRequest({ producerId: authority.producerId, workId: 'sample-feature', requestId: 'review-a' }).revision, 4);
  work.close();
}));

test('a request advancing during asynchronous ingest cannot publish its older revision', async () => fixture(async ({ metadata, attention }) => {
  const first = event({ revision: 1, requestId: 'review-race' });
  const revised = event({ revision: 2, requestId: 'review-race', expected: 1, occurredAt: '2026-09-26T09:00:00.000Z' });
  let advance = true;
  const wrapped = {
    registerSourceCapability: value => attention.registerSourceCapability(value),
    ingest: async occurrence => {
      if (advance) {
        advance = false;
        metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: normalizeDeveloperEvent(revised, authority) });
      }
      return attention.ingest(occurrence);
    }
  };
  const work = createDeveloperWorkService({ metadata, attention: wrapped });
  await work.accept({ ...authority, event: first });
  const active = attention.list().episodes;
  assert.equal(active.length, 1);
  assert.equal(active[0].sourceRevision, '2');
  assert.equal(active[0].occurredAt, '2026-09-26T09:00:00.000Z');
  assert.equal(metadata.listPendingDeveloperEvents({}).length, 0);
  work.close();
}));

test('failure, rollback and recovery remain one High incident until explicit resolution', async () => fixture(async ({ metadata, attention }) => {
  const controller = { producerId: 'sample-controller', role: 'controller', allowedProjects: ['sample-project'] };
  const incident = (revision, expected, eventType, code) => ({
    schemaVersion: 1, eventId: randomUUID(), workId: 'deployment-work', workRevision: revision, eventType,
    occurredAt: '2026-09-26T10:00:00.000Z', context: { projectAlias: 'sample-project', deploymentId: 'deployment-1' },
    request: { requestId: 'incident-1', kind: 'deployment-incident', expectedRequestRevision: expected, summary: 'Deployment needs review' },
    outcome: { code, deploymentId: 'deployment-1' }
  });
  const work = createDeveloperWorkService({ metadata, attention });
  const ids = [];
  for (const value of [
    incident(1, 0, 'production_deployment_failed', 'failed'),
    incident(2, 1, 'production_rollback', 'rolled-back'),
    incident(3, 2, 'production_recovered', 'recovered')
  ]) {
    const receipt = await work.accept({ ...controller, event: value });
    const active = attention.list().episodes;
    assert.equal(active.length, 1);
    assert.equal(active[0].severity, 'High');
    assert.equal(active[0].evidenceFacts.outcomeObservedAt, receipt.acceptedAt);
    ids.push(active[0].episodeId);
  }
  assert.equal(new Set(ids).size, 1);
  assert.deepEqual(metadata.listActivity().map(row => row.operationKind).sort(), [
    'developer-work.production_deployment_failed',
    'developer-work.production_rollback',
    'developer-work.production_recovered'
  ].sort());
  work.close();
}));
