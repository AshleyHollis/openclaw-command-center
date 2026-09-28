import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { normalizeDeveloperEvent } from '../../src/developer-work/contract.mjs';

const stateDir = process.argv[2];
const authority = { producerId: 'sample-dev', role: 'worker', allowedProjects: ['sample-project'] };
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { activity: true, attention: true } });
const event = normalizeDeveloperEvent({
  schemaVersion: 1, eventId: 'a3c429e9-c12f-4301-a799-622852499df1', workId: 'crash-feature', workRevision: 1,
  eventType: 'feature_ready_for_review', occurredAt: '2026-09-26T10:00:00Z', context: { projectAlias: 'sample-project' },
  session: { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'fictional-session', lifecycleRevision: 'fictional-lifecycle' },
  request: { requestId: 'crash-expired', kind: 'review', expectedRequestRevision: 0, summary: 'Review fictional feature', question: 'Is it ready?', expiresAt: '2026-09-26T10:01:00Z' }
}, authority);
metadata.disposeExpiredDeveloperEvent({ producerId: authority.producerId, event, assertAuthorityCurrent() {}, now: () => Date.parse('2026-09-26T10:02:00Z') });
const activeOpening = normalizeDeveloperEvent({ ...event, eventId: 'a3c429e9-c12f-4301-a799-622852499df2', workId: 'crash-active', request: { requestId: 'crash-active-review', kind: 'review', expectedRequestRevision: 0, summary: 'Review fictional work', question: 'Is it ready?' } }, authority);
metadata.acceptDeveloperEvent({ producerId: authority.producerId, event: activeOpening, assertAuthorityCurrent() {} });
const terminal = normalizeDeveloperEvent({ ...activeOpening, eventId: 'a3c429e9-c12f-4301-a799-622852499df3', workRevision: 2, eventType: 'request_resolved', request: { requestId: 'crash-active-review', kind: 'review', expectedRequestRevision: 1, expiresAt: '2026-09-26T10:01:00Z' }, outcome: { code: 'reviewed', requestId: 'crash-active-review' } }, authority);
metadata.disposeExpiredDeveloperEvent({ producerId: authority.producerId, event: terminal, assertAuthorityCurrent() {}, now: () => Date.parse('2026-09-26T10:02:00Z') });
process.stdout.write('disposition-committed\n');
setInterval(() => {}, 1000);
