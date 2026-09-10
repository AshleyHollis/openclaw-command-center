import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeCommandCenterMetadata } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';

test('initialization refuses success on directory sync failure and a retry durably retains the same database',
  { skip: process.platform !== 'linux' && 'Requires Linux directory durability semantics' }, async t => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'metadata-init-durability-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const original = fs.fsyncSync;
    const syncedDirectories = [];
    let fault = true;
    // Filesystem boundary fault injection, not a mock of the metadata owner.
    fs.fsyncSync = descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        if (fault) throw Object.assign(new Error('injected sync failure'), { code: 'EIO' });
        syncedDirectories.push(fs.readlinkSync(`/proc/self/fd/${descriptor}`));
      }
      return original(descriptor);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => initializeCommandCenterMetadata({ stateDir, expectedSchemaVersion: 8 }), { code: 'EIO' });
      const databasePath = resolveCommandCenterDatabasePath(stateDir);
      const bytes = await readFile(databasePath); const identity = await stat(databasePath);
      fault = false;
      assert.deepEqual(initializeCommandCenterMetadata({ stateDir, expectedSchemaVersion: 8 }),
        { phase: 'verified', schemaVersion: 8, disposition: 'existing' });
      assert.deepEqual(syncedDirectories, [path.dirname(databasePath), path.join(stateDir, 'plugins'), stateDir]);
      assert.equal((await stat(databasePath)).ino, identity.ino);
      assert.deepEqual(await readFile(databasePath), bytes);
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  });
