import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { NoteAdapter } from '../../src/sources/notes.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { enrollNoteFolderIdentity } from '../../src/sources/note-folder-identity.mjs';

export async function openFixture(stateDir, options = {}) {
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  const coordinator = process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME
    ? (await import(process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME)).tryAcquireExclusiveSqliteCoordinator
    : undefined;
  const root = path.join(stateDir, 'vault');
  const adapter = new NoteAdapter({ metadata, topicId: 'fictional-read-only', root,
    tryAcquireExclusiveSqliteCoordinator: coordinator,
    fsSafeRootFactory: async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative) }),
    ...options });
  return { metadata, adapter, root, coordinator, async enroll() {
    metadata.createTopic({ topicId: 'fictional-read-only', paraCategory: 'project', lifecycle: 'active' });
    const observedRevision = await enrollNoteFolderIdentity(root);
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-folder', topicId: 'fictional-read-only', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root });
    metadata.setSourceLocator({ referenceId: 'fictional-folder', locator: root, ownership: 'adopted', observedRevision });
  }, close() { adapter.close(); metadata.close(); } };
}

if (process.argv[2] === 'child') {
  const [stateDir, operation, logicalOperationId, expectedRevision, boundary = 'claimed'] = process.argv.slice(3);
  const die = () => { writeSync(1, 'boundary-reached\n'); process.kill(process.pid, 'SIGKILL'); };
  const fixture = await openFixture(stateDir, { afterAtomicPublish: boundary === 'published' ? die : undefined });
  const rename = fs.rename;
  fs.rename = async (source, target) => {
    await rename(source, target);
    if (boundary === 'claimed' && String(target).includes('.command-center-claim-')) die();
  };
  syncBuiltinESMExports();
  await fixture.adapter[operation]({ path: 'original.md', destinationPath: 'nested/moved.md', text: 'replacement', logicalOperationId, expectedRevision });
  throw new Error('The child missed the required process-death boundary.');
}
