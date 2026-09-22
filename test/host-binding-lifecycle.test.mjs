import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enrollNoteFolderIdentity, readNoteFolderIdentity, setHostDurableFolderStager, setHostFilesystemIdentityReader } from '../src/sources/note-folder-identity.mjs';
import { createHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

test('out-of-order host binding release cannot resurrect revoked filesystem authority', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-host-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = createHostFileAccessFixture();
  const releaseStager = setHostDurableFolderStager(fixture.stageDurableFileInDirectory);
  const releaseSeedReader = setHostFilesystemIdentityReader(fixture.readDurableFilesystemIdentity);
  await enrollNoteFolderIdentity(root);
  releaseSeedReader(); releaseStager();

  let staleCalls = 0; let overlayCalls = 0;
  const releaseStale = setHostFilesystemIdentityReader(async () => { staleCalls += 1; return fixture.readDurableFilesystemIdentity(); });
  const releaseOverlay = setHostFilesystemIdentityReader(async () => { overlayCalls += 1; return fixture.readDurableFilesystemIdentity(); });
  releaseStale(); releaseOverlay();
  await assert.rejects(() => readNoteFolderIdentity(root), error => error.code === 'capability-unavailable');
  assert.deepEqual({ staleCalls, overlayCalls }, { staleCalls: 0, overlayCalls: 0 });
});
