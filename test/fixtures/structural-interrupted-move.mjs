import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';

// Crash at the real filesystem boundary, after its effect and before its reply.
const [stateDir, vault, encoded, method = 'recategorizeConfirm', fault = 'after-move'] = process.argv.slice(2);
if (fault === 'after-move') {
  const rename = fs.rename;
  fs.rename = async (...args) => { await rename(...args); process.kill(process.pid, 'SIGKILL'); };
} else if (fault === 'before-metadata-commit') {
  // Real SQLite process death with an open transaction after receipt publication.
  const prepare = DatabaseSync.prototype.prepare; const exec = DatabaseSync.prototype.exec;
  let armed = false;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql.includes("UPDATE topic_operations SET state = 'applied'")) armed = true;
    return prepare.call(this, sql, ...args);
  };
  DatabaseSync.prototype.exec = function (sql, ...args) {
    if (armed && sql === 'COMMIT') process.kill(process.pid, 'SIGKILL');
    return exec.call(this, sql, ...args);
  };
} else throw new Error('Unsupported isolated fault.');
syncBuiltinESMExports();
const { createTopicLifecycleService } = await import('../../src/topics/lifecycle.mjs');
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, scheduler: true } });
const lifecycle = createTopicLifecycleService({ metadata, noteVaultRoot: vault, commitmentProvider: async () => [], sessionStore: { listSessionEntries: () => [{ sessionKey: 'fixture:session', entry: { sessionId: 'fixture-session-id' } }] } });
await lifecycle[method](JSON.parse(encoded));
throw new Error('The crash boundary was not reached.');
