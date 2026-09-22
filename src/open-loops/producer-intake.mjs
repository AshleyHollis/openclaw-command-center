import { normalizeAcceptedExtraction } from './intake-accounting.mjs';

const kinds = new Set(['email', 'chat', 'note']);
const nonBlank = value => typeof value === 'string' && value.trim().length > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function assertRecord(record) {
  const hasRawText = nonBlank(record?.rawText);
  const hasAcceptedExtraction = record?.acceptedExtraction !== undefined;
  if (!record || record.schemaVersion !== 1 || !kinds.has(record.sourceKind) || !nonBlank(record.sourceExternalId) || !nonBlank(record.sourceVersion) || !nonBlank(record.checkpoint) || hasRawText === hasAcceptedExtraction) fail('producer-record-invalid');
}

function exactEvidence(value) {
  if (!value || !nonBlank(value.sourceReferenceId) || !nonBlank(value.sourcePath) || !nonBlank(value.topicId)) fail('producer-evidence-unavailable');
  const sourceReferenceVersion = value.sourceReferenceVersion ?? value.revision;
  if (!nonBlank(sourceReferenceVersion)) fail('producer-evidence-unavailable');
  return { topicId: value.topicId, sourceReferenceId: value.sourceReferenceId, sourcePath: value.sourcePath, sourceReferenceVersion };
}

function acceptedExtraction(value) {
  try { return normalizeAcceptedExtraction(value); }
  catch { fail('producer-extraction-invalid'); }
}

function accountingResult(value) { return value?.details ?? value; }
function accountOutcome(account, outcomeId) { return account?.outcomes?.find(item => item.outcomeId === outcomeId); }
function unfinished(account, outcomeId) { return !accountOutcome(account, outcomeId) || accountOutcome(account, outcomeId).status === 'missing'; }

/**
 * Orchestrates a maintained producer without owning extraction or source storage.
 * Injected functions are the supported Command Center tool boundaries. The
 * producer retains its queue and advances its own checkpoint only after this
 * function returns a healthy receipt.
 */
export function createProducerIntakeAdapter({ processorVersion, extract, loadIntakeSourceAccount, resolveTopic, saveSourceNote, captureSourceCommitment, captureChatCommitment, recordIntakeSourcePlan, recordIntakeOutcome, recordIntakeReceipt, now = () => new Date().toISOString() } = {}) {
  if (!nonBlank(processorVersion) || ![extract, loadIntakeSourceAccount, resolveTopic, saveSourceNote, captureSourceCommitment, captureChatCommitment, recordIntakeSourcePlan, recordIntakeOutcome, recordIntakeReceipt].every(value => typeof value === 'function')) fail('producer-adapter-invalid');

  return Object.freeze({
    async process({ runId, sourceKind: selectedSourceKind, records, nextExpectedAt, enumeration }) {
      if (!nonBlank(runId) || !Array.isArray(records) || records.length > 500 || !nonBlank(nextExpectedAt) || selectedSourceKind !== undefined && !kinds.has(selectedSourceKind)) fail('producer-batch-invalid');
      const counts = { processedCount: 0, actionableCount: 0, noteCount: 0, skippedCount: 0, uncertainCount: 0, failedCount: 0 };
      let checkpoint = 'start';
      const observedAt = now();
      const sourceKinds = new Set([selectedSourceKind, ...records.map(record => record?.sourceKind)].filter(kind => kinds.has(kind)));
      if (sourceKinds.size !== 1) fail('producer-batch-source-kind-mismatch');
      const sourceKind = [...sourceKinds][0];
      const receiptCounts = () => ({ processedCount: counts.processedCount, actionableCount: counts.actionableCount, noteCount: counts.noteCount });
      const recordEnumerations = records.map(record => record?.enumeration).filter(Boolean);
      if (enumeration && recordEnumerations.length || recordEnumerations.length > 1) fail('producer-enumeration-scope-invalid');
      const receiptEnumeration = enumeration ?? recordEnumerations[0];
      const incompleteEnumeration = receiptEnumeration && (receiptEnumeration.scope !== 'complete' || receiptEnumeration.remainingCount > 0 || receiptEnumeration.failedReadCount > 0 || receiptEnumeration.scanCapReached);
      if (incompleteEnumeration && (!nonBlank(receiptEnumeration.scopeId) || !nonBlank(receiptEnumeration.resumeCursor))) fail('producer-continuation-required');
      const continuation = incompleteEnumeration ? { scopeId: receiptEnumeration.scopeId, cursor: receiptEnumeration.resumeCursor, remainingCount: receiptEnumeration.remainingCount, failedReadCount: receiptEnumeration.failedReadCount, scanCapReached: receiptEnumeration.scanCapReached } : undefined;
      const pending = await recordIntakeReceipt({ sourceKind, runId, checkpoint, status: 'pending', observedAt, nextExpectedAt, ...receiptCounts() });
      if (pending?.receipt && pending.receipt.status !== 'pending') return Object.freeze({ schemaVersion: 1, checkpoint: pending.receipt.checkpoint, status: pending.receipt.status, processedCount: pending.receipt.processedCount, actionableCount: pending.receipt.actionableCount, noteCount: pending.receipt.noteCount, skippedCount: 0, uncertainCount: 0, failedCount: pending.receipt.status === 'failed' ? 1 : 0, ...(pending.receipt.continuation ? { continuation: pending.receipt.continuation } : {}), receipt: pending });
      try {
        for (const record of records) {
          assertRecord(record);
          const enumerationValue = receiptEnumeration ?? { scope: 'complete', scannedCount: records.length, remainingCount: 0, failedReadCount: 0, scanCapReached: false };
          let durable = accountingResult(await loadIntakeSourceAccount({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion }));
          if (!durable) {
            const proposed = record.acceptedExtraction === undefined
              ? acceptedExtraction(await extract({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, rawText: record.rawText }))
              : acceptedExtraction(record.acceptedExtraction);
            const proposedOutcomes = proposed.obligations.map(obligation => ({ outcomeId: obligation.obligationId, kind: obligation.classification }));
            const proposedKnowledgeId = proposed.knowledgeMarkdown.trim() ? proposed.knowledgeOutcomeId ?? `${record.sourceExternalId}:information` : null;
            if (proposedKnowledgeId) proposedOutcomes.push({ outcomeId: proposedKnowledgeId, kind: 'information' });
            if (proposed.noAction) proposedOutcomes.push({ outcomeId: proposed.noAction.outcomeId, kind: 'no-action' });
            if (proposedOutcomes.length === 0) proposedOutcomes.push({ outcomeId: `${record.sourceExternalId}:no-action`, kind: 'no-action' });
            durable = accountingResult(await recordIntakeSourcePlan({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, checkpoint: record.checkpoint, observedAt, processorVersion, acceptedExtraction: proposed, outcomes: proposedOutcomes, enumeration: enumerationValue }));
          }
          if (!durable?.plan || durable.plan.sourceKind !== record.sourceKind || durable.plan.sourceExternalId !== record.sourceExternalId || durable.plan.sourceVersion !== record.sourceVersion || !nonBlank(durable.plan.processorVersion)) fail('producer-durable-plan-unavailable');
          const extraction = acceptedExtraction(durable.plan.acceptedExtraction);
          const plannedOutcomes = durable.plan.outcomes;
          const account = durable.account;
          const obligations = extraction.obligations;
          const knowledgeOutcomeId = extraction.knowledgeMarkdown.trim() ? extraction.knowledgeOutcomeId ?? `${record.sourceExternalId}:information` : null;
          const noAction = extraction.noAction;
          const topic = await resolveTopic({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, proposedTopic: extraction.proposedTopic, notePath: extraction.notePath });
          if (!topic || !nonBlank(topic.topicId)) {
            for (const outcome of plannedOutcomes.filter(item => unfinished(account, item.outcomeId))) await recordIntakeOutcome({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, outcomeId: outcome.outcomeId, kind: outcome.kind, status: 'unresolved-topic', summary: 'Topic ownership requires review', recordedAt: now() });
            counts.uncertainCount += 1; counts.processedCount += 1; checkpoint = record.checkpoint; continue;
          }
          let evidence;
          const retainedKnowledge = knowledgeOutcomeId ? accountOutcome(account, knowledgeOutcomeId) : null;
          if (retainedKnowledge?.status === 'quiet') evidence = exactEvidence(retainedKnowledge);
          else if (record.existingEvidence ?? topic.evidence) evidence = exactEvidence(record.existingEvidence ?? { ...topic.evidence, topicId: topic.topicId });
          else if (extraction.knowledgeMarkdown.trim()) {
            if (!nonBlank(topic.noteFolderReferenceId) || !nonBlank(extraction.notePath)) fail('producer-note-destination-unavailable');
            const saved = await saveSourceNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, sourceKind: record.sourceKind === 'chat' ? 'note' : record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, path: extraction.notePath, markdown: extraction.knowledgeMarkdown });
            evidence = exactEvidence({ ...saved, topicId: topic.topicId });
            counts.noteCount += saved.replayed === true ? 0 : 1;
          }
          if (knowledgeOutcomeId && unfinished(account, knowledgeOutcomeId)) {
            if (!evidence) fail('producer-evidence-required');
            await recordIntakeOutcome({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, outcomeId: knowledgeOutcomeId, kind: 'information', status: 'quiet', summary: extraction.knowledgeSummary ?? 'Information retained in the Topic Note', topicId: evidence.topicId, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.sourcePath, sourceReferenceVersion: evidence.sourceReferenceVersion, recordedAt: now() });
          }
          if (obligations.length && !evidence) fail('producer-evidence-required');
          for (const obligation of obligations) {
            if (!obligation || !nonBlank(obligation.obligationId) || !nonBlank(obligation.title) || !['explicit', 'inferred', 'idea', 'quoted'].includes(obligation.provenance)) fail('producer-obligation-invalid');
            if (!unfinished(account, obligation.obligationId)) continue;
            const { classification, ...captureObligation } = obligation;
            const params = { ...captureObligation, topicId: topic.topicId, sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.sourcePath };
            const captured = record.sourceKind === 'chat' ? await captureChatCommitment(params) : await captureSourceCommitment(params);
            const loop = captured?.loop ?? captured?.details?.loop;
            if (!nonBlank(loop?.loopId)) fail('producer-outcome-evidence-required');
            await recordIntakeOutcome({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, outcomeId: obligation.obligationId, kind: classification, status: classification === 'decision' ? 'pending-decision' : 'applied', summary: obligation.title, loopId: loop.loopId, recordedAt: now() });
            counts.actionableCount += 1;
          }
          const noActionOutcome = noAction ?? { outcomeId: `${record.sourceExternalId}:no-action`, summary: 'No action required' };
          if ((noAction || !extraction.knowledgeMarkdown.trim() && obligations.length === 0) && unfinished(account, noActionOutcome.outcomeId)) {
            await recordIntakeOutcome({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, outcomeId: noActionOutcome.outcomeId, kind: 'no-action', status: 'no-action', summary: noActionOutcome.summary, recordedAt: now() });
            counts.skippedCount += 1;
          }
          counts.processedCount += 1; checkpoint = record.checkpoint;
        }
        const completedAt = now();
        const status = incompleteEnumeration ? 'incomplete' : counts.processedCount === 0 && counts.uncertainCount === 0 ? 'healthy-empty' : 'healthy-processed';
        const receipt = await recordIntakeReceipt({ sourceKind, runId, checkpoint, status, observedAt: completedAt, ...(status === 'incomplete' ? { continuation } : { lastSuccessfulAt: completedAt }), nextExpectedAt, ...receiptCounts() });
        return Object.freeze({ schemaVersion: 1, checkpoint, status, ...counts, ...(continuation ? { continuation: Object.freeze(continuation) } : {}), receipt });
      } catch (error) {
        counts.failedCount += 1;
        await recordIntakeReceipt({ sourceKind, runId, checkpoint, status: 'failed', observedAt: now(), ...(continuation ? { continuation } : {}), ...receiptCounts() });
        throw Object.assign(error instanceof Error ? error : new Error('producer-intake-failed'), { checkpoint, counts: Object.freeze({ ...counts }) });
      }
    }
  });
}
