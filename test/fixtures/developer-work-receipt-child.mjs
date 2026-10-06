import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { normalizeDeveloperEvent } from '../../src/developer-work/contract.mjs';

const stateDir = process.argv[2];
const authority = { producerId: 'sample-dev', role: 'worker', allowedProjects: ['sample-project'] };
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: false, sessions: false, scheduler: false, activity: true, analysis: false, attention: true, search: false } });
const event = normalizeDeveloperEvent({
  schemaVersion: 1, eventId: 'a3c429e9-c12f-4301-a799-622852499df0', workId: 'crash-feature', workRevision: 1,
  eventType: 'feature_ready_for_review', occurredAt: '2026-09-26T10:00:00.000Z', context: { projectAlias: 'sample-project' },
  session: { agentId: 'sample-agent', sessionKey: 'agent:sample-agent:main', sessionId: 'session-1', lifecycleRevision: 'lifecycle-1' },
  request: { requestId: 'crash-review', kind: 'review', expectedRequestRevision: 0, summary: 'Review sample feature', question: 'Is it ready?' }
}, authority);
metadata.acceptDeveloperEvent({ producerId: authority.producerId, event });
process.stdout.write('boundary-reached\n');
setInterval(() => {}, 1000);
