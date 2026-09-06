import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { TopicProvisioningService } from '../../src/topics/provisioning.mjs';
import { runConfiguredTopicPreparation } from '../../src/migration/reconcile-cli.mjs';
import { reconciliationPlanDigest } from '../../src/migration/reconcile.mjs';
import { copyBuiltPluginForNativeCli, parseNativeCliSummary } from './native-cli-plugin.mjs';

const realCli = process.env.COMMAND_CENTER_REHEARSAL_REAL_CLI === '1';
async function executeNativePreparation(t, { stateDir, config, planPath, expectedDigest }) {
  const pluginRoot = await copyBuiltPluginForNativeCli(stateDir);
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ ...config,
    agents: { defaults: { workspace: path.join(stateDir, 'workspace') } },
    plugins: { ...config.plugins, allow: ['command-center'], load: { paths: [pluginRoot] } }
  }));
  const launcher = path.join(path.dirname(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE), 'openclaw.mjs');
  const child = spawn(process.execPath, [launcher, 'command-center', 'prepare-topic', 'execute', '--plan', planPath, '--digest', expectedDigest], {
    cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCLAW_HOME: stateDir, OPENCLAW_NO_RESPAWN: '1', NODE_DISABLE_COMPILE_CACHE: '1' }
  });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  t.after(async () => { stop(); await closed.catch(() => {}); });
  t.signal.addEventListener('abort', stop, { once: true });
  const output = { stdout: '', stderr: '' }; let bytes = 0; let overflow = false; let expired = false;
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
    bytes += chunk.length; if (bytes > 1024 * 1024) { overflow = true; stop(); return; } output[stream] += chunk;
  });
  const timer = setTimeout(() => { expired = true; stop(); }, 150_000);
  try {
    const result = await closed;
    assert.equal(expired || overflow, false, 'native preparation exceeded its startup/output bound');
    assert.equal(result.code, 0, Object.values(output).join('\n'));
    const summary = parseNativeCliSummary(Object.values(output), expectedDigest);
    assert.equal(Object.values(output).join('\n').includes('fictional-main-life'), false);
    return summary;
  } finally { clearTimeout(timer); t.signal.removeEventListener('abort', stop); stop(); await closed.catch(() => {}); }
}

test('provisioning resumes a lost first-Primary response after SQLite reopen without creating another native Session', { timeout: realCli ? 330_000 : 180_000 }, async t => {
  assert.equal(process.platform, 'linux');
  const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
  assert.ok(stateDir && process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  process.env.OPENCLAW_STATE_DIR = stateDir; process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
  const resolved = new Map(['sqlite-runtime', 'file-access-runtime', 'state-paths', 'session-store-runtime'].map(name => [`openclaw/plugin-sdk/${name}`, pathToFileURL(require.resolve(`openclaw/plugin-sdk/${name}`)).href]));
  const hooks = registerHooks({ resolve: (specifier, context, nextResolve) => resolved.has(specifier) ? { url: resolved.get(specifier), shortCircuit: true } : nextResolve(specifier, context) });
  t.after(() => hooks.deregister());
  const vault = path.join(stateDir, 'vault'); const folder = path.join(vault, 'areas', 'studio');
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'Overview.md'), '# Existing Studio Notes\n');
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  t.after(() => metadata.close());
  const input = { logicalOperationId: randomUUID(), topicId: randomUUID(), name: 'Studio', paraCategory: 'area', folderPath: folder };
  const runtime = { provisioningAuthority: { assertCurrent() {} } };
  let attempted = 0; let created;
  const lostReplyStore = { ...sessionStore, patchSessionEntry: async options => {
    attempted++;
    created = await sessionStore.patchSessionEntry(options);
    throw new Error('fictional-lost-primary-response');
  } };
  const first = new TopicProvisioningService({ metadata, noteVaultRoot: vault, sessionStore: lostReplyStore });
  await assert.rejects(first.create(input, runtime), /fictional-lost-primary-response/);
  assert.equal(attempted, 1);
  assert.ok(created?.sessionId);
  assert.equal(metadata.getTopic(input.topicId).lifecycle, 'provisioning');
  const folderBefore = metadata.getSourceLocator(`note-folder:${input.topicId}`);
  metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  const retry = new TopicProvisioningService({ metadata, noteVaultRoot: vault, sessionStore: { ...sessionStore,
    patchSessionEntry() { throw new Error('retry must not redispatch'); }
  } });
  const result = await retry.create(input, runtime);
  assert.equal(result.status, 'applied'); assert.equal(result.topic.lifecycle, 'active');
  const primary = metadata.listSessionStates().find(row => row.isPrimary);
  assert.equal(primary.sessionId, created.sessionId);
  assert.equal(metadata.listSessionStates().length, 1);
  assert.deepEqual(metadata.getSourceLocator(`note-folder:${input.topicId}`), folderBefore);
  assert.equal(await readFile(path.join(folder, 'Overview.md'), 'utf8'), '# Existing Studio Notes\n');
  const receipt = metadata.getTopicOperation(input.logicalOperationId);
  assert.deepEqual(await retry.create(input, runtime), result);
  assert.deepEqual(metadata.getTopicOperation(input.logicalOperationId), receipt);

  await t.test('an explicit missing folder is created without renaming existing PARA folders', async () => {
    const missingFolder = path.join(vault, 'areas', 'workshop');
    const newInput = { logicalOperationId: randomUUID(), topicId: randomUUID(), name: 'Workshop', paraCategory: 'area', folderPath: missingFolder };
    const owner = new TopicProvisioningService({ metadata, noteVaultRoot: vault, sessionStore });
    const applied = await owner.create(newInput, runtime);
    assert.equal(applied.topic.lifecycle, 'active');
    const locator = metadata.getSourceLocator(`note-folder:${newInput.topicId}`);
    assert.equal(locator.locator, missingFolder);
    assert.equal(locator.ownership, 'created');
    assert.ok(locator.observedRevision.startsWith('note-folder:1:'));
    assert.deepEqual(metadata.getSourceConventionState(locator.referenceId).map(row => row.state), ['customized', 'customized']);
    assert.equal(metadata.listSessionStates().length, 2);
    await assert.rejects(owner.create({ ...newInput, folderPath: path.join(vault, 'areas', 'another') }, runtime), { code: 'provisioning-primary-conflict' });
    assert.deepEqual(metadata.getSourceLocator(locator.referenceId), locator);
    assert.equal(await readFile(path.join(folder, 'Overview.md'), 'utf8'), '# Existing Studio Notes\n');
    assert.deepEqual(await owner.retry({ logicalOperationId: newInput.logicalOperationId, topicId: newInput.topicId, expectedRevision: 1 }, runtime), applied);
  });

  await t.test('configured preparation preserves its pinned plan and supports genuinely read-only inspection and verification', async () => {
    const main = { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'fictional-main', lifecycleRevision: 'fictional-main-life' };
    await sessionStore.patchSessionEntry({ agentId: main.agentId, sessionKey: main.sessionKey,
      fallbackEntry: { sessionId: main.sessionId, lifecycleRevision: main.lifecycleRevision, updatedAt: 1 }, update: entry => entry });
    const mainBefore = sessionStore.getSessionEntry({ agentId: main.agentId, sessionKey: main.sessionKey, readConsistency: 'latest' });
    const plan = { schemaVersion: 1, logicalOperationId: randomUUID(), topicId: randomUUID(), name: 'Sketchbook', paraCategory: 'resource',
      folderPath: path.join(vault, 'resources', 'sketchbook'), noteVaultRoots: [vault], protectedSessions: [main] };
    const config = { plugins: { entries: { 'command-center': { enabled: true, config: { topics: { noteRoot: vault } } } } } };
    const planPath = path.join(stateDir, 'preparation.json');
    const expectedDigest = reconciliationPlanDigest(plan);
    await writeFile(planPath, JSON.stringify(plan));
    const invoke = (mode, overrides = {}) => runConfiguredTopicPreparation({ mode, planPath, expectedDigest, config, ...overrides });
    assert.deepEqual(await invoke('preflight'), { phase: 'preflight', planDigest: expectedDigest, topics: 0 });
    assert.equal(metadata.getTopic(plan.topicId), null);
    await assert.rejects(lstat(plan.folderPath), { code: 'ENOENT' });
    await assert.rejects(invoke('verify'), { code: 'preparation-incomplete' });
    await assert.rejects(invoke('resume'), { code: 'preparation-reservation-missing' });
    const applied = realCli ? await executeNativePreparation(t, { stateDir, config, planPath, expectedDigest }) : await invoke('execute');
    assert.deepEqual(applied, { phase: 'applied', planDigest: expectedDigest, topics: 1 });
    const completed = metadata.getTopicOperation(plan.logicalOperationId);
    const primary = metadata.getProvisioningPrimary(plan.logicalOperationId);
    const locator = metadata.getSourceLocator(`note-folder:${plan.topicId}`);
    assert.equal(completed.intent.preparationDigest, expectedDigest);
    const markerBefore = await readFile(path.join(plan.folderPath, '.command-center-folder-identity'));
    assert.deepEqual(await invoke('verify'), applied);
    assert.deepEqual(await invoke('resume'), applied);
    assert.deepEqual(metadata.getTopicOperation(plan.logicalOperationId), completed);
    assert.deepEqual(metadata.getProvisioningPrimary(plan.logicalOperationId), primary);
    assert.deepEqual(metadata.getSourceLocator(locator.referenceId), locator);
    assert.deepEqual(await readFile(path.join(plan.folderPath, '.command-center-folder-identity')), markerBefore);
    assert.deepEqual(sessionStore.getSessionEntry({ agentId: main.agentId, sessionKey: main.sessionKey, readConsistency: 'latest' }), mainBefore);
    const cancelled = new AbortController(); cancelled.abort(Object.assign(new Error('cancelled'), { code: 'test-cancelled' }));
    await assert.rejects(invoke('execute', { signal: cancelled.signal }), { code: 'test-cancelled' });
    const changed = { ...plan, protectedSessions: [...plan.protectedSessions, { agentId: 'main', sessionKey: `agent:main:command-center:topic:${input.topicId}:primary`,
      sessionId: created.sessionId, lifecycleRevision: created.lifecycleRevision }] };
    await writeFile(planPath, JSON.stringify(changed));
    await assert.rejects(invoke('resume', { expectedDigest: reconciliationPlanDigest(changed) }), { code: 'provisioning-primary-conflict' });
    assert.deepEqual(metadata.getTopicOperation(plan.logicalOperationId), completed);
  });
});
