import { sourceError } from '../sources/errors.mjs';
import { topicAnalysisRunId } from './analysis-runner.mjs';

function publicResult(run) {
  if (!run || typeof run.runId !== 'string' || !run.runId) throw sourceError('unavailable', 'Topic Analysis did not return a durable run identity.');
  return Object.freeze({
    status: run.outcome === 'success' ? 'applied' : run.outcome === 'failed' ? 'failed' : 'running',
    analysisId: run.runId,
    observedRevision: run.runId
  });
}

function providerOperationId(logicalOperationId) {
  return logicalOperationId ? `analysis-provider:${logicalOperationId}` : undefined;
}

export function createTopicAnalysisProvider({ getRunner, metadata, onCompleted } = {}) {
  if (typeof getRunner !== 'function' || !metadata) throw new TypeError('Topic Analysis provider requires its production runner and metadata.');
  const durableRun = (analysisId) => (metadata.listTopicAnalysisRuns?.() ?? []).find((run) => run.runId === analysisId) ?? null;
  return Object.freeze({
    async run(input = {}) {
      const runner = getRunner();
      if (!runner || typeof runner.run !== 'function') throw sourceError('capability-unavailable', 'Topic Analysis is not ready.', { capability: 'analysis' });
      // The source mutation coordinator owns bridge idempotency. The runner's
      // journal remains available to scheduler/tool callers, but must not
      // compete for the same logical operation record at this boundary.
      const result = publicResult(await runner.run({ trigger: input.trigger ?? 'manual', topicId: input.topicId, logicalOperationId: providerOperationId(input.logicalOperationId) }));
      await onCompleted?.(result);
      return result;
    },
    async status() {
      const run = (metadata.listTopicAnalysisRuns?.() ?? []).at(-1);
      return run ? publicResult(run) : Object.freeze({ status: 'ready' });
    },
    read(analysisId) {
      const run = durableRun(analysisId);
      return run ? publicResult(run) : null;
    },
    reconcile(logicalOperationId) {
      const innerOperationId = providerOperationId(logicalOperationId);
      const operation = innerOperationId && metadata.getOperation?.(innerOperationId);
      const candidateRun = innerOperationId && durableRun(operation?.observedRevision ?? topicAnalysisRunId(innerOperationId));
      const committedRun = ['success', 'failed'].includes(candidateRun?.outcome) ? candidateRun : null;
      try {
        const result = operation?.resultIdentity ? publicResult(JSON.parse(operation.resultIdentity)) : committedRun ? publicResult(committedRun) : null;
        if (!result) return null;
        void Promise.resolve(onCompleted?.(result)).catch(() => {});
        return result;
      } catch { return null; }
    }
  });
}
