import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { createTopicPageActionsHandler } from '../src/topics/page-http.mjs';
import { enrollNoteFolderIdentity } from '../src/sources/note-folder-identity.mjs';

// Actual SQLite, filesystem coordinator and TCP body/response seam. Authentication
// remains the host relay's boundary; this fixture does not claim host activation.
async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'note-reconcile-http-'));
  const root = path.join(stateDir, 'vault'); await mkdir(root); await writeFile(path.join(root, 'brief.md'), 'original');
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  const topicId = randomUUID(); metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'folder:fixture', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root });
  metadata.setSourceLocator({ referenceId: 'folder:fixture', locator: root, observedRevision: await enrollNoteFolderIdentity(root) });
  const service = createAuthoritativeSourceService({ metadata, root, capabilities: { notes: true },
    fsSafeRootFactory: async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative) }) });
  const note = await service.notesRead({ topicId, path: 'brief.md' });
  service.topics = { get: (id) => metadata.getTopic(id) };
  const server = createServer(createTopicPageActionsHandler(service));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const input = { schemaVersion: 1, action: 'notes.edit', topicId, referenceId: note.sourceReference.referenceId, path: 'brief.md', contentBase64: Buffer.from('submitted').toString('base64'), expectedRevision: note.revision, expectedTopicRevision: metadata.getTopic(topicId).revision, logicalOperationId: randomUUID() };
  const post = async (body) => { const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  try { await run({ metadata, service, input, post, root, stateDir }); }
  finally { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); for (const topic of service.topicServices.values()) topic.notes?.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('reconcile-only classifies an unsubmitted save without writing it', { skip: process.platform !== 'linux' }, () => fixture(async ({ input, post, root, metadata }) => {
  const before = await stat(path.join(root, input.path));
  const response = await post({ ...input, action: 'notes.edit.reconcile' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'not-applied');
  assert.equal(response.body.logicalOperationId, input.logicalOperationId);
  assert.equal(response.body.result.path, input.path);
  assert.equal(await readFile(path.join(root, input.path), 'utf8'), 'original');
  assert.equal((await stat(path.join(root, input.path))).ino, before.ino);
  assert.equal(metadata.getOperation(input.logicalOperationId), null);
}));

function creation(input) {
  return { schemaVersion: 1, action: 'notes.create', topicId: input.topicId, referenceId: 'folder:fixture', path: 'new.md', contentBase64: input.contentBase64, expectedTopicRevision: input.expectedTopicRevision, logicalOperationId: input.logicalOperationId };
}

test('create reconciliation without an owned witness stays unknown and never creates a Note', { skip: process.platform !== 'linux' }, () => fixture(async ({ input, post, root, metadata }) => {
  const command = { ...creation(input), action: 'notes.create.reconcile' };
  const response = await post(command);
  assert.equal(response.status, 422);
  assert.equal(response.body.code, 'unknown');
  assert.equal(response.body.message, 'The Note save outcome is still unknown.');
  await assert.rejects(stat(path.join(root, command.path)), { code: 'ENOENT' });
  assert.equal(metadata.getOperation(command.logicalOperationId), null);
}));

test('create reconciliation confirms the exact owned Note after a Topic revision change without recreating it', { skip: process.platform !== 'linux' }, () => fixture(async ({ input, post, root, metadata }) => {
  const command = creation(input);
  const created = await post(command); assert.equal(created.status, 200);
  const before = await stat(path.join(root, command.path));
  metadata.updateTopic({ topicId: input.topicId, paraCategory: 'archive' });
  const reconciled = await post({ ...command, action: 'notes.create.reconcile' });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.status, 'applied');
  assert.equal(reconciled.body.result.referenceId, created.body.result.referenceId);
  assert.equal(reconciled.body.result.revision, created.body.result.revision);
  assert.equal((await stat(path.join(root, command.path))).ino, before.ino);
  assert.equal((await post({ ...command, logicalOperationId: randomUUID() })).status, 409);
  assert.notEqual((await post({ ...command, action: 'notes.create.reconcile', contentBase64: Buffer.from('different').toString('base64') })).status, 200);
  assert.equal(await readFile(path.join(root, command.path), 'utf8'), 'submitted');
}));

test('reconcile-only confirms the exact save after a Topic revision change without resaving', { skip: process.platform !== 'linux' }, () => fixture(async ({ input, post, root, metadata }) => {
  const applied = await post(input); assert.equal(applied.status, 200);
  const before = await stat(path.join(root, input.path));
  metadata.updateTopic({ topicId: input.topicId, paraCategory: 'archive' });
  const response = await post({ ...input, action: 'notes.edit.reconcile' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'applied');
  assert.equal(response.body.result.revision, applied.body.result.revision);
  assert.equal((await stat(path.join(root, input.path))).ino, before.ino);
  assert.equal(await readFile(path.join(root, input.path), 'utf8'), 'submitted');
  assert.equal((await post({ ...input, logicalOperationId: randomUUID() })).status, 409);
}));

test('reconcile-only rejects changed intent and never assigns a later edit to the old operation', { skip: process.platform !== 'linux' }, () => fixture(async ({ input, post, root }) => {
  assert.equal((await post(input)).status, 200);
  assert.notEqual((await post({ ...input, action: 'notes.edit.reconcile', contentBase64: Buffer.from('different').toString('base64') })).status, 200);
  await writeFile(path.join(root, input.path), 'later external edit');
  assert.equal((await post({ ...input, action: 'notes.edit.reconcile' })).status, 409);
  assert.equal(await readFile(path.join(root, input.path), 'utf8'), 'later external edit');
}));

test('reconciliation rechecks current Topic ownership and rejects extra fields without exposing content', { skip: process.platform !== 'linux' }, () => fixture(async ({ input, post, metadata }) => {
  assert.equal((await post(input)).status, 200);
  assert.equal((await post({ ...input, action: 'notes.edit.reconcile', listOperations: true })).status, 400);
  const foreignTopicId = randomUUID(); metadata.createTopic({ topicId: foreignTopicId, paraCategory: 'project', lifecycle: 'active' });
  const response = await post({ ...input, action: 'notes.edit.reconcile', topicId: foreignTopicId });
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(JSON.stringify(response.body), /submitted|original/);
  assert.equal(metadata.getOperation(input.logicalOperationId).state, 'applied');
}));

test('an unknown reconciliation never reports that the save was not applied', { skip: process.platform !== 'linux' }, () => fixture(async ({ input, post, root }) => {
  await rm(path.join(root, input.path));
  const response = await post({ ...input, action: 'notes.edit.reconcile' });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, 'unknown');
  assert.equal(response.body.message, 'The Note save outcome is still unknown.');
}));

for (const operation of ['edit', 'create']) test(`reconcile-only finishes an inode-proven ${operation} after actual process death before either completion receipt`, { skip: process.platform !== 'linux', timeout: 30000 }, () => fixture(async ({ input, post, root, stateDir, metadata }) => {
  const command = operation === 'create' ? creation(input) : input;
  const childInput = { schemaVersion: 1, topicId: command.topicId, referenceId: command.referenceId, path: command.path, text: 'submitted', ...(operation === 'edit' ? { expectedRevision: command.expectedRevision } : {}), logicalOperationId: command.logicalOperationId };
  const source = `
    import { openCommandCenterMetadataService } from './src/metadata/service.mjs';
    import { createAuthoritativeSourceService } from './src/sources/service.mjs';
    import path from 'node:path';
    const [stateDir, root, inputJson, operation] = process.argv.slice(1);
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    const service = createAuthoritativeSourceService({ metadata, root, capabilities: { notes: true },
      fsSafeRootFactory: async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative) }),
      afterAtomicPublish: () => process.kill(process.pid, 'SIGKILL') });
    await service[operation === 'create' ? 'notesCreate' : 'notesEdit'](JSON.parse(inputJson));
    throw new Error('Process did not reach the publication boundary');`;
  const child = spawn(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', '--input-type=module', '-e', source, stateDir, root, JSON.stringify(childInput), operation], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(exit.signal, 'SIGKILL', stderr);
  assert.equal(metadata.getOperation(input.logicalOperationId).state, 'pending');
  assert.equal(metadata.getTopicOperation(`notes.fs:${input.logicalOperationId}`).state, 'pending');
  const published = await stat(path.join(root, command.path));
  const response = await post({ ...command, action: `${command.action}.reconcile` });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'applied');
  assert.equal((await stat(path.join(root, command.path))).ino, published.ino);
  if (operation === 'create') assert.notEqual(response.body.result.referenceId, command.referenceId);
  assert.equal(metadata.getOperation(input.logicalOperationId).state, 'applied');
  assert.equal(metadata.getTopicOperation(`notes.fs:${input.logicalOperationId}`).state, 'applied');
  assert.equal(await readFile(path.join(root, command.path), 'utf8'), 'submitted');
}));
