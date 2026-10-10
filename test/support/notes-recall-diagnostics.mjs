import assert from 'node:assert/strict';

// Disposable fictional fixture only; never reads provider credentials or live state.
export function configureNotesRecallModel(config, baseUrl) {
  const url = new URL(baseUrl);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/v1');
  assert.equal(url.username + url.password + url.search + url.hash, '');
  const provider = config.models.providers.fixture;
  assert.equal(provider.models[0].id, 'fixture-model');
  provider.baseUrl = baseUrl;
  provider.api = 'openai-completions';
  provider.models[0].api = 'openai-completions';
  provider.models[0].compat = { ...provider.models[0].compat, supportsTools: true };
  provider.request = { ...provider.request, allowPrivateNetwork: true };
  config.agents.entries = { ...config.agents.entries, main: { ...config.agents.entries?.main,
    model: 'fixture/fixture-model', modelPolicy: { allow: ['fixture/fixture-model'] } } };
  // This fictional provider exercises direct native tool execution. Native Tool
  // Search defaults on and catalogs plugin schemas; its discovery journey needs
  // a separate provider protocol. Keep the exact optional grant and deny policy.
  config.tools = { ...config.tools, toolSearch: false, alsoAllow: ['command_center_recall_topic_notes'] };
}

const select = (value, allowed) => allowed.includes(value) ? value : value == null ? null : 'other';
const roles = ['user', 'assistant', 'tool', 'system', 'developer'];
const statuses = ['ok', 'ready', 'partial', 'unavailable', 'stale', 'empty', 'error', 'cancelled'];
const phases = ['initial-tool-result', 'restart-tool-result', 'permission-loss-tool-result', 'permission-recovery-tool-result', 'citation-link'];
export function summarizeRecallFailure(error) {
  const counters = error.observations;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { category: select(error.category, ['recall-tool-result-timeout', 'recall-citation-timeout', 'host-early-exit', 'readiness-timeout']),
    phase: select(error.phase, phases), cancelled: error.name === 'AbortError' || error.code === 'ABORT_ERR',
    observations: counters ? { attempts: count(counters.attempts), successfulObservations: count(counters.successfulObservations),
      refusedConnections: count(counters.refusedConnections), elapsedMs: count(counters.elapsedMs) } : null };
}
function classifyNativeError(value) {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, 4096);
  if (/unknown model|model (?:not found|is not allowed)|no model available/iu.test(text)) return 'model-resolution';
  if (/no api provider|unsupported api|api (?:is )?(?:undefined|not configured)/iu.test(text)) return 'model-api';
  if (/ECONNREFUSED|connection refused|fetch failed/iu.test(text)) return 'provider-transport';
  if (/tool.*(?:not registered|not found|not allowed)/iu.test(text)) return 'tool-registration';
  return 'unclassified';
}

// Never retain bodies, prompts, arguments, IDs, URLs, paths, error text, or credentials.
export function collectRecallDiagnostics(provider, nativeEvents) {
  return {
    ingressCount: provider.ingress.length, completionCount: provider.requests.length,
    recallResultCount: provider.recallResults.length,
    ingress: provider.ingress.slice(-8).map(row => ({
      method: select(row.method, ['GET', 'POST']),
      route: select(row.path, ['/v1/models', '/v1/chat/completions', '/v1/responses']),
    })),
    completions: provider.requests.slice(-8).map(row => ({
      action: select(row.action, ['recall', 'final']), currentRole: select(row.currentRole, roles),
      completedCurrentTool: row.completedCurrentTool === true, issuedToolCall: Boolean(row.issuedToolCallId),
      recallToolRegistered: row.tools.includes('command_center_recall_topic_notes'),
      currentToolStatus: select(row.currentToolStatus, statuses),
      transcript: row.transcriptShape.slice(-12).map(item => ({ role: select(item.role, roles),
        hasToolCallId: Boolean(item.toolCallId), assistantToolCallCount: item.assistantToolCallIds.length })),
    })),
    nativeEvents: nativeEvents.slice(-32),
  };
}

export function recordRecallNativeEvent(events, payload) {
  let message; try { message = JSON.parse(String(payload)); } catch { return; }
  if (message?.type !== 'event' || !['agent', 'chat'].includes(message.event)) return;
  const event = message.payload ?? {};
  const data = event.data ?? {};
  const stream = select(event.stream, ['lifecycle', 'tool', 'assistant', 'error']);
  if (message.event === 'agent' && !['lifecycle', 'tool', 'error'].includes(stream)) return;
  if (events.length === 32) events.shift();
  events.push({ event: message.event, stream,
    phase: select(data.phase, ['start', 'end', 'error']),
    state: select(event.state, ['delta', 'final', 'aborted', 'error']),
    executionSettled: data.executionSettled === true,
    recallTool: data.name === 'command_center_recall_topic_notes',
    toolError: data.isError === true,
    hasError: Boolean(event.errorMessage || event.error || data.error),
    errorKind: classifyNativeError(event.errorMessage ?? event.error?.message ?? data.error?.message ?? data.error),
    errorCode: select(data.error?.code ?? data.result?.details?.error?.code ?? event.error?.code,
      ['UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'UNAVAILABLE', 'FORBIDDEN', 'INVALID_REQUEST', 'ABORTED']),
    toolStatus: select(data.result?.details?.status, statuses),
    hasRunId: typeof event.runId === 'string', hasSessionKey: typeof event.sessionKey === 'string',
  });
}

export async function waitForRecallObservation(wait, observe, earlyExit, { phase, ...options }) {
  assert.ok(phases.includes(phase));
  try { await wait(observe, earlyExit, options); }
  catch (error) {
    if (options.signal?.aborted || error.category !== 'readiness-timeout') throw error;
    const failure = new Error(`Notes Recall ${phase} did not arrive within ${options.deadlineMs} ms`);
    failure.name = 'NotesRecallWaitFailure';
    failure.category = phase === 'citation-link' ? 'recall-citation-timeout' : 'recall-tool-result-timeout';
    failure.phase = phase;
    failure.observations = error.readiness;
    throw failure;
  }
}
