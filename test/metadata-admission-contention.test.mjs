import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { createMetadataService } from '../src/plugin-service.mjs';

for (const readOnly of [false, true]) {
  test(`metadata admission refuses transient exclusive contention without recovery (${readOnly ? 'read-only' : 'ordinary'})`, { timeout: 10000 }, async t => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'metadata-admission-contention-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const initial = openCommandCenterMetadataService({ stateDir });
    initial.createTopic({ topicId: 'fictional-garden', name: 'Garden', paraCategory: 'area', lifecycle: 'active' });
    initial.close();
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    const before = await readFile(databasePath);
    const files = await readdir(stateDir, { recursive: true });
    const writer = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(workerData);
      database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      parentPort.postMessage('held');
      parentPort.once('message', () => {
        database.exec('ROLLBACK'); database.close(); parentPort.close();
      });
    `, { eval: true, workerData: databasePath });
    t.after(() => writer.terminate());
    await once(writer, 'message');
    try {
      assert.throws(() => openCommandCenterMetadataService({ stateDir, readOnly }), error => {
        assert.equal(error.name, 'CommandCenterMetadataError');
        assert.equal(error.code, 'storage-contended');
        assert.equal(error.retryable, true);
        assert.equal(error.errcode & 0xff, 5);
        assert.equal(error.cause.errcode, error.errcode);
        return true;
      });
      if (!readOnly) {
        let gatewayCalls = 0;
        const plugin = createMetadataService({ runtime: { state: { resolveStateDir: () => stateDir }, gateway: { request() { gatewayCalls += 1; throw new Error('Contended startup must not dispatch Gateway work'); } } }, pluginConfig: {}, logger: { warn() {} } });
        try {
          await assert.rejects(plugin.start(), { code: 'storage-contended', retryable: true });
          assert.equal(plugin.sourceService, undefined);
          assert.equal(plugin.topicService, undefined);
          assert.equal(gatewayCalls, 0);
        } finally { await plugin.stop(); }
      }
    } finally {
      const exited = once(writer, 'exit'); writer.postMessage('release');
      assert.equal((await exited)[0], 0);
    }
    assert.deepEqual(await readFile(databasePath), before);
    assert.deepEqual(await readdir(stateDir, { recursive: true }), files);
    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(inspected.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(inspected.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { inspected.close(); }
    const reopened = openCommandCenterMetadataService({ stateDir, readOnly });
    try {
      assert.notEqual(reopened.getOperatingStatus().mode, 'recovery-only');
      assert.equal(reopened.getTopic('fictional-garden').name, 'Garden');
      if (readOnly) assert.throws(() => reopened.createTopic({ topicId: 'refused', name: 'Refused', paraCategory: 'area', lifecycle: 'active' }), { code: 'read-only' });
    } finally { reopened.close(); }
    assert.deepEqual(await readFile(databasePath), before);
  });
}
