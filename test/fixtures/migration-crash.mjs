import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';

const migrationTestHooks = Symbol.for('openclaw.command-center.test.migration-hooks');
const hook = process.argv[3] === 'before-commit' ? 'beforeCommit' : 'afterDatabaseCommit';
openCommandCenterMetadataService({
  stateDir: process.argv[2],
  [migrationTestHooks]: {
    [hook]() {
      process.kill(process.pid, 'SIGKILL');
    }
  }
});
