import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { AuthoritativeSourceService } from '../../src/sources/service.mjs';

const [stateDir, encodedInput, phase] = process.argv.slice(2);
const input = JSON.parse(encodedInput);
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
const effectPath = path.join(stateDir, 'fictional-native-effect.json');
const nativeResult = { key: 'agent:main:dashboard:interrupted', sessionId: 'interrupted-id', entry: { sessionId: 'interrupted-id', updatedAt: 20 } };
const die = () => process.kill(process.pid, 'SIGKILL');
const sessionStore = {
  listSessionEntries: () => [],
  getSessionEntry({ sessionKey }) {
    if (sessionKey === 'agent:main:dashboard:primary') {
      if (phase === 'before-dispatch') die();
      return { sessionId: 'primary-id', updatedAt: 10 };
    }
    if (phase === 'before-attachment') die();
    if (existsSync(effectPath)) {
      const result = JSON.parse(readFileSync(effectPath, 'utf8'));
      if (result.key === sessionKey) return result.entry;
    }
    return undefined;
  }
};
const service = new AuthoritativeSourceService({ metadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
const runtime = {
    creationAuthority: { principalId: 'fictional-operator', assertCurrent() {} },
    gatewayRequest: async () => {
      // This is an explicit external native boundary fixture, not a claim about
      // native deduplication or native persistent creation receipts.
      writeFileSync(effectPath, JSON.stringify(nativeResult));
      if (phase === 'lost-reply') die();
      return nativeResult;
    }
  };
try {
  const result = await service.sessionsCreate(input, runtime);
  if (phase === 'after-completion') die();
  if (phase === 'after-acknowledgement') {
    await service.sessionsCreationAcknowledge({ topicId: input.topicId, logicalOperationId: input.logicalOperationId, referenceId: result.value.sourceReference.referenceId }, runtime);
    die();
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  if (phase !== 'competing-new') throw error;
  process.stdout.write(JSON.stringify({ code: error.code }));
} finally { metadata.close(); }
