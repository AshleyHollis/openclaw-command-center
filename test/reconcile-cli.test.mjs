import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import plugin from '../src/plugin.mjs';
import { readPinnedReconciliationPlan, registerReconciliationCli, runConfiguredReconciliation, runConfiguredTopicPreparation } from '../src/migration/reconcile-cli.mjs';
import { reconciliationPlanDigest } from '../src/migration/reconcile.mjs';

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
  assert.deepEqual(paths, ['reconcile', 'prepare-topic'].flatMap(command => ['preflight', 'execute', 'resume', 'verify'].map(mode => `command-center ${command} ${mode}`)));
  assert.equal(required.length, 16); assert.equal(actions.length, 8);
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
