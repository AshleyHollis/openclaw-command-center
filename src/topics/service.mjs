import { sourceError } from '../sources/errors.mjs';
import { createTopicProvisioningService } from './provisioning.mjs';
import { createTopicLifecycleService } from './lifecycle.mjs';
import { createTopicRecoveryService } from './recovery.mjs';

const ACTIVE_GROUPS = Object.freeze(['project', 'area', 'resource']);
const DESTINATION_TOPIC_LIMIT = 100;

function sourceRecoveryRevision(metadata, referenceId) {
  return metadata.getSourceLocator?.(referenceId)?.observedRevision
    ?? metadata.getSessionState?.(referenceId)?.sessionId
    ?? metadata.getSourceReference(referenceId)?.observedRevision
    ?? `unbound:${referenceId}`;
}

function publicRecoveryDiagnostic(item, diagnostic = item.diagnostics?.[0] ?? {}) {
  return Object.freeze({
    topicId: item.topicId,
    referenceId: item.referenceId,
    sourceKind: item.sourceKind,
    expectedIdentity: item.sourceKind === 'note_folder' ? 'exact Note Folder identity' : 'exact Primary Session identity',
    check: String(diagnostic.check ?? 'exact-identity').slice(0, 80),
    status: item.state === 'required' ? 'recovery-required' : 'verified',
    retryable: item.state === 'required'
  });
}

function topicView(metadata, topic, detectedRecovery = []) {
  const recovery = [...(metadata.listSourceRecovery?.(topic.topicId) ?? []), ...detectedRecovery].map((item) => ({
    ...item,
    expectedRevision: sourceRecoveryRevision(metadata, item.referenceId)
  }));
  const provisioningOperationId = topic.lifecycle === 'provisioning' ? metadata.listTopicOperations?.(topic.topicId)?.filter((item) => item.operationKind === 'topics.create').at(-1)?.logicalOperationId ?? null : null;
  return Object.freeze({
    ...topic,
    name: metadata.getTopicName?.(topic.topicId) ?? topic.topicId,
    revision: topic.revision,
    usable: topic.lifecycle === 'active' && topic.paraCategory !== 'archive' && !recovery.some((item) => item.state === 'required'),
    recovery,
    provisioningOperationId,
    sourceReferences: metadata.listSourceReferences(topic.topicId),
    locators: metadata.listSourceLocators?.(topic.topicId) ?? []
  });
}

function destinationTopic(topic) {
  const noteFolderReferenceId = topic.sourceReferences?.find((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder')?.referenceId;
  return Object.freeze({
    topicId: topic.topicId,
    name: topic.name,
    revision: topic.revision,
    paraCategory: topic.paraCategory,
    lifecycle: topic.lifecycle,
    health: topic.health,
    usable: topic.usable,
    ...(noteFolderReferenceId ? { noteFolderReferenceId } : {}),
    provisioningOperationId: topic.provisioningOperationId,
    recovery: topic.recovery.map(({ recoveryId, topicId, referenceId, sourceKind, state, diagnostics, expectedRevision, createdAt, updatedAt }) => ({ recoveryId, topicId, referenceId, sourceKind, state, diagnostics: (diagnostics?.length ? diagnostics : [{}]).map((diagnostic) => publicRecoveryDiagnostic({ topicId, referenceId, sourceKind, state }, diagnostic)), expectedRevision, createdAt, updatedAt }))
  });
}

export class TopicService {
  constructor(options = {}) {
    this.metadata = options.metadata;
    if (!this.metadata) throw sourceError('recovery-only', 'Topic service requires metadata.');
    this.noteVaultRoots = options.noteVaultRoots ?? (options.noteVaultRoot === undefined ? [] : [options.noteVaultRoot]);
    this.noteVaultRoot = this.noteVaultRoots[0];
    const shared = { ...options, metadata: this.metadata };
    this.provisioning = options.provisioning ?? createTopicProvisioningService(shared);
    this.lifecycle = options.lifecycle ?? createTopicLifecycleService(shared);
    this.recovery = options.recovery ?? createTopicRecoveryService(shared);
  }

  listTopics({ includeProvisioning = true, includeArchived = true, includeRetired = true } = {}) {
    return this.metadata.listTopics().filter((topic) => includeProvisioning || topic.lifecycle !== 'provisioning').filter((topic) => includeArchived || topic.paraCategory !== 'archive').filter((topic) => includeRetired || topic.lifecycle !== 'retired').map((topic) => topicView(this.metadata, topic));
  }

  listActiveTopics() {
    return this.listTopics({ includeProvisioning: false, includeArchived: false, includeRetired: false }).filter((topic) => topic.usable);
  }

  listGrouped({ includeArchived = false } = {}) {
    const groups = Object.fromEntries(ACTIVE_GROUPS.map((category) => [category, []]));
    for (const topic of this.listTopics({ includeProvisioning: false, includeArchived, includeRetired: false })) {
      if (ACTIVE_GROUPS.includes(topic.paraCategory) && topic.usable) groups[topic.paraCategory].push(topic);
    }
    return Object.freeze(groups);
  }

  listDestination() {
    const topics = this.listTopics();
    const safe = (values) => values.map(destinationTopic);
    const isProvisioning = (topic) => topic.lifecycle === 'provisioning';
    const isRecovering = (topic) => !isProvisioning(topic) && topic.recovery.some((item) => item.state === 'required');
    const isArchived = (topic) => !isRecovering(topic) && topic.lifecycle === 'active' && topic.paraCategory === 'archive';
    const isRetired = (topic) => topic.lifecycle === 'retired';
    return Object.freeze({
      activeGroups: Object.fromEntries(ACTIVE_GROUPS.map((category) => [category, safe(topics.filter((topic) => topic.paraCategory === category && topic.usable).slice(0, DESTINATION_TOPIC_LIMIT))])),
      provisioning: safe(topics.filter(isProvisioning).slice(0, DESTINATION_TOPIC_LIMIT)),
      recovery: safe(topics.filter(isRecovering).slice(0, DESTINATION_TOPIC_LIMIT)),
      archived: safe(topics.filter(isArchived).slice(0, DESTINATION_TOPIC_LIMIT)),
      retired: safe(topics.filter(isRetired).slice(0, DESTINATION_TOPIC_LIMIT))
    });
  }

  async verifiedView(topic) {
    const persisted = this.metadata.listSourceRecovery?.(topic.topicId) ?? [];
    const detected = [];
    for (const reference of this.metadata.listSourceReferences(topic.topicId).filter((item) => item.sourceKind === 'note_folder' || item.sourceKind === 'session' && this.metadata.getSessionState?.(item.referenceId)?.isPrimary)) {
      if (persisted.some((item) => item.referenceId === reference.referenceId && item.state === 'required')) continue;
      const inspection = await this.recovery.inspect(topic.topicId, reference.referenceId).catch(() => ({ available: false, failure: 'authoritative-source-unverifiable' }));
      if (!inspection.available) detected.push({
        recoveryId: `detected:${reference.referenceId}`, topicId: topic.topicId, referenceId: reference.referenceId,
        sourceKind: reference.sourceKind, state: 'required', failure: inspection.failure,
        diagnostics: [{ check: 'exact-identity', result: String(inspection.failure).slice(0, 80), routes: ['verify', 'replace'] }]
      });
    }
    const view = topicView(this.metadata, topic, detected);
    return Object.freeze({ ...view, health: view.recovery.some((item) => item.state === 'required') ? 'source-recovery' : 'ready' });
  }

  async listDestinationVerified() {
    const topics = await Promise.all(this.metadata.listTopics().map((topic) => this.verifiedView(topic)));
    const safe = (values) => values.map(destinationTopic);
    const provisioning = topics.filter((topic) => topic.lifecycle === 'provisioning');
    const recovery = topics.filter((topic) => topic.lifecycle !== 'provisioning' && topic.health === 'source-recovery');
    const archived = topics.filter((topic) => topic.lifecycle === 'active' && topic.paraCategory === 'archive' && topic.health !== 'source-recovery');
    const retired = topics.filter((topic) => topic.lifecycle === 'retired');
    return Object.freeze({
      activeGroups: Object.fromEntries(ACTIVE_GROUPS.map((category) => [category, safe(topics.filter((topic) => topic.paraCategory === category && topic.usable).slice(0, DESTINATION_TOPIC_LIMIT))])),
      provisioning: safe(provisioning.slice(0, DESTINATION_TOPIC_LIMIT)), recovery: safe(recovery.slice(0, DESTINATION_TOPIC_LIMIT)), archived: safe(archived.slice(0, DESTINATION_TOPIC_LIMIT)), retired: safe(retired.slice(0, DESTINATION_TOPIC_LIMIT))
    });
  }

  async listDestinationPageVerified({ cursor = 0, limit = DESTINATION_TOPIC_LIMIT } = {}) {
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > DESTINATION_TOPIC_LIMIT) throw sourceError('invalid-request', 'A bounded destination cursor and limit are required.');
    const topics = await Promise.all(this.metadata.listTopics().map((topic) => this.verifiedView(topic)));
    const provisioning = topics.filter((topic) => topic.lifecycle === 'provisioning');
    const recovery = topics.filter((topic) => topic.lifecycle !== 'provisioning' && topic.health === 'source-recovery');
    const archived = topics.filter((topic) => topic.lifecycle === 'active' && topic.paraCategory === 'archive' && topic.health !== 'source-recovery');
    const retired = topics.filter((topic) => topic.lifecycle === 'retired');
    const entries = [
      ...ACTIVE_GROUPS.flatMap((category) => topics.filter((topic) => topic.paraCategory === category && topic.usable).map((topic) => [category, topic])),
      ...provisioning.map((topic) => ['provisioning', topic]),
      ...recovery.map((topic) => ['recovery', topic]),
      ...archived.map((topic) => ['archived', topic]),
      ...retired.map((topic) => ['retired', topic])
    ];
    const page = entries.slice(cursor, cursor + limit);
    const result = { activeGroups: Object.fromEntries(ACTIVE_GROUPS.map((category) => [category, []])), provisioning: [], recovery: [], archived: [], retired: [] };
    for (const [bucket, topic] of page) {
      if (ACTIVE_GROUPS.includes(bucket)) result.activeGroups[bucket].push(destinationTopic(topic));
      else result[bucket].push(destinationTopic(topic));
    }
    return Object.freeze({ ...result, nextCursor: cursor + page.length < entries.length ? String(cursor + page.length) : null });
  }

  async getVerified(topicId) { return this.verifiedView(this.lifecycle.topic(topicId)); }
  async getDestinationVerified(topicId) { return destinationTopic(await this.getVerified(topicId)); }

  list(options = {}) { return this.listGrouped(options); }
  grouped(options = {}) { return this.listGrouped(options); }

  get(topicId) { return topicView(this.metadata, this.lifecycle.topic(topicId)); }
  getTopic(topicId) { return this.get(topicId); }

  create(input, runtime) { return this.provisioning.create(input, runtime); }
  createTopic(input, runtime) { return this.create(input, runtime); }
  provisioningRetry(input, runtime) { return this.provisioning.retry(input, runtime); }
  retryProvisioning(input, runtime) { return this.provisioningRetry(input, runtime); }
  retry(input, runtime) { return this.provisioning.retry(input, runtime); }
  provisioningRollback(input) { return this.provisioning.rollback(input); }
  rollbackProvisioning(input) { return this.provisioningRollback(input); }
  rollback(input) { return this.provisioning.rollback(input); }
  rename(input) { return this.lifecycle.rename(input); }
  renameTopic(input) { return this.rename(input); }
  replacePrimarySession(input, runtime) { return this.lifecycle.replacePrimarySession(input, runtime); }
  recategorizationPreview(input) { return this.lifecycle.recategorizePreview(input); }
  previewStructuralChange(input) { return this.recategorizationPreview(input); }
  recategorizePreview(input) { return this.lifecycle.recategorizePreview(input); }
  recategorizationConfirm(input) { return this.lifecycle.recategorizeConfirm(input); }
  applyStructuralChange(input) { return this.recategorizationConfirm(input); }
  recategorizeConfirm(input) { return this.lifecycle.recategorizeConfirm(input); }
  archivePreview(input) { return this.lifecycle.archivePreview(input); }
  previewArchive(input) { return this.archivePreview(input); }
  archiveConfirm(input) { return this.lifecycle.archiveConfirm(input); }
  archiveTopic(input) { return this.archiveConfirm(input); }
  restorePreview(input) { return this.lifecycle.restorePreview(input); }
  restoreConfirm(input) { return this.lifecycle.restoreConfirm(input); }
  restoreTopic(input) { return this.restoreConfirm(input); }
  recoveryVerify(input) { return this.recovery.verify(input); }
  recoveryRelink(input) { return this.recovery.relink(input); }
  recoveryReplace(input) { return this.recovery.replace(input); }
  recoveryInspect(input) { return this.recovery.inspect(input.topicId, input.referenceId); }
  async inspectSourceRecovery(input) {
    const inspection = await this.recoveryInspect(input);
    const item = { topicId: input.topicId, referenceId: input.referenceId, sourceKind: inspection.reference.sourceKind, state: inspection.available ? 'verified' : 'required' };
    return Object.freeze({ ...item, diagnostics: [publicRecoveryDiagnostic(item, { check: inspection.failure ?? 'exact-identity' })], expectedRevision: sourceRecoveryRevision(this.metadata, input.referenceId) });
  }
  markSourceMissing(topicId, referenceId, failure) { return this.recovery.markMissing(topicId, referenceId, failure); }

  assertWritable(topicId, operation = 'write', requiredSourceKinds = undefined) {
    const topic = this.lifecycle.topic(topicId);
    if (topic.lifecycle === 'provisioning') throw sourceError('conflict', `Topic ${operation} is unavailable while provisioning is incomplete.`);
    if (topic.lifecycle === 'retired') throw sourceError('conflict', `Retired Topics do not support ${operation}.`);
    if (topic.paraCategory === 'archive') throw sourceError('archived-read-only', `Archived Topics are read-only; ${operation} is blocked.`);
    const recoveries = this.metadata.listSourceRecovery?.(topicId) ?? [];
    if (recoveries.some((item) => item.state === 'required' && (!requiredSourceKinds || requiredSourceKinds.includes(item.sourceKind)))) throw sourceError('source-recovery', `Topic ${operation} is blocked until its exact Source Recovery is verified.`);
    return topic;
  }
}

export function createTopicService(options) { return new TopicService(options); }
