import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { inspectNoteFolderCandidate } from '../sources/note-folder-identity.mjs';
import { adoptExistingTopic } from '../topics/bootstrap.mjs';
import { prepareDiscordPreservation, importDiscordPreservation, prepareNativePreservation, importNativePreservation } from './preserved-history-batch.mjs';
import { IMPORTED_HISTORY_OPERATION, NATIVE_HISTORY_OPERATION } from '../metadata/imported-history.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const reconciliationPlanDigest = plan => createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
const overlaps = (a, b) => [path.relative(a, b), path.relative(b, a)].some(value => value === '' || (!value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value)));

// Explicit operator command only, never activation/startup behavior. Preflight
// uses no reservations or source writes. Resume needs an unchanged durable plan;
// only that receipt authorizes starting its not-yet-reserved child operations.
export async function reconcilePreservedWorkspace(options) {
  const { metadata, sessionStore, mode, assertCurrent, expectedPlanDigest } = options;
  const runtime = { metadata, sessionStore, transcripts: options.transcripts,
    ...(options.storePath ? { storePath: options.storePath } : {}),
    ...(options.env ? { env: freeze(structuredClone(options.env)) } : {}),
    ...(options.config ? { config: freeze(structuredClone(options.config)) } : {}) };
  if (!['preflight', 'execute', 'resume', 'verify'].includes(mode)) fail('reconciliation-mode-invalid');
  const plan = freeze(structuredClone(options.plan));
  const planKeys = ['schemaVersion', 'logicalOperationId', 'sourceOptions', 'bootstraps', 'mappings', 'protectedSessions'];
  if (!exact(plan, plan?.schemaVersion === 2 ? [...planKeys, 'nativeHistory'] : planKeys) || ![1, 2].includes(plan.schemaVersion) ||
    !isCanonicalUuid(plan.logicalOperationId) || plan.logicalOperationId !== plan.logicalOperationId.toLowerCase() ||
    !Array.isArray(plan.bootstraps) || plan.bootstraps.length > 100 || !Array.isArray(plan.protectedSessions) || plan.protectedSessions.length === 0 ||
    plan.protectedSessions.length > 100 || !/^[a-f0-9]{64}$/.test(expectedPlanDigest) || reconciliationPlanDigest(plan) !== expectedPlanDigest) fail('reconciliation-plan-invalid');
  if (plan.schemaVersion === 2 && !exact(plan.nativeHistory, ['sourceOptions', 'mappings'])) fail('reconciliation-plan-invalid');
  if (typeof sessionStore?.getSessionEntry !== 'function') fail('capability-unavailable');
  const assertAuthority = () => { if (typeof assertCurrent !== 'function' || assertCurrent()?.then) fail('reconciliation-authority-unavailable'); };
  const nativeEntry = primary => sessionStore.getSessionEntry({ agentId: primary.agentId, sessionKey: primary.sessionKey,
    ...(runtime.storePath ? { storePath: runtime.storePath } : {}), ...(runtime.env ? { env: runtime.env } : {}), readConsistency: 'latest' });
  const sameNative = (entry, primary) => entry && entry.sessionId === primary.sessionId && (entry.lifecycleRevision ?? null) === primary.lifecycleRevision;
  const protectedKeys = new Set();
  for (const primary of plan.protectedSessions) {
    if (!exact(primary, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision']) || !/^[a-z0-9_-]{1,64}$/.test(primary.agentId) ||
      typeof primary.sessionKey !== 'string' || !primary.sessionKey.startsWith(`agent:${primary.agentId}:`) || typeof primary.sessionId !== 'string' || !primary.sessionId ||
      !(primary.lifecycleRevision === null || typeof primary.lifecycleRevision === 'string' && primary.lifecycleRevision.length > 0) || protectedKeys.has(primary.sessionKey)) fail('reconciliation-plan-invalid');
    protectedKeys.add(primary.sessionKey);
  }
  const checkSources = () => {
    assertAuthority();
    for (const primary of plan.protectedSessions) if (!sameNative(nativeEntry(primary), primary)) fail('reconciliation-protected-session-changed');
  };
  checkSources();
  let parent = metadata.getReconciliation(plan.logicalOperationId);
  if ((mode === 'resume' || mode === 'verify') && !parent) fail('reconciliation-reservation-missing');
  if (parent && parent.planDigest !== expectedPlanDigest) fail('intent-mismatch');
  if (mode === 'verify' && parent.phase !== 'applied') fail('reconciliation-incomplete');
  const source = await prepareDiscordPreservation({ sourceOptions: plan.sourceOptions, mappings: plan.mappings, assertCurrent: checkSources });
  const nativeSource = plan.schemaVersion === 2 ? await prepareNativePreservation({ ...plan.nativeHistory, assertCurrent: checkSources }) : null;
  checkSources();
  const bootstraps = [];
  for (const input of plan.bootstraps) {
    const inspected = metadata.inspectTopicBootstrap(input, checkSources);
    const { intent, receipt } = inspected;
    if (protectedKeys.has(intent.primary.sessionKey) || plan.protectedSessions.some(primary => primary.agentId === intent.primary.agentId && primary.sessionId === intent.primary.sessionId)) fail('reconciliation-protected-session-claimed');
    if (bootstraps.some(other => other.intent.topicId === intent.topicId || other.intent.folder.directoryIdentity === intent.folder.directoryIdentity ||
      overlaps(other.intent.folder.path, intent.folder.path) || other.intent.primary.sessionKey === intent.primary.sessionKey ||
      other.intent.primary.agentId === intent.primary.agentId && other.intent.primary.sessionId === intent.primary.sessionId)) fail('reconciliation-source-overlap');
    const folder = await inspectNoteFolderCandidate(intent.folder.path);
    checkSources();
    const expectedMarker = receipt?.phase === 'applied' ? receipt.folderIdentity : intent.folder.markerIdentity;
    const pendingOwnMarker = receipt && expectedMarker === null && folder.markerIdentity?.startsWith(`note-folder:1:${input.logicalOperationId}:`);
    if (folder.path !== intent.folder.path || folder.directoryIdentity !== intent.folder.directoryIdentity ||
      folder.markerIdentity !== expectedMarker && !pendingOwnMarker) fail('reconciliation-folder-changed');
    const entry = nativeEntry(intent.primary);
    const creating = intent.primary.creation === 'if-absent';
    if (creating && (!receipt || receipt.phase === 'reserved')) { if (entry) fail('bootstrap-source-conflict'); }
    else if (!sameNative(entry, intent.primary) || entry.sendPolicy === 'deny') fail(creating && receipt?.phase === 'creating' && !entry ? 'bootstrap-creation-unknown' : 'bootstrap-source-conflict');
    bootstraps.push(inspected);
  }
  const selectedHistories = [...source.selected, ...(nativeSource?.selected ?? [])];
  // Admission counts the whole new plan as well as previously retained history;
  // a later child must not discover the owner's limit after earlier effects.
  const histories = selectedHistories.map(item => metadata.inspectImportedHistory({ logicalOperationId: item.mapping.logicalOperationId, intent: item.intent }, checkSources));
  const historyKeys = histories.map(item => item.target.sessionKey);
  if (new Set(historyKeys).size !== historyKeys.length) fail('history-reservation-conflict');
  metadata.assertImportedHistoryCapacity(histories.map(item => item.logicalOperationId));
  for (const history of histories) {
    const entry = nativeEntry(history.target);
    if (protectedKeys.has(history.target.sessionKey) || plan.protectedSessions.some(primary => primary.agentId === history.target.agentId && primary.sessionId === history.target.sessionId) ||
      bootstraps.some(bootstrap => bootstrap.intent.primary.sessionKey === history.target.sessionKey || bootstrap.intent.primary.agentId === history.target.agentId && bootstrap.intent.primary.sessionId === history.target.sessionId)) fail('reconciliation-source-overlap');
    if (!history.receipt || history.receipt.phase === 'reserved') { if (entry) fail('history-destination-rebound'); }
    else if (!entry || entry.sessionId !== history.target.sessionId || entry.lifecycleRevision !== history.logicalOperationId || entry.sendPolicy !== 'deny') fail(!entry && history.receipt.phase === 'creating' ? 'history-creation-unknown' : 'history-destination-rebound');
    if (history.intent.topicId === null || history.receipt?.phase === 'verified') continue;
    const planned = bootstraps.find(bootstrap => bootstrap.intent.topicId === history.intent.topicId);
    const topic = metadata.getTopic(history.intent.topicId);
    if (planned && !topic ? history.intent.expectedTopicRevision !== 0 : !topic || topic.lifecycle !== 'active' || topic.revision !== history.intent.expectedTopicRevision) fail('stale-revision');
  }
  const reservationInput = { logicalOperationId: plan.logicalOperationId, planDigest: expectedPlanDigest, children: [
    ...bootstraps.map(item => ({ logicalOperationId: item.logicalOperationId, operationKind: 'topic.bootstrap.v1', intentDigest: item.intentDigest })),
    ...histories.map(item => ({ logicalOperationId: item.logicalOperationId, operationKind: item.intent.schemaVersion === 2 ? NATIVE_HISTORY_OPERATION : IMPORTED_HISTORY_OPERATION, intentDigest: item.intentDigest }))
  ] };
  if (new Set([plan.logicalOperationId, ...reservationInput.children.map(child => child.logicalOperationId)]).size !== reservationInput.children.length + 1 ||
    reservationInput.children.some(child => child.logicalOperationId !== child.logicalOperationId.toLowerCase())) fail('reconciliation-plan-invalid');
  const sortedChildren = [...reservationInput.children].sort((a, b) => a.logicalOperationId.localeCompare(b.logicalOperationId));
  if (parent && !isDeepStrictEqual(parent.children, sortedChildren)) fail('intent-mismatch');
  for (const other of metadata.listReconciliations()) {
    if (other.logicalOperationId !== plan.logicalOperationId && (reservationInput.children.some(child => other.logicalOperationId === child.logicalOperationId || other.children.some(claim => claim.logicalOperationId === child.logicalOperationId)) || other.children.some(child => child.logicalOperationId === plan.logicalOperationId))) fail('reconciliation-child-conflict');
  }
  checkSources();
  const nativeAccounting = nativeSource ? { sourceFiles: nativeSource.counts.files, sourceHeaders: nativeSource.counts.headers,
    sourceMessages: nativeSource.counts.messages, sourceOtherRecords: nativeSource.counts.otherRecords, sourceEntries: nativeSource.counts.entries } : null;
  if (mode === 'preflight') return freeze({ phase: 'preflight', planDigest: expectedPlanDigest, children: sortedChildren,
    accounting: { topics: bootstraps.length, sourceChannels: source.counts.channels, sourceMessages: source.counts.messages, sourceAttachments: source.counts.attachments,
      ...(nativeAccounting ? { nativeHistory: nativeAccounting } : {}) }, attachmentCoverage: source.attachmentCoverage });
  if (mode === 'execute') parent = metadata.reserveReconciliation(reservationInput, checkSources);
  const checkChildAuthority = () => {
    checkSources();
    if (!isDeepStrictEqual(metadata.getReconciliation(plan.logicalOperationId), parent)) fail('stale-revision');
  };
  const verifyOnly = mode === 'verify' || parent.phase === 'applied';
  const topics = [];
  for (const input of plan.bootstraps) {
    checkChildAuthority();
    const existing = metadata.getTopicBootstrap(input.logicalOperationId);
    topics.push(await adoptExistingTopic({ ...runtime, input, assertCurrent: checkChildAuthority,
      mode: verifyOnly ? 'verify' : existing ? 'resume' : 'execute' }));
  }
  // The durable unchanged parent, not the word "resume", authorizes children
  // that never started. Child owners still refuse every uncertain dispatched
  // effect and retain original source revisions/operation identities.
  const imported = await importDiscordPreservation({ ...runtime, mappings: plan.mappings, sourceOptions: plan.sourceOptions,
    mode: verifyOnly ? 'verify' : 'execute', assertCurrent: checkChildAuthority });
  const nativeImported = nativeSource ? await importNativePreservation({ ...runtime, ...plan.nativeHistory,
    mode: verifyOnly ? 'verify' : 'execute', assertCurrent: checkChildAuthority }) : null;
  checkChildAuthority();
  if (!verifyOnly) parent = metadata.completeReconciliation({ logicalOperationId: parent.logicalOperationId,
    expectedRevision: parent.revision, planDigest: expectedPlanDigest }, checkSources);
  return freeze({ phase: parent.phase, planDigest: expectedPlanDigest, topics, ...imported,
    ...(nativeImported ? { nativeHistory: nativeImported, accounting: { ...imported.accounting, nativeHistory: nativeImported.accounting } } : {}) });
}
