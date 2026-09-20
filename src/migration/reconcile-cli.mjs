import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { reconciliationPlanDigest, reconcilePreservedWorkspace } from './reconcile.mjs';
import { assertPreparationPlan, prepareTopicForReconciliation } from './prepare-topic.mjs';
import { createTopicService } from '../topics/service.mjs';
import { createAuthoritativeSourceService } from '../sources/service.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const recoveryFailure = receipts => { throw Object.assign(new Error('note-folder-recovery-halted'), { code: 'note-folder-recovery-halted', receipts }); };
const MAX_PLAN_BYTES = 2 * 1024 * 1024;

export async function readPinnedReconciliationPlan(filename, expectedDigest) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !/^[a-f0-9]{64}$/.test(expectedDigest)) fail('reconciliation-plan-invalid');
  if (path.resolve(await realpath(filename)) !== path.resolve(filename)) fail('reconciliation-plan-unsafe');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_PLAN_BYTES)) fail('reconciliation-plan-unsafe');
    const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (count > MAX_PLAN_BYTES || BigInt(count) !== before.size || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('reconciliation-plan-changed');
    let plan;
    try { plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))); }
    catch { fail('reconciliation-plan-invalid'); }
    if (reconciliationPlanDigest(plan) !== expectedDigest) fail('reconciliation-plan-digest-mismatch');
    return plan;
  } finally { await handle.close(); }
}

// Local operator CLI, not a Gateway RPC or startup importer. Host CLI admission
// and filesystem access supply the operator authority; cancellation fences every
// child commit. Never initialize the legacy migration/startup service here.
export async function runConfiguredReconciliation({ mode, planPath, expectedDigest, config, signal }) {
  if (!['preflight', 'execute', 'resume', 'verify'].includes(mode)) fail('reconciliation-mode-invalid');
  const env = { ...process.env };
  const selectedConfig = structuredClone(config);
  const pluginConfig = selectedConfig?.plugins?.entries?.['command-center']?.config ?? {};
  const plan = await readPinnedReconciliationPlan(planPath, expectedDigest);
  const readerBindingReady = isDeepStrictEqual(pluginConfig.preservedHistorySource, plan.sourceOptions)
    && (plan.schemaVersion !== 2 || Boolean(plan.nativeHistory?.sourceOptions)
      && isDeepStrictEqual(pluginConfig.nativeHistorySource, plan.nativeHistory.sourceOptions));
  if (mode !== 'preflight' && !readerBindingReady) fail('reconciliation-reader-not-configured');
  if (pluginConfig.sourceCapabilities?.notes === false || pluginConfig.sourceCapabilities?.sessions === false) fail('capability-unavailable');
  const [{ resolveStateDir }, sessionStore, transcripts, { openCommandCenterMetadataService }] = await Promise.all([
    import('openclaw/plugin-sdk/state-paths'), import('openclaw/plugin-sdk/session-store-runtime'),
    import('openclaw/plugin-sdk/session-transcript-runtime'), import('../metadata/service.mjs')
  ]);
  const check = () => { signal?.throwIfAborted(); };
  check();
  const metadata = openCommandCenterMetadataService({ stateDir: resolveStateDir(env), capabilities: { notes: true, sessions: true }, readOnly: mode === 'preflight' || mode === 'verify' });
  try {
    const result = await reconcilePreservedWorkspace({ metadata, sessionStore, transcripts, env, config: selectedConfig,
      mode, plan, expectedPlanDigest: expectedDigest, assertCurrent: check });
    // CLI output reports accounting, never private paths, source content, Session
    // identifiers, or credentials. The private plan remains operator-controlled.
    return { phase: result.phase, planDigest: result.planDigest, readerBindingReady,
      topics: result.topics?.length ?? result.accounting.topics, accounting: result.accounting,
      attachmentCoverage: result.attachmentCoverage };
  } finally { metadata.close(); }
}

export async function runConfiguredTopicPreparation({ mode, planPath, expectedDigest, config, signal }) {
  if (!['preflight', 'execute', 'resume', 'verify'].includes(mode)) fail('preparation-mode-invalid');
  const env = { ...process.env }; const selectedConfig = structuredClone(config);
  const plan = await readPinnedReconciliationPlan(planPath, expectedDigest);
  assertPreparationPlan(plan, selectedConfig, expectedDigest);
  const [{ resolveStateDir }, sessionStore, { openCommandCenterMetadataService }] = await Promise.all([
    import('openclaw/plugin-sdk/state-paths'), import('openclaw/plugin-sdk/session-store-runtime'), import('../metadata/service.mjs')
  ]);
  const check = () => { signal?.throwIfAborted(); }; check();
  const metadata = openCommandCenterMetadataService({ stateDir: resolveStateDir(env), capabilities: { notes: true, sessions: true }, readOnly: mode === 'preflight' || mode === 'verify' });
  try {
    return await prepareTopicForReconciliation({ metadata, sessionStore, env, config: selectedConfig, mode, plan, expectedPlanDigest: expectedDigest, assertCurrent: check });
  } finally { metadata.close(); }
}

export async function runConfiguredMetadataInitialization({ mode, planPath, expectedDigest, signal }) {
  if (!['execute', 'verify'].includes(mode)) fail('initialization-mode-invalid');
  const env = { ...process.env };
  const plan = await readPinnedReconciliationPlan(planPath, expectedDigest);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
    Object.keys(plan).sort().join(',') !== 'metadataSchemaVersion,purpose,schemaVersion,stateDirectory' ||
    plan.schemaVersion !== 1 || plan.purpose !== 'command-center-metadata-initialization' ||
    typeof plan.stateDirectory !== 'string' || !path.isAbsolute(plan.stateDirectory) ||
    path.resolve(plan.stateDirectory) !== plan.stateDirectory) fail('initialization-plan-invalid');
  const [{ resolveStateDir }, { initializeCommandCenterMetadata, openCommandCenterMetadataService }, { COMMAND_CENTER_SCHEMA_VERSION }] = await Promise.all([
    import('openclaw/plugin-sdk/state-paths'), import('../metadata/service.mjs'), import('../metadata/schema.mjs')
  ]);
  if (plan.metadataSchemaVersion !== COMMAND_CENTER_SCHEMA_VERSION) fail('initialization-schema-mismatch');
  const stateDir = resolveStateDir(env);
  if (path.resolve(stateDir) !== plan.stateDirectory) fail('initialization-state-mismatch');
  signal?.throwIfAborted();
  // No awaited work between the final authority check and the synchronous owner.
  // Verification never creates state; execution never migrates an existing DB.
  if (mode === 'execute') return initializeCommandCenterMetadata({ stateDir, expectedSchemaVersion: plan.metadataSchemaVersion });
  const metadata = openCommandCenterMetadataService({ stateDir, readOnly: true });
  try { return { phase: 'verified', schemaVersion: metadata.getOperatingStatus().schemaVersion, disposition: 'existing' }; }
  finally { metadata.close(); }
}

function assertNoteFolderRecoveryPlan(plan, expectedDigest) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
    Object.keys(plan).sort().join(',') !== 'bindings,purpose,schemaVersion,stateDirectory' ||
    plan.schemaVersion !== 1 || plan.purpose !== 'command-center-note-folder-recovery' ||
    typeof plan.stateDirectory !== 'string' || !path.isAbsolute(plan.stateDirectory) || path.resolve(plan.stateDirectory) !== plan.stateDirectory ||
    !Array.isArray(plan.bindings) || plan.bindings.length < 1 || plan.bindings.length > 100 ||
    reconciliationPlanDigest(plan) !== expectedDigest) fail('note-folder-recovery-plan-invalid');
}

// A private, digest-pinned operator plan is deliberately required. This is not
// a Gateway RPC: it cannot scan a vault or infer a replacement folder, and its
// stable per-binding operation IDs allow the existing recovery owner to resume
// an interrupted marker enrollment safely.
export async function runConfiguredNoteFolderRecovery({ mode, planPath, expectedDigest, config, signal, hostFileAccess }) {
  if (!['preflight', 'execute', 'verify'].includes(mode)) fail('note-folder-recovery-mode-invalid');
  const env = { ...process.env };
  const plan = await readPinnedReconciliationPlan(planPath, expectedDigest);
  assertNoteFolderRecoveryPlan(plan, expectedDigest);
  const [{ resolveStateDir }, sdkFileAccess, { openCommandCenterMetadataService }, identity] = await Promise.all([
    import('openclaw/plugin-sdk/state-paths'), import('openclaw/plugin-sdk/file-access-runtime'), import('../metadata/service.mjs'), import('../sources/note-folder-identity.mjs')
  ]);
  const fileAccess = hostFileAccess ?? sdkFileAccess;
  const stateDir = resolveStateDir(env);
  if (path.resolve(stateDir) !== plan.stateDirectory) fail('note-folder-recovery-state-mismatch');
  const pluginConfig = structuredClone(config)?.plugins?.entries?.['command-center']?.config ?? {};
  const noteRoot = pluginConfig.topics?.noteRoot;
  if (typeof noteRoot !== 'string' || !path.isAbsolute(noteRoot)) fail('note-folder-recovery-note-root-invalid');
  signal?.throwIfAborted();
  const releaseStager = identity.setHostDurableFolderStager(fileAccess.stageDurableFileInDirectory);
  const releaseIdentityReader = identity.setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true }, readOnly: mode !== 'execute' });
  try {
    const topics = createTopicService({ metadata, noteVaultRoot: noteRoot });
    const checks = [];
    for (const item of plan.bindings) {
      signal?.throwIfAborted();
      checks.push(await topics.folderRecoveryBatch.preflight(item));
    }
    const publicReceipts = values => values.map((item, index) => Object.freeze({ binding: index + 1, logicalOperationId: item.logicalOperationId, status: item.status, ...(item.reason ? { reason: item.reason } : {}) }));
    if (mode === 'preflight') return { phase: 'preflight', planDigest: expectedDigest, accounting: { ready: checks.filter(item => item.status === 'ready').length, resumeReady: checks.filter(item => item.status === 'resume-ready').length, alreadyHealthy: checks.filter(item => item.status === 'already-healthy').length, blocked: checks.filter(item => item.status === 'blocked').length }, receipts: publicReceipts(checks) };
    if (mode === 'verify') {
      if (checks.some(item => item.status !== 'already-healthy')) fail('note-folder-recovery-not-verified');
      return { phase: 'verified', planDigest: expectedDigest, accounting: { verified: checks.length }, receipts: publicReceipts(checks) };
    }
    if (checks.some(item => !['ready', 'resume-ready', 'already-healthy'].includes(item.status))) fail('note-folder-recovery-preflight-blocked');
    const result = await topics.recoverNoteFoldersBatch({ bindings: plan.bindings, assertCurrent: () => signal?.throwIfAborted() });
    if (result.status !== 'completed') recoveryFailure(publicReceipts(result.receipts));
    return { phase: result.status, planDigest: expectedDigest, accounting: { recovered: result.receipts.filter(item => item.status === 'recovered').length, replayed: result.receipts.filter(item => item.status === 'replayed').length, alreadyHealthy: result.receipts.filter(item => item.status === 'already-healthy').length, blocked: result.receipts.filter(item => item.status === 'blocked').length }, receipts: publicReceipts(result.receipts) };
  } finally { metadata.close(); releaseIdentityReader(); releaseStager(); }
}

export async function runConfiguredDiscoverabilityCheck({ config, signal }) {
  const env = { ...process.env };
  const pluginConfig = structuredClone(config)?.plugins?.entries?.['command-center']?.config ?? {};
  const noteRoot = pluginConfig.topics?.noteRoot;
  if (typeof noteRoot !== 'string' || !path.isAbsolute(noteRoot)) fail('topic-discoverability-note-root-invalid');
  const [{ resolveStateDir }, sessionStore, fileAccess, { openCommandCenterMetadataService }, identity] = await Promise.all([
    import('openclaw/plugin-sdk/state-paths'), import('openclaw/plugin-sdk/session-store-runtime'), import('openclaw/plugin-sdk/file-access-runtime'),
    import('../metadata/service.mjs'), import('../sources/note-folder-identity.mjs')
  ]);
  signal?.throwIfAborted();
  const releaseIdentityReader = identity.setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  const metadata = openCommandCenterMetadataService({ stateDir: resolveStateDir(env), capabilities: { notes: true, sessions: true }, readOnly: true });
  const sources = createAuthoritativeSourceService({ metadata, capabilities: { notes: true, sessions: true }, api: { runtime: { agent: { session: sessionStore } } } });
  try {
    const topics = createTopicService({ metadata, noteVaultRoot: noteRoot, sessionStore });
    const destination = await topics.listDestinationVerified();
    const active = metadata.listTopics().filter(topic => topic.lifecycle === 'active' && ['project', 'area', 'resource'].includes(topic.paraCategory));
    const visible = [...Object.values(destination.activeGroups).flat(), ...destination.recovery.filter(topic => topic.lifecycle === 'active' && ['project', 'area', 'resource'].includes(topic.paraCategory))];
    const visibleIds = new Set(visible.map(topic => topic.topicId));
    const recoveryBySourceKind = {};
    for (const topic of destination.recovery) for (const item of topic.recovery.filter(row => row.state === 'required')) recoveryBySourceKind[item.sourceKind] = (recoveryBySourceKind[item.sourceKind] ?? 0) + 1;
    let primaryVerified = 0;
    for (const topic of active) {
      signal?.throwIfAborted();
      try {
        const catalog = await sources.sessionsList({ schemaVersion: 1, topicId: topic.topicId, includeClosed: false });
        if (catalog.conversations.filter(row => row.isPrimary === true && row.status === 'open').length === 1) primaryVerified += 1;
      } catch { /* counted below without exposing private source details */ }
    }
    const summary = Object.freeze({ schemaVersion: 1, activeTopics: active.length, visibleTopics: visibleIds.size,
      recoveryTopics: destination.recovery.filter(topic => topic.lifecycle === 'active').length, recoveryBySourceKind,
      primaryConversationsVerified: primaryVerified, primaryConversationsMissing: active.length - primaryVerified,
      widespreadIdentityFailure: active.length > 0 && (recoveryBySourceKind.note_folder ?? 0) >= Math.ceil(active.length / 2) });
    if (active.length === 0 || visibleIds.size !== active.length || summary.recoveryTopics > 0 || primaryVerified !== active.length) {
      throw Object.assign(new Error('topic-discoverability-unhealthy'), { code: 'topic-discoverability-unhealthy', summary });
    }
    return { phase: 'healthy', ...summary };
  } finally { sources.close(); metadata.close(); releaseIdentityReader(); }
}

export function registerReconciliationCli({ program, config, logger }) {
  const group = program.command('command-center').description('Command Center existing-data reconciliation');
  for (const [command, run] of [['reconcile', runConfiguredReconciliation], ['prepare-topic', runConfiguredTopicPreparation], ['initialize-metadata', runConfiguredMetadataInitialization], ['recover-note-folders', runConfiguredNoteFolderRecovery]]) {
  const reconcile = group.command(command).description('Inspect or run an explicitly pinned private preparation or import plan');
  for (const mode of command === 'initialize-metadata' ? ['execute', 'verify'] : command === 'recover-note-folders' ? ['preflight', 'execute', 'verify'] : ['preflight', 'execute', 'resume', 'verify']) {
    reconcile.command(mode).requiredOption('--plan <absolute-path>', 'Private approved plan JSON')
      .requiredOption('--digest <sha256>', 'Approved canonical plan SHA-256')
      .action(async options => {
        const cancellation = new AbortController();
        const abort = () => cancellation.abort(Object.assign(new Error('reconciliation-cancelled'), { code: 'reconciliation-cancelled' }));
        process.once('SIGINT', abort); process.once('SIGTERM', abort);
        try {
          const result = await run({ mode, planPath: options.plan, expectedDigest: options.digest, config, signal: cancellation.signal });
          logger.info(JSON.stringify(result));
        } catch (error) {
          const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) ? error.code : 'reconciliation-failed';
          const receipts = Array.isArray(error?.receipts) ? error.receipts : undefined;
          logger.error(receipts ? JSON.stringify({ code, receipts }) : code); process.exitCode = 1;
        } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
      });
  }
  }
  group.command('verify-discoverability').description('Verify active Topic and Primary Conversation discoverability').action(async () => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort(Object.assign(new Error('reconciliation-cancelled'), { code: 'reconciliation-cancelled' }));
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try { logger.info(JSON.stringify(await runConfiguredDiscoverabilityCheck({ config, signal: cancellation.signal }))); }
    catch (error) { logger.error(JSON.stringify({ code: error?.code ?? 'topic-discoverability-check-failed', ...(error?.summary ? { summary: error.summary } : {}) })); process.exitCode = 1; }
    finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  });
}
