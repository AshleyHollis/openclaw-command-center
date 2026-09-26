import { lstatSync, renameSync, existsSync } from 'node:fs';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { ensureConventionalFolder, setHostDurableDirectoryPublisher } from '../../src/topics/conventions.mjs';
import { TopicProvisioningService } from '../../src/topics/provisioning.mjs';
import { installHostFileAccessFixture } from '../support/host-file-access-fixture.mjs';

const [stateDir, vault, operationId, topicId, mode = 'after-session-checkpoint'] = process.argv.slice(2);
installHostFileAccessFixture();
setHostDurableDirectoryPublisher(options => {
  const before = lstatSync(options.stagedDir, { bigint: true });
  if (before.dev !== options.expectedIdentity.dev || before.ino !== options.expectedIdentity.ino || existsSync(options.targetDir))
    throw new Error('The test publisher rejected changed or occupied directory.');
  options.assertBeforeMutation?.();
  renameSync(options.stagedDir, options.targetDir);
});
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
const name = 'Fictional Recovery'; const folderPath = path.join(vault, 'Projects', name);
metadata.reserveConditionalProvisioning({ logicalOperationId: operationId, topicId, name, paraCategory: 'project', folderPath }, () => {});
const folder = await ensureConventionalFolder({ noteVaultRoots: [vault], name, paraCategory: 'project', folderPath,
  metadata, topicId, enrollmentOperationId: operationId, assertCurrent: () => {} });
metadata.bindProvisioningNoteFolder({ topicId, name, paraCategory: 'project', expectedRevision: 0,
  expectedLocatorVersion: 0, expectedSourceRevision: null, locator: folder.path,
  observedRevision: folder.revision, ownership: folder.ownership }, () => {});
const interrupted = { ...metadata,
  advanceConditionalProvisioningRollback: (...args) => {
    const result = metadata.advanceConditionalProvisioningRollback(...args);
    if (mode === 'after-session-checkpoint' && args[1] === 'session-cleared') process.kill(process.pid, 'SIGKILL');
    return result;
  } };
if (mode === 'after-marker-unlink') {
  const originalUnlink = filesystem.unlink;
  filesystem.unlink = async (...args) => {
    const result = await originalUnlink(...args);
    if (path.basename(args[0]) === '.command-center-folder-identity') process.kill(process.pid, 'SIGKILL');
    return result;
  };
  syncBuiltinESMExports();
}
const owner = new TopicProvisioningService({ metadata: interrupted, noteVaultRoot: vault,
  sessionStore: { getSessionEntry: () => null }, gateway: { request: () => { throw new Error('No Session existed.'); } } });
await owner.rollback({ logicalOperationId: operationId, topicId, expectedRevision: 0 });
throw new Error('The child survived the rollback checkpoint.');
