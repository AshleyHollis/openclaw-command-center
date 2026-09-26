import { randomUUID } from 'node:crypto';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { ensureConventionalFolder, setHostDurableDirectoryPublisher } from '../../src/topics/conventions.mjs';
import { finishConditionalProvisioning } from '../../src/topics/provisioning-primary.mjs';
import { setHostDurableFolderStager, setHostFilesystemIdentityReader } from '../../src/sources/note-folder-identity.mjs';
import { setHostNoteFilesystemCoordinator } from '../../src/sources/note-filesystem-owner.mjs';

const [stateDir, vault, mode] = process.argv.slice(2);
const operationId = process.env.TOPIC_TEST_OPERATION_ID ?? randomUUID();
const topicId = process.env.TOPIC_TEST_TOPIC_ID ?? randomUUID();
const name = 'Fictional Recovery';
const folderPath = `${vault}/Projects/${name}`;
const fileAccess = await import('openclaw/plugin-sdk/file-access-runtime');
const sqlite = await import('openclaw/plugin-sdk/sqlite-runtime');
for (const method of ['stageDurableFileInDirectory', 'readDurableFilesystemIdentity', 'publishDurableDirectoryNoReplace']) {
  if (typeof fileAccess[method] !== 'function') throw new Error(`Candidate host lacks ${method}`);
}
setHostDurableFolderStager(fileAccess.stageDurableFileInDirectory);
setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
setHostNoteFilesystemCoordinator(sqlite.tryAcquireExclusiveSqliteCoordinator);
setHostDurableDirectoryPublisher(options => {
  if (mode === 'before-publication') process.kill(process.pid, 'SIGKILL');
  const result = fileAccess.publishDurableDirectoryNoReplace(options);
  if (mode === 'after-publication') process.kill(process.pid, 'SIGKILL');
  return result;
});
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
metadata.reserveConditionalProvisioning({ logicalOperationId: operationId, topicId, name, paraCategory: 'project', folderPath,
  preparationDigest: null }, () => {});
const folder = await ensureConventionalFolder({ noteVaultRoots: [vault], name, paraCategory: 'project', folderPath, metadata, topicId,
  enrollmentOperationId: operationId, assertCurrent: () => {} });
if (mode === 'after-session-create') {
  metadata.bindProvisioningNoteFolder({ topicId, name, paraCategory: 'project', expectedRevision: 0,
    expectedLocatorVersion: 0, expectedSourceRevision: null, locator: folder.path,
    observedRevision: folder.revision, ownership: folder.ownership }, () => {});
  const native = await import('openclaw/plugin-sdk/session-store-runtime');
  const sessionStore = { getSessionEntry: native.getSessionEntry,
    patchSessionEntry: async (...args) => {
      const result = await native.patchSessionEntry(...args);
      process.kill(process.pid, 'SIGKILL');
      return result;
    } };
  await finishConditionalProvisioning({ metadata, sessionStore, env: process.env, parentOperationId: operationId,
    expectedTopicRevision: 0, assertCurrent: () => {} });
  throw new Error('The child survived native Session creation.');
}
metadata.close();
