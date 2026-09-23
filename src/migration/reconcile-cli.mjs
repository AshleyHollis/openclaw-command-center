import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { reconciliationPlanDigest, reconcilePreservedWorkspace } from './reconcile.mjs';
import { assertPreparationPlan, prepareTopicForReconciliation } from './prepare-topic.mjs';
import { createTopicService } from '../topics/service.mjs';
import { createAuthoritativeSourceService } from '../sources/service.mjs';
import { inspectTopicDiscoverability } from '../topics/discoverability.mjs';
import { createHistoricalBackfill, historicalBackfillPlanDigest, withdrawHistoricalBackfill } from '../open-loops/historical-backfill.mjs';
import { createHistoricalBackfillStore } from '../open-loops/historical-backfill-store.mjs';
import { createHistoricalBackfillOperator } from '../open-loops/historical-backfill-operator.mjs';
import { createProducerIntakeAdapter } from '../open-loops/producer-intake.mjs';
import { prepareAdmittedRetry, reconcileAdmittedRetry, producerSourceExternalId } from '../open-loops/intake-retry.mjs';
import { normalizeProducerIntakePlan, producerIntakePlanDigest } from '../open-loops/producer-intake-plan.mjs';
import { normalizeEmailReaderPlan, emailReaderPlanDigest } from '../open-loops/email-reader-plan.mjs';
import { recordEmailReaderRefreshReceipt } from '../open-loops/email-reader-refresh-receipt.mjs';
import { sourceTopicResolverToolFactory, sourceNoteCaptureToolFactory, sourceCommitmentCaptureToolFactory, intakeReceiptToolFactory, intakeSourcePlanToolFactory, intakeSourceAccountToolFactory, intakeOutcomeToolFactory } from '../open-loops/source-intake-tool.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const recoveryFailure = receipts => { throw Object.assign(new Error('note-folder-recovery-halted'), { code: 'note-folder-recovery-halted', receipts }); };
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_ADAPTER_BYTES = 2 * 1024 * 1024;

async function readPinnedJson(filename, invalidCode, unsafeCode, changedCode) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(invalidCode);
  if (path.resolve(await realpath(filename)) !== path.resolve(filename)) fail(unsafeCode);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_PLAN_BYTES)) fail(unsafeCode);
    const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (count > MAX_PLAN_BYTES || BigInt(count) !== before.size || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail(changedCode);
    let plan;
    try { plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))); }
    catch { fail(invalidCode); }
    return plan;
  } finally { await handle.close(); }
}

export async function readPinnedReconciliationPlan(filename, expectedDigest) {
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) fail('reconciliation-plan-invalid');
  const plan = await readPinnedJson(filename, 'reconciliation-plan-invalid', 'reconciliation-plan-unsafe', 'reconciliation-plan-changed');
  if (reconciliationPlanDigest(plan) !== expectedDigest) fail('reconciliation-plan-digest-mismatch');
  return plan;
}

export async function readPinnedHistoricalBackfillPlan(filename, expectedDigest) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedDigest)) fail('backfill-plan-invalid');
  const plan = await readPinnedJson(filename, 'backfill-plan-invalid', 'backfill-plan-unsafe', 'backfill-plan-changed');
  if (historicalBackfillPlanDigest(plan) !== expectedDigest) fail('backfill-plan-digest-mismatch');
  return plan;
}

export async function readPinnedProducerIntakePlan(filename, expectedDigest) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedDigest)) fail('producer-plan-invalid');
  const input = await readPinnedJson(filename, 'producer-plan-invalid', 'producer-plan-unsafe', 'producer-plan-changed');
  if (producerIntakePlanDigest(input) !== expectedDigest) fail('producer-plan-digest-mismatch');
  return normalizeProducerIntakePlan(input);
}

export async function readProducerIntakePlanDigest(filename) {
  const input = await readPinnedJson(filename, 'producer-plan-invalid', 'producer-plan-unsafe', 'producer-plan-changed');
  return producerIntakePlanDigest(input);
}

export async function readPinnedEmailReaderPlan(filename, expectedDigest) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedDigest)) fail('email-reader-plan-invalid');
  const input = await readPinnedJson(filename, 'email-reader-plan-invalid', 'email-reader-plan-unsafe', 'email-reader-plan-changed');
  if (emailReaderPlanDigest(input) !== expectedDigest) fail('email-reader-plan-digest-mismatch');
  return normalizeEmailReaderPlan(input);
}

export async function readEmailReaderPlanDigest(filename) {
  const input = await readPinnedJson(filename, 'email-reader-plan-invalid', 'email-reader-plan-unsafe', 'email-reader-plan-changed');
  return emailReaderPlanDigest(input);
}

export { producerSourceExternalId } from '../open-loops/intake-retry.mjs';

export async function runConfiguredEmailReaderPlan({ planPath, expectedDigest, signal }) {
  const plan = await readPinnedEmailReaderPlan(planPath, expectedDigest);
  signal?.throwIfAborted();
  const [{ resolveStateDir }, { openCommandCenterMetadataService }] = await Promise.all([import('openclaw/plugin-sdk/state-paths'), import('../metadata/service.mjs')]);
  const metadata = openCommandCenterMetadataService({ stateDir: resolveStateDir({ ...process.env }), capabilities: { notes: true, sessions: true } });
  try {
    const dispositions = [];
    for (const record of plan.records) {
      signal?.throwIfAborted();
      const result = metadata.recordEmailReaderLocator({ sourceExternalId: producerSourceExternalId(plan.sourceNamespace, record.sourceExternalId), sourceVersion: record.sourceVersion, messageId: record.messageId, status: record.status, ...(record.webLink ? { webLink: record.webLink } : {}), observedAt: record.observedAt });
      dispositions.push(result.disposition);
    }
    return Object.freeze({ schemaVersion: 1, status: 'applied', count: dispositions.length, recorded: dispositions.filter(value => value === 'recorded').length, updated: dispositions.filter(value => value === 'updated').length, duplicate: dispositions.filter(value => value === 'duplicate').length, stale: dispositions.filter(value => value === 'stale').length });
  } finally { metadata.close(); }
}

export async function runConfiguredEmailReaderRefreshReceipt({ input, signal }) {
  signal?.throwIfAborted();
  const [{ resolveStateDir }, { openCommandCenterMetadataService }] = await Promise.all([import('openclaw/plugin-sdk/state-paths'), import('../metadata/service.mjs')]);
  signal?.throwIfAborted();
  const metadata = openCommandCenterMetadataService({ stateDir: resolveStateDir({ ...process.env }), capabilities: { notes: true, sessions: true } });
  try { signal?.throwIfAborted(); return recordEmailReaderRefreshReceipt(metadata, input); }
  finally { metadata.close(); }
}

async function importPinnedBackfillAdapter(filename, expectedDigest) {
  const digestText = String(expectedDigest).replace(/^sha256:/u, '');
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !/^[a-f0-9]{64}$/u.test(digestText)) fail('backfill-adapter-invalid');
  if (path.resolve(await realpath(filename)) !== path.resolve(filename)) fail('backfill-adapter-unsafe');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let source;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_ADAPTER_BYTES)) fail('backfill-adapter-unsafe');
    const buffer = Buffer.alloc(Number(before.size));
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(count) !== before.size || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('backfill-adapter-changed');
    if (createHash('sha256').update(buffer).digest('hex') !== digestText) fail('backfill-adapter-digest-mismatch');
    source = buffer;
  } finally { await handle.close(); }
  // Import the descriptor-bound bytes, not the mutable pathname. Adapters are
  // standalone operator modules and may use built-in or package imports.
  const module = await import(`data:text/javascript;base64,${source.toString('base64')}#sha256=${digestText}`);
  if (typeof module.createHistoricalBackfillAdapter !== 'function') fail('backfill-adapter-invalid');
  source.fill(0);
  return module.createHistoricalBackfillAdapter;
}

export async function runConfiguredHistoricalBackfill({ mode, planPath, expectedDigest, adapterPath, expectedAdapterDigest, config, signal, hostFileAccess }) {
  if (!['preview', 'apply', 'withdraw'].includes(mode)) fail('backfill-mode-invalid');
  const plan = await readPinnedHistoricalBackfillPlan(planPath, expectedDigest);
  signal?.throwIfAborted();
  const createAdapter = await importPinnedBackfillAdapter(adapterPath, expectedAdapterDigest);
  const [{ resolveStateDir }, sdkFileAccess, sdkSqlite, { openCommandCenterMetadataService }, identity, filesystemOwner] = await Promise.all([
    import('openclaw/plugin-sdk/state-paths'), import('openclaw/plugin-sdk/file-access-runtime'), import('openclaw/plugin-sdk/sqlite-runtime'),
    import('../metadata/service.mjs'), import('../sources/note-folder-identity.mjs'), import('../sources/note-filesystem-owner.mjs')
  ]);
  const fileAccess = hostFileAccess ?? sdkFileAccess;
  const sqlite = hostFileAccess ?? sdkSqlite;
  // CLI registration is intentionally lazy and does not run normal plugin
  // activation, so install the published host identity reader for this bounded
  // operator invocation. Exact Note reads still verify the enrolled folder and
  // held filesystem witness before the adapter can commit an effect.
  const releaseIdentityReader = identity.setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  const releaseCoordinator = filesystemOwner.setHostNoteFilesystemCoordinator(sqlite.tryAcquireExclusiveSqliteCoordinator);
  let metadata; let sourceService;
  try {
    metadata = openCommandCenterMetadataService({ stateDir: resolveStateDir({ ...process.env }), capabilities: { notes: true, sessions: true } });
    sourceService = createAuthoritativeSourceService({ metadata, capabilities: { notes: true, sessions: false } });
    const adapterDigest = `sha256:${String(expectedAdapterDigest).replace(/^sha256:/u, '')}`;
    const store = createHistoricalBackfillStore({ metadata });
    const assertCurrent = () => signal?.throwIfAborted();
    const owner = createHistoricalBackfillOperator({ metadata, sourceService, plan, assertCurrent,
      loadBackfillState: () => store.loadState({ backfillId: plan.backfillId, mode: 'apply', stateKey: `${plan.backfillId}:apply` }) });
    const adapter = await createAdapter({ plan: structuredClone(plan), mode, config: structuredClone(config), signal, commandCenter: owner.commandCenter });
    assertCurrent();
    if (!adapter || typeof adapter !== 'object') fail('backfill-adapter-invalid');
    const wrapped = {
      ...adapter,
      ...(typeof adapter.applyRecord === 'function' ? { applyRecord: input => owner.runWithRecordAuthority(input, () => adapter.applyRecord(input)) } : {}),
      ...(typeof adapter.reconcileRecord === 'function' ? { reconcileRecord: input => owner.runWithRecordAuthority(input, () => adapter.reconcileRecord(input)) } : {}),
      ...(typeof adapter.inspectEffect === 'function' ? { inspectEffect: input => owner.runWithEffectAuthority(input, () => adapter.inspectEffect(input)) } : {}),
      ...(typeof adapter.withdrawEffect === 'function' ? { withdrawEffect: input => owner.runWithEffectAuthority(input, () => adapter.withdrawEffect(input)) } : {}),
      ...(typeof adapter.reconcileWithdrawal === 'function' ? { reconcileWithdrawal: input => owner.runWithEffectAuthority(input, () => adapter.reconcileWithdrawal(input)) } : {})
    };
    if (mode === 'withdraw') return await withdrawHistoricalBackfill({ ...wrapped, ...store, backfillId: plan.backfillId, expectedPlanDigest: historicalBackfillPlanDigest(plan), adapterDigest, assertCurrent });
    return await createHistoricalBackfill({ ...wrapped, ...store, assertCurrent }).run({ mode, plan, adapterDigest });
  } finally { sourceService?.close(); metadata?.close(); releaseCoordinator(); releaseIdentityReader(); }
}

export async function runConfiguredProducerIntake({ planPath, expectedDigest, config, signal, hostFileAccess, resumeAttemptId }) {
  const plan = await readPinnedProducerIntakePlan(planPath, expectedDigest);
  const pluginConfig = structuredClone(config)?.plugins?.entries?.['command-center']?.config ?? {};
  if (pluginConfig.sourceCapabilities?.notes === false) fail('capability-unavailable');
  signal?.throwIfAborted();
  const [{ resolveStateDir }, sdkFileAccess, sdkSqlite, { openCommandCenterMetadataService }, identity, filesystemOwner] = await Promise.all([
    import('openclaw/plugin-sdk/state-paths'), import('openclaw/plugin-sdk/file-access-runtime'), import('openclaw/plugin-sdk/sqlite-runtime'),
    import('../metadata/service.mjs'), import('../sources/note-folder-identity.mjs'), import('../sources/note-filesystem-owner.mjs')
  ]);
  signal?.throwIfAborted();
  const fileAccess = hostFileAccess ?? sdkFileAccess;
  const sqlite = hostFileAccess ?? sdkSqlite;
  const releaseIdentityReader = identity.setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  const releaseCoordinator = filesystemOwner.setHostNoteFilesystemCoordinator(sqlite.tryAcquireExclusiveSqliteCoordinator);
  let metadata; let sourceService;
  try {
    metadata = openCommandCenterMetadataService({ stateDir: resolveStateDir({ ...process.env }), capabilities: { notes: true, sessions: true } });
    const retry = resumeAttemptId === undefined ? null : prepareAdmittedRetry(metadata, plan, expectedDigest, resumeAttemptId);
    if (retry && retry.records.length === 0) return reconcileAdmittedRetry(metadata, plan, expectedDigest, resumeAttemptId, () => signal?.throwIfAborted());
    sourceService = createAuthoritativeSourceService({ metadata, capabilities: { notes: true, sessions: false } });
    const getOwners = () => ({ metadata, sourceService });
    const tools = {
      resolve: sourceTopicResolverToolFactory({ getOwners })(), save: sourceNoteCaptureToolFactory({ getOwners })(), capture: sourceCommitmentCaptureToolFactory({ getOwners })(),
      receipt: intakeReceiptToolFactory({ getOwners })(), plan: intakeSourcePlanToolFactory({ getOwners })(), account: intakeSourceAccountToolFactory({ getOwners })(), outcome: intakeOutcomeToolFactory({ getOwners })()
    };
    const invoke = async (tool, params) => { signal?.throwIfAborted(); const result = await tool.execute('producer-intake-cli', params); signal?.throwIfAborted(); return result?.details; };
    const adapter = createProducerIntakeAdapter({
      processorVersion: plan.processorVersion,
      async extract() { fail('producer-extractor-unavailable'); },
      loadIntakeSourceAccount: params => invoke(tools.account, params),
      async resolveTopic({ proposedTopic, notePath, expectedNoteRevision }) {
        if (typeof proposedTopic !== 'string' || !proposedTopic.trim()) return null;
        const result = await invoke(tools.resolve, { topicName: proposedTopic, ...(notePath ? { notePath } : {}), ...(expectedNoteRevision ? { expectedNoteRevision } : {}) });
        return result?.status === 'resolved' ? result : null;
      },
      async saveSourceNote(params) {
        const result = await invoke(tools.save, params); const note = result?.note; const reference = result?.sourceReference;
        return { sourceReferenceId: reference?.referenceId, sourcePath: note?.path, sourceReferenceVersion: note?.revision, replayed: result?.result?.status === 'replayed' };
      },
      captureSourceCommitment: params => invoke(tools.capture, params),
      async captureChatCommitment() { fail('producer-source-kind-invalid'); },
      recordIntakeSourcePlan: params => invoke(tools.plan, params), recordIntakeOutcome: params => invoke(tools.outcome, params), recordIntakeReceipt: params => invoke(tools.receipt, params)
    });
    const result = await adapter.process({ runId: retry?.runId ?? plan.runId, sourceKind: plan.sourceKind, records: retry?.records ?? plan.records.map(record => ({ ...record, sourceKind: plan.sourceKind, sourceExternalId: producerSourceExternalId(plan.sourceNamespace, record.sourceExternalId) })), nextExpectedAt: plan.nextExpectedAt, planDigest: expectedDigest, ...(retry ? { purpose: 'admitted-retry', retryOfRunId: plan.runId, unadmittedSourceCount: retry.unadmittedSourceCount } : { enumeration: plan.enumeration }), scope: plan.scope });
    return retry ? Object.freeze({ ...result, retriedSources: retry.records.length, blockedOutcomeCount: retry.blockedOutcomeCount, unadmittedSourceCount: retry.unadmittedSourceCount }) : result;
  } finally { sourceService?.close(); metadata?.close(); releaseCoordinator(); releaseIdentityReader(); }
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
  const [{ resolveStateDir }, sdkFileAccess, sdkSqlite, { openCommandCenterMetadataService }, identity, filesystemOwner] = await Promise.all([
    import('openclaw/plugin-sdk/state-paths'), import('openclaw/plugin-sdk/file-access-runtime'), import('openclaw/plugin-sdk/sqlite-runtime'),
    import('../metadata/service.mjs'), import('../sources/note-folder-identity.mjs'), import('../sources/note-filesystem-owner.mjs')
  ]);
  const fileAccess = hostFileAccess ?? sdkFileAccess;
  const sqlite = hostFileAccess ?? sdkSqlite;
  const stateDir = resolveStateDir(env);
  if (path.resolve(stateDir) !== plan.stateDirectory) fail('note-folder-recovery-state-mismatch');
  const pluginConfig = structuredClone(config)?.plugins?.entries?.['command-center']?.config ?? {};
  const noteRoot = pluginConfig.topics?.noteRoot;
  if (typeof noteRoot !== 'string' || !path.isAbsolute(noteRoot)) fail('note-folder-recovery-note-root-invalid');
  signal?.throwIfAborted();
  const releaseStager = identity.setHostDurableFolderStager(fileAccess.stageDurableFileInDirectory);
  const releaseIdentityReader = identity.setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  const releaseCoordinator = filesystemOwner.setHostNoteFilesystemCoordinator(sqlite.tryAcquireExclusiveSqliteCoordinator);
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true }, readOnly: mode !== 'execute' });
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
  } finally { metadata?.close(); releaseCoordinator(); releaseIdentityReader(); releaseStager(); }
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
  let metadata;
  let sources;
  try {
    metadata = openCommandCenterMetadataService({ stateDir: resolveStateDir(env), capabilities: { notes: true, sessions: true }, readOnly: true });
    sources = createAuthoritativeSourceService({ metadata, capabilities: { notes: true, sessions: true }, api: { runtime: { agent: { session: sessionStore } } } });
    const topics = createTopicService({ metadata, noteVaultRoot: noteRoot, sessionStore });
    return await inspectTopicDiscoverability({ metadata, topics, sources, signal });
  } finally { sources?.close(); metadata?.close(); releaseIdentityReader(); }
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
  const backfill = group.command('backfill').description('Run an explicitly pinned private historical intake plan');
  for (const mode of ['preview', 'apply', 'withdraw']) {
    backfill.command(mode)
      .requiredOption('--plan <absolute-path>', 'Private approved plan JSON')
      .requiredOption('--digest <sha256>', 'Approved canonical plan SHA-256')
      .requiredOption('--adapter <absolute-path>', 'Private approved source adapter module')
      .requiredOption('--adapter-digest <sha256>', 'Approved source adapter SHA-256')
      .action(async options => {
        const cancellation = new AbortController();
        const abort = () => cancellation.abort(Object.assign(new Error('backfill-cancelled'), { code: 'backfill-cancelled' }));
        process.once('SIGINT', abort); process.once('SIGTERM', abort);
        try {
          logger.info(JSON.stringify(await runConfiguredHistoricalBackfill({ mode, planPath: options.plan, expectedDigest: options.digest,
            adapterPath: options.adapter, expectedAdapterDigest: options.adapterDigest, config, signal: cancellation.signal })));
        } catch (error) {
          logger.error(typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(error.code) ? error.code : 'backfill-failed');
          process.exitCode = 1;
        } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
      });
  }
  const intake = group.command('intake').description('Digest or apply one explicitly pinned maintained-producer handoff');
  intake.command('digest')
    .requiredOption('--plan <absolute-path>', 'Private accepted-extraction batch JSON')
    .action(async options => {
      try { logger.info(await readProducerIntakePlanDigest(options.plan)); }
      catch (error) { logger.error(typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(error.code) ? error.code : 'producer-intake-failed'); process.exitCode = 1; }
    });
  intake.command('apply')
    .requiredOption('--plan <absolute-path>', 'Private accepted-extraction batch JSON')
    .requiredOption('--digest <sha256>', 'Approved canonical batch SHA-256')
    .action(async options => {
      const cancellation = new AbortController();
      const abort = () => cancellation.abort(Object.assign(new Error('producer-intake-cancelled'), { code: 'producer-intake-cancelled' }));
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try { logger.info(JSON.stringify(await runConfiguredProducerIntake({ planPath: options.plan, expectedDigest: options.digest, config, signal: cancellation.signal }))); }
      catch (error) { logger.error(typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(error.code) ? error.code : 'producer-intake-failed'); process.exitCode = 1; }
      finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    });
  intake.command('resume')
    .description('Retry missing effects only from an already admitted signed email batch; no source read or extraction')
    .requiredOption('--plan <absolute-path>', 'Original private accepted-extraction batch JSON')
    .requiredOption('--digest <sha256>', 'Original approved canonical batch SHA-256')
    .requiredOption('--attempt <id>', 'Stable retry attempt ID; reuse it after a lost response')
    .action(async options => {
      const cancellation = new AbortController();
      const abort = () => cancellation.abort(Object.assign(new Error('producer-intake-cancelled'), { code: 'producer-intake-cancelled' }));
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try { logger.info(JSON.stringify(await runConfiguredProducerIntake({ planPath: options.plan, expectedDigest: options.digest, resumeAttemptId: options.attempt, config, signal: cancellation.signal }))); }
      catch (error) { logger.error(typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(error.code) ? error.code : 'producer-retry-failed'); process.exitCode = 1; }
      finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    });
  intake.command('reader-digest')
    .requiredOption('--plan <absolute-path>', 'Private bounded email reader locator plan JSON')
    .action(async options => { try { logger.info(await readEmailReaderPlanDigest(options.plan)); } catch (error) { logger.error(error?.code ?? 'email-reader-plan-invalid'); process.exitCode = 1; } });
  intake.command('reader-apply')
    .requiredOption('--plan <absolute-path>', 'Private bounded email reader locator plan JSON')
    .requiredOption('--digest <sha256>', 'Pinned canonical reader plan SHA-256')
    .action(async options => {
      const cancellation = new AbortController();
      const abort = () => cancellation.abort(Object.assign(new Error('email-reader-cancelled'), { code: 'email-reader-cancelled' }));
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try { logger.info(JSON.stringify(await runConfiguredEmailReaderPlan({ planPath: options.plan, expectedDigest: options.digest, signal: cancellation.signal }))); }
      catch (error) { logger.error(error?.code ?? 'email-reader-plan-failed'); process.exitCode = 1; }
      finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    });
  intake.command('reader-status')
    .description('Record one content-free original-email reader refresh attempt, independently of capture')
    .requiredOption('--source-namespace <id>')
    .requiredOption('--capture-run-id <id>')
    .requiredOption('--batch-id <sha256>')
    .requiredOption('--attempt-id <uuid>')
    .requiredOption('--status <pending|completed|failed>')
    .requiredOption('--observed-at <iso>')
    .requiredOption('--selected <count>')
    .requiredOption('--linked <count>')
    .requiredOption('--unavailable <count>')
    .option('--failure-code <code>')
    .action(async options => {
      const cancellation = new AbortController();
      const abort = () => cancellation.abort(Object.assign(new Error('email-reader-cancelled'), { code: 'email-reader-cancelled' }));
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try { logger.info(JSON.stringify(await runConfiguredEmailReaderRefreshReceipt({ input: { schemaVersion: 1, sourceNamespace: options.sourceNamespace, captureRunId: options.captureRunId, batchId: options.batchId, attemptId: options.attemptId, status: options.status, observedAt: options.observedAt, selectedCount: Number(options.selected), linkedCount: Number(options.linked), unavailableCount: Number(options.unavailable), ...(options.failureCode ? { failureCode: options.failureCode } : {}) }, signal: cancellation.signal }))); }
      catch (error) { logger.error(typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(error.code) ? error.code : 'email-reader-status-failed'); process.exitCode = 1; }
      finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    });
  group.command('verify-discoverability').description('Verify active Topic and Primary Conversation discoverability').action(async () => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort(Object.assign(new Error('reconciliation-cancelled'), { code: 'reconciliation-cancelled' }));
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try { logger.info(JSON.stringify(await runConfiguredDiscoverabilityCheck({ config, signal: cancellation.signal }))); }
    catch (error) { logger.error(JSON.stringify({ code: error?.code ?? 'topic-discoverability-check-failed', ...(error?.summary ? { summary: error.summary } : {}) })); process.exitCode = 1; }
    finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  });
}
