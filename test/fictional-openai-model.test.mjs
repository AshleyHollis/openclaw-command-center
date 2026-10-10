import assert from 'node:assert/strict';
import test from 'node:test';
import { startFictionalOpenAiModel } from './support/fictional-openai-model.mjs';

async function completion(model, messages, tools) {
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-model', stream: true, messages, tools })
  });
  assert.equal(response.status, 200);
  return response.text();
}

test('fictional model binds a response to the current exact tool result, not historic tool messages', async () => {
  const model = await startFictionalOpenAiModel();
  try {
    const maintenance = { type: 'function', function: { name: 'command_center_update_working_note' } };
    await completion(model, [{ role: 'user', content: 'Update fictional Notes.' }], [maintenance]);
    const first = model.requests.at(-1);
    assert.equal(first.action, 'maintain');
    assert.ok(first.issuedToolCallId);
    assert.match(first.issuedToolCallId, /^[a-z0-9]+$/iu, 'the real host preserves this portable provider call-id form');
    await completion(model, [
      { role: 'user', content: 'Update fictional Notes.' },
      { role: 'assistant', tool_calls: [{ id: first.issuedToolCallId }] },
      { role: 'tool', tool_call_id: first.issuedToolCallId, content: '{"status":"applied"}' },
      { role: 'user', content: 'Normalized current user record.' }
    ], [maintenance]);
    assert.equal(model.requests.at(-1).action, 'final', 'an exact pending result remains current when the host appends its normalized user record');
    assert.equal(model.requests.at(-1).completedCurrentTool, true);
    const second = model.requests.at(-1);
    assert.equal(second.issuedToolCallId, null);
    const filing = { type: 'function', function: { name: 'command_center_file_topic_attachment' } };
    await completion(model, [
      { role: 'user', content: 'Old turn' },
      { role: 'assistant', tool_calls: [{ id: first.issuedToolCallId }] },
      { role: 'tool', tool_call_id: first.issuedToolCallId, content: '{"status":"applied"}' },
      { role: 'user', content: 'File media://inbound/fictional-current-document now.' }
    ], [filing]);
    const latest = model.requests.at(-1);
    assert.equal(latest.action, 'file');
    assert.equal(latest.mediaRef, 'media://inbound/fictional-current-document');
    assert.equal(latest.completedCurrentTool, false);
  } finally { await model.close(); }
});

test('fictional isolated clarification proposal uses zero tools and only exact saved words', async () => {
  const model = await startFictionalOpenAiModel();
  try {
    const words = 'I paid the fictional invoice in full. Keep this statement on this bill only.';
    const response = await completion(model, [{ role: 'user', content: JSON.stringify({ userWords: words,
      acceptedObligation: { title: 'Pay fictional invoice' } }) }], []);
    assert.match(response, /paymentState/u);
    assert.equal(model.requests.at(-1).isolatedClarificationProposal, true);
    assert.deepEqual(model.requests.at(-1).tools, []);
  } finally { await model.close(); }
});

test('fictional model can complete an explicit no-Note fixture turn without invoking an available maintenance tool', async () => {
  const model = await startFictionalOpenAiModel();
  try {
    const maintenance = { type: 'function', function: { name: 'command_center_update_working_note' } };
    await completion(model, [{ role: 'user', content: '[fixture:no-note] Acknowledge this turn without changing a Note.' }], [maintenance]);
    assert.equal(model.requests.at(-1).action, 'final');
    assert.equal(model.requests.at(-1).issuedToolCallId, null);
  } finally {
    await model.close();
  }
});

test('fictional model finds the newest unconsumed native attachment before its normalized user record', async () => {
  const model = await startFictionalOpenAiModel();
  try {
    const filing = { type: 'function', function: { name: 'command_center_file_topic_attachment' } };
    await completion(model, [
      { role: 'user', content: 'File media://inbound/fictional-native-document now.' },
      { role: 'user', content: [{ type: 'text', text: 'File this attachment.' }] }
    ], [filing]);
    const first = model.requests.at(-1);
    assert.equal(first.action, 'file');
    assert.equal(first.mediaRef, 'media://inbound/fictional-native-document');
    await completion(model, [
      { role: 'user', content: 'File media://inbound/fictional-native-document now.' },
      { role: 'assistant', tool_calls: [{ id: first.issuedToolCallId }] },
      { role: 'tool', tool_call_id: first.issuedToolCallId, content: '{"status":"applied"}' },
      { role: 'user', content: [{ type: 'text', text: 'File this attachment.' }] }
    ], [filing]);
    assert.equal(model.requests.at(-1).action, 'final');
  } finally {
    await model.close();
  }
});

test('fictional model exercises explicit and vague natural-language capture through the real tool contract', async () => {
  const model = await startFictionalOpenAiModel();
  try {
    const capture = { type: 'function', function: { name: 'command_center_capture_commitment' } };
    const explicit = await completion(model, [{ role: 'user', content: '[fixture:capture-laundry] Add researching laundry storage to my list.' }], [capture]);
    assert.equal(model.requests.at(-1).action, 'capture');
    assert.match(explicit, /command_center_capture_commitment/);
    const vague = await completion(model, [{ role: 'user', content: '[fixture:capture-vague] Maybe utility-room storage could be interesting.' }], [capture]);
    assert.equal(model.requests.at(-1).action, 'capture');
    assert.match(vague, /provenance\\\":\\\"idea/);
  } finally { await model.close(); }
});

test('fictional targeted clarification calls exact read and interpretation tools across normalized native messages', async () => {
  const model = await startFictionalOpenAiModel();
  try {
    const target = { loopId: 'fictional-loop', expectedRevision: 4, clarificationObservationId: 'fictional-clarification' };
    const prompt = `Process one item.\n[fixture:targeted-clarification:${Buffer.from(JSON.stringify(target)).toString('base64url')}]`;
    const read = await completion(model, [{ role: 'user', content: prompt }], []);
    assert.equal(model.requests.at(-1).action, 'targeted-load');
    assert.match(read, /command_center_get_pending_clarification/u);
    const readId = model.requests.at(-1).issuedToolCallId;
    const interpreted = await completion(model, [
      { role: 'user', content: prompt },
      { role: 'assistant', tool_calls: [{ id: readId }] },
      { role: 'tool', tool_call_id: readId, content: JSON.stringify({ ...target, status: 'pending', processorVersion: 'fictional-v1', userWords: 'I paid the fictional bill in full.' }) },
      { role: 'user', content: 'Normalized current user record.' }
    ], []);
    assert.equal(model.requests.at(-1).action, 'targeted-interpret');
    assert.match(interpreted, /command_center_interpret_clarification/u);
    const interpretationId = model.requests.at(-1).issuedToolCallId;
    await completion(model, [
      { role: 'user', content: prompt },
      { role: 'assistant', tool_calls: [{ id: interpretationId }] },
      { role: 'tool', tool_call_id: interpretationId, content: '{"status":"applied"}' },
      { role: 'user', content: 'Normalized current user record.' }
    ], []);
    assert.equal(model.requests.at(-1).action, 'final');
  } finally { await model.close(); }
});

test('fictional recall provider routes the exact current result after native normalization', async () => {
  const model = await startFictionalOpenAiModel({ noteRecall: true });
  try {
    const tool = { type: 'function', function: { name: 'command_center_recall_topic_notes' } };
    await completion(model, [{ role: 'user', content: '[fixture:notes-recall] Recall alpha.' }], [tool]);
    const id = model.requests.at(-1).issuedToolCallId;
    assert.equal(model.requests.at(-1).action, 'recall');
    const result = { groups: { notes: [{ excerpt: 'alpha actual tool evidence', navigation: {
      topicId: 'fictional-topic', referenceId: 'fictional-source', path: 'nested/source.md', observedRevision: 'v1'
    } }] } };
    const answer = await completion(model, [
      { role: 'user', content: '[fixture:notes-recall] Recall alpha.' },
      { role: 'assistant', tool_calls: [{ id }] },
      { role: 'tool', tool_call_id: id, content: JSON.stringify(result) },
      { role: 'user', content: 'Normalized current user record.' }
    ], [tool]);
    assert.match(answer, /alpha actual tool evidence/);
    assert.match(answer, /p.sourcePath=nested%2Fsource.md/);
    assert.deepEqual(model.recallResults, [result]);
    assert.equal(model.requests.at(-1).action, 'final');
  } finally { await model.close(); }
});

const discoveryTools = ['tool_search', 'tool_call'].map(name => ({ type: 'function', function: { name } }));
const discoveryPrompt = { role: 'user', content: '[fixture:notes-recall] Recall alpha.' };
const candidate = { id: 'fictional-catalog-opaque-id', name: 'command_center_recall_topic_notes', source: 'openclaw', sourceName: 'command-center' };
function issuedInput(response) {
  const frame = JSON.parse(response.split('\n').find(line => line.startsWith('data: ')).slice(6));
  const call = frame.choices[0].delta.tool_calls?.[0];
  return call ? { name: call.function.name, args: JSON.parse(call.function.arguments) } : null;
}
const returned = (id, value) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(value) });

test('fictional default discovery uses only the returned native catalog ID and exact current wrapped Recall result', async () => {
  const model = await startFictionalOpenAiModel({ noteRecall: true, noteRecallDiscovery: true });
  try {
    const search = await completion(model, [discoveryPrompt], discoveryTools);
    assert.deepEqual(issuedInput(search), { name: 'tool_search', args: { query: 'command_center_recall_topic_notes', limit: 8 } });
    const searchId = model.requests.at(-1).issuedToolCallId;
    const call = await completion(model, [discoveryPrompt, returned(searchId, [candidate]), { role: 'user', content: 'Normalized current user record.' }], discoveryTools);
    assert.deepEqual(issuedInput(call), { name: 'tool_call', args: { id: candidate.id, args: { query: 'alpha' } } });
    assert.equal(model.requests.at(-1).recallCatalogMatched, true);
    assert.equal(model.requests.at(-1).recallCatalogOtherCommandCenterCount, 0);
    const callId = model.requests.at(-1).issuedToolCallId;
    const result = { schemaVersion: 1, selectionBasis: 'current-topic-notes', status: 'available', groups: { notes: [{ excerpt: 'alpha native-dispatched evidence', navigation: {
      topicId: 'fictional-topic', referenceId: 'fictional-source', path: 'nested/source.md', observedRevision: 'v1'
    } }] } };
    result.groups.conversations = [];
    const envelope = { tool: { id: candidate.id, name: candidate.name, source: candidate.source },
      result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: result } };
    const transcript = [discoveryPrompt, returned(callId, envelope), returned('foreign-call-id', { groups: { notes: [] } }),
      { role: 'user', content: 'Normalized current user record.' }];
    const answer = await completion(model, transcript, discoveryTools);
    assert.match(answer, /alpha native-dispatched evidence/);
    assert.match(answer, /p.sourcePath=nested%2Fsource.md/);
    assert.deepEqual(model.recallResults, [result]);
    assert.equal(model.requests.at(-1).recallCatalogResultVerified, true);
    assert.equal(model.requests.at(-1).action, 'final');
    const repeat = await completion(model, [...transcript, discoveryPrompt], discoveryTools);
    assert.equal(issuedInput(repeat).name, 'tool_search', 'a new turn must rediscover rather than reuse the completed result');
    assert.equal(model.recallResults.length, 1);
  } finally { await model.close(); }
});

test('fictional discovery refuses missing controls without a direct Recall fallback', async () => {
  const model = await startFictionalOpenAiModel({ noteRecall: true, noteRecallDiscovery: true });
  try {
    const direct = { type: 'function', function: { name: candidate.name } };
    for (const tools of [[], [discoveryTools[0]], [discoveryTools[1]], [direct], [...discoveryTools, direct]]) {
      assert.equal(issuedInput(await completion(model, [discoveryPrompt], tools)), null);
      assert.equal(model.requests.at(-1).action, 'final');
    }
    assert.deepEqual(model.recallResults, []);
  } finally { await model.close(); }
});

test('fictional discovery refuses absent, ambiguous or foreign catalog candidates without dispatch', async () => {
  const model = await startFictionalOpenAiModel({ noteRecall: true, noteRecallDiscovery: true });
  try {
    for (const candidates of [null, {}, [], [candidate, candidate], [{ ...candidate, id: '' }], [{ ...candidate, id: ' ' }],
      [{ ...candidate, source: 'mcp' }], [{ ...candidate, sourceName: 'another-plugin' }], [{ ...candidate, name: 'another-tool' }]]) {
      await completion(model, [discoveryPrompt], discoveryTools);
      const searchId = model.requests.at(-1).issuedToolCallId;
      assert.equal(issuedInput(await completion(model, [discoveryPrompt, returned(searchId, candidates)], discoveryTools)), null);
      assert.equal(model.requests.at(-1).recallCatalogMatched, false);
    }
    assert.deepEqual(model.recallResults, []);
  } finally { await model.close(); }
});

test('fictional discovery refuses wrong native dispatch identities, errors and malformed results', async () => {
  const model = await startFictionalOpenAiModel({ noteRecall: true, noteRecallDiscovery: true });
  try {
    const valid = { tool: { id: candidate.id, name: candidate.name, source: candidate.source },
      result: { content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, selectionBasis: 'current-topic-notes', status: 'no-matches', groups: { notes: [], conversations: [] } }) }] } };
    for (const envelope of [...[{}, { status: 'error' }, { schemaVersion: 1, status: 'available', selectionBasis: 'other', groups: { notes: [], conversations: [] } }, { schemaVersion: 1, status: 'available', selectionBasis: 'current-topic-notes', groups: { notes: [], conversations: [{}] } }].map(value => ({ ...valid, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })), { ...valid, tool: { ...valid.tool, id: 'wrong-id' } }, { ...valid, tool: { ...valid.tool, name: 'wrong-name' } },
      { ...valid, tool: { ...valid.tool, source: 'mcp' } }, { ...valid, result: { ...valid.result, isError: true } },
      { ...valid, result: { content: [{ type: 'text', text: 'invalid' }] } }, { ...valid, result: { content: [{ type: 'text', text: 'null' }] } }]) {
      await completion(model, [discoveryPrompt], discoveryTools);
      const searchId = model.requests.at(-1).issuedToolCallId;
      await completion(model, [discoveryPrompt, returned(searchId, [candidate])], discoveryTools);
      const callId = model.requests.at(-1).issuedToolCallId;
      assert.equal(issuedInput(await completion(model, [discoveryPrompt, returned(callId, envelope)], discoveryTools)), null);
      assert.equal(model.requests.at(-1).recallCatalogResultVerified, false);
    }
    assert.deepEqual(model.recallResults, []);
  } finally { await model.close(); }
});

test('foreign or historical catalog responses cannot satisfy current discovery', async () => {
  const model = await startFictionalOpenAiModel({ noteRecall: true, noteRecallDiscovery: true });
  try {
    await completion(model, [discoveryPrompt], discoveryTools);
    const oldId = model.requests.at(-1).issuedToolCallId;
    await completion(model, [discoveryPrompt, returned(oldId, [])], discoveryTools);
    for (const id of ['foreign-call-id', oldId]) {
      await completion(model, [discoveryPrompt], discoveryTools);
      await completion(model, [discoveryPrompt, returned(id, [candidate])], discoveryTools);
      assert.equal(model.requests.at(-1).completedCurrentTool, false);
      assert.equal(model.requests.at(-1).recallCatalogMatched, false);
      assert.notEqual(model.requests.at(-1).action, 'recall-call');
    }
    assert.deepEqual(model.recallResults, []);
  } finally { await model.close(); }
});

 test('non-tool transcript records cannot complete a pending native discovery call', async () => {
  for (const role of ['user', 'assistant']) {
    const model = await startFictionalOpenAiModel({ noteRecall: true, noteRecallDiscovery: true });
    try {
      await completion(model, [discoveryPrompt], discoveryTools);
      const id = model.requests.at(-1).issuedToolCallId;
      await completion(model, [discoveryPrompt, { ...returned(id, [candidate]), role }], discoveryTools);
      assert.equal(model.requests.at(-1).completedCurrentTool, false);
      assert.equal(model.requests.at(-1).recallCatalogMatched, false);
      assert.deepEqual(model.recallResults, []);
    } finally { await model.close(); }
  }
});
