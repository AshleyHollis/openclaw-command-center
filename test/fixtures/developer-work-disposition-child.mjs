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
process.stdout.write('disposition-committed\n');
setInterval(() => {}, 1000);
