import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import plugin from '../src/plugin.mjs';
import { readPinnedReconciliationPlan, registerReconciliationCli, runConfiguredHistoricalBackfill, runConfiguredNoteFolderRecovery, runConfiguredReconciliation, runConfiguredTopicPreparation } from '../src/migration/reconcile-cli.mjs';
import { reconciliationPlanDigest } from '../src/migration/reconcile.mjs';
import { historicalBackfillPlanDigest } from '../src/open-loops/historical-backfill.mjs';

test('CLI metadata declares lazy reconciliation without runtime activation', async () => {
  let registration; let declaration;
  plugin.register({ registrationMode: 'cli-metadata', registerCli(callback, metadata) { registration = callback; declaration = metadata; },
    get runtime() { throw new Error('No activation during discovery'); }, get notifications() { throw new Error('No notification authority'); } });
  assert.deepEqual(declaration.descriptors.map(item => item.name), ['command-center']);
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.cliCommands, declaration.descriptors, 'native command ownership must be discoverable before runtime registration');
  const paths = []; const actions = []; const required = [];
  const command = name => ({ command(child) { return command(`${name} ${child}`.trim()); }, description() { return this; },
    requiredOption(option) { required.push([name, option]); return this; }, action(callback) { paths.push(name); actions.push(callback); return this; } });
  await registration({ program: command(''), config: {}, logger: {} });
  assert.deepEqual(paths, [
    ...['reconcile', 'prepare-topic'].flatMap(command => ['preflight', 'execute', 'resume', 'verify'].map(mode => `command-center ${command} ${mode}`)),
    'command-center initialize-metadata execute', 'command-center initialize-metadata verify',
    ...['preflight', 'execute', 'verify'].map(mode => `command-center recover-note-folders ${mode}`),
    ...['preview', 'apply', 'withdraw'].map(mode => `command-center backfill ${mode}`),
    'command-center verify-discoverability'
  ]);
  assert.equal(required.length, 38); assert.equal(actions.length, 17);
});

test('historical backfill CLI runs a digest-pinned private adapter with durable metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backfill-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'plan.json');
  const adapterPath = path.join(root, 'adapter.mjs');
  const effectPath = path.join(root, 'effect.json');
  const plan = { schemaVersion: 1, backfillId: 'fictional-cli-preview', sourceKind: 'email', scope: { topicIds: [], topicNames: [], maxRecords: 1 } };
  const adapterSource = `import { existsSync, rmSync, writeFileSync } from 'node:fs';
  const effectPath = ${JSON.stringify(effectPath)};
  export function createHistoricalBackfillAdapter() { return {
    async readPage() { return { records: [{ schemaVersion: 1, sourceExternalId: 'fictional', sourceVersion: '1', checkpoint: '001' }], next: '001', done: true }; },
    async classify() { return { schemaVersion: 1, disposition: 'actionable', obligationId: 'fictional', title: 'Review fictional work' }; },
    async applyRecord() { writeFileSync(effectPath, '{"revision":1}'); return { disposition: 'created', effectId: 'loop:fictional', revision: 1 }; },
    async reconcileRecord() { return existsSync(effectPath) ? { status: 'applied', result: { disposition: 'created', effectId: 'loop:fictional', revision: 1 } } : { status: 'not-applied' }; },
    async inspectEffect() { return existsSync(effectPath) ? { revision: 1, userDecided: false } : null; },
    async withdrawEffect() { rmSync(effectPath); return { status: 'applied' }; },
    async reconcileWithdrawal() { return existsSync(effectPath) ? { status: 'not-applied' } : { status: 'applied' }; },
    async recordReceipt() {}
  }; }\n`;
  await writeFile(planPath, JSON.stringify(plan)); await writeFile(adapterPath, adapterSource);
  const adapterDigest = `sha256:${(await import('node:crypto')).createHash('sha256').update(adapterSource).digest('hex')}`;
  const saved = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = root;
  try {
    const result = await runConfiguredHistoricalBackfill({ mode: 'preview', planPath, expectedDigest: historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: adapterDigest, config: {} });
    assert.equal(result.complete, true); assert.equal(result.counts.created, 0);
    const applied = await runConfiguredHistoricalBackfill({ mode: 'apply', planPath, expectedDigest: historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: adapterDigest, config: {} });
    assert.equal(applied.counts.created, 1);
    const withdrawn = await runConfiguredHistoricalBackfill({ mode: 'withdraw', planPath, expectedDigest: historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: adapterDigest, config: {} });
    assert.equal(withdrawn.counts.withdrawn, 1);
    await assert.rejects(runConfiguredHistoricalBackfill({ mode: 'preview', planPath, expectedDigest: historicalBackfillPlanDigest(plan), adapterPath, expectedAdapterDigest: `sha256:${'0'.repeat(64)}`, config: {} }), { code: 'backfill-adapter-digest-mismatch' });
  } finally { if (saved === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = saved; }
});

test('Note Folder recovery CLI rejects an unpinned or noncanonical plan before opening metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-recovery-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'plan.json');
  const plan = { schemaVersion: 1, purpose: 'command-center-note-folder-recovery', stateDirectory: root, bindings: [] };
  await writeFile(planPath, JSON.stringify(plan));
  const saved = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = root;
  try {
    await assert.rejects(runConfiguredNoteFolderRecovery({ mode: 'execute', planPath, expectedDigest: reconciliationPlanDigest(plan), config: { plugins: { entries: { 'command-center': { config: { topics: { noteRoot: root } } } } } } }), { code: 'note-folder-recovery-plan-invalid' });
  } finally { if (saved === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = saved; }
});

test('a noncanonical preparation name is refused before native SDK or metadata initialization', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prepare-cli-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'plan.json');
  const saved = Object.fromEntries(['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_HOME'].map(key => [key, process.env[key]]));
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'openclaw.json');
  process.env.OPENCLAW_HOME = root;
  try {
  const plan = { schemaVersion: 1, logicalOperationId: randomUUID(), topicId: randomUUID(), name: ' Garden ', paraCategory: 'area',
    folderPath: path.join(root, 'Areas', 'Garden'), noteVaultRoots: [root], protectedSessions: [
      { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'fictional-main', lifecycleRevision: null }
    ] };
  await writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(runConfiguredTopicPreparation({ mode: 'execute', planPath, expectedDigest: reconciliationPlanDigest(plan),
    config: { plugins: { entries: { 'command-center': { config: { topics: { noteRoot: root } } } } } } }), { code: 'preparation-plan-invalid' });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('private plan reads are bounded, digest-pinned and cannot enable import without a configured reader', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reconcile-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'plan.json');
  const plan = { schemaVersion: 1, sourceOptions: { root: '/fictional/preserved-source' } };
  const digest = reconciliationPlanDigest(plan);
  await writeFile(filename, JSON.stringify(plan));
  assert.deepEqual(await readPinnedReconciliationPlan(filename, digest), plan);
  await assert.rejects(readPinnedReconciliationPlan(filename, '0'.repeat(64)), { code: 'reconciliation-plan-digest-mismatch' });
  await assert.rejects(runConfiguredReconciliation({ mode: 'execute', planPath: filename, expectedDigest: digest, config: {} }), { code: 'reconciliation-reader-not-configured' });
  await writeFile(filename, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(readPinnedReconciliationPlan(filename, digest), { code: 'reconciliation-plan-unsafe' });
});
