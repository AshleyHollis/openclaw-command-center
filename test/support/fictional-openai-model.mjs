import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export const fictionalAccountedEmailSourceNamespace = 'fictional-graph:account-one';
export const fictionalAccountedEmailRawId = 'fictional-real-host-mixed-message';
export const fictionalAccountedEmailSourceId = `namespaced:v1:sha256:${createHash('sha256').update(JSON.stringify([fictionalAccountedEmailSourceNamespace, fictionalAccountedEmailRawId])).digest('hex')}`;

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

function latestToolResult(messages) {
  const message = [...messages].reverse().find(item => item?.role === 'tool');
  if (!message) return null;
  const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(part => part?.text ?? part?.content ?? '').join('') : '';
  try { return JSON.parse(content); } catch { return null; }
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
  const pendingToolActions = new Map();
  const usedMediaReferences = new Set();
  const accounted = { phaseOneStep: 0, phaseTwoStep: 0, resolved: null, saved: null, captured: null };
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
    const completedToolAction = currentToolResultId === null ? null : pendingToolActions.get(currentToolResultId) ?? null;
    const completedCurrentTool = currentToolResultId !== null && pendingToolCalls.delete(currentToolResultId);
    if (completedCurrentTool) pendingToolActions.delete(currentToolResultId);
    // Native Chat appends a normalized current-user record after the original
    // attachment-bearing record. Select the newest unconsumed managed reference
    // rather than assuming that the last user record carries every attachment.
    const mediaRef = newestUnusedMediaReference(messages, usedMediaReferences);
    // The real-host journey needs one settled native turn whose normal
    // completion schedules catch-up work, followed by a separate turn that
    // writes a Note. Keep that distinction explicit in the test-only model;
    // production tool selection remains entirely host/model owned.
    const noNoteFixtureTurn = JSON.stringify(latestUserMessage(messages)?.content ?? '').includes('[fixture:no-note]');
    const serializedMessages = JSON.stringify(messages);
    const captureFixtureTurn = serializedMessages.includes('[fixture:capture-laundry]');
    const vagueFixtureTurn = serializedMessages.includes('[fixture:capture-vague]');
    const accountedPhaseOne = serializedMessages.includes('[fixture:accounted-mixed-email-phase-1]');
    const accountedPhaseTwo = serializedMessages.includes('[fixture:accounted-mixed-email-phase-2]');
    if (completedCurrentTool && (accountedPhaseOne || accountedPhaseTwo)) {
      const result = latestToolResult(messages);
      if (completedToolAction === 'command_center_get_intake_source_account') accounted.loaded = result;
      if (completedToolAction === 'command_center_resolve_source_topic') accounted.resolved = result;
      if (completedToolAction === 'command_center_save_source_note') accounted.saved = result;
      if (completedToolAction === 'command_center_capture_source_commitment') accounted.captured = result;
    }
    const source = { sourceKind: 'email', sourceExternalId: fictionalAccountedEmailSourceId, sourceVersion: 'email-change-key-real-host-52' };
    const acceptedExtraction = { schemaVersion: 1, proposedTopic: 'Fictional Native Journey', notePath: 'Inbox/fictional-real-host-mixed-email.md', knowledgeMarkdown: '# Fictional retained real-host reference\n', knowledgeOutcomeId: 'real-host-reference', obligations: [{ obligationId: 'real-host-choice', title: 'Choose fictional real-host delivery window', provenance: 'inferred', classification: 'decision' }, { obligationId: 'real-host-payment', title: 'Pay fictional real-host invoice', provenance: 'explicit' }, { obligationId: 'real-host-reply', title: 'Reply with fictional real-host reference', provenance: 'explicit' }] };
    let frames;
    let action = 'final';
    if (accountedPhaseOne && accounted.phaseOneStep <= 5) {
      const step = accounted.phaseOneStep++;
      if (step === 0) { action = 'accounted-resolve'; frames = toolCall({ id, model, name: 'command_center_resolve_source_topic', arguments: { topicName: acceptedExtraction.proposedTopic } }); }
      else if (step === 1) { action = 'accounted-plan'; frames = toolCall({ id, model, name: 'command_center_plan_intake_source', arguments: { ...source, checkpoint: 'page-1:fictional-real-host-mixed-message', observedAt: '2026-09-22T04:00:00.000Z', processorVersion: 'fictional-real-host-processor-v1', acceptedExtraction, outcomes: [{ outcomeId: 'real-host-choice', kind: 'decision' }, { outcomeId: 'real-host-payment', kind: 'obligation' }, { outcomeId: 'real-host-reply', kind: 'obligation' }, { outcomeId: 'real-host-reference', kind: 'information' }], enumeration: { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false } } }); }
      else if (step === 2) { action = 'accounted-save'; frames = toolCall({ id, model, name: 'command_center_save_source_note', arguments: { topicId: accounted.resolved?.topicId, noteFolderReferenceId: accounted.resolved?.noteFolderReferenceId, ...source, path: acceptedExtraction.notePath, markdown: acceptedExtraction.knowledgeMarkdown } }); }
      else if (step === 3) { action = 'accounted-outcome-reference'; frames = toolCall({ id, model, name: 'command_center_record_intake_outcome', arguments: { ...source, outcomeId: 'real-host-reference', kind: 'information', status: 'quiet', summary: 'Retain fictional real-host reference', topicId: accounted.resolved?.topicId, sourceReferenceId: accounted.saved?.sourceReferenceId, sourcePath: accounted.saved?.path, sourceReferenceVersion: accounted.saved?.revision, recordedAt: '2026-09-22T04:00:05.000Z' } }); }
      else if (step === 4) { action = 'accounted-capture-choice'; frames = toolCall({ id, model, name: 'command_center_capture_source_commitment', arguments: { topicId: accounted.resolved?.topicId, ...source, sourceReferenceId: accounted.saved?.sourceReferenceId, sourcePath: accounted.saved?.path, title: 'Choose fictional real-host delivery window', obligationId: 'real-host-choice', provenance: 'inferred' } }); }
      else { action = 'accounted-outcome-choice'; frames = toolCall({ id, model, name: 'command_center_record_intake_outcome', arguments: { ...source, outcomeId: 'real-host-choice', kind: 'decision', status: 'pending-decision', summary: 'Choose fictional real-host delivery window', loopId: accounted.captured?.loopId, recordedAt: '2026-09-22T04:00:10.000Z' } }); }
    } else if (accountedPhaseTwo && accounted.phaseTwoStep <= 6) {
      const step = accounted.phaseTwoStep++;
      const durableExtraction = accounted.loaded?.acceptedExtraction;
      const durableOutcomes = Array.isArray(accounted.loaded?.outcomes) ? accounted.loaded.outcomes : [];
      const durableOutcome = outcomeId => durableOutcomes.find(outcome => outcome.outcomeId === outcomeId);
      const retained = durableOutcome('real-host-reference');
      if (step === 0 || step === 6) { action = step === 0 ? 'accounted-load' : 'accounted-load-final'; frames = toolCall({ id, model, name: 'command_center_get_intake_source_account', arguments: source }); }
      else if (step === 1 || step === 3) { const payment = step === 1; const obligation = durableExtraction?.obligations?.find(item => item.obligationId === (payment ? 'real-host-payment' : 'real-host-reply')); action = payment ? 'accounted-capture-payment' : 'accounted-capture-reply'; frames = toolCall({ id, model, name: 'command_center_capture_source_commitment', arguments: { ...obligation, classification: undefined, topicId: retained?.topicId, ...source, sourceReferenceId: retained?.sourceReferenceId, sourcePath: retained?.sourcePath } }); }
      else if (step === 2 || step === 4) { const payment = step === 2; const outcome = durableOutcome(payment ? 'real-host-payment' : 'real-host-reply'); const obligation = durableExtraction?.obligations?.find(item => item.obligationId === outcome?.outcomeId); action = payment ? 'accounted-outcome-payment' : 'accounted-outcome-reply'; frames = toolCall({ id, model, name: 'command_center_record_intake_outcome', arguments: { ...source, outcomeId: outcome?.outcomeId, kind: outcome?.kind, status: 'applied', summary: obligation?.title, loopId: accounted.captured?.loopId, recordedAt: payment ? '2026-09-22T04:01:10.000Z' : '2026-09-22T04:01:20.000Z' } }); }
      else { action = 'accounted-receipt'; frames = toolCall({ id, model, name: 'command_center_record_intake_receipt', arguments: { sourceKind: 'email', runId: 'fictional-real-host-resume', checkpoint: 'page-1:fictional-real-host-mixed-message', status: 'healthy-processed', observedAt: '2026-09-22T04:02:00.000Z', lastSuccessfulAt: '2026-09-22T04:02:00.000Z', nextExpectedAt: '2026-09-23T04:02:00.000Z', processedCount: 1, actionableCount: 2, noteCount: 0 } }); }
    } else if (completedCurrentTool) {
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
    } else if ((captureFixtureTurn || vagueFixtureTurn) && tools.has('command_center_capture_commitment')) {
      action = 'capture';
      frames = toolCall({ id, model, name: 'command_center_capture_commitment', arguments: vagueFixtureTurn
        ? { title: 'Maybe explore utility-room ideas', obligationId: 'utility-room-ideas', provenance: 'idea', confidence: 0.55 }
        : { title: 'Research laundry storage', obligationId: 'laundry-storage-research', provenance: 'explicit', importance: 'normal', importanceOrigin: 'processing', effortMinutes: 30, contexts: ['home'] } });
    } else if (tools.has('command_center_update_working_note')) {
      action = 'maintain';
      frames = toolCall({ id, model, name: 'command_center_update_working_note', arguments: { path: 'Overview.md', text: '# Fictional Native Journey\n- Native working Note update from an isolated fictional model.\n' } });
    } else {
      frames = textCompletion({ id, model, text: 'Fictional native Chat reply.' });
    }
    const issuedToolCallId = action === 'final' ? null : stableToolCallId(id);
    if (issuedToolCallId) { pendingToolCalls.add(issuedToolCallId); pendingToolActions.set(issuedToolCallId, frames[0].choices[0].delta.tool_calls[0].function.name); }
    if (action === 'file' && mediaRef) usedMediaReferences.add(mediaRef);
    requests.push(Object.freeze({ id, action, mediaRef, tools: [...tools].sort(), messageCount: messages.length, currentRole: currentMessage?.role ?? null, currentToolResultId, currentToolStatus: toolResultStatus(currentMessage), completedCurrentTool, issuedToolCallId, transcriptShape: transcriptShape(messages), loadedProcessorVersion: accounted.loaded?.processorVersion ?? null, loadedOutcomeStatuses: accounted.loaded?.outcomes?.map(outcome => [outcome.outcomeId, outcome.status]) ?? [] }));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fictional model did not bind a loopback endpoint.');
  return Object.freeze({ baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, ingress, close: () => new Promise(resolve => server.close(resolve)) });
}
