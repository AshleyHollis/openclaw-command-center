import assert from 'node:assert/strict';
import test from 'node:test';
import { configureNotesRecallModel, collectRecallDiagnostics, recordRecallNativeEvent, waitForRecallObservation, summarizeRecallFailure } from './support/notes-recall-diagnostics.mjs';

test('Recall fictional model declares the actual completions API and main-agent tool policy', () => {
  const config = { models: { providers: { fixture: { models: [{ id: 'fixture-model', compat: { other: true } }] } } },
    agents: { entries: { main: { workspace: 'fictional' }, other: { enabled: false } } }, tools: { deny: ['fictional-denied'] } };
  configureNotesRecallModel(config, 'http://127.0.0.1:12345/v1');
  const provider = config.models.providers.fixture;
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider.models[0].api, provider.api);
  assert.deepEqual(provider.models[0].compat, { other: true, supportsTools: true });
  assert.equal(provider.request.allowPrivateNetwork, true);
  assert.deepEqual(config.agents.entries.main, { workspace: 'fictional', model: 'fixture/fixture-model', modelPolicy: { allow: ['fixture/fixture-model'] } });
  assert.deepEqual(config.agents.entries.other, { enabled: false });
  assert.deepEqual(config.tools, { deny: ['fictional-denied'], toolSearch: false, alsoAllow: ['command_center_recall_topic_notes'] });
  for (const url of ['https://127.0.0.1/v1', 'http://example.invalid/v1', 'http://127.0.0.1/v1?sentinel=x', 'http://user:sentinel@127.0.0.1/v1'])
    assert.throws(() => configureNotesRecallModel(config, url));
});

test('failure diagnostics retain bounded structural stages while dropping arbitrary source and error strings', () => {
  const sentinel = 'fictional-sentinel-sentinel';
  const events = [];
  for (let i = 0; i < 40; i++) recordRecallNativeEvent(events, JSON.stringify({ type: 'event', event: 'agent', payload: {
    stream: 'tool', runId: sentinel, sessionKey: sentinel, data: { phase: sentinel, name: 'command_center_recall_topic_notes',
      isError: true, error: { code: sentinel, message: sentinel }, result: { details: { status: 'partial', content: sentinel } } } } }));
  recordRecallNativeEvent(events, JSON.stringify({ type: 'event', event: 'chat', payload: { state: 'error', errorMessage: sentinel } }));
  const provider = { ingress: Array.from({ length: 40 }, () => ({ method: 'POST', path: `/v1/responses?fixtureMarker=${sentinel}` })),
    requests: Array.from({ length: 40 }, () => ({ action: 'recall', currentRole: 'user', currentToolStatus: sentinel,
      completedCurrentTool: false, issuedToolCallId: sentinel, tools: ['command_center_recall_topic_notes', sentinel],
      transcriptShape: Array.from({ length: 40 }, () => ({ role: 'assistant', toolCallId: sentinel, assistantToolCallIds: [sentinel], content: sentinel })) })),
    recallResults: [{ text: sentinel }] };
  const result = collectRecallDiagnostics(provider, events);
  assert.equal(result.ingressCount, 40); assert.equal(result.completionCount, 40); assert.equal(result.recallResultCount, 1);
  assert.equal(result.ingress.length, 8); assert.equal(result.completions.length, 8); assert.equal(result.nativeEvents.length, 32);
  assert.equal(result.completions[0].transcript.length, 12);
  assert.equal(result.ingress[0].route, 'other'); assert.equal(result.completions[0].recallToolRegistered, true);
  assert.equal(result.nativeEvents.at(-1).state, 'error'); assert.equal(result.nativeEvents.at(-1).hasError, true);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test('native observation ignores non-events, invalid JSON and assistant content', () => {
  const events = [];
  for (const payload of ['invalid', '{}', JSON.stringify({ type: 'event', event: 'agent', payload: { stream: 'assistant', data: { text: 'fictional-private' } } })])
    recordRecallNativeEvent(events, payload);
  assert.deepEqual(events, []);
  recordRecallNativeEvent(events, JSON.stringify({ type: 'event', event: 'agent', payload: { stream: 'lifecycle', data: { phase: 'end', executionSettled: true } } }));
  assert.equal(events[0].phase, 'end'); assert.equal(events[0].executionSettled, true);
  for (const [errorMessage, expected] of [['Unknown model: fictional/private', 'model-resolution'], ['No API provider configured for fictional', 'model-api'],
    ['fetch failed for fictional', 'provider-transport'], ['tool fictional not registered', 'tool-registration']]) {
    recordRecallNativeEvent(events, JSON.stringify({ type: 'event', event: 'chat', payload: { state: 'error', errorMessage } }));
    assert.equal(events.at(-1).errorKind, expected);
    assert.equal(JSON.stringify(events).includes(errorMessage), false);
  }
});

test('Recall tool and citation timeout labels preserve observation counts and original deadlines', async () => {
  const observations = { attempts: 1196, successfulObservations: 0, refusedConnections: 0, elapsedMs: 120000 };
  for (const phase of ['initial-tool-result', 'restart-tool-result', 'permission-loss-tool-result', 'permission-recovery-tool-result', 'citation-link']) {
    const deadlineMs = phase === 'citation-link' ? 30000 : 120000;
    const wait = async (_observe, _early, options) => {
      assert.equal(options.deadlineMs, deadlineMs);
      throw Object.assign(new Error('Host readiness'), { category: 'readiness-timeout', readiness: observations });
    };
    await assert.rejects(waitForRecallObservation(wait, async () => false, Promise.resolve(), { phase, deadlineMs }), error => {
      assert.equal(error.name, 'NotesRecallWaitFailure'); assert.equal(error.phase, phase);
      assert.equal(error.category, phase === 'citation-link' ? 'recall-citation-timeout' : 'recall-tool-result-timeout');
      assert.equal(error.observations, observations); assert.equal(error.message.includes('Host readiness'), false);
      assert.deepEqual(summarizeRecallFailure(error), { category: error.category, phase, cancelled: false, observations });
      return true;
    });
  }
});

test('persisted failure summary excludes arbitrary error text and invalid counters', () => {
  const summary = summarizeRecallFailure({ category: 'fictional-sentinel', phase: 'fictional-sentinel', message: 'fictional-sentinel',
    observations: { attempts: 'fictional-sentinel', successfulObservations: -1, refusedConnections: 0, elapsedMs: 120000 } });
  assert.deepEqual(summary, { category: 'other', phase: 'other', cancelled: false,
    observations: { attempts: null, successfulObservations: null, refusedConnections: 0, elapsedMs: 120000 } });
  assert.equal(JSON.stringify(summary).includes('fictional-sentinel'), false);
});

test('Recall wait preserves cancellation, early host failure, and successful completion', async () => {
  const controller = new AbortController(); controller.abort(new Error('fictional cancellation'));
  const cancellation = Object.assign(new Error('cancelled'), { category: 'readiness-timeout' });
  const early = Object.assign(new Error('early exit'), { category: 'host-early-exit' });
  await assert.rejects(waitForRecallObservation(async () => { throw cancellation; }, () => false, Promise.resolve(), { phase: 'initial-tool-result', signal: controller.signal }), error => error === cancellation);
  await assert.rejects(waitForRecallObservation(async () => { throw early; }, () => false, Promise.resolve(), { phase: 'initial-tool-result' }), error => error === early);
  await waitForRecallObservation(async observe => assert.equal(await observe(), true), () => true, Promise.resolve(), { phase: 'initial-tool-result' });
});
