import { createHash, randomUUID } from 'node:crypto';
import { assertSafeDirectory } from '../sources/note-path.mjs';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { normalizeLegacyDiscordMigration, normalizeOptionalLegacyDiscordMigration, legacyDiscordMigrationConfigDigest } from './config.mjs';
import { readLegacyDiscordExport, selectMappedLegacyDiscordChannels } from './export-v1.mjs';
import { occurrenceIdentity, occurrencePayloadDigest } from './occurrence.mjs';
import { canonicalImportedUserMessage, importedProvenance, provenanceMatches, transcriptEntries } from './transcript.mjs';

const MIGRATION_ID = 'legacy-discord-v1';
const ZERO_DIGEST = 'sha256:' + '0'.repeat(64);

function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function channelDigest(channel) { return digest(channel.occurrences.map((occurrence) => ({ identity: occurrenceIdentity(channel.channelId, occurrence), payload: occurrencePayloadDigest(occurrence) }))); }
function occurrenceSequenceDigest(channel) { return channel.occurrences.length === 0 ? ZERO_DIGEST : digest(channel.occurrences.map((occurrence) => occurrenceIdentity(channel.channelId, occurrence))); }
function safeError(error, fallback = 'migration-failure') { return { code: String(error?.code || fallback).slice(0, 80), summary: String(error?.code || fallback).slice(0, 300) }; }
function readSessionId(value) { return value?.sessionId ?? value?.session?.sessionId ?? value?.id ?? null; }
function readSessionKey(value) { return value?.key ?? value?.sessionKey ?? value?.session?.key ?? null; }
function asFailure(error, fallback = 'migration-failure') { const safe = safeError(error, fallback); return { code: safe.code || fallback, summary: safe.summary || fallback }; }
function phaseHook(hooks, name, context) { const hook = hooks?.[name]; if (typeof hook === 'function') hook(context); }
function sessionRows(value) { return Array.isArray(value) ? value : value?.sessions ?? value?.items ?? []; }
function deterministicSessionId(sessionKey) {
  const bytes = createHash('sha256').update(`command-center:legacy-discord:session:v1:${sessionKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function durableAnchor(result, target, occurrence, parentId, index) {
  const anchor = result?.anchor ?? {};
  return Object.freeze({
    schemaVersion: 1,
    agentId: anchor.agentId ?? target.agentId,
    sessionId: anchor.sessionId ?? target.sessionId,
    sessionKey: anchor.sessionKey ?? target.sessionKey,
    generation: anchor.generation ?? 'injected-runtime-v1',
    entryId: anchor.entryId ?? result.messageId,
    rawSeq: anchor.rawSeq ?? index + 1,
    effectiveParentId: anchor.effectiveParentId ?? result.effectiveParentId ?? parentId ?? null,
    activeMessagePosition: anchor.activeMessagePosition ?? index,
    idempotencyKey: anchor.idempotencyKey ?? result.message?.idempotencyKey ?? occurrenceIdentity(target.sourceChannelId ?? '', occurrence).idempotencyKey
  });
}

export class LegacyDiscordMigrationService {
  constructor(options = {}) {
    this.metadata = options.metadata;
    this.api = options.api;
    this.gateway = options.gateway ?? options.api?.runtime?.gateway;
    this.sessionStore = options.sessionStore ?? options.api?.runtime?.agent?.session;
    this.config = options.config ?? options.api?.pluginConfig?.legacyDiscordMigration;
    this.transcript = options.transcriptRuntime;
    this.folderVerifier = options.folderVerifier ?? assertSafeDirectory;
    this.now = options.now ?? (() => new Date().toISOString());
    this.hooks = options.hooks;
    this.logger = options.logger;
    this.inFlight = null;
  }

  normalizedConfig() { return normalizeOptionalLegacyDiscordMigration(this.config); }

  authoritativeStorePath() {
    if (typeof this.sessionStore?.resolveStorePath !== 'function') return undefined;
    const hostConfig = this.api?.runtime?.config?.current?.() ?? this.api?.config;
    const storePath = this.sessionStore.resolveStorePath(hostConfig?.session?.store, { agentId: 'main', env: process.env });
    if (typeof storePath !== 'string' || storePath.trim() === '') throw Object.assign(new Error('The authoritative Session store identity is unavailable.'), { code: 'sessions-unavailable' });
    return storePath;
  }

  async runtime() {
    if (this.transcript) return this.transcript;
    // This is the published OpenClaw SDK identity. It is lazy so contract and
    // recovery tests can inject a transcript seam without loading host-only
    // transitive dependencies in the isolated candidate process.
    this.transcript = await import('openclaw/plugin-sdk/session-transcript-runtime');
    return this.transcript;
  }

  async status() {
    const completion = this.metadata?.getMigrationCompletion?.();
    if (completion) return this.statusShape('complete', completion, [], []);
    const state = this.metadata?.getMigrationState?.();
    if (!this.config && !state) return Object.freeze({ schemaVersion: 1, enabled: false, phase: 'disabled', complete: true, actions: [], channels: [], failures: [] });
    if (!state) return this.statusShape('pending', null, [], []);
    return this.statusShape(state.phase, null, this.metadata.listMigrationChannels?.() ?? [], state.failureCode ? [{ failureCode: state.failureCode, failureSummary: state.failureSummary, failureCount: state.failureCount }] : [], state.revision);
  }

  statusShape(phase, completion, channelRows, failures, migrationRevision = null) {
    const boundedChannels = channelRows.slice(0, 100).map((row) => Object.freeze({
      channelId: row.sourceChannelId, topicId: row.topicId, phase: row.phase,
      expectedCount: row.expectedCount, importedCount: row.importedCount, nextOrdinal: row.nextOrdinal,
      expectedDigest: row.expectedDigest, importedDigest: row.importedDigest,
      ...(row.failureCode ? { failureCode: row.failureCode, failureSummary: String(row.failureSummary ?? '').slice(0, 300), failureCount: row.failureCount } : {})
    }));
    const complete = phase === 'complete';
    return Object.freeze({ schemaVersion: 1, enabled: true, phase, complete, actions: complete ? [] : [
      { id: 'resume-migration', method: 'command-center.v1.migration.resume', scope: 'operator.write' },
      { id: 'review-failures', method: 'command-center.v1.migration.review-failures', scope: 'operator.read' }
    ], channels: boundedChannels, failures: failures.slice(0, 20), ...(migrationRevision === null ? {} : { migrationRevision }), ...(completion ? { completion: { schemaVersion: completion.schemaVersion, configDigest: completion.configDigest, sourceDigest: completion.sourceDigest, verifiedChannelCount: completion.verifiedChannelCount, verifiedOccurrenceCount: completion.verifiedOccurrenceCount, completionRevision: completion.completionRevision, verifiedAt: completion.verifiedAt } } : {}) });
  }

  async review() { return this.status(); }

  async resume(input = {}) {
    if (!isCanonicalUuid(input.logicalOperationId)) throw new TypeError('Migration Resume requires a canonical logicalOperationId.');
    if (!Number.isSafeInteger(input.expectedMigrationRevision) || input.expectedMigrationRevision < 1) throw new TypeError('Migration Resume requires an expectedMigrationRevision.');
    const intentDigest = digest({ method: 'command-center.v1.migration.resume', expectedMigrationRevision: input.expectedMigrationRevision });
    const existing = this.metadata?.getOperation?.(input.logicalOperationId);
    if (existing) {
      if (existing.intentDigest !== intentDigest || existing.operationKind !== 'migration.resume') throw Object.assign(new Error('Logical operation ID was reused with a different intent.'), { code: 'intent-mismatch' });
      if (this.inFlight) return this.inFlight;
      // A durable terminal replay is a read of the completed bootstrap, not a
      // second migration attempt after progress rows have been removed.
      if (existing.state === 'applied' && existing.resultIdentity === MIGRATION_ID) return this.status();
      const result = await this.start({ logicalOperationId: input.logicalOperationId, resume: true });
      this.metadata?.recordOperation?.({ logicalOperationId: input.logicalOperationId, transportRequestId: existing.transportRequestId, intentDigest, operationKind: 'migration.resume', state: result.complete ? 'applied' : 'unknown', resultStatus: result.phase, resultIdentity: result.complete ? MIGRATION_ID : null, observedRevision: String(result.migrationRevision ?? input.expectedMigrationRevision), createdAt: existing.createdAt, updatedAt: this.now() });
      return result;
    }
    const state = this.metadata?.getMigrationState?.();
    if (!state || state.revision !== input.expectedMigrationRevision) throw Object.assign(new Error('Migration revision is stale.'), { code: 'stale-revision' });
    this.metadata?.recordOperation?.({ logicalOperationId: input.logicalOperationId, transportRequestId: input.logicalOperationId, intentDigest, operationKind: 'migration.resume', state: 'pending', observedRevision: String(input.expectedMigrationRevision), createdAt: this.now(), updatedAt: this.now() });
    const result = await this.start({ logicalOperationId: input.logicalOperationId, resume: true });
    this.metadata?.recordOperation?.({ logicalOperationId: input.logicalOperationId, transportRequestId: input.logicalOperationId, intentDigest, operationKind: 'migration.resume', state: result.complete ? 'applied' : 'unknown', resultStatus: result.phase, resultIdentity: result.complete ? 'legacy-discord-v1' : null, observedRevision: String(result.migrationRevision ?? input.expectedMigrationRevision), createdAt: this.now(), updatedAt: this.now() });
    return result;
  }

  async start({ logicalOperationId = randomUUID(), resume = false } = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run({ logicalOperationId, resume }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async run({ logicalOperationId, resume }) {
    // The global tombstone prevents re-import. A valid replacement config is
    // nevertheless reported as a bounded completed-bootstrap conflict so it
    // cannot be mistaken for a new one-time migration.
    const completion = this.metadata?.getMigrationCompletion?.();
    if (completion) {
      try {
        this.metadata.reconcileCompletedLegacyDiscordTopics({ configDigest: completion.configDigest, verifiedTopicCount: completion.verifiedChannelCount, verifiedAt: completion.verifiedAt });
      } catch (error) {
        return this.statusShape('review', null, [], [{ failureCode: 'completed-activation-conflict', failureSummary: String(error?.message ?? error).slice(0, 300) }]);
      }
      try {
        const configured = this.normalizedConfig();
        if (configured && legacyDiscordMigrationConfigDigest(configured) !== completion.configDigest) {
          return this.statusShape('complete', completion, [], [{ failureCode: 'completed-bootstrap-conflict', failureSummary: 'The completed migration configuration differs from its durable tombstone.' }]);
        }
      } catch {
        // Configuration removal or later malformed input cannot re-arm completion.
      }
      return this.status();
    }
    let config;
    try {
      config = this.normalizedConfig();
    } catch (error) {
      const failure = asFailure(error, 'invalid-migration-config');
      try {
        const durable = this.metadata.getMigrationState?.();
        this.metadata?.setMigrationState?.(durable ? { ...durable, phase: 'review', failureCode: failure.code, failureSummary: failure.summary, failureCount: (durable.failureCount ?? 0) + 1, updatedAt: this.now() } : { stateId: MIGRATION_ID, schemaVersion: 1, configDigest: digest(this.config), sourceDigest: ZERO_DIGEST, phase: 'review', failureCode: failure.code, failureSummary: failure.summary, failureCount: 1, updatedAt: this.now() });
      } catch { /* malformed configuration must still produce bounded status */ }
      return this.status();
    }
    if (!config) {
      if (this.metadata.getMigrationState?.()) await this.recordReview(Object.assign(new Error('The durable migration configuration was removed before completion.'), { code: 'config-missing' }), this.metadata.listMigrationChannels?.().map((row) => ({ channel: { channelId: row.sourceChannelId } })) ?? []);
      return this.status();
    }
    let selected;
    let state;
    let configDigest;
    let sourceDigest = ZERO_DIGEST;
    try {
      configDigest = legacyDiscordMigrationConfigDigest(config);
      state = this.metadata.getMigrationState?.();
      if (state && state.configDigest !== configDigest) throw Object.assign(new Error('Migration configuration identity changed.'), { code: 'config-changed' });
      if (!state) {
        this.metadata.setMigrationState({ stateId: MIGRATION_ID, schemaVersion: 1, configDigest, sourceDigest, phase: 'pending', revision: 1, updatedAt: this.now() });
        state = this.metadata.getMigrationState();
      }
      const exportValue = await readLegacyDiscordExport(config.exportPath);
      selected = selectMappedLegacyDiscordChannels(exportValue, config.channels);
      // Unconfigured channels are deliberately outside this one-time import.
      // Their later export changes must not invalidate durable configured work.
      sourceDigest = digest(selected.map(({ channel }) => channel));
      if (state && (state.configDigest !== configDigest || (state.sourceDigest !== ZERO_DIGEST && state.sourceDigest !== sourceDigest))) throw Object.assign(new Error('Migration source identity changed.'), { code: 'source-changed' });
      selected = await this.preflightFolders(selected);
      this.preflightDestinations(selected);
      await this.preflightSessions(selected);
      this.metadata.setMigrationState({ stateId: MIGRATION_ID, schemaVersion: 1, configDigest, sourceDigest, phase: state.phase === 'review' ? 'pending' : state.phase, failureCode: null, failureSummary: null, failureCount: state.failureCount ?? 0, updatedAt: this.now() });
      phaseHook(this.hooks, 'beforeRun', { logicalOperationId, resume, configDigest, sourceDigest });
      await this.provision(selected, { configDigest, sourceDigest });
      await this.import(selected, { configDigest, sourceDigest });
      await this.verify(selected, { configDigest, sourceDigest });
      const verifiedChannels = selected.length;
      const verifiedOccurrences = selected.reduce((total, item) => total + item.channel.occurrences.length, 0);
      this.metadata.completeLegacyDiscordMigration({ configDigest, sourceDigest, verifiedChannelCount: verifiedChannels, verifiedOccurrenceCount: verifiedOccurrences, completionRevision: this.metadata.getMigrationState()?.revision ?? 1, verifiedAt: this.now() });
      phaseHook(this.hooks, 'afterComplete', { logicalOperationId });
      return this.status();
    } catch (error) {
      await this.recordReview(error, selected);
      this.logger?.warn?.(`Legacy Discord migration requires review (${asFailure(error).code}).`);
      return this.status();
    }
  }

  async preflightFolders(selected) {
    const seen = new Set();
    const prepared = [];
    for (const item of selected) {
      let verified;
      try { verified = await this.folderVerifier(item.mapping.noteFolderPath); }
      catch (error) { throw Object.assign(new Error('The configured Note Folder is unavailable or unsafe.', { cause: error }), { code: error?.code ?? 'folder-unavailable', channelId: item.channel.channelId }); }
      const canonicalPath = typeof verified === 'string' && verified.trim() !== '' ? verified : item.mapping.noteFolderPath;
      if (seen.has(canonicalPath)) throw Object.assign(new Error('Configured Note Folders resolve to the same authoritative directory.'), { code: 'folder-conflict' });
      seen.add(canonicalPath);
      prepared.push(Object.freeze({ channel: item.channel, mapping: Object.freeze({ ...item.mapping, noteFolderPath: canonicalPath }) }));
    }
    return Object.freeze(prepared);
  }

  preflightDestinations(selected) {
    const allReferences = this.metadata.listSourceReferences?.() ?? [];
    const migrationState = this.metadata.getMigrationState?.();
    for (const { channel, mapping } of selected) {
      const row = this.metadata.getMigrationChannel?.(channel.channelId) ?? null;
      const topic = this.metadata.getTopic?.(mapping.topicId) ?? null;
      const expectedReferences = new Set([`migration:folder:${channel.channelId}`, `migration:session:${channel.channelId}`]);
      const references = topic ? this.metadata.listSourceReferences?.(mapping.topicId) ?? [] : [];
      const ownershipMarker = `legacy-discord-owner:${migrationState?.configDigest ?? ''}`;
      const durableBootstrapOwnership = topic?.lifecycle === 'provisioning' && references.length > 0 && references.every((reference) => expectedReferences.has(reference.referenceId)) && references.some((reference) => reference.referenceId === `migration:folder:${channel.channelId}` && reference.observedRevision === ownershipMarker);
      if (topic && !row && !durableBootstrapOwnership) throw Object.assign(new Error('Configured destination Topic already exists outside this migration ledger.'), { code: 'topic-conflict', channelId: channel.channelId });
      const expectedFolderReferenceId = `migration:folder:${channel.channelId}`;
      const folderOwners = allReferences.filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder' && reference.externalSourceId === mapping.noteFolderPath);
      if (folderOwners.some((reference) => reference.referenceId !== expectedFolderReferenceId || reference.topicId !== mapping.topicId)) throw Object.assign(new Error('Configured Note Folder is already bound outside this migration destination.'), { code: 'folder-conflict', channelId: channel.channelId });
      const expectedLifecycle = row?.phase === 'complete' ? 'active' : 'provisioning';
      if (row && (row.topicId !== mapping.topicId || topic?.lifecycle !== expectedLifecycle)) throw Object.assign(new Error('Migration destination Topic ownership differs from its durable ledger.'), { code: 'topic-conflict', channelId: channel.channelId });
    }
  }

  async preflightSessions(selected) {
    if (!this.hasSessionCatalog()) throw Object.assign(new Error('The Sessions capability is unavailable.'), { code: 'sessions-unavailable' });
    for (const { channel, mapping } of selected) {
      const expectedSessionKey = `agent:main:command-center:legacy-discord:${channel.channelId}`;
      const matches = await this.sessionMatches(expectedSessionKey, channel.channelId);
      const expectedReference = this.metadata.getTopic(mapping.topicId) ? this.metadata.listSourceReferences(mapping.topicId).find((reference) => reference.referenceId === `migration:session:${channel.channelId}`) : null;
      if (matches.length > 1 || (matches.length === 1 && !expectedReference)) throw Object.assign(new Error('The deterministic Primary Session is unavailable or not owned by this migration.'), { code: 'session-conflict', channelId: channel.channelId });
      if (this.sessionStore && matches.length === 1 && readSessionId(matches[0]) !== deterministicSessionId(expectedSessionKey)) throw Object.assign(new Error('The deterministic Primary Session key is owned by a different Session identity.'), { code: 'session-conflict', channelId: channel.channelId });
    }
  }

  async sessionMatches(expectedSessionKey, channelId) {
    if (this.sessionStore?.listSessionEntries) {
      const storePath = this.authoritativeStorePath();
      const entries = this.sessionStore.listSessionEntries({ agentId: 'main', env: process.env, readOnly: true, ...(storePath ? { storePath } : {}) });
      return entries.filter((item) => item?.sessionKey === expectedSessionKey).map((item) => ({ sessionKey: item.sessionKey, sessionId: item.entry?.sessionId }));
    }
    const matches = [];
    let offset = 0;
    while (true) {
      const listing = await this.gateway.request('sessions.list', { agentId: 'main', search: expectedSessionKey, limit: 100, offset });
      matches.push(...sessionRows(listing).filter((entry) => readSessionKey(entry) === expectedSessionKey));
      if (matches.length > 1 || listing?.hasMore !== true) return matches;
      if (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset <= offset) throw Object.assign(new Error('The Sessions catalog pagination did not advance.'), { code: 'session-conflict', channelId });
      offset = listing.nextOffset;
    }
  }

  async reconcileSession(expectedSessionKey, channelId) {
    if (!this.hasSessionCatalog()) throw Object.assign(new Error('The Sessions capability is unavailable.'), { code: 'sessions-unavailable', channelId });
    const matches = await this.sessionMatches(expectedSessionKey, channelId);
    if (matches.length > 1) throw Object.assign(new Error('The deterministic Primary Session is ambiguous.'), { code: 'session-conflict', channelId });
    if (this.sessionStore && matches.length === 1 && readSessionId(matches[0]) !== deterministicSessionId(expectedSessionKey)) throw Object.assign(new Error('The deterministic Primary Session key is owned by a different Session identity.'), { code: 'session-conflict', channelId });
    return matches.length === 1 ? readSessionId(matches[0]) : null;
  }

  hasSessionCatalog() {
    return Boolean(this.sessionStore?.listSessionEntries && this.sessionStore?.getSessionEntry && this.sessionStore?.patchSessionEntry) || Boolean(this.gateway?.request);
  }

  async createSession(expectedSessionKey, channel) {
    if (!this.sessionStore) {
      return this.gateway.request('sessions.create', { agentId: 'main', ['k' + 'ey']: expectedSessionKey, label: `Primary Session — ${channel.displayName}` });
    }
    const sessionId = deterministicSessionId(expectedSessionKey);
    const storePath = this.authoritativeStorePath();
    const fallbackEntry = { sessionId, updatedAt: Date.now(), label: `Primary Session — ${channel.displayName}` };
    await this.sessionStore.patchSessionEntry({
      sessionKey: expectedSessionKey,
      agentId: 'main',
      env: process.env,
      ...(storePath ? { storePath } : {}),
      fallbackEntry,
      replaceEntry: true,
      update: (entry, context) => context?.existingEntry ? null : entry
    });
    const entry = this.sessionStore.getSessionEntry({ sessionKey: expectedSessionKey, agentId: 'main', env: process.env, readConsistency: 'latest', ...(storePath ? { storePath } : {}) });
    if (!entry || entry.sessionId !== sessionId) throw Object.assign(new Error('The deterministic Primary Session is unavailable or owned by another creator.'), { code: 'session-conflict', channelId: channel.channelId });
    return { sessionKey: expectedSessionKey, sessionId };
  }

  async provision(selected, { configDigest, sourceDigest }) {
    this.metadata.setMigrationState({ stateId: MIGRATION_ID, schemaVersion: 1, configDigest, sourceDigest, phase: 'provisioning', updatedAt: this.now() });
    for (const item of selected) {
      const channel = item.channel;
      const mapping = item.mapping;
      let row = this.metadata.getMigrationChannel?.(channel.channelId);
      if (row?.phase === 'complete') continue;
      phaseHook(this.hooks, 'beforePhase', { phase: 'provisioning', channelId: channel.channelId });
      const topic = this.metadata.getTopic(mapping.topicId);
      let references = topic ? this.metadata.listSourceReferences(mapping.topicId) : [];
      let topicCreated = false;
      if (!topic) {
        if (typeof this.metadata.createMigrationTopicBinding !== 'function') throw Object.assign(new Error('Atomic migration Topic binding persistence is unavailable.'), { code: 'destination-corrupt', channelId: channel.channelId });
        this.metadata.createMigrationTopicBinding({ topic: { topicId: mapping.topicId, paraCategory: mapping.paraCategory, lifecycle: 'provisioning', createdAt: this.now(), updatedAt: this.now() }, reference: { version: 1, referenceId: `migration:folder:${channel.channelId}`, topicId: mapping.topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: mapping.noteFolderPath, observedRevision: `legacy-discord-owner:${configDigest}`, createdAt: this.now(), updatedAt: this.now() } });
        topicCreated = true;
        references = this.metadata.listSourceReferences(mapping.topicId);
        phaseHook(this.hooks, 'afterTopicBinding', { channelId: channel.channelId, topicId: mapping.topicId });
      } else if (!row && !references.length) {
        throw Object.assign(new Error('Configured destination Topic already exists.'), { code: 'topic-conflict', channelId: channel.channelId });
      } else if (!row && references.some((reference) => ![`migration:folder:${channel.channelId}`, `migration:session:${channel.channelId}`].includes(reference.referenceId))) {
        throw Object.assign(new Error('Configured destination Topic has bindings outside this migration ledger.'), { code: 'topic-conflict', channelId: channel.channelId });
      } else if (topic.paraCategory !== mapping.paraCategory) {
        throw Object.assign(new Error('Configured destination Topic classification conflicts.'), { code: 'topic-conflict', channelId: channel.channelId });
      }
      let folders = references.filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder' && reference.externalSourceId === mapping.noteFolderPath);
      const expectedSessionReferenceId = `migration:session:${channel.channelId}`;
      const expectedSessionKey = `agent:main:command-center:legacy-discord:${channel.channelId}`;
      if (!row && references.length > 0 && references.some((reference) => reference.referenceId !== expectedSessionReferenceId
        && !(reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder' && reference.externalSourceId === mapping.noteFolderPath))) {
        throw Object.assign(new Error('Configured provisioning Topic already has unrelated bindings.'), { code: 'topic-conflict', channelId: channel.channelId });
      }
      if (folders.length === 0 && topicCreated) folders = references.filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder' && reference.externalSourceId === mapping.noteFolderPath);
      if (folders.length !== 1) throw Object.assign(new Error('The exact configured Note Folder Source Reference is unavailable or ambiguous.'), { code: 'folder-conflict', channelId: channel.channelId });
      const noteFolderReference = folders[0];
      let sessionReference;
      let sessionId;
      if (row) {
        sessionReference = references.find((reference) => reference.referenceId === row.sessionReferenceId);
        sessionId = row.sessionId;
        if (!sessionReference || sessionReference.sourceSystem !== 'openclaw' || sessionReference.sourceKind !== 'session' || sessionReference.externalSourceId !== expectedSessionKey) throw Object.assign(new Error('The recorded Primary Session binding is unavailable or rebound.'), { code: 'session-conflict', channelId: channel.channelId });
      } else {
        sessionReference = references.find((reference) => reference.referenceId === expectedSessionReferenceId);
        if (sessionReference) {
          if (sessionReference.sourceSystem !== 'openclaw' || sessionReference.sourceKind !== 'session' || sessionReference.externalSourceId !== expectedSessionKey) throw Object.assign(new Error('The recorded Primary Session binding has an unexpected identity.'), { code: 'session-conflict', channelId: channel.channelId });
          sessionId = this.metadata.getSessionState(sessionReference.referenceId)?.sessionId;
          if (!sessionId) {
            sessionId = await this.reconcileSession(expectedSessionKey, channel.channelId);
            if (!sessionId) {
              const result = await this.createSession(expectedSessionKey, channel);
              sessionId = readSessionId(result);
              if (!sessionId || (readSessionKey(result) !== null && readSessionKey(result) !== expectedSessionKey)) throw Object.assign(new Error('The Sessions capability returned an unexpected identity.'), { code: 'session-conflict', channelId: channel.channelId });
              phaseHook(this.hooks, 'afterSessionCreate', { channelId: channel.channelId, sessionId });
            }
            this.metadata.setSessionState({ referenceId: sessionReference.referenceId, sessionId, status: 'open', isPrimary: true, updatedAt: this.now() });
          }
        } else {
          if (!this.hasSessionCatalog()) throw Object.assign(new Error('The Sessions capability is unavailable.'), { code: 'sessions-unavailable', channelId: channel.channelId });
          sessionReference = { version: 1, referenceId: expectedSessionReferenceId, topicId: mapping.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: expectedSessionKey, observedRevision: null, createdAt: this.now(), updatedAt: this.now() };
          this.metadata.createSourceReference(sessionReference);
          sessionId = await this.reconcileSession(expectedSessionKey, channel.channelId);
          if (!sessionId) {
            const result = await this.createSession(expectedSessionKey, channel);
            sessionId = readSessionId(result);
            if (!sessionId || (readSessionKey(result) !== null && readSessionKey(result) !== expectedSessionKey)) throw Object.assign(new Error('The Sessions capability returned an unexpected identity.'), { code: 'session-conflict', channelId: channel.channelId });
            phaseHook(this.hooks, 'afterSessionCreate', { channelId: channel.channelId, sessionId });
          }
          this.metadata.setSessionState({ referenceId: sessionReference.referenceId, sessionId, status: 'open', isPrimary: true, displayName: `Primary Session — ${channel.displayName}`, updatedAt: this.now() });
        }
      }
      phaseHook(this.hooks, 'afterProvisioningBinding', { channelId: channel.channelId, topicId: mapping.topicId, sessionId });
      row = this.metadata.setMigrationChannel({ sourceChannelId: channel.channelId, topicId: mapping.topicId, noteFolderReferenceId: noteFolderReference.referenceId, sessionReferenceId: sessionReference.referenceId, sessionId, phase: 'pending', expectedCount: channel.occurrences.length, expectedDigest: channelDigest(channel), importedCount: row?.importedCount ?? 0, importedDigest: row?.importedDigest ?? ZERO_DIGEST, nextOrdinal: row?.nextOrdinal ?? 0, failureCount: row?.failureCount ?? 0, updatedAt: this.now() });
      const expectedOccurrences = channel.occurrences.map((occurrence) => {
        const identity = occurrenceIdentity(channel.channelId, occurrence);
        return { occurrenceId: identity.occurrenceId, occurrenceDigest: identity.occurrenceDigest, displayOrder: occurrence.displayOrder };
      });
      const persistedOccurrences = this.metadata.setMigrationOccurrences?.(channel.channelId, expectedOccurrences) ?? [];
      if (persistedOccurrences.length !== expectedOccurrences.length || persistedOccurrences.some((row, index) => row.occurrenceId !== expectedOccurrences[index].occurrenceId || row.occurrenceDigest !== expectedOccurrences[index].occurrenceDigest || row.displayOrder !== expectedOccurrences[index].displayOrder)) throw Object.assign(new Error('Migration occurrence checkpoint conflicts with the configured source.'), { code: 'destination-corrupt', channelId: channel.channelId });
      phaseHook(this.hooks, 'afterPhase', { phase: 'provisioning', channelId: channel.channelId, row });
    }
  }

  async readEvents(row) {
    const runtime = await this.runtime();
    const readPage = runtime.readSessionTranscriptVisibleMessageDelta;
    if (typeof readPage === 'function') {
      const target = await this.transcriptTarget(row);
      const entries = [];
      let cursor;
      do {
        const page = await readPage({ ...target, ...(cursor ? { cursor } : {}), maxBytes: 1_048_576, maxMessages: 200 });
        if (page?.kind === 'missing') return [];
        if (page?.kind !== 'page') throw Object.assign(new Error('The authoritative transcript projection is unavailable or changed during migration.'), { code: 'destination-corrupt' });
        entries.push(...page.entries);
        if (!page.hasMore) return entries;
        if (typeof page.cursor !== 'string' || page.cursor === cursor) throw Object.assign(new Error('The authoritative transcript cursor did not advance.'), { code: 'destination-corrupt' });
        cursor = page.cursor;
      } while (true);
    }
    const read = runtime.readVisibleSessionTranscriptMessageEntries;
    if (typeof read !== 'function') throw Object.assign(new Error('The Sessions visible transcript read capability is unavailable.'), { code: 'sessions-unavailable' });
    return read(await this.transcriptTarget(row));
  }

  async transcriptTarget(row) {
    const runtime = await this.runtime();
    const target = { agentId: 'main', sessionKey: this.metadata.getSourceReference(row.sessionReferenceId).externalSourceId, sessionId: row.sessionId };
    const storePath = this.authoritativeStorePath();
    if (storePath) target.storePath = storePath;
    if (typeof runtime.resolveSessionTranscriptIdentity === 'function') {
      const identity = await runtime.resolveSessionTranscriptIdentity(target);
      if (identity?.agentId !== 'main' || identity?.sessionKey !== target.sessionKey || identity?.sessionId !== target.sessionId) throw Object.assign(new Error('The resolved Primary Session identity differs from the durable binding.'), { code: 'session-rebound' });
    }
    return target;
  }

  async append(row, channel, occurrence, previousEventId) {
    const runtime = await this.runtime();
    const append = runtime.appendSessionTranscriptMessageByIdentityStrict;
    if (typeof append !== 'function' || typeof runtime.withSessionTranscriptWriteLock !== 'function') throw Object.assign(new Error('The Sessions strict transcript append capability is unavailable.'), { code: 'sessions-unavailable' });
    const identity = occurrenceIdentity(channel.channelId, occurrence);
    const target = await this.transcriptTarget(row);
    const params = { eventId: identity.eventId, idempotencyLookup: 'scan', idempotencyKey: identity.idempotencyKey, parentId: previousEventId ?? undefined, message: canonicalImportedUserMessage(channel.channelId, occurrence), now: Date.parse(occurrence.timestamp), updateMode: 'none' };
    const result = await append({ ...target, ...params });
    if (result?.kind === 'rejected') throw Object.assign(new Error('The Primary Session identity changed during import.'), { code: 'session-rebound', channelId: channel.channelId });
    if (result?.kind !== 'result' || result.result?.messageId !== identity.eventId) throw Object.assign(new Error('The Primary Session append was suppressed or returned a conflicting identity.'), { code: 'destination-corrupt', channelId: channel.channelId });
    return result;
  }

  async import(selected, { configDigest, sourceDigest }) {
    this.metadata.setMigrationState({ stateId: MIGRATION_ID, schemaVersion: 1, configDigest, sourceDigest, phase: 'importing', updatedAt: this.now() });
    for (const item of selected) {
      const channel = item.channel;
      let row = this.metadata.getMigrationChannel(channel.channelId);
      if (!row) throw Object.assign(new Error('Migration channel provisioning state is missing.'), { code: 'destination-corrupt', channelId: channel.channelId });
      if (row.phase === 'complete') continue;
      phaseHook(this.hooks, 'beforePhase', { phase: 'importing', channelId: channel.channelId });
      const events = transcriptEntries(await this.readEvents(row));
      if (events.length > channel.occurrences.length) throw Object.assign(new Error('An ordinary transcript suffix exists before migration verification.'), { code: 'destination-corrupt', channelId: channel.channelId });
      for (const [index, entry] of events.entries()) {
        const occurrence = channel.occurrences[index];
        const expectedParentId = index === 0 ? null : events[index - 1].eventId;
        if (!occurrence || !provenanceMatches(entry.message, channel.channelId, occurrence) || entry.eventId !== occurrenceIdentity(channel.channelId, occurrence).eventId || entry.parentId !== expectedParentId) throw Object.assign(new Error('The existing transcript is not the exact imported source prefix.'), { code: 'destination-corrupt', channelId: channel.channelId });
      }
      let previousEventId = events.at(-1)?.eventId ?? null;
      // The ledger is a checkpoint, never proof of a transcript write. Re-read
      // every deterministic occurrence so a checkpoint that survived before an
      // append is repaired rather than silently skipped.
      for (let index = 0; index < channel.occurrences.length; index += 1) {
        const occurrence = channel.occurrences[index];
        const identity = occurrenceIdentity(channel.channelId, occurrence);
        const existing = events[index]?.message?.__openclaw?.legacyDiscordV1?.occurrenceId === identity.occurrenceId ? events[index] : null;
        const checkpoint = this.metadata.listMigrationOccurrences(channel.channelId).find((entry) => entry.occurrenceId === identity.occurrenceId);
        let result;
        if (existing) {
          if (!provenanceMatches(existing.message, channel.channelId, occurrence)) throw Object.assign(new Error('An imported occurrence payload differs from the unchanged source.'), { code: 'destination-corrupt', channelId: channel.channelId });
          if (!checkpoint?.destinationMessageId || !checkpoint?.destinationAnchor) result = await this.append(row, channel, occurrence, index === 0 ? null : events[index - 1]?.eventId ?? null);
          previousEventId = existing.eventId ?? previousEventId;
        } else {
          result = await this.append(row, channel, occurrence, previousEventId);
          previousEventId = result?.result?.messageId ?? result?.messageId ?? previousEventId;
          events.push({ event: { id: previousEventId, parentId: index === 0 ? null : events.at(-1)?.eventId ?? null }, eventId: previousEventId, parentId: index === 0 ? null : events.at(-1)?.eventId ?? null, message: canonicalImportedUserMessage(channel.channelId, occurrence) });
        }
        if (result) phaseHook(this.hooks, 'afterAuthoritativeAppend', { phase: 'importing', channelId: channel.channelId, displayOrder: occurrence.displayOrder, occurrenceId: identity.occurrenceId, destinationMessageId: result.result.messageId });
        if (result) {
          const target = { ...(await this.transcriptTarget(row)), sourceChannelId: channel.channelId };
          this.metadata.setMigrationOccurrences(channel.channelId, [{ occurrenceId: identity.occurrenceId, occurrenceDigest: identity.occurrenceDigest, displayOrder: occurrence.displayOrder, destinationMessageId: result.result.messageId, destinationAnchor: durableAnchor(result.result, target, occurrence, index === 0 ? null : events[index - 1]?.eventId ?? null, index) }]);
        }
        phaseHook(this.hooks, 'afterAppend', { phase: 'importing', channelId: channel.channelId, displayOrder: occurrence.displayOrder, occurrenceId: identity.occurrenceId });
        row = this.metadata.setMigrationChannel({ ...row, phase: 'importing', importedCount: index + 1, importedDigest: digest(channel.occurrences.slice(0, index + 1).map((entry) => occurrenceIdentity(channel.channelId, entry))), nextOrdinal: index + 1, updatedAt: this.now() });
        phaseHook(this.hooks, 'afterCheckpoint', { phase: 'importing', channelId: channel.channelId, displayOrder: occurrence.displayOrder });
      }
      this.metadata.setMigrationChannel({ ...row, phase: 'verifying', nextOrdinal: channel.occurrences.length, updatedAt: this.now() });
      // A channel is one bounded batch: publish only after all of its ordered
      // occurrences have committed, never once per imported message.
      const runtime = await this.runtime();
      await runtime.withSessionTranscriptWriteLock(await this.transcriptTarget(row), async (locked) => {
        if (typeof locked?.publishUpdate === 'function') await locked.publishUpdate();
      });
      phaseHook(this.hooks, 'afterPhase', { phase: 'importing', channelId: channel.channelId });
    }
  }

  async verify(selected, { configDigest, sourceDigest }) {
    this.metadata.setMigrationState({ stateId: MIGRATION_ID, schemaVersion: 1, configDigest, sourceDigest, phase: 'verifying', updatedAt: this.now() });
    for (const item of selected) {
      try { await this.folderVerifier(item.mapping.noteFolderPath); }
      catch (error) { throw Object.assign(new Error('The configured Note Folder failed final verification.', { cause: error }), { code: error?.code ?? 'folder-unavailable', channelId: item.channel.channelId }); }
      const row = this.metadata.getMigrationChannel(item.channel.channelId);
      const topic = this.metadata.getTopic(row?.topicId);
      const references = topic ? this.metadata.listSourceReferences(row.topicId) : [];
      const folder = references.filter((reference) => reference.referenceId === row?.noteFolderReferenceId && reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder' && reference.externalSourceId === item.mapping.noteFolderPath);
      const expectedSessionKey = `agent:main:command-center:legacy-discord:${item.channel.channelId}`;
      const session = references.filter((reference) => reference.referenceId === row?.sessionReferenceId && reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session' && reference.externalSourceId === expectedSessionKey);
      const sessionState = row ? this.metadata.getSessionState(row.sessionReferenceId) : null;
      const completedChannel = row?.phase === 'complete';
      const expectedLifecycle = completedChannel ? 'active' : 'provisioning';
      if (!row || !topic || topic.lifecycle !== expectedLifecycle || (!completedChannel && references.length !== 2) || folder.length !== 1 || session.length !== 1 || !sessionState || sessionState.sessionId !== row.sessionId || sessionState.status !== 'open' || sessionState.isPrimary !== true) throw Object.assign(new Error('Destination Topic bindings are incomplete, ambiguous, or rebound.'), { code: 'verification-failed', channelId: item.channel.channelId });
      if (row.expectedCount !== item.channel.occurrences.length || row.expectedDigest !== channelDigest(item.channel) || row.importedCount !== item.channel.occurrences.length || row.importedDigest !== occurrenceSequenceDigest(item.channel) || row.nextOrdinal !== item.channel.occurrences.length) throw Object.assign(new Error('Migration checkpoint does not match the exact source occurrence set.'), { code: 'verification-failed', channelId: item.channel.channelId });
      const checkpoints = this.metadata.listMigrationOccurrences?.(item.channel.channelId) ?? [];
      if (checkpoints.length !== item.channel.occurrences.length || checkpoints.some((checkpoint, index) => checkpoint.occurrenceId !== occurrenceIdentity(item.channel.channelId, item.channel.occurrences[index]).occurrenceId || checkpoint.occurrenceDigest !== occurrenceIdentity(item.channel.channelId, item.channel.occurrences[index]).occurrenceDigest || checkpoint.displayOrder !== item.channel.occurrences[index].displayOrder || checkpoint.destinationMessageId !== occurrenceIdentity(item.channel.channelId, item.channel.occurrences[index]).eventId || checkpoint.destinationAnchor?.entryId !== checkpoint.destinationMessageId || checkpoint.destinationAnchor?.sessionId !== row.sessionId || checkpoint.destinationAnchorDigest !== digest(checkpoint.destinationAnchor))) throw Object.assign(new Error('Migration occurrence identity checkpoints differ from source or authoritative anchors.'), { code: 'verification-failed', channelId: item.channel.channelId });
      const entries = transcriptEntries(await this.readEvents(row));
      const imported = entries.filter((entry) => entry.message?.__openclaw?.legacyDiscordV1?.immutable === true);
      if (imported.length !== item.channel.occurrences.length) throw Object.assign(new Error('Source coverage does not match the Primary Session prefix.'), { code: 'verification-failed', channelId: item.channel.channelId });
      if (!completedChannel && (entries.length !== imported.length || entries.some((entry) => entry.message?.__openclaw?.legacyDiscordV1?.immutable !== true))) throw Object.assign(new Error('A foreign transcript event exists during the immutable import prefix.'), { code: 'verification-failed', channelId: item.channel.channelId });
      for (const [index, occurrence] of item.channel.occurrences.entries()) {
        const entry = imported[index];
        const checkpoint = checkpoints[index];
        const identity = occurrenceIdentity(item.channel.channelId, occurrence);
        if (!entry || entry.eventId !== identity.eventId || entry.message?.idempotencyKey !== identity.idempotencyKey || !provenanceMatches(entry.message, item.channel.channelId, occurrence)) throw Object.assign(new Error('Primary Session prefix identity, order, or payload differs from source.'), { code: 'verification-failed', channelId: item.channel.channelId });
        const expectedParentId = index === 0 ? null : imported[index - 1].eventId;
        if (entry.parentId !== expectedParentId) throw Object.assign(new Error('Primary Session imported parent ordering differs.'), { code: 'verification-failed', channelId: item.channel.channelId });
        const anchor = checkpoint.destinationAnchor;
        if (anchor.sessionKey !== expectedSessionKey || anchor.entryId !== entry.eventId || anchor.effectiveParentId !== entry.parentId || anchor.activeMessagePosition !== index || anchor.idempotencyKey !== identity.idempotencyKey) throw Object.assign(new Error('Migration occurrence anchor differs from the authoritative visible transcript.'), { code: 'verification-failed', channelId: item.channel.channelId });
      }
      if (item.channel.occurrences.length === 0) {
        if (!completedChannel && entries.length !== 0) throw Object.assign(new Error('An empty imported prefix has unexpected Primary Session messages.'), { code: 'verification-failed', channelId: item.channel.channelId });
      } else {
        const firstImportedIndex = entries.findIndex((entry) => entry.message?.__openclaw?.legacyDiscordV1?.immutable === true);
        if (firstImportedIndex !== 0) throw Object.assign(new Error('Ordinary Primary Session messages precede the imported prefix.'), { code: 'verification-failed', channelId: item.channel.channelId });
        if (entries.some((entry, index) => index < imported.length && entry.message?.__openclaw?.legacyDiscordV1?.immutable !== true)) throw Object.assign(new Error('The imported prefix contains an ordinary message.'), { code: 'verification-failed', channelId: item.channel.channelId });
      }
      if (!completedChannel) {
        this.metadata.setMigrationChannel({ ...row, phase: 'verifying', importedCount: imported.length, nextOrdinal: item.channel.occurrences.length, updatedAt: this.now() });
      } else if (row.failureCode) {
        this.metadata.setMigrationChannel({ ...row, phase: 'complete', failureCode: null, failureSummary: null, updatedAt: this.now() });
      }
      phaseHook(this.hooks, 'afterVerify', { channelId: item.channel.channelId });
      const runtime = await this.runtime();
      await runtime.withSessionTranscriptWriteLock(await this.transcriptTarget(row), async (locked) => {
          if (typeof locked?.readEvents !== 'function') throw Object.assign(new Error('The authoritative transcript lock cannot verify committed events.'), { code: 'sessions-unavailable', channelId: item.channel.channelId });
          const committed = transcriptEntries(await locked.readEvents());
          if (committed.length < item.channel.occurrences.length || (!completedChannel && committed.length !== item.channel.occurrences.length) || committed.slice(0, item.channel.occurrences.length).some((entry) => entry.message?.__openclaw?.legacyDiscordV1?.immutable !== true)) throw Object.assign(new Error('A foreign transcript event appeared before the durable imported prefix boundary.'), { code: 'verification-failed', channelId: item.channel.channelId });
          for (const [index, occurrence] of item.channel.occurrences.entries()) {
            const entry = committed[index];
            const identity = occurrenceIdentity(item.channel.channelId, occurrence);
            const expectedParentId = index === 0 ? null : committed[index - 1]?.eventId ?? null;
            if (!entry || entry.eventId !== identity.eventId || entry.parentId !== expectedParentId || !provenanceMatches(entry.message, item.channel.channelId, occurrence)) throw Object.assign(new Error('Primary Session prefix changed before durable channel activation.'), { code: 'verification-failed', channelId: item.channel.channelId });
            if (typeof runtime.readSessionTranscriptVisibleMessageDelta === 'function') {
              const replay = await locked.appendMessage({ eventId: identity.eventId, idempotencyLookup: 'scan', idempotencyKey: identity.idempotencyKey, parentId: expectedParentId ?? undefined, message: canonicalImportedUserMessage(item.channel.channelId, occurrence), now: Date.parse(occurrence.timestamp) });
              const target = { ...(await this.transcriptTarget(row)), sourceChannelId: item.channel.channelId };
              const authoritativeAnchor = durableAnchor(replay, target, occurrence, expectedParentId, index);
              if (!replay || digest(authoritativeAnchor) !== checkpoints[index].destinationAnchorDigest) throw Object.assign(new Error('Migration occurrence generation or raw anchor changed before activation.'), { code: 'verification-failed', channelId: item.channel.channelId });
            }
          }
          if (!completedChannel) this.metadata.completeLegacyDiscordMigrationChannel(item.channel.channelId, this.now());
      });
    }
  }

  async recordReview(error, selected = []) {
    const failure = asFailure(error);
    const channelId = error?.channelId ?? selected?.[0]?.channel?.channelId;
    try {
      if (channelId && this.metadata.getMigrationChannel?.(channelId)) {
        const row = this.metadata.getMigrationChannel(channelId);
        // A channel activation is its last safe durable boundary. A later
        // whole-set re-verification failure must not regress that channel into
        // an active-Topic/review-row state that can never pass preflight.
        this.metadata.setMigrationChannel({ ...row, phase: row.phase === 'complete' ? 'complete' : 'review', failureCode: failure.code, failureSummary: failure.summary, failureCount: (row.failureCount ?? 0) + 1, updatedAt: this.now() });
      }
      const state = this.metadata.getMigrationState?.();
      if (state) this.metadata.setMigrationState({ ...state, phase: 'review', failureCode: failure.code, failureSummary: channelId ? `${failure.summary}:${channelId}`.slice(0, 300) : failure.summary, failureCount: (state.failureCount ?? 0) + 1, updatedAt: this.now() });
    } catch { /* Review must stay bounded even when storage is already unavailable. */ }
  }
}

export function createLegacyDiscordMigrationService(options) { return new LegacyDiscordMigrationService(options); }
