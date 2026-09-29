import assert from 'node:assert/strict';
import test from 'node:test';
import { developerEventDigest, normalizeDeveloperEvent } from '../src/developer-work/contract.mjs';

const authority = { producerId: 'fictional-dev', role: 'worker', allowedProjects: ['sample-project'] };
const request = {
  schemaVersion: 1,
  eventId: 'a3c429e9-c12f-4301-a799-622852499dad',
  workId: 'feature-7',
  workRevision: 1,
  eventType: 'feature_ready_for_review',
  occurredAt: '2026-09-26T10:00:00.000Z',
  context: { projectAlias: 'sample-project', phase: 'reviewing' },
  session: { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'incarnation-1', lifecycleRevision: 'reset-1' },
  request: { requestId: 'review-1', kind: 'review', expectedRequestRevision: 0, summary: 'Review the sample feature', question: 'Is this ready for release?' }
};

test('normalizes bounded source evidence without accepting producer identity from the body', () => {
  const event = normalizeDeveloperEvent(request, authority);
  assert.equal(event.request.kind, 'review');
  assert.equal(Object.hasOwn(event, 'producerId'), false);
  assert.equal(developerEventDigest(event), developerEventDigest(structuredClone(event)));
  assert.throws(() => normalizeDeveloperEvent({ ...request, producerId: 'another-dev' }, authority), /invalid shape/);
  assert.throws(() => normalizeDeveloperEvent(request, { ...authority, allowedProjects: ['other-project'] }), /not admitted/);
});

test('rejects freeform attention authority and malformed human request evidence', () => {
  assert.throws(() => normalizeDeveloperEvent({ ...request, severity: 'Critical' }, authority), /invalid shape/);
  assert.throws(() => normalizeDeveloperEvent({ ...request, request: { ...request.request, kind: 'approval' } }, authority), /incomplete/);
  assert.throws(() => normalizeDeveloperEvent({ ...request, request: { ...request.request, summary: '<script>alert(1)</script>' } }, authority), /invalid/);
  assert.throws(() => normalizeDeveloperEvent({ ...request, session: { ...request.session, lifecycleRevision: undefined } }, authority), /invalid/);
  assert.throws(() => normalizeDeveloperEvent({ ...request, workRevision: 0 }, authority), /positive/);
});

test('requires controller authority and exact deployment identity for incidents', () => {
  const incident = {
    ...request,
    eventType: 'production_deployment_failed',
    context: { projectAlias: 'sample-project', deploymentId: 'deploy-1' },
    session: undefined,
    request: { requestId: 'incident-1', kind: 'deployment-incident', expectedRequestRevision: 0, summary: 'Sample deployment failed' },
    outcome: { code: 'failed', deploymentId: 'deploy-1' }
  };
  assert.throws(() => normalizeDeveloperEvent(incident, authority), /Controller authority/);
  assert.equal(normalizeDeveloperEvent(incident, { ...authority, role: 'controller' }).request.requestId, 'incident-1');
  assert.throws(() => normalizeDeveloperEvent({ ...incident, outcome: { code: 'failed', deploymentId: 'deploy-2' } }, { ...authority, role: 'controller' }), /incomplete/);
  const terminal = { ...incident, eventType: 'request_resolved', workRevision: 2,
    request: { ...incident.request, expectedRequestRevision: 1 },
    outcome: { code: 'recovered', requestId: 'incident-1', deploymentId: 'deploy-1' } };
  assert.equal(normalizeDeveloperEvent(terminal, { ...authority, role: 'controller' }).outcome.deploymentId, 'deploy-1');
  assert.throws(() => normalizeDeveloperEvent({ ...terminal, outcome: { code: 'recovered', requestId: 'incident-1' } }, { ...authority, role: 'controller' }), /incomplete/);
});

test('terminal evidence targets one existing request and work progress alone cannot create Attention', () => {
  const terminal = {
    ...request,
    workRevision: 3,
    eventType: 'request_resolved',
    request: { requestId: 'review-1', kind: 'review', expectedRequestRevision: 1 },
    outcome: { code: 'reviewed', requestId: 'review-1' }
  };
  assert.equal(normalizeDeveloperEvent(terminal, authority).request.expectedRequestRevision, 1);
  assert.throws(() => normalizeDeveloperEvent({ ...terminal, outcome: { code: 'reviewed', requestId: 'review-2' } }, authority), /exact request/);
  assert.throws(() => normalizeDeveloperEvent({ ...request, eventType: 'feature_completed', outcome: { code: 'completed' } }, authority), /only a result/);
  assert.equal(normalizeDeveloperEvent({ ...request, eventType: 'feature_completed', request: undefined, session: undefined, outcome: { code: 'completed' } }, authority).eventType, 'feature_completed');
});
