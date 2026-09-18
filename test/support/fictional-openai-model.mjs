import { createServer } from 'node:http';

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function latestUserMessage(messages) {
  return [...messages].reverse().find((message) => message?.role === 'user') ?? null;
}

function currentTurnToolResultId(messages, pendingToolCalls) {
  // The host may append its normalized current-user record after the provider
  // tool result. Match an exact outstanding ID across the transcript first:
  // completed calls are removed immediately, so a historic result cannot
  // satisfy a new call.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const id = typeof message?.tool_call_id === 'string' ? message.tool_call_id
      : typeof message?.toolCallId === 'string' ? message.toolCallId : null;
    if (id && pendingToolCalls.has(id)) return id;
  }
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') { latestUserIndex = index; break; }
  }
  for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
    const message = messages[index];
    const id = typeof message?.tool_call_id === 'string' ? message.tool_call_id
      : typeof message?.toolCallId === 'string' ? message.toolCallId : null;
    // The pinned host's OpenAI-compatible transcript occasionally omits the
    // provider call id on a tool-result message. It is still safe to complete
    // only when that result is after the current user turn and exactly one
    // fixture call remains pending; a historic result or two pending calls
    // never satisfies this fallback.
    if (message?.role === 'tool' && pendingToolCalls.size === 1) return pendingToolCalls.values().next().value;
  }
  return null;
}

function toolResultStatus(message) {
  if (message?.role !== 'tool') return null;
  const match = JSON.stringify(message.content ?? null).match(/"status"\s*:\s*"(applied|reconciled|conflict|unknown|failed)"/u);
  return match?.[1] ?? null;
}

function mediaReference(message) {
  const match = JSON.stringify(message ?? null).match(/media:\/\/inbound\/[^"\\\s]+/u);
  return match?.[0] ?? null;
}

function newestUnusedMediaReference(messages, usedMediaReferences) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reference = mediaReference(messages[index]);
    if (reference && !usedMediaReferences.has(reference)) return reference;
  }
  return null;
}

function transcriptShape(messages) {
  return messages.slice(-12).map((message) => Object.freeze({
    role: typeof message?.role === 'string' ? message.role : null,
    toolCallId: typeof message?.tool_call_id === 'string' ? message.tool_call_id
      : typeof message?.toolCallId === 'string' ? message.toolCallId : null,
    assistantToolCallIds: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((call) => typeof call?.id === 'string' ? call.id : null).filter(Boolean)
      : [],
    contentKind: Array.isArray(message?.content) ? 'array' : message?.content === null ? 'null' : typeof message?.content,
    contentPartTypes: Array.isArray(message?.content)
      ? message.content.map((part) => typeof part?.type === 'string' ? part.type : null).filter(Boolean)
      : [],
    contentHasManagedMedia: /media:\/\/inbound\//u.test(JSON.stringify(message?.content ?? null)),
    attachmentCount: Array.isArray(message?.attachments) ? message.attachments.length : 0
  }));
}

function completionChunk({ id, model, delta, finishReason = null }) {
  return { id, object: 'chat.completion.chunk', created: 1_789_000_000, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function stableToolCallId(id) {
  // The host's native OpenAI-compatible transcript normalizes provider call
  // identifiers. Emit the portable subset from the outset so the fictional
  // provider can bind only the exact current returned result.
  return `callfixture${String(id).replace(/[^a-z0-9]/giu, '')}`;
}

function toolCall({ id, model, name, arguments: input }) {
  return [
    completionChunk({ id, model, delta: { role: 'assistant', tool_calls: [{ index: 0, id: stableToolCallId(id), type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }),
    completionChunk({ id, model, delta: {}, finishReason: 'tool_calls' })
  ];
}

function textCompletion({ id, model, text }) {
  return [
    completionChunk({ id, model, delta: { role: 'assistant', content: text } }),
    completionChunk({ id, model, delta: {}, finishReason: 'stop' })
  ];
}

/** A loopback-only OpenAI-compatible model for fictional host acceptance. */
export async function startFictionalOpenAiModel({ firstTurnFinal = false } = {}) {
  const requests = [];
  const ingress = [];
  const pendingToolCalls = new Set();
  const usedMediaReferences = new Set();
  let sequence = 0;
  let initialTurnCompleted = false;
  const server = createServer(async (request, response) => {
    ingress.push(Object.freeze({ method: request.method ?? null, path: request.url ?? null }));
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body;
    try { body = await readJson(request); }
    catch { response.writeHead(400); response.end(JSON.stringify({ error: { message: 'Invalid fictional request.' } })); return; }
    const id = `fictional-${++sequence}`;
    const model = typeof body.model === 'string' ? body.model : 'fixture-model';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = new Set((Array.isArray(body.tools) ? body.tools : []).map(entry => entry?.function?.name).filter(value => typeof value === 'string'));
    const currentMessage = messages.at(-1) ?? null;
    const currentToolResultId = currentTurnToolResultId(messages, pendingToolCalls);
    const completedCurrentTool = currentToolResultId !== null && pendingToolCalls.delete(currentToolResultId);
    // Native Chat appends a normalized current-user record after the original
    // attachment-bearing record. Select the newest unconsumed managed reference
    // rather than assuming that the last user record carries every attachment.
    const mediaRef = newestUnusedMediaReference(messages, usedMediaReferences);
    // The real-host journey needs one settled native turn whose normal
    // completion schedules catch-up work, followed by a separate turn that
    // writes a Note. Keep that distinction explicit in the test-only model;
    // production tool selection remains entirely host/model owned.
    const noNoteFixtureTurn = JSON.stringify(latestUserMessage(messages)?.content ?? '').includes('[fixture:no-note]');
    let frames;
    let action = 'final';
    if (completedCurrentTool) {
      frames = textCompletion({ id, model, text: 'Fictional native tool action completed.' });
    } else if (firstTurnFinal && !initialTurnCompleted) {
      // The native Chat transport may normalize user content before it reaches
      // an OpenAI-compatible provider. This journey needs one explicit
      // tool-free settled turn before it exercises the two granted tools.
      initialTurnCompleted = true;
      frames = textCompletion({ id, model, text: 'Fictional native Chat reply without a Note change.' });
    } else if (noNoteFixtureTurn) {
      frames = textCompletion({ id, model, text: 'Fictional native Chat reply without a Note change.' });
    } else if (mediaRef && tools.has('command_center_file_topic_attachment')) {
      action = 'file'; frames = toolCall({ id, model, name: 'command_center_file_topic_attachment', arguments: { mediaRef } });
    } else if (tools.has('command_center_update_working_note')) {
      action = 'maintain';
      frames = toolCall({ id, model, name: 'command_center_update_working_note', arguments: { path: 'Overview.md', text: '# Fictional Native Journey\n- Native working Note update from an isolated fictional model.\n' } });
    } else {
      frames = textCompletion({ id, model, text: 'Fictional native Chat reply.' });
    }
    const issuedToolCallId = action === 'final' ? null : stableToolCallId(id);
    if (issuedToolCallId) pendingToolCalls.add(issuedToolCallId);
    if (action === 'file' && mediaRef) usedMediaReferences.add(mediaRef);
    requests.push(Object.freeze({ id, action, mediaRef, tools: [...tools].sort(), messageCount: messages.length, currentRole: currentMessage?.role ?? null, currentToolResultId, currentToolStatus: toolResultStatus(currentMessage), completedCurrentTool, issuedToolCallId, transcriptShape: transcriptShape(messages) }));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fictional model did not bind a loopback endpoint.');
  return Object.freeze({ baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, ingress, close: () => new Promise(resolve => server.close(resolve)) });
}
