import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { projectionId } from '../src/metadata/projections.mjs';
import { resolveCommandCenterProjectionRoot } from '../src/metadata/path.mjs';

const services = new Set();
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const sourceSnapshot = (revision = 'fictional-v1') => Object.freeze({
  sourceRevision: revision,
  noteFolders: Object.freeze([{ identity: 'folder-fictional', contentDigest: digest('folder') }]),
  sessions: Object.freeze([{ identity: 'session-fictional', contentDigest: digest('session') }]),
  reminderSchedules: Object.freeze([{ identity: 'schedule-fictional', contentDigest: digest('schedule') }]),
  importedHistory: Object.freeze([{ identity: 'history-fictional', contentDigest: digest('history') }])
});
const provider = (snapshot = sourceSnapshot()) => Object.freeze({ readSnapshot: () => snapshot });

async function withState(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-projection-'));
  try { return await run(stateDir); } finally { for (const service of services) service.close(); services.clear(); await rm(stateDir, { recursive: true, force: true }); }
}
function open(stateDir) { const service = openCommandCenterMetadataService({ stateDir }); services.add(service); return service; }
function seed(service) {
  const at = '2026-08-22T00:00:00.000Z';
  service.createTopic({ topicId: 'topic-fictional', paraCategory: 'project', lifecycle: 'active', createdAt: at, updatedAt: at });
  service.setPresentationPreferences({ topicId: 'topic-fictional', displayLabel: 'Fictional Topic', sortOrder: 1, collapsed: false, updatedAt: at });
  for (const [referenceId, sourceSystem, sourceKind, externalSourceId] of [['folder', 'obsidian', 'note_folder', 'folder-fictional'], ['session', 'openclaw', 'session', 'session-fictional'], ['schedule', 'scheduler', 'reminder_schedule', 'schedule-fictional'], ['history', 'openclaw', 'imported_history', 'history-fictional']]) service.createSourceReference({ referenceId, topicId: 'topic-fictional', sourceSystem, sourceKind, externalSourceId, createdAt: at, updatedAt: at });
}
function authority(service, snapshot) { return { metadata: service.readProjectionSnapshot(), source: structuredClone(snapshot), bookkeeping: service.listProjectionBookkeeping() }; }

test('deleting projections preserves authority and rebuilding is equivalent', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service); const sources = sourceSnapshot();
  await service.rebuildProjections({ authoritativeSources: provider(sources) });
  const before = service.queryProjections(); const checkpoint = service.getProjectionBookkeeping(projectionId); const frozen = authority(service, sources);
  assert.equal(service.deleteDerivedProjections(), true); assert.equal(service.deleteDerivedProjections(), true);
  assert.deepEqual(authority(service, sources), frozen); assert.deepEqual(service.getProjectionBookkeeping(projectionId), checkpoint);
  await service.rebuildProjections({ authoritativeSources: provider(Object.freeze({ ...sources, noteFolders: [...sources.noteFolders].reverse(), sessions: [...sources.sessions].reverse() })) });
  assert.deepEqual(service.queryProjections(), before);
  assert.deepEqual(service.getProjectionBookkeeping(projectionId), checkpoint);
}));

test('commits one deterministic checkpoint and bounded progress', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service); const events = [];
  const checkpoint = await service.rebuildProjections({ authoritativeSources: provider(), onProgress: (event) => events.push(event) });
  assert.equal(checkpoint.projectionId, projectionId); assert.match(checkpoint.inputDigest, /^sha256:[0-9a-f]{64}$/); assert.match(checkpoint.sourceRevision, /^importedHistory:fictional-v1\|noteFolders:fictional-v1\|reminderSchedules:fictional-v1\|sessions:fictional-v1$/);
  assert.deepEqual(events.map(({ phase, completed, total }) => ({ phase, completed, total })), [{ phase: 'validate', completed: 0, total: 3 }, { phase: 'build', completed: 1, total: 3 }, { phase: 'publish', completed: 2, total: 3 }, { phase: 'complete', completed: 3, total: 3 }]);
  const again = await service.rebuildProjections({ authoritativeSources: provider() }); assert.deepEqual(again, checkpoint);
  assert.equal(service.listProjectionBookkeeping().filter((row) => row.projectionId === projectionId).length, 1);
  const generation = JSON.parse(await readFile(path.join(resolveCommandCenterProjectionRoot(stateDir), 'committed.json')));
  assert.deepEqual(Object.keys(generation.results).sort(), ['cache', 'index', 'summary']); assert.equal('authoritativeSources' in generation, false);
}));

test('concurrent retries are duplicate-free and a changed revision creates one new checkpoint', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service);
  const results = await Promise.all(Array.from({ length: 4 }, () => service.rebuildProjections({ authoritativeSources: provider() })));
  assert.ok(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0])));
  const first = results[0];
  const changed = await service.rebuildProjections({ authoritativeSources: provider(sourceSnapshot('fictional-v2')) });
  assert.notEqual(changed.inputDigest, first.inputDigest); assert.notEqual(changed.sourceRevision, first.sourceRevision);
  assert.equal(service.listProjectionBookkeeping().filter((row) => row.projectionId === projectionId).length, 1);
  const result = service.queryProjections(); assert.deepEqual([...result.cache].map((item) => item.topicId), ['topic-fictional']); assert.equal(new Set(result.index.map((item) => item.referenceId)).size, result.index.length);
}));

test('missing and inconsistent source inputs fail closed with bounded diagnostics', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service); const before = service.listProjectionBookkeeping();
  for (const field of ['noteFolders', 'sessions', 'reminderSchedules', 'importedHistory']) {
    const missing = { ...sourceSnapshot() }; delete missing[field];
    await assert.rejects(service.rebuildProjections({ authoritativeSources: provider(missing) }), (error) => error.code === 'missing-source');
    assert.equal(service.getProjectionStatus().diagnostics[0].code, 'projection-source-unavailable'); assert.deepEqual(service.listProjectionBookkeeping(), before);
  }
  const malformed = { ...sourceSnapshot(), sessions: { sourceRevision: 'fictional-v1', records: 'not-an-array' } };
  await assert.rejects(service.rebuildProjections({ authoritativeSources: provider(malformed) }), (error) => error.code === 'source-inconsistent');
  const inconsistent = { ...sourceSnapshot(), sessions: [{ identity: 'session-fictional', contentDigest: 'not-a-digest' }] };
  await assert.rejects(service.rebuildProjections({ authoritativeSources: provider(inconsistent) }), (error) => error.code === 'source-inconsistent');
  const status = service.getProjectionStatus(); assert.equal(status.diagnostics[0].code, 'projection-source-inconsistent'); assert.ok(status.diagnostics.every((item) => Object.values(item).filter((value) => typeof value === 'string').every((value) => value.length <= 300)));
  const conflict = { ...sourceSnapshot(), sessions: [{ identity: 'session-fictional', contentDigest: digest('session') }, { identity: 'session-fictional', contentDigest: digest('other') }] };
  await assert.rejects(service.rebuildProjections({ authoritativeSources: provider(conflict) }), (error) => error.code === 'source-inconsistent');
  const revisionConflict = { ...sourceSnapshot(), sessions: [{ identity: 'session-fictional', contentDigest: digest('session'), sourceRevision: 'fictional-v2' }] };
  await assert.rejects(service.rebuildProjections({ authoritativeSources: provider(revisionConflict) }), (error) => error.code === 'source-inconsistent');
  const declaredRevisionConflict = Object.fromEntries(Object.entries(sourceSnapshot()).map(([field, value]) => ['sourceRevision', 'fictional-v1'].includes(field) ? [field, value] : [field, { sourceRevision: 'fictional-v2', records: value }]));
  await assert.rejects(service.rebuildProjections({ authoritativeSources: provider(declaredRevisionConflict) }), (error) => error.code === 'source-inconsistent');
}));

test('the same opaque external ID is valid in distinct canonical source categories', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service);
  service.deleteSourceReference('session');
  service.createSourceReference({ referenceId: 'session', topicId: 'topic-fictional', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'folder-fictional', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
  const sources = { ...sourceSnapshot(), sessions: [{ identity: 'folder-fictional', contentDigest: digest('session') }] };
  await service.rebuildProjections({ authoritativeSources: provider(sources) });
  assert.deepEqual(service.queryProjections().index.filter((row) => row.externalSourceId === 'folder-fictional').map((row) => [row.sourceSystem, row.sourceKind]), [['obsidian', 'note_folder'], ['openclaw', 'session']]);
}));

test('projection operations leave every authoritative fixture fact unchanged', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service); const sourcePath = path.join(stateDir, 'fictional-authority.json'); await writeFile(sourcePath, JSON.stringify(sourceSnapshot()));
  const sourceProvider = Object.freeze({ readSnapshot: async () => JSON.parse(await readFile(sourcePath, 'utf8')) });
  const before = digest(await readFile(sourcePath));
  await service.rebuildProjections({ authoritativeSources: sourceProvider });
  service.deleteDerivedProjections();
  await assert.rejects(service.rebuildProjections({ authoritativeSources: provider({ ...sourceSnapshot(), importedHistory: [{ identity: 'history-fictional', contentDigest: 'bad' }] }) }));
  await service.rebuildProjections({ authoritativeSources: sourceProvider });
  assert.equal(digest(await readFile(sourcePath)), before);
}));

test('projection root refuses a symlinked in-tree component', async () => withState(async (stateDir) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'command-center-outside-'));
  try {
    await mkdir(path.join(stateDir, 'plugins'), { recursive: true });
    await symlink(outside, path.join(stateDir, 'plugins', 'command-center'), 'dir');
    assert.throws(() => resolveCommandCenterProjectionRoot(stateDir), /owned in-tree directory/);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('deletion refuses a parent directory replaced by a symlink', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service); await service.rebuildProjections({ authoritativeSources: provider() });
  const commandCenter = path.join(stateDir, 'plugins', 'command-center');
  const preserved = path.join(stateDir, 'plugins', 'command-center-preserved');
  const victim = await mkdtemp(path.join(os.tmpdir(), 'command-center-victim-'));
  try {
    await rename(commandCenter, preserved);
    await symlink(victim, commandCenter, 'dir');
    await assert.throws(() => service.deleteDerivedProjections(), /owned in-tree directory/);
    assert.deepEqual(await readdir(victim), []);
  } finally { await rm(victim, { recursive: true, force: true }); }
}));

test('a tampered committed result is gated and rebuilt from current inputs', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service); await service.rebuildProjections({ authoritativeSources: provider() });
  const generationPath = path.join(resolveCommandCenterProjectionRoot(stateDir), 'committed.json');
  const generation = JSON.parse(await readFile(generationPath)); generation.results.index.push({ ...generation.results.index[0], referenceId: 'invented-reference' });
  await writeFile(generationPath, JSON.stringify(generation));
  assert.throws(() => service.queryProjections(), (error) => error.code === 'projection-unavailable');
  await service.rebuildProjections({ authoritativeSources: provider() });
  assert.equal(service.queryProjections().index.length, 4);
}));

test('restart rebuild replaces a symlinked committed artifact without querying it', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service); await service.rebuildProjections({ authoritativeSources: provider() });
  const root = resolveCommandCenterProjectionRoot(stateDir); const generationPath = path.join(root, 'committed.json');
  const outside = path.join(stateDir, 'outside-generation.json'); await writeFile(outside, await readFile(generationPath));
  await rm(generationPath); await symlink(outside, generationPath, 'file');
  service.close(); services.delete(service);
  const reopened = open(stateDir);
  assert.throws(() => reopened.queryProjections(), (error) => error.code === 'projection-unavailable');
  await reopened.rebuildProjections({ authoritativeSources: provider() });
  assert.equal((await lstat(generationPath)).isSymbolicLink(), false);
  assert.equal(reopened.queryProjections().index.length, 4);
}));

test('restart rebuild repairs a reordered committed result before exposing queries', async () => withState(async (stateDir) => {
  const service = open(stateDir); seed(service); await service.rebuildProjections({ authoritativeSources: provider() });
  const generationPath = path.join(resolveCommandCenterProjectionRoot(stateDir), 'committed.json');
  const generation = JSON.parse(await readFile(generationPath)); generation.results.index.reverse();
  await writeFile(generationPath, JSON.stringify(generation)); service.close(); services.delete(service);
  const reopened = open(stateDir);
  await reopened.rebuildProjections({ authoritativeSources: provider() });
  assert.deepEqual(reopened.queryProjections().index.map((row) => row.referenceId), ['folder', 'history', 'session', 'schedule']);
}));

test('crash boundaries never expose a partial query and restart converges', async () => {
  for (const point of ['validation', 'write', 'publication', 'bookkeeping']) await withState(async (stateDir) => {
    const service = open(stateDir); seed(service); service.close(); services.delete(service);
    const sourcePath = path.join(stateDir, 'fictional-authority.json'); await writeFile(sourcePath, JSON.stringify(sourceSnapshot()));
    const before = digest(await readFile(sourcePath));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/projection-crash.mjs', import.meta.url)), stateDir, point, sourcePath], { encoding: 'utf8', env: { ...process.env, COMMAND_CENTER_PROJECTION_CRASH_AT: point } });
    assert.equal(child.signal, 'SIGKILL');
    const reopened = open(stateDir); assert.throws(() => reopened.queryProjections(), (error) => error.code === 'projection-unavailable');
    await reopened.rebuildProjections({ authoritativeSources: provider() });
    assert.equal(reopened.queryProjections().index.length, 4); assert.equal(reopened.listProjectionBookkeeping().filter((row) => row.projectionId === projectionId).length, 1);
    const entries = await readdir(resolveCommandCenterProjectionRoot(stateDir)); assert.deepEqual(entries, ['committed.json']);
    assert.equal(digest(await readFile(sourcePath)), before);
  });
});
