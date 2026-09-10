import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../../src/migration/service.mjs';

const metadata = openCommandCenterMetadataService({ stateDir: process.argv[2], capabilities: { notes: true, sessions: true } });
await createLegacyDiscordMigrationService({
  metadata,
  config: JSON.parse(process.argv[3]),
  gateway: { async request(method) {
    if (method === 'sessions.list') return { sessions: [] };
    throw new Error('Native Session creation must follow the committed folder binding');
  } },
  transcriptRuntime: {},
  hooks: { afterTopicBinding() { process.kill(process.pid, 'SIGKILL'); } }
}).start();
throw new Error('The committed folder binding crash boundary was not reached');
