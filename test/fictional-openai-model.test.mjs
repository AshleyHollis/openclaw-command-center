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
