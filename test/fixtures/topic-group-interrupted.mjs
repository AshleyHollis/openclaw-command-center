import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { AuthoritativeSourceService } from '../../src/sources/service.mjs';

const [stateDir, encodedInput, phase] = process.argv.slice(2);
const input = JSON.parse(encodedInput);
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
const entry = { sessionId: 'original', lifecycleRevision: 'lifecycle-one', updatedAt: 10 };
const die = () => process.kill(process.pid, 'SIGKILL');
// External native boundary only. The actual plugin owner and SQLite journal
// run here; native Session-store CAS is covered by host conformance tests.
const sessionStore = {
  listSessionEntries: () => [{ sessionKey: 'agent:main:dashboard:fixture', entry }],
  async patchSessionEntry(params) {
    const patch = params.update(structuredClone(entry));
    params.assertCommitAllowed();
    if (phase === 'before-effect') die();
    Object.assign(entry, patch);
    writeFileSync(path.join(stateDir, 'fictional-group-effect.json'), JSON.stringify(entry));
    if (phase === 'after-effect') die();
    return entry;
  }
};
const owner = new AuthoritativeSourceService({ metadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
await owner.sessionGroup(input, { creationAuthority: { principalId: 'fixture-operator', assertCurrent() {} } });
if (phase === 'after-receipt') die();
throw new Error('Crash fixture did not reach its boundary');
