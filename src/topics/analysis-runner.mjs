import { createHash, randomUUID } from 'node:crypto';
import { candidateToProposal, eligibleTopics, MAX_CHANGED_TOPICS, MAX_PROPOSALS, orderProposals } from './analysis-policy.mjs';
import { canonicalJson, materialEvidenceDigest } from './analysis-evidence.mjs';

const locks = new WeakMap();
const MAX_SOURCES = 100;
function nowIso(now) { const value = typeof now === 'function' ? now() : now; return new Date(typeof value === 'number' ? value : Date.parse(value)).toISOString(); }
function sourceRevision(metadata, source) { return metadata.getSourceLocator?.(source.referenceId)?.observedRevision ?? source.observedRevision ?? `unobserved:${source.referenceId}`; }
function freeze(value) { return Object.freeze(value); }
function publicFailure(error) { return error?.code === 'conflict' ? 'Topic Analysis was blocked by a source revision conflict.' : 'Topic Analysis could not complete.'; }
function withoutCaptureTimes(value) {
  if (Array.isArray(value)) return value.map(withoutCaptureTimes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:capturedAt|captureTime|observedAt)$/u.test(key)).map(([key, item]) => [key, withoutCaptureTimes(item)]));
  return value;
}
function proposalContent(proposal, evidenceDigest) {
  return { operation: proposal.operation, affectedTopicIds: proposal.affectedTopicIds, affectedSourceIds: proposal.affectedSourceIds, plannedSourceIds: proposal.plannedSourceIds, before: proposal.before, after: proposal.after, rationale: proposal.rationale, provenance: withoutCaptureTimes(proposal.provenance), searchRetrievalConsequences: proposal.searchRetrievalConsequences, dependencies: proposal.dependencies, blockers: proposal.blockers, reversibility: proposal.reversibility, materialEvidenceDigest: evidenceDigest };
}

export function topicAnalysisRunId(logicalOperationId) {
  if (!logicalOperationId) return randomUUID();
  const hex = createHash('sha256').update(`command-center:topic-analysis:${logicalOperationId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

export class TopicAnalysisRunner {
  constructor(options = {}) {
    this.metadata = options.metadata;
    if (!this.metadata) throw new TypeError('Topic Analysis requires metadata.');
    this.topicService = options.topicService;
    this.analyzer = options.analyzer ?? options.candidateProvider ?? options.analysisProvider;
    this.now = options.now ?? (() => Date.now());
    this.maxChangedTopics = options.maxChangedTopics ?? MAX_CHANGED_TOPICS;
    this.maxProposals = options.maxProposals ?? MAX_PROPOSALS;
  }

  async run(input = {}) {
    const trigger = input.trigger ?? 'manual';
    if (!['weekly', 'manual', 'catch-up'].includes(trigger)) throw new TypeError('Analysis trigger is invalid.');
    const owner = this.metadata;
    const logicalOperationId = input.logicalOperationId;
    const topicId = input.topicId ?? null;
    const intent = { action: 'analysis.run', trigger, topicId };
    if (logicalOperationId) {
      const journal = this.metadata.getOperation?.(logicalOperationId);
      if (journal) {
        if (journal.intentDigest !== canonicalJson(intent)) throw Object.assign(new Error('Logical operation ID was reused with different analysis intent.'), { code: 'intent-mismatch' });
        if (journal.resultIdentity) return JSON.parse(journal.resultIdentity);
      }
    }
    const active = locks.get(owner);
    if (logicalOperationId && active && active.logicalOperationId === logicalOperationId && (active.trigger !== trigger || active.topicId !== topicId)) throw Object.assign(new Error('Logical operation ID was reused with different analysis intent.'), { code: 'intent-mismatch' });
    if (active && active.topicId !== topicId) {
      try { await active.promise; } catch { /* the next exact scope remains independently runnable */ }
      return this.run(input);
    }
    let promise; let ownsLock = false;
    if (active) {
      promise = active.promise;
      if (logicalOperationId) {
        const at = nowIso(this.now);
        this.metadata.recordOperation?.({ logicalOperationId, transportRequestId: logicalOperationId, intentDigest: canonicalJson(intent), operationKind: 'topic-analysis.run', state: 'pending', resultStatus: 'pending', resultIdentity: null, observedRevision: active.runId, createdAt: at, updatedAt: at });
      }
    }
    else {
      const runId = topicAnalysisRunId(logicalOperationId);
      promise = Promise.resolve().then(() => this.#runLocked({ ...input, trigger, runId }));
      locks.set(owner, { promise, logicalOperationId, trigger, topicId, runId });
      ownsLock = true;
    }
    try {
      const result = await promise;
      if (logicalOperationId) this.metadata.recordOperation?.({ logicalOperationId, transportRequestId: logicalOperationId, intentDigest: canonicalJson(intent), operationKind: 'topic-analysis.run', state: result.outcome === 'success' ? 'applied' : 'not-applied', resultStatus: result.outcome, resultIdentity: JSON.stringify(result), observedRevision: result.runId, createdAt: result.finishedAt ?? nowIso(this.now), updatedAt: result.finishedAt ?? nowIso(this.now) });
      return result;
    } finally {
      if (ownsLock && locks.get(owner)?.promise === promise) locks.delete(owner);
    }
  }

  async #runLocked({ trigger, topicId = null, runId }) {
    const startedAt = nowIso(this.now);
    const priorRuns = this.metadata.listTopicAnalysisRuns?.() ?? [];
    const previousSuccess = priorRuns.filter((run) => run.outcome === 'success').at(-1) ?? null;
    const baselineCursor = this.metadata.getTopicAnalysisCursor?.() ?? { nextTopicId: null, nextSourceId: null };
    this.metadata.recordTopicAnalysisRun({ runId, schemaVersion: 1, trigger, outcome: 'running', baselineCursor, startedAt });
    let changed = []; let evaluated = 0; let proposals = 0; let retainedOverflowCount = 0; let activitySourceReferenceId = null; let activitySourceRevision = null;
    try {
      const topics = eligibleTopics(this.topicService?.listTopics?.({ includeArchived: true, includeProvisioning: false, includeRetired: false }) ?? this.metadata.listTopics().filter((topic) => topic.lifecycle === 'active')).filter((topic) => topicId === null || topic.topicId === topicId);
      const watermarks = new Map((this.metadata.listTopicAnalysisWatermarks?.() ?? []).map((item) => [item.subjectId, item]));
      const scoped = topics.map((topic) => {
        const sources = (this.metadata.listSourceReferences(topic.topicId) ?? []).slice(0, MAX_SOURCES).map((source) => ({ ...source, observedRevision: sourceRevision(this.metadata, source) }));
        const topicRevision = `topic:${topic.revision}`;
        const topicChanged = !watermarks.has(`topic:${topic.topicId}`) || watermarks.get(`topic:${topic.topicId}`).observedRevision !== topicRevision;
        const sourceChanged = sources.some((source) => !watermarks.has(`source:${source.referenceId}`) || watermarks.get(`source:${source.referenceId}`).observedRevision !== source.observedRevision);
        return { topic, sources, changed: topicChanged || sourceChanged };
      });
      activitySourceReferenceId = topicId === null ? null : scoped[0]?.sources?.[0]?.referenceId ?? null;
      activitySourceRevision = topicId === null ? null : scoped[0]?.sources?.[0]?.observedRevision ?? null;
      const current = scoped.filter((item) => item.changed);
      const cursorId = baselineCursor.nextTopicId;
      if (cursorId) { const index = current.findIndex((item) => item.topic.topicId === cursorId); if (index >= 0) current.push(...current.splice(0, index)); }
      changed = current;
      if (current.length > this.maxChangedTopics) {
        retainedOverflowCount = current.length - this.maxChangedTopics;
        throw Object.assign(new Error('Topic Analysis changed-Topic bound was exceeded.'), { code: 'bounded-analysis' });
      }
      if (!previousSuccess) {
        for (const item of changed) await this.getCandidates(item, { runId, previousSuccess: null });
        const baseline = scoped.flatMap(({ topic, sources }) => [{ subjectId: `topic:${topic.topicId}`, subjectType: 'topic', topicId: topic.topicId, observedRevision: `topic:${topic.revision}` }, ...sources.map((source) => ({ subjectId: `source:${source.referenceId}`, subjectType: 'source', topicId: topic.topicId, observedRevision: source.observedRevision }))]);
        this.metadata.setTopicAnalysisWatermarks(baseline.map((item) => ({ ...item, lastSuccessRunId: runId, updatedAt: startedAt })));
        this.metadata.setTopicAnalysisCursor({ nextTopicId: null, nextSourceId: null, updatedAt: startedAt });
        const result = { schemaVersion: 1, runId, trigger, baseline: true, changedCount: 0, evaluatedCount: 0, proposalCount: 0, retainedOverflowCount: 0, outcome: 'success' };
        this.metadata.recordTopicAnalysisRun({ runId, schemaVersion: 1, trigger, outcome: 'success', baselineCursor, successCursor: { nextTopicId: null, nextSourceId: null }, changedCount: 0, evaluatedCount: 0, proposalCount: 0, retainedOverflowCount: 0, startedAt, finishedAt: nowIso(this.now) });
        this.recordActivity(runId, startedAt, 'applied', topicId, activitySourceReferenceId, activitySourceRevision);
        return freeze(result);
      }
      const pendingWatermarks = [];
      const publications = [];
      for (const item of changed) {
        evaluated += 1;
        const response = await this.getCandidates(item, { runId, previousSuccess });
        for (const candidate of response) {
          const proposal = candidateToProposal(candidate, { now: startedAt, requireReady: true });
          if (!proposal) continue;
          const sourceIds = new Set(item.sources.map((source) => source.referenceId));
          if (proposal.affectedSourceIds.some((sourceId) => !sourceIds.has(sourceId) && !proposal.plannedSourceIds.includes(sourceId))) continue;
          if (proposal.evidenceFacts.some((fact) => !sourceIds.has(fact.sourceId) && !proposal.plannedSourceIds.includes(fact.sourceId))) continue;
          const observedRevisions = new Map(item.sources.map((source) => [source.referenceId, source.observedRevision]));
          if (proposal.evidenceFacts.some((fact) => observedRevisions.has(fact.sourceId) && observedRevisions.get(fact.sourceId) !== fact.sourceRevision)) continue;
          const existing = this.metadata.getTopicProposal(proposal.proposalId);
          const itemSourceIds = new Set(item.sources.map((source) => source.referenceId));
          const activeLineage = (this.metadata.listTopicProposals?.() ?? []).filter((prior) => prior.proposalId !== proposal.proposalId && !['superseded', 'applied', 'failed', 'kept', 'suppressed'].includes(prior.state) && ((prior.affectedTopicIds ?? []).includes(item.topic.topicId) || (prior.affectedSourceIds ?? []).some((id) => itemSourceIds.has(id))));
          if (!proposal.predecessorId && activeLineage.length > 1) throw Object.assign(new Error('Topic Analysis found ambiguous proposal lineage.'), { code: 'conflict' });
          const inferredPredecessor = proposal.predecessorId ? null : activeLineage[0];
          const linkedProposal = inferredPredecessor ? { ...proposal, predecessorId: inferredPredecessor.proposalId } : proposal;
          const digest = materialEvidenceDigest(proposal.evidenceFacts);
          const suppressed = existing?.state === 'suppressed' && existing.suppressedDigest === digest;
          const materialChanged = !existing || existing.materialEvidenceDigest !== digest;
          const contentChanged = !existing || canonicalJson(proposalContent(existing, existing.materialEvidenceDigest)) !== canonicalJson(proposalContent(proposal, digest));
          const retainedState = existing?.state === 'applied' || existing?.state === 'superseded' ? existing.state : suppressed ? 'suppressed' : contentChanged ? 'pending' : existing?.state ?? 'pending';
          const next = { ...linkedProposal, revision: existing ? (contentChanged ? existing.revision + 1 : existing.revision) : 1, state: retainedState, ...(suppressed ? { suppressedDigest: digest } : {}) };
          publications.push({ proposal: linkedProposal, next });
          proposals += 1;
          if (proposals > this.maxProposals) {
            retainedOverflowCount = proposals - this.maxProposals;
            throw Object.assign(new Error('Topic Analysis proposal bound was exceeded.'), { code: 'bounded-analysis' });
          }
        }
        pendingWatermarks.push({ topic: item.topic, sources: item.sources });
      }
      const retained = (this.metadata.listTopicProposals?.() ?? []).filter((proposal) => !['superseded', 'applied', 'failed', 'kept', 'suppressed'].includes(proposal.state) && !publications.some((item) => item.next.proposalId === proposal.proposalId)).map((proposal) => ({ ...proposal, evidenceFacts: this.metadata.listTopicAnalysisEvidence?.(proposal.proposalId, { currentOnly: true }) ?? [] }));
      orderProposals([...retained, ...publications.map((item) => item.next)]);
      for (const { proposal, next } of publications) {
        if (proposal.predecessorId) {
          const predecessor = this.metadata.getTopicProposal?.(proposal.predecessorId);
          if (predecessor && predecessor.proposalId !== proposal.proposalId && !['superseded', 'applied', 'failed', 'kept', 'suppressed'].includes(predecessor.state)) this.metadata.saveTopicProposal({ ...predecessor, schemaVersion: 1, state: 'superseded', successorId: proposal.proposalId, updatedAt: nowIso(this.now) });
        }
        const { evidenceFacts: _evidenceFacts, ...storedProposal } = next;
        this.metadata.saveTopicProposal(storedProposal);
        this.metadata.setTopicAnalysisEvidence(proposal.proposalId, proposal.evidenceFacts.map((fact) => ({ ...fact, observedAt: fact.observedAt ?? startedAt })));
      }
      const successfulWatermarks = pendingWatermarks.flatMap(({ topic, sources }) => [
        { subjectId: `topic:${topic.topicId}`, subjectType: 'topic', topicId: topic.topicId, observedRevision: `topic:${topic.revision}`, lastSuccessRunId: runId, updatedAt: nowIso(this.now) },
        ...sources.map((source) => ({ subjectId: `source:${source.referenceId}`, subjectType: 'source', topicId: topic.topicId, observedRevision: source.observedRevision, lastSuccessRunId: runId, updatedAt: nowIso(this.now) }))
      ]);
      this.metadata.setTopicAnalysisWatermarks(successfulWatermarks);
      const nextTopicId = null;
      this.metadata.setTopicAnalysisCursor({ nextTopicId, nextSourceId: null, updatedAt: nowIso(this.now) });
      const finishedAt = nowIso(this.now);
      this.metadata.recordTopicAnalysisRun({ runId, schemaVersion: 1, trigger, outcome: 'success', baselineCursor, successCursor: { nextTopicId, nextSourceId: null }, changedCount: changed.length, evaluatedCount: evaluated, proposalCount: proposals, retainedOverflowCount, startedAt, finishedAt });
      this.recordActivity(runId, finishedAt, 'applied', topicId, activitySourceReferenceId, activitySourceRevision);
      return freeze({ schemaVersion: 1, runId, trigger, baseline: false, changedCount: changed.length, evaluatedCount: evaluated, proposalCount: proposals, retainedOverflowCount, outcome: 'success' });
    } catch (error) {
      const finishedAt = nowIso(this.now); const message = publicFailure(error);
      this.metadata.recordTopicAnalysisRun({ runId, schemaVersion: 1, trigger, outcome: 'failed', baselineCursor, changedCount: changed.length, evaluatedCount: evaluated, proposalCount: proposals, retainedOverflowCount, startedAt, finishedAt, error: message });
      this.recordActivity(runId, finishedAt, 'failed', topicId, activitySourceReferenceId, activitySourceRevision);
      return freeze({ schemaVersion: 1, runId, trigger, outcome: 'failed', error: message, changedCount: changed.length, evaluatedCount: evaluated, proposalCount: proposals, retainedOverflowCount });
    }
  }

  async getCandidates(item, context) {
    if (!this.analyzer) return [];
    const result = typeof this.analyzer === 'function' ? await this.analyzer({ topic: item.topic, sources: item.sources, ...context }) : await (this.analyzer.analyze?.({ topic: item.topic, sources: item.sources, ...context }) ?? []);
    return Array.isArray(result) ? result : result?.proposals ?? result?.candidates ?? [];
  }

  recordActivity(runId, at, outcome, topicId = null, sourceReferenceId = null, sourceRevision = null) {
    const observedRevision = sourceReferenceId ? JSON.stringify({ sourceReferenceId, sourceRevision }) : null;
    try { this.metadata.recordActivity({ activityId: `activity:topic-analysis:${runId}`, topicId, logicalOperationId: `topic-analysis:${runId}`, transportRequestId: runId, operationKind: 'topic-analysis.run', outcome, observedRevision, createdAt: at, updatedAt: at }); } catch { /* Activity failure must not turn a completed analysis into a second run. */ }
  }
}

export function createTopicAnalysisRunner(options) { return new TopicAnalysisRunner(options); }
export const createAnalysisRunner = createTopicAnalysisRunner;
