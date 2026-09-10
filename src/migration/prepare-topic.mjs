import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { TopicProvisioningService } from '../topics/provisioning.mjs';
import { reconciliationPlanDigest } from './reconcile.mjs';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { resolveProvisioningFolderPath, validateTopicName, validateParaCategory } from '../topics/conventions.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function assertPreparationPlan(plan, config, expectedPlanDigest) {
  if (!exact(plan, ['schemaVersion', 'logicalOperationId', 'topicId', 'name', 'paraCategory', 'folderPath', 'noteVaultRoots', 'protectedSessions']) || plan.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(expectedPlanDigest) || reconciliationPlanDigest(plan) !== expectedPlanDigest ||
    !Array.isArray(plan.noteVaultRoots) || plan.noteVaultRoots.length !== 1 || typeof plan.noteVaultRoots[0] !== 'string' || !path.isAbsolute(plan.noteVaultRoots[0]) ||
    path.resolve(plan.noteVaultRoots[0]) !== plan.noteVaultRoots[0] || !Array.isArray(plan.protectedSessions) || plan.protectedSessions.length === 0 || plan.protectedSessions.length > 100) fail('preparation-plan-invalid');
  const pluginConfig = config?.plugins?.entries?.['command-center']?.config;
  if (!isDeepStrictEqual(plan.noteVaultRoots, [pluginConfig?.topics?.noteRoot])) fail('preparation-roots-mismatch');
  if (pluginConfig.sourceCapabilities?.notes === false || pluginConfig.sourceCapabilities?.sessions === false) fail('capability-unavailable');
  try {
    if (!isCanonicalUuid(plan.logicalOperationId) || plan.logicalOperationId !== plan.logicalOperationId.toLowerCase() ||
      !isCanonicalUuid(plan.topicId) || plan.topicId !== plan.topicId.toLowerCase() || validateTopicName(plan.name) !== plan.name ||
      validateParaCategory(plan.paraCategory, { allowArchive: false }) !== plan.paraCategory ||
      resolveProvisioningFolderPath({ noteVaultRoots: plan.noteVaultRoots, name: plan.name, paraCategory: plan.paraCategory, folderPath: plan.folderPath }) !== plan.folderPath) fail('preparation-plan-invalid');
  } catch { fail('preparation-plan-invalid'); }
  const protectedKeys = new Set();
  for (const session of plan.protectedSessions) {
    if (!exact(session, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision']) || !/^[a-z0-9_-]{1,64}$/.test(session.agentId) ||
      typeof session.sessionKey !== 'string' || !session.sessionKey.startsWith(`agent:${session.agentId}:`) || protectedKeys.has(session.sessionKey) ||
      typeof session.sessionId !== 'string' || !session.sessionId || !(session.lifecycleRevision === null || typeof session.lifecycleRevision === 'string' && session.lifecycleRevision.length > 0)) fail('preparation-plan-invalid');
    protectedKeys.add(session.sessionKey);
  }
  return protectedKeys;
}

// One explicitly approved Topic, before the import plan is frozen. This command
// does not initialize the workspace, import history or enable interactive create.
export async function prepareTopicForReconciliation(options) {
  const { metadata, sessionStore, mode, expectedPlanDigest, assertCurrent } = options;
  const plan = structuredClone(options.plan);
  const config = structuredClone(options.config);
  const env = Object.freeze({ ...(options.env ?? process.env) });
  if (!['preflight', 'execute', 'resume', 'verify'].includes(mode)) fail('preparation-mode-invalid');
  const protectedKeys = assertPreparationPlan(plan, config, expectedPlanDigest);
  const read = sessionStore?.getSessionEntry;
  if (typeof read !== 'function') fail('capability-unavailable');
  const check = () => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then || sessionStore.getSessionEntry !== read) fail('preparation-authority-unavailable');
    for (const session of plan.protectedSessions) {
      const entry = read.call(sessionStore, { agentId: session.agentId, sessionKey: session.sessionKey, env, readConsistency: 'latest' });
      if (!entry || entry.sessionId !== session.sessionId || (entry.lifecycleRevision ?? null) !== session.lifecycleRevision) fail('preparation-protected-session-changed');
    }
  };
  const input = { logicalOperationId: plan.logicalOperationId, topicId: plan.topicId, name: plan.name,
    paraCategory: plan.paraCategory, folderPath: plan.folderPath, preparationDigest: expectedPlanDigest };
  check();
  const inspected = metadata.inspectConditionalProvisioning(input, check);
  if (protectedKeys.has(inspected.primary.sessionKey) || plan.protectedSessions.some(session => session.agentId === inspected.primary.agentId && session.sessionId === inspected.primary.sessionId)) fail('preparation-protected-session-claimed');
  const owner = new TopicProvisioningService({ metadata, sessionStore, noteVaultRoots: plan.noteVaultRoots });
  const result = await owner.prepare(input, { env, provisioningAuthority: { assertCurrent: check } }, mode);
  check();
  // This public result is safe for CLI logs. Exact private identities remain in
  // the approved plan and owning receipts used to assemble reconciliation.
  return Object.freeze({ phase: result.status, planDigest: expectedPlanDigest, topics: result.status === 'applied' ? 1 : 0 });
}
