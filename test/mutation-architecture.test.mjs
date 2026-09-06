import assert from 'node:assert/strict';
import test from 'node:test';
import { auditMutationArchitecture, checkMutationArchitecture } from '../scripts/mutation-architecture.mjs';

const owner = { id: 'notes', module: 'src/sources/notes.mjs', commands: ['notes.edit'], tests: ['test/note-adapter.test.mjs'], gaps: ['I03'] };
const fixture = (source, overrides = {}) => ({
  files: new Map([['src/native-ui/editor.mjs', source], [owner.module, ''], [owner.tests[0], '']]),
  writeMethods: ['command-center.v1.notes.edit'], owners: [owner], ...overrides
});

test('architecture refuses a UI filesystem write instead of silently accepting a bypass', () => {
  const errors = auditMutationArchitecture(fixture("import { writeFile } from 'node:fs/promises'; await writeFile('note.md', 'bypass');"));
  assert.ok(errors.some((error) => error.includes('forbidden effect import')));
});

test('architecture refuses direct metadata mutation and native Cron dispatch in transports', () => {
  assert.ok(auditMutationArchitecture(fixture('service.metadata.updateTopic(input);')).some((error) => error.includes('metadata mutation')));
  assert.ok(auditMutationArchitecture(fixture("host.request('cron.update', input);")).some((error) => error.includes('native mutation')));
});

test('architecture refuses native conversation writes and the host database effect import', () => {
  for (const method of ['sessions.create', 'chat.send']) {
    assert.ok(auditMutationArchitecture(fixture(`host.request('${method}', input);`)).some((error) => error.includes('native mutation')), method);
  }
  assert.ok(auditMutationArchitecture(fixture("import { openDatabaseSync } from 'openclaw/plugin-sdk/sqlite-runtime';")).some((error) => error.includes('forbidden effect import')));
});

test('architecture refuses direct domain adapter imports from UI even with an alias', () => {
  assert.ok(auditMutationArchitecture(fixture("import { NoteAdapter as Writer } from '../sources/notes.mjs';")).some((error) => error.includes('owning implementation')));
});

test('new write commands require one owner and existing regression files', () => {
  assert.ok(auditMutationArchitecture(fixture('', { writeMethods: ['command-center.v1.notes.delete'] })).some((error) => error.includes('unowned write')));
  assert.ok(auditMutationArchitecture(fixture('', { owners: [owner, { ...owner, id: 'duplicate' }] })).some((error) => error.includes('multiple owners')));
  assert.ok(auditMutationArchitecture(fixture('', { owners: [{ ...owner, tests: ['test/missing.test.mjs'] }] })).some((error) => error.includes('missing regression')));
});

test('closed domain delegation is allowed; recorded gaps are not passing-proof claims', () => {
  assert.deepEqual(auditMutationArchitecture(fixture("await host.request('command-center.v1.notes.edit', input);")), []);
  assert.deepEqual(auditMutationArchitecture(fixture("if (action === 'chat.send') return service.sessionsSend(input); const actions = { 'sessions.create': ['label'] };")), []);
  assert.ok(auditMutationArchitecture(fixture("dispatch({ method: 'chat.send', params: input });")).some((error) => error.includes('native mutation')));
});

test('current registered writes have owners and transports do not bypass them', async () => {
  await checkMutationArchitecture(new URL('../', import.meta.url));
});

test('native HTTP actions require one catalogue owner, including reconcile-only actions', () => {
  const route = '/plugins/command-center/api/topic/actions';
  const surface = { route, module: 'src/topics/page-http.mjs', actions: ['notes.edit', 'notes.edit.reconcile'] };
  const catalogue = [{ route, action: 'notes.edit', owner: 'notes', mode: 'write' }];
  const options = fixture('', { httpSurfaces: [surface], nativeWriteRoutes: [route], httpCommands: catalogue });
  options.files.set(surface.module, '');
  assert.ok(auditMutationArchitecture(options).some((error) => error.includes('unowned HTTP action') && error.includes('notes.edit.reconcile')));
  const complete = [...catalogue, { route, action: 'notes.edit.reconcile', owner: 'notes', mode: 'reconcile' }];
  assert.deepEqual(auditMutationArchitecture({ ...options, httpCommands: complete }), []);
  assert.ok(auditMutationArchitecture({ ...options, httpCommands: [...complete, complete[0]] }).some((error) => error.includes('multiple HTTP owners')));
  assert.ok(auditMutationArchitecture({ ...options, httpCommands: [...complete, { route, action: 'notes.delete', owner: 'notes', mode: 'write' }] }).some((error) => error.includes('unregistered HTTP action')));
});

test('architecture checks the current native manifest and actual closed HTTP action vocabularies', async () => {
  const result = await checkMutationArchitecture(new URL('../', import.meta.url));
  assert.equal(result.httpRoutes, 5);
  assert.equal(result.httpActions, 34);
});

test('new native routes and invalid HTTP ownership cannot evade the catalogue', () => {
  const route = '/plugins/command-center/api/topic/actions';
  const surface = { route, module: 'src/topics/page-http.mjs', actions: ['notes.edit'] };
  const command = { route, action: 'notes.edit', owner: 'notes', mode: 'write' };
  const options = fixture('', { httpSurfaces: [surface], nativeWriteRoutes: [route], httpCommands: [command] });
  options.files.set(surface.module, '');
  assert.ok(auditMutationArchitecture({ ...options, nativeWriteRoutes: [route, '/new-write'] }).some((error) => error.includes('uninventoried HTTP write route')));
  assert.ok(auditMutationArchitecture({ ...options, nativeWriteRoutes: [] }).some((error) => error.includes('undeclared HTTP write route')));
  assert.ok(auditMutationArchitecture({ ...options, httpCommands: [{ ...command, owner: 'missing' }] }).some((error) => error.includes('unknown HTTP owner')));
  assert.ok(auditMutationArchitecture({ ...options, httpCommands: [{ ...command, mode: 'unchecked' }] }).some((error) => error.includes('invalid HTTP mode')));
});
