const kinds = new Set(['email', 'chat', 'note']);
const nonBlank = value => typeof value === 'string' && value.trim().length > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function assertRecord(record) {
  if (!record || record.schemaVersion !== 1 || !kinds.has(record.sourceKind) || !nonBlank(record.sourceExternalId) || !nonBlank(record.sourceVersion) || !nonBlank(record.checkpoint) || !nonBlank(record.rawText)) fail('producer-record-invalid');
}

function exactEvidence(value, record) {
  if (!value || !nonBlank(value.sourceReferenceId) || !nonBlank(value.sourcePath) || !nonBlank(value.topicId)) fail('producer-evidence-unavailable');
  return { topicId: value.topicId, sourceReferenceId: value.sourceReferenceId, sourcePath: value.sourcePath, sourceVersion: value.sourceVersion ?? record.sourceVersion };
}

/**
 * Orchestrates a maintained producer without owning extraction or source storage.
 * Injected functions are the supported Command Center tool boundaries. The
 * producer retains its queue and advances its own checkpoint only after this
 * function returns a healthy receipt.
 */
export function createProducerIntakeAdapter({ extract, resolveTopic, saveSourceNote, captureSourceCommitment, captureChatCommitment, recordIntakeReceipt, now = () => new Date().toISOString() } = {}) {
  if (![extract, resolveTopic, saveSourceNote, captureSourceCommitment, captureChatCommitment, recordIntakeReceipt].every(value => typeof value === 'function')) fail('producer-adapter-invalid');

  return Object.freeze({
    async process({ runId, records, nextExpectedAt }) {
      if (!nonBlank(runId) || !Array.isArray(records) || records.length > 500 || !nonBlank(nextExpectedAt)) fail('producer-batch-invalid');
      const counts = { processedCount: 0, actionableCount: 0, noteCount: 0, skippedCount: 0, uncertainCount: 0, failedCount: 0 };
      let checkpoint = 'start';
      const observedAt = now();
      const sourceKinds = new Set(records.map(record => record?.sourceKind).filter(kind => kinds.has(kind)));
      if (sourceKinds.size !== 1) fail('producer-batch-source-kind-mismatch');
      const sourceKind = [...sourceKinds][0];
      const receiptCounts = () => ({ processedCount: counts.processedCount, actionableCount: counts.actionableCount, noteCount: counts.noteCount });
      await recordIntakeReceipt({ sourceKind, runId, checkpoint, status: 'pending', observedAt, nextExpectedAt, ...receiptCounts() });
      try {
        for (const record of records) {
          assertRecord(record);
          const extraction = await extract({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, rawText: record.rawText });
          if (!extraction || extraction.schemaVersion !== 1 || !Array.isArray(extraction.obligations) || typeof extraction.knowledgeMarkdown !== 'string') fail('producer-extraction-invalid');
          const topic = await resolveTopic({ sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, proposedTopic: extraction.proposedTopic });
          if (!topic || !nonBlank(topic.topicId)) { counts.uncertainCount += 1; checkpoint = record.checkpoint; continue; }
          let evidence;
          if (record.existingEvidence) evidence = exactEvidence(record.existingEvidence, record);
          else if (extraction.knowledgeMarkdown.trim()) {
            if (!nonBlank(topic.noteFolderReferenceId) || !nonBlank(extraction.notePath)) fail('producer-note-destination-unavailable');
            const saved = await saveSourceNote({ topicId: topic.topicId, noteFolderReferenceId: topic.noteFolderReferenceId, sourceKind: record.sourceKind === 'chat' ? 'note' : record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, path: extraction.notePath, markdown: extraction.knowledgeMarkdown });
            evidence = exactEvidence({ ...saved, topicId: topic.topicId, sourceVersion: saved.sourceVersion ?? record.sourceVersion }, record);
            counts.noteCount += saved.replayed === true ? 0 : 1;
          }
          if (extraction.obligations.length && !evidence) fail('producer-evidence-required');
          for (const obligation of extraction.obligations) {
            if (!obligation || !nonBlank(obligation.obligationId) || !nonBlank(obligation.title) || !['explicit', 'inferred', 'idea', 'quoted'].includes(obligation.provenance)) fail('producer-obligation-invalid');
            const params = { topicId: topic.topicId, sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, ...evidence, ...obligation };
            if (record.sourceKind === 'chat') await captureChatCommitment(params);
            else await captureSourceCommitment(params);
            counts.actionableCount += 1;
          }
          if (!extraction.knowledgeMarkdown.trim() && extraction.obligations.length === 0) counts.skippedCount += 1;
          counts.processedCount += 1; checkpoint = record.checkpoint;
        }
        const completedAt = now();
        const status = counts.processedCount === 0 && counts.uncertainCount === 0 ? 'healthy-empty' : 'healthy-processed';
        const receipt = await recordIntakeReceipt({ sourceKind, runId, checkpoint, status, observedAt: completedAt, lastSuccessfulAt: completedAt, nextExpectedAt, ...receiptCounts() });
        return Object.freeze({ schemaVersion: 1, checkpoint, status, ...counts, receipt });
      } catch (error) {
        counts.failedCount += 1;
        await recordIntakeReceipt({ sourceKind, runId, checkpoint, status: 'failed', observedAt: now(), ...receiptCounts() });
        throw Object.assign(error instanceof Error ? error : new Error('producer-intake-failed'), { checkpoint, counts: Object.freeze({ ...counts }) });
      }
    }
  });
}
