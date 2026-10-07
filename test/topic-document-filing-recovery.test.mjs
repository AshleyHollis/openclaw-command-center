import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';
import { installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

const release = installHostFileAccessFixture();
test.after(release);
const linux = { skip: process.platform !== 'linux' && 'Descriptor-relative Note publication requires Linux.' };
const bytes = Buffer.from('fictional original attachment bytes');

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'topic-filing-recovery-'));
  const root = path.join(directory, 'vault');
  const stateDir = path.join(directory, 'state');
  await mkdir(root);
  const topicId = 'fictional-filing';
  const sessionKey = 'agent:main:fictional-filing';
  const sessionId = 'fictional-filing-incarnation';
  const input = { sessionKey, sessionId, mediaRef: 'media://inbound/fictional-original' };
  let metadata;
  let service;
  const open = () => {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    service = createAuthoritativeSourceService({ metadata, root, capabilities: { notes: true, sessions: true },
      sessionStore: { getSessionEntry: () => ({ sessionId, updatedAt: 10 }), listSessionEntries: () => [{ sessionKey, entry: { sessionId, updatedAt: 10 } }] },
      api: { runtime: { media: { loadWebMedia: async () => ({ buffer: bytes, contentType: 'application/pdf', fileName: 'original.pdf' }) } } } });
  };
  open();
  metadata.createTopic({ topicId, name: 'Fictional filing', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-filing', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root, observedRevision: null });
  await enrollFixtureFolder(metadata, 'folder:fictional-filing', root);
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'session:fictional-filing', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: '10' }, state: { referenceId: 'session:fictional-filing', sessionId, status: 'open', isPrimary: true, displayName: 'Fictional' } });
  t.after(async () => { metadata.close(); await rm(directory, { recursive: true, force: true }); });
  return { root, directory, input, get metadata() { return metadata; }, get service() { return service; }, reopen() { metadata.close(); open(); } };
}

test('filing retry refuses an equal-byte foreign replacement after durable restart', linux, async t => {
  const f = await fixture(t);
  const filed = await f.service.documentsFileAttachment(f.input);
  const original = path.join(f.root, filed.value.document.path);
  await rename(original, path.join(f.directory, 'retained-original.pdf'));
  await writeFile(original, bytes);
  f.reopen();
  await assert.rejects(() => f.service.documentsFileAttachment(f.input), { code: 'conflict' });
  assert.deepEqual(await readFile(original), bytes);
  assert.deepEqual(await readFile(path.join(f.directory, 'retained-original.pdf')), bytes);
});
