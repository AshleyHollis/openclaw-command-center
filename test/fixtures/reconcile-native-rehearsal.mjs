import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { inspectNoteFolderCandidate } from '../../src/sources/note-folder-identity.mjs';
import { adoptExistingTopic } from '../../src/topics/bootstrap.mjs';
import { reconcilePreservedWorkspace, reconciliationPlanDigest } from '../../src/migration/reconcile.mjs';
import { createPreservationFixture } from './discord-preservation.mjs';
import { runConfiguredReconciliation, runConfiguredTopicPreparation } from '../../src/migration/reconcile-cli.mjs';
import { copyBuiltPluginForNativeCli, parseNativeCliSummary } from './native-cli-plugin.mjs';

const realCli = process.env.COMMAND_CENTER_REHEARSAL_REAL_CLI === '1';

// The real launcher runs without injected module hooks. Its normal plugin loader
// must resolve the copied built plugin against the selected host's actual SDK.
async function invokeNativeCli(t, { stateDir, config, planPath, expectedPlanDigest }) {
  const pluginRoot = await copyBuiltPluginForNativeCli(stateDir);
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ ...config,
    agents: { defaults: { workspace: path.join(stateDir, 'workspace') } },
    plugins: { ...config.plugins, allow: ['command-center'], load: { paths: [pluginRoot] } }
  }));
  const launcher = path.join(path.dirname(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE), 'openclaw.mjs');
  const child = spawn(process.execPath, [launcher, 'command-center', 'reconcile', 'verify', '--plan', planPath, '--digest', expectedPlanDigest], {
    cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCLAW_HOME: stateDir, OPENCLAW_NO_RESPAWN: '1', NODE_DISABLE_COMPILE_CACHE: '1' }
  });
  const outputs = { stdout: '', stderr: '' }; let outputBytes = 0; let timedOut = false;
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  t.after(async () => { stop(); await closed.catch(() => {}); });
  const abort = () => stop();
  t.signal.addEventListener('abort', abort, { once: true });
  const collect = stream => chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 1024 * 1024) { stop(); return; }
    outputs[stream] += chunk;
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
  // This is a separate bounded CLI startup/loader diagnostic, not a relaxation
  // of the existing operation deadline or of release performance qualification.
  const timeout = setTimeout(() => { timedOut = true; stop(); }, 150_000);
  try {
    const result = await closed;
    const output = Object.values(outputs).join('\n');
    assert.equal(timedOut, false, 'native CLI startup watchdog expired');
    assert.equal(result.code, 0, output);
    const summary = parseNativeCliSummary(Object.values(outputs), expectedPlanDigest);
    assert.equal(summary.phase, 'applied'); assert.equal(summary.accounting.verifiedMessages, 1);
    assert.equal(summary.readerBindingReady, true);
    assert.equal(output.includes('Original garden message'), false);
    assert.equal(output.includes('fictional-life-main'), false);
  } finally {
    clearTimeout(timeout); t.signal.removeEventListener('abort', abort);
    stop(); await closed.catch(() => {});
  }
}

test('pinned workspace reconciliation resumes between real bootstrap and history steps without replacing existing sources', { timeout: realCli ? 330_000 : 180_000 }, async t => {
  assert.equal(process.platform, 'linux');
  const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
  assert.ok(stateDir && process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  process.env.OPENCLAW_STATE_DIR = stateDir; process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
  const transcripts = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-transcript-runtime')).href);
  const resolved = new Map(['sqlite-runtime', 'file-access-runtime', 'state-paths', 'session-store-runtime', 'session-transcript-runtime'].map(name => [`openclaw/plugin-sdk/${name}`, pathToFileURL(require.resolve(`openclaw/plugin-sdk/${name}`)).href]));
  const hooks = registerHooks({ resolve: (specifier, context, nextResolve) => resolved.has(specifier) ? { url: resolved.get(specifier), shortCircuit: true } : nextResolve(specifier, context) });
  t.after(() => hooks.deregister());
  const protectedSessions = [];
  for (const name of ['main', 'reports', 'garden']) {
    const primary = { agentId: 'main', sessionKey: `agent:main:${name}`, sessionId: `fictional-${name}`, lifecycleRevision: `fictional-life-${name}` };
    await sessionStore.patchSessionEntry({ agentId: primary.agentId, sessionKey: primary.sessionKey, fallbackEntry: { sessionId: primary.sessionId, lifecycleRevision: primary.lifecycleRevision, updatedAt: 1 }, update: entry => entry });
    assert.equal((await transcripts.appendSessionTranscriptMessageByIdentityStrict({ ...primary, config: {}, eventId: `fixture-${name}`,
      message: { role: 'user', content: `Original ${name} message`, timestamp: 1767225600000 }, now: 1767225600000 })).kind, 'result');
    if (name !== 'garden') protectedSessions.push(primary);
  }
  const channel = { id: 'fictional-garden', name: 'Fictional Garden', type: 0 };
  const message = { id: 'fictional-message', channel_id: channel.id, author: { id: 'fictional-author', bot: false }, content: 'Preserved garden history', timestamp: '2026-01-01T00:00:00Z', attachments: [] };
  const baseline = { guildStructureCount: 1, guildTextChannelCount: 1, messageCount: 1, attachmentCount: 0 };
  const source = await createPreservationFixture(t, { baseline, summary: { ...baseline, discoveredThreadCount: 0, reactionCount: 0,
    channelReceipts: [{ id: channel.id, messageCount: 1, firstMessageId: message.id, lastMessageId: message.id }], attachments: [] },
    files: new Map([['channels.json', Buffer.from(JSON.stringify([channel]))], ['threads.json', Buffer.from('{"threads":[],"endpointReceipts":[]}')],
      [`messages/${channel.id}.jsonl`, Buffer.from(JSON.stringify(message) + '\n')], [`messages/${channel.id}.reactions.json`, Buffer.from('[]')]]) });
  const folder = path.join(stateDir, 'notes', 'areas', 'garden');
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'Overview.md'), '# Original garden Notes\n');
  const bootstrap = { logicalOperationId: randomUUID(), intent: { schemaVersion: 1, mappingDigest: 'a'.repeat(64), topicId: randomUUID(), name: 'Garden', paraCategory: 'area',
    folder: await inspectNoteFolderCandidate(folder), primary: { agentId: 'main', sessionKey: 'agent:main:garden', sessionId: 'fictional-garden', lifecycleRevision: 'fictional-life-garden' } } };
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  t.after(() => metadata.close());
  const preparation = { schemaVersion: 1, logicalOperationId: randomUUID(), topicId: randomUUID(), name: 'Garden Journal', paraCategory: 'project',
    folderPath: path.join(stateDir, 'notes', 'projects', 'garden-journal'), noteVaultRoots: [path.join(stateDir, 'notes')],
    protectedSessions: [...protectedSessions, bootstrap.intent.primary] };
  const preparationPath = path.join(stateDir, 'approved-preparation.json');
  await writeFile(preparationPath, JSON.stringify(preparation));
  const preparationOptions = { planPath: preparationPath, expectedDigest: reconciliationPlanDigest(preparation),
    config: { plugins: { entries: { 'command-center': { enabled: true, config: { topics: { noteRoot: path.join(stateDir, 'notes') } } } } } } };
  assert.equal((await runConfiguredTopicPreparation({ ...preparationOptions, mode: 'execute' })).phase, 'applied');
  assert.equal((await runConfiguredTopicPreparation({ ...preparationOptions, mode: 'verify' })).phase, 'applied');
  const preparedReceipt = metadata.getTopicOperation(preparation.logicalOperationId);
  const preparedPrimary = metadata.getProvisioningPrimary(preparation.logicalOperationId).intent.primary;
  const preparedNative = sessionStore.getSessionEntry({ agentId: preparedPrimary.agentId, sessionKey: preparedPrimary.sessionKey, readConsistency: 'latest' });
  const preparedFolder = await inspectNoteFolderCandidate(preparation.folderPath);
  protectedSessions.push({ agentId: preparedPrimary.agentId, sessionKey: preparedPrimary.sessionKey, sessionId: preparedPrimary.sessionId, lifecycleRevision: preparedPrimary.lifecycleRevision });
  const initialOperations = metadata.listOperations();
  // Freeze only after preparation. This already-active Topic is not bootstrapped
  // again, and imported history uses its actual post-preparation revision.
  const plan = { schemaVersion: 1, logicalOperationId: randomUUID(), sourceOptions: source.options, bootstraps: [bootstrap],
    mappings: [{ sourceChannelId: channel.id, logicalOperationId: randomUUID(), agentId: 'main', topicId: preparation.topicId, expectedTopicRevision: 1 }], protectedSessions };
  const expectedPlanDigest = reconciliationPlanDigest(plan);
  const options = { metadata, sessionStore, transcripts, config: {}, plan, expectedPlanDigest, assertCurrent: () => {} };
  await assert.rejects(reconcilePreservedWorkspace({ ...options, mode: 'resume' }), { code: 'reconciliation-reservation-missing' });
  await assert.rejects(reconcilePreservedWorkspace({ ...options, mode: 'verify' }), { code: 'reconciliation-reservation-missing' });
  await assert.rejects(reconcilePreservedWorkspace({ ...options, mode: 'execute', expectedPlanDigest: '0'.repeat(64) }), { code: 'reconciliation-plan-invalid' });
  const incomplete = { ...plan, mappings: [] };
  await assert.rejects(reconcilePreservedWorkspace({ ...options, plan: incomplete, expectedPlanDigest: reconciliationPlanDigest(incomplete), mode: 'execute' }), { code: 'history-mapping-incomplete' });
  assert.deepEqual(metadata.listOperations(), initialOperations);
  const preflight = await reconcilePreservedWorkspace({ ...options, mode: 'preflight' });
  assert.equal(preflight.accounting.sourceMessages, 1); assert.equal(preflight.accounting.topics, 1);
  assert.deepEqual(metadata.listOperations(), initialOperations); assert.equal((await inspectNoteFolderCandidate(folder)).markerIdentity, null);
  const mutableOptions = { ...options, mode: 'preflight', env: { ...process.env } };
  const pendingPreflight = reconcilePreservedWorkspace(mutableOptions);
  mutableOptions.sessionStore = { getSessionEntry() { throw new Error('Changed destination must not be consulted'); } };
  mutableOptions.metadata = {};
  mutableOptions.env.OPENCLAW_STATE_DIR = path.join(stateDir, 'wrong-state');
  mutableOptions.storePath = path.join(stateDir, 'wrong-store');
  assert.deepEqual(await pendingPreflight, preflight);
  // Actual durable checkpoint between children; a fresh metadata instance must
  // continue the unstarted history under the original approved parent plan.
  metadata.reserveReconciliation({ logicalOperationId: plan.logicalOperationId, planDigest: expectedPlanDigest, children: preflight.children }, () => {});
  await adoptExistingTopic({ ...options, input: bootstrap, mode: 'execute' });
  metadata.close();
  metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  assert.equal(metadata.listImportedHistories().length, 0);
  const reordered = structuredClone(plan);
  reordered.bootstraps[0].intent = Object.fromEntries(Object.entries(reordered.bootstraps[0].intent).reverse());
  assert.equal(reconciliationPlanDigest(reordered), expectedPlanDigest);
  const applied = await reconcilePreservedWorkspace({ ...options, metadata, plan: reordered, mode: 'resume' });
  assert.equal(applied.phase, 'applied'); assert.equal(applied.accounting.verifiedHistories, 1); assert.equal(applied.accounting.verifiedMessages, 1);
  const before = metadata.listOperations();
  assert.deepEqual(await reconcilePreservedWorkspace({ ...options, metadata, mode: 'verify' }), applied);
  assert.deepEqual(await reconcilePreservedWorkspace({ ...options, metadata, mode: 'execute' }), applied);
  assert.deepEqual(metadata.listOperations(), before);
  assert.equal(metadata.listTopics().length, 2);
  assert.equal(metadata.listImportedHistories()[0].intent.topicId, preparation.topicId);
  assert.deepEqual(metadata.getTopicOperation(preparation.logicalOperationId), preparedReceipt);
  assert.deepEqual(sessionStore.getSessionEntry({ agentId: preparedPrimary.agentId, sessionKey: preparedPrimary.sessionKey, readConsistency: 'latest' }), preparedNative);
  assert.deepEqual(await inspectNoteFolderCandidate(preparation.folderPath), preparedFolder);
  assert.equal(await readFile(path.join(folder, 'Overview.md'), 'utf8'), '# Original garden Notes\n');
  for (const name of ['main', 'reports', 'garden']) {
    assert.deepEqual((await transcripts.readVisibleSessionTranscriptMessageEntries({ agentId: 'main', sessionKey: `agent:main:${name}`, sessionId: `fictional-${name}` })).map(row => row.message.content), [`Original ${name} message`]);
  }
  const changed = structuredClone(plan); changed.bootstraps[0].intent.name = 'Changed';
  await assert.rejects(reconcilePreservedWorkspace({ ...options, metadata, plan: changed, expectedPlanDigest: reconciliationPlanDigest(changed), mode: 'resume' }), { code: 'intent-mismatch' });
  const planPath = path.join(stateDir, 'approved-plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const cliResult = await runConfiguredReconciliation({ mode: 'verify', planPath, expectedDigest: expectedPlanDigest,
    config: { plugins: { entries: { 'command-center': { enabled: true, config: { preservedHistorySource: source.options } } } } } });
  assert.equal(cliResult.phase, 'applied'); assert.equal(cliResult.readerBindingReady, true); assert.equal(cliResult.accounting.verifiedMessages, 1);
  assert.deepEqual(metadata.listOperations(), before);
  if (realCli) {
    const nativeBefore = ['main', 'reports', 'garden'].map(name => structuredClone(sessionStore.getSessionEntry({
      agentId: 'main', sessionKey: `agent:main:${name}`, consistency: 'latest'
    })));
    await invokeNativeCli(t, { stateDir, planPath, expectedPlanDigest,
      config: { plugins: { entries: { 'command-center': { enabled: true, config: { preservedHistorySource: source.options } } } } } });
    assert.deepEqual(metadata.listOperations(), before);
    assert.equal(await readFile(path.join(folder, 'Overview.md'), 'utf8'), '# Original garden Notes\n');
    for (const [index, name] of ['main', 'reports', 'garden'].entries()) {
      assert.deepEqual(sessionStore.getSessionEntry({ agentId: 'main', sessionKey: `agent:main:${name}`, consistency: 'latest' }), nativeBefore[index]);
      assert.deepEqual((await transcripts.readVisibleSessionTranscriptMessageEntries({ agentId: 'main', sessionKey: `agent:main:${name}`, sessionId: `fictional-${name}` })).map(row => row.message.content), [`Original ${name} message`]);
    }
  }
  const fresh = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'conflicting-rehearsal'), capabilities: { notes: true, sessions: true } });
  try {
    const conflicting = structuredClone(plan); conflicting.logicalOperationId = randomUUID();
    conflicting.bootstraps[0].logicalOperationId = randomUUID(); conflicting.bootstraps[0].intent.topicId = randomUUID();
    conflicting.bootstraps[0].intent.folder = await inspectNoteFolderCandidate(folder);
    conflicting.mappings[0].logicalOperationId = randomUUID(); conflicting.mappings[0].topicId = conflicting.bootstraps[0].intent.topicId;
    const markerBefore = await inspectNoteFolderCandidate(folder);
    await assert.rejects(reconcilePreservedWorkspace({ ...options, metadata: fresh, plan: conflicting, expectedPlanDigest: reconciliationPlanDigest(conflicting), mode: 'execute' }), { code: 'history-destination-rebound' });
    assert.deepEqual(fresh.listOperations(), []); assert.deepEqual(fresh.listTopics(), []);
    assert.deepEqual(await inspectNoteFolderCandidate(folder), markerBefore);
  } finally { fresh.close(); }
});
