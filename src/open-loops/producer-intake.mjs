const kinds = new Set(['email', 'chat', 'note']);
const nonBlank = value => typeof value === 'string' && value.trim().length > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function assertRecord(record) {
  if (!record || record.schemaVersion !== 1 || !kinds.has(record.sourceKind) || !nonBlank(record.sourceExternalId) || !nonBlank(record.sourceVersion) || !nonBlank(record.checkpoint) || !nonBlank(record.rawText)) fail('producer-record-invalid');
}

function exactEvidence(value, record) {
  if (!value || !nonBlank(value.sourceReferenceId) || !nonBlank(value.sourcePath) || !nonBlank(value.topicId)) fail('producer-evidence-unavailable');
  return { topicId: value.topicId, sourceReferenceId: value.sourceReferenceId, sourcePath: value.sourcePath, sourceVersion: value.sourceVersion ?? value.revision ?? record.sourceVersion };
}

/**
 * Orchestrates a maintained producer without owning extraction or source storage.
 * Injected functions are the supported Command Center tool boundaries. The
 * producer retains its queue and advances its own checkpoint only after this
 * function returns a healthy receipt.
 */
export function createProducerIntakeAdapter({ extract, resolveTopic, saveSourceNote, captureSourceCommitment, captureChatCommitment, recordIntakeSourcePlan, recordIntakeOutcome, recordIntakeReceipt, now = () => new Date().toISOString() } = {}) {
  if (![extract, resolveTopic, saveSourceNote, captureSourceCommitment, captureChatCommitment, recordIntakeSourcePlan, recordIntakeOutcome, recordIntakeReceipt].every(value => typeof value === 'function')) fail('producer-adapter-invalid');

  return Object.freeze({
    async process({ runId, records, nextExpectedAt, enumeration }) {
      if (!nonBlank(runId) || !Array.isArray(records) || records.length > 500 || !nonBlank(nextExpectedAt)) fail('producer-batch-invalid');
      const counts = { processedCount: 0, actionableCount: 0, noteCount: 0, skippedCount: 0, uncertainCount: 0, failedCount: 0 };
      let checkpoint = 'start';
      const observedAt = now();
      const sourceKinds = new Set(records.map(record => record?.sourceKind).filter(kind => kinds.has(kind)));
      if (sourceKinds.size !== 1) fail('producer-batch-source-kind-mismatch');
      const sourceKind = [...sourceKinds][0];
      const receiptCounts = () => ({ processedCount: counts.processedCount, actionableCount: counts.actionableCount, noteCount: counts.noteCount });
      const recordEnumerations = records.map(record => record?.enumeration).filter(Boolean);
      if (enumeration && recordEnumerations.length || recordEnumerations.length > 1) fail('producer-enumeration-scope-invalid');
      const receiptEnumeration = enumeration ?? recordEnumerations[0];
      const incompleteEnumeration = receiptEnumeration && (receiptEnumeration.scope !== 'complete' || receiptEnumeration.remainingCount > 0 || receiptEnumeration.failedReadCount > 0 || receiptEnumeration.scanCapReached);
      if (incompleteEnumeration && (!nonBlank(receiptEnumeration.scopeId) || !nonBlank(receiptEnumeration.resumeCursor))) fail('producer-continuation-required');
      const continuation = incompleteEnumeration ? { scopeId: receiptEnumeration.scopeId, cursor: receiptEnumeration.resumeCursor, remainingCount: receiptEnumeration.remainingCount, failedReadCount: receiptEnumeration.failedReadCount, scanCapReached: receiptEnumeration.scanCapReached } : undefined;
      await recordIntakeReceipt({ sourceKind, runId, checkpoint, status: 'pending', observedAt, nextExpectedAt, ...receiptCounts() });
      try {
        for (const record of records) {
          assertRecord(record);
          const extraction = await extract({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, rawText: record.rawText });
          if (!extraction || extraction.schemaVersion !== 1 || !Array.isArray(extraction.obligations) || typeof extraction.knowledgeMarkdown !== 'string') fail('producer-extraction-invalid');
          const obligations = extraction.obligations.map(obligation => ({ ...obligation, classification: obligation.classification ?? 'obligation' }));
          if (obligations.some(obligation => !['obligation', 'decision'].includes(obligation.classification))) fail('producer-obligation-invalid');
          const plannedOutcomes = obligations.map(obligation => ({ outcomeId: obligation.obligationId, kind: obligation.classification }));
          const knowledgeOutcomeId = extraction.knowledgeMarkdown.trim() ? extraction.knowledgeOutcomeId ?? `${record.sourceExternalId}:information` : null;
          if (knowledgeOutcomeId) plannedOutcomes.push({ outcomeId: knowledgeOutcomeId, kind: 'information' });
          const noAction = extraction.noAction;
          if (noAction !== undefined && (!noAction || !nonBlank(noAction.outcomeId) || !nonBlank(noAction.summary))) fail('producer-extraction-invalid');
          if (noAction) plannedOutcomes.push({ outcomeId: noAction.outcomeId, kind: 'no-action' });
          if (plannedOutcomes.length === 0) plannedOutcomes.push({ outcomeId: `${record.sourceExternalId}:no-action`, kind: 'no-action' });
          const enumerationValue = receiptEnumeration ?? { scope: 'complete', scannedCount: records.length, remainingCount: 0, failedReadCount: 0, scanCapReached: false };
          await recordIntakeSourcePlan({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, checkpoint: record.checkpoint, observedAt, outcomes: plannedOutcomes, enumeration: enumerationValue });
          const topic = await resolveTopic({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, proposedTopic: extraction.proposedTopic });
          if (!topic || !nonBlank(topic.topicId)) {
            for (const outcome of plannedOutcomes) await recordIntakeOutcome({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, outcomeId: outcome.outcomeId, kind: outcome.kind, status: 'unresolved-topic', summary: 'Topic ownership requires review', recordedAt: now() });
            counts.uncertainCount += 1; counts.processedCount += 1; checkpoint = record.checkpoint; continue;
          }
          let evidence;
          if (record.existingEvidence) evidence = exactEvidence(record.existingEvidence, record);
          else if (extraction.knowledgeMarkdown.trim()) {
            if (!nonBlank(topic.noteFolderReferenceId) || !nonBlank(extraction.notePath)) fail('producer-note-destination-unavailable');
            const saved = await saveSourceNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, sourceKind: record.sourceKind === 'chat' ? 'note' : record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, path: extraction.notePath, markdown: extraction.knowledgeMarkdown });
            evidence = exactEvidence({ ...saved, topicId: topic.topicId, sourceVersion: saved.sourceVersion ?? record.sourceVersion }, record);
            counts.noteCount += saved.replayed === true ? 0 : 1;
          }
          if (knowledgeOutcomeId) {
            if (!evidence) fail('producer-evidence-required');
            await recordIntakeOutcome({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, outcomeId: knowledgeOutcomeId, kind: 'information', status: 'quiet', summary: extraction.knowledgeSummary ?? 'Information retained in the Topic Note', topicId: evidence.topicId, sourceReferenceId: evidence.sourceReferenceId, sourcePath: evidence.sourcePath, sourceReferenceVersion: evidence.sourceVersion, recordedAt: now() });
          }
          if (obligations.length && !evidence) fail('producer-evidence-required');
          for (const obligation of obligations) {
            if (!obligation || !nonBlank(obligation.obligationId) || !nonBlank(obligation.title) || !['explicit', 'inferred', 'idea', 'quoted'].includes(obligation.provenance)) fail('producer-obligation-invalid');
            const { classification, ...captureObligation } = obligation;
            const params = { topicId: topic.topicId, sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, ...evidence, ...captureObligation };
            const captured = record.sourceKind === 'chat' ? await captureChatCommitment(params) : await captureSourceCommitment(params);
            const loop = captured?.loop ?? captured?.details?.loop;
            if (!nonBlank(loop?.loopId)) fail('producer-outcome-evidence-required');
            await recordIntakeOutcome({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, outcomeId: obligation.obligationId, kind: classification, status: classification === 'decision' ? 'pending-decision' : 'applied', summary: obligation.title, loopId: loop.loopId, recordedAt: now() });
            counts.actionableCount += 1;
          }
          if (noAction || !extraction.knowledgeMarkdown.trim() && obligations.length === 0) {
            const outcome = noAction ?? { outcomeId: `${record.sourceExternalId}:no-action`, summary: 'No action required' };
            await recordIntakeOutcome({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, outcomeId: outcome.outcomeId, kind: 'no-action', status: 'no-action', summary: outcome.summary, recordedAt: now() });
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
