import { DatabaseSync } from 'node:sqlite';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { TopicProvisioningService } from '../../src/topics/provisioning.mjs';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const [stateDir, vault, fault = 'before-commit'] = process.argv.slice(2);
const enrollmentOperationId = ['before-commit-owned', 'stage-mkdir', 'stage-marked'].includes(fault) ? '77777777-7777-4777-8777-777777777777' : undefined;
if (fault === 'stage-mkdir') {
  const mkdir = filesystem.mkdir;
  filesystem.mkdir = async (...args) => {
    const result = await mkdir(...args);
    if (String(args[0]).includes('.command-center-provision-')) process.kill(process.pid, 'SIGKILL');
    return result;
  };
  syncBuiltinESMExports();
}
if (fault === 'stage-marked') {
  const rename = filesystem.rename;
  filesystem.rename = async (...args) => {
    if (String(args[0]).includes('.command-center-provision-')) process.kill(process.pid, 'SIGKILL');
    return rename(...args);
  };
  syncBuiltinESMExports();
}
const prepare = DatabaseSync.prototype.prepare;
const exec = DatabaseSync.prototype.exec;
let armed = false;
// Inject process death at the real SQLite boundary, never replace the owner.
DatabaseSync.prototype.prepare = function (sql, ...args) {
  if (sql.includes('INSERT INTO source_convention_state')) armed = true;
  return prepare.call(this, sql, ...args);
};
DatabaseSync.prototype.exec = function (sql, ...args) {
  if (armed && sql === 'COMMIT' && fault.startsWith('before-commit')) process.kill(process.pid, 'SIGKILL');
  const result = exec.call(this, sql, ...args);
  if (armed && sql === 'COMMIT' && fault === 'after-commit') process.kill(process.pid, 'SIGKILL');
  return result;
};
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
await new TopicProvisioningService({ metadata, noteVaultRoot: vault }).bindFolder('fictional-topic', { name: 'Fictional', paraCategory: 'project' }, { enrollmentOperationId });
throw new Error('The SQLite crash boundary was not reached.');
