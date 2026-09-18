import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { NoteAdapter } from '../../src/sources/notes.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../../src/sources/service.mjs';
import { enrollNoteFolderIdentity } from '../../src/sources/note-folder-identity.mjs';

export async function openFixture(stateDir, hooks = {}) {
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  const { beforeObservation, ...adapterHooks } = hooks;
  const observedMetadata = beforeObservation ? new Proxy({ ...metadata }, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === 'observeSourceReference' || key === 'createSourceReference') return async (input) => { await beforeObservation(input); return value(input); };
    return value;
  } }) : metadata;
  const coordinator = process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME
    ? (await import(process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME)).tryAcquireExclusiveSqliteCoordinator
    : undefined;
  const options = { metadata: observedMetadata, topicId: 'fictional-recovery', root: path.join(stateDir, 'vault'),
    tryAcquireExclusiveSqliteCoordinator: coordinator,
    fsSafeRootFactory: async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative) }), ...adapterHooks };
  const adapter = new NoteAdapter(options);
  const service = createAuthoritativeSourceService({ ...options, capabilities: { notes: true } });
  return { adapter, service, metadata, async enroll() {
    const observedRevision = await enrollNoteFolderIdentity(options.root);
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-folder', topicId: 'fictional-recovery', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: options.root });
    metadata.setSourceLocator({ referenceId: 'fictional-folder', locator: options.root, ownership: 'adopted', observedRevision });
  }, close() { adapter.close(); for (const topic of service.topicServices.values()) topic.notes?.close(); metadata.close(); } };
}

if (process.argv[2] === 'child') {
  const [stateDir, operation, boundary, logicalOperationId, expectedRevision, seam = 'adapter'] = process.argv.slice(3);
  const die = () => { writeSync(1, 'boundary-reached\n'); process.kill(process.pid, 'SIGKILL'); };
  const fixture = await openFixture(stateDir, { beforeObservation: boundary === 'metadata' ? async (reference) => {
    if (reference.observedRevision === expectedRevision) return;
    const root = path.join(stateDir, 'vault'); const claim = (await fs.readdir(root)).find((name) => name.includes('.command-center-claim-'));
    if (!claim) return;
    await fs.writeFile(path.join(root, claim), 'late original-descriptor write'); die();
  } : undefined, afterSourceClaim: boundary === 'held' ? async () => {
    writeSync(1, 'writer-held\n'); await new Promise(() => { setInterval(() => {}, 1_000); });
  } : undefined, beforeAtomicCommit: boundary === 'create-prepared' ? die : undefined, afterAtomicPublish: boundary === 'published' ? die : boundary === 'rollback-foreign' ? async () => {
    const target = path.join(stateDir, 'vault', operation === 'edit' ? 'original.md' : 'nested/moved.md');
    await fs.rename(target, path.join(stateDir, 'published-result.md'));
    await fs.writeFile(target, 'foreign', { flag: 'wx' });
    throw new Error('A foreign publication interrupts the Note operation.');
  } : undefined });
  if (['claimed', 'foreign-claim', 'rollback-foreign'].includes(boundary)) {
    const originalRename = fs.rename;
    fs.rename = async (source, target) => {
      if (boundary === 'foreign-claim' && String(target).includes('.command-center-claim-')) {
        await originalRename(source, path.join(stateDir, 'vault/external-original.md'));
        await fs.writeFile(source, 'original', { flag: 'wx' });
      }
      await originalRename(source, target);
      if (boundary === 'rollback-foreign' ? String(target).includes('.command-center-preserved-') : String(target).includes('.command-center-claim-')) die();
    };
    syncBuiltinESMExports();
  }
  if (['create-published', 'create-attempting'].includes(boundary)) {
    const originalLink = fs.link;
    fs.link = async (source, target) => {
      if (boundary === 'create-attempting' && String(target).endsWith('/original.md')) die();
      await originalLink(source, target);
      if (String(target).endsWith('/original.md')) die();
    };
    syncBuiltinESMExports();
  }
  const input = operation === 'create' ? { path: 'original.md', text: 'replacement', logicalOperationId, referenceId: 'fictional-folder' }
    : { path: 'original.md', destinationPath: 'nested/moved.md', text: 'replacement', expectedRevision, logicalOperationId };
  if (seam === 'service') await fixture.service[`notes${operation[0].toUpperCase()}${operation.slice(1)}`]({ ...input, topicId: 'fictional-recovery' });
  else await fixture.adapter[operation](input);
  throw new Error('The child missed the required process-death boundary.');
}
