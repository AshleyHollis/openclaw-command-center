import http from 'node:http';
import { createDeveloperEventHandler } from '../../src/developer-work/http-route.mjs';
import { createDeveloperWorkService } from '../../src/developer-work/service.mjs';
import { createAttentionService } from '../../src/attention/service.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';

const stateDir = process.argv[2];
const holdDispositionReply = process.argv[3] === 'hold';
const credential = 'a'.repeat(48); // Fictional test-only credential.
const principal = { producerId: 'sample-dev', role: 'worker', tokenEnv: 'SAMPLE_DEV_BEARER', allowedProjects: ['sample-project'], families: ['human-request', 'request-terminal'] };
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { activity: true, attention: true } });
const attention = createAttentionService({ metadata, now: () => '2026-09-26T10:02:00Z' });
const work = createDeveloperWorkService({ metadata, attention, now: () => Date.parse('2026-09-26T10:02:00Z') });
const service = {
  accept: input => work.accept(input),
  async disposeExpired(input) {
    const receipt = work.disposeExpired(input);
    if (holdDispositionReply && input.event.request?.requestId === 'crash-expired') {
      process.stdout.write('disposition-committed\n');
      await new Promise(() => {}); // Parent SIGKILLs after the committed receipt, before HTTP acknowledgement.
    }
    return receipt;
  }
};
// This local-only fixture exercises the real HTTP handler behind its trusted
// loopback proxy branch. No external listener, endpoint, or credential exists.
const handler = createDeveloperEventHandler({ service, principals: [principal], env: { SAMPLE_DEV_BEARER: credential }, trustedProxyPeers: ['127.0.0.1', '::ffff:127.0.0.1', '::1'] });
const server = http.createServer((req, res) => { handler(req, res).catch(error => { process.stderr.write(String(error)); res.destroy(); }); });
server.listen(0, '127.0.0.1', () => process.stdout.write('ready:' + server.address().port + '\n'));
