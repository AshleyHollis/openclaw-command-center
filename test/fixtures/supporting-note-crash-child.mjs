import { writeSync } from 'node:fs';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../../src/sources/service.mjs';
import { installHostFileAccessFixture } from '../support/host-file-access-fixture.mjs';

const [stateDir, root, inputJson] = process.argv.slice(2);
installHostFileAccessFixture();
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
const source = createAuthoritativeSourceService({ metadata, root, capabilities: { notes: true }, noteRecoveryEffects: false,
  fsSafeRootFactory: async rootDir => ({ rootDir, rootReal: rootDir, resolve: async relative => path.join(rootDir, relative) }),
  afterAtomicPublish: ({ operation }) => {
    if (operation !== 'edit') throw new Error('The fixture reached an unexpected Note effect.');
    writeSync(1, 'supporting-note-published\n');
    process.kill(process.pid, 'SIGKILL');
  } });
await source.notesEdit(JSON.parse(inputJson));
throw new Error('The supporting Note effect did not reach its process-death boundary.');
