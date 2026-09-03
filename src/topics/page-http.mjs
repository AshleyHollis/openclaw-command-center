import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { allowOpaqueFrameRequest } from '../http/opaque-frame-cors.mjs';

const ROUTE = '/plugins/command-center/api/topic/actions';
const MAX_NOTE_BYTES = 8 * 1024 * 1024 + 1;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;

const ACTION_FIELDS = Object.freeze({
  'conversations.create': ['schemaVersion', 'action', 'topicId', 'label', 'expectedRevision', 'logicalOperationId', 'authoritativeSession'],
  'chat.send': ['schemaVersion', 'action', 'topicId', 'referenceId', 'message', 'logicalOperationId'],
  'conversations.close': ['schemaVersion', 'action', 'topicId', 'referenceId', 'expectedRevision', 'logicalOperationId'],
  'conversations.reopen': ['schemaVersion', 'action', 'topicId', 'referenceId', 'expectedRevision', 'logicalOperationId'],
  'notes.create': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'contentBase64', 'expectedTopicRevision', 'logicalOperationId'],
  'notes.edit': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'contentBase64', 'expectedRevision', 'expectedTopicRevision', 'logicalOperationId'],
  'notes.rename': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'destinationPath', 'expectedRevision', 'expectedTopicRevision', 'logicalOperationId'],
  'notes.move': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'destinationPath', 'expectedRevision', 'expectedTopicRevision', 'logicalOperationId']
});

function invalid(message) { return Object.assign(new Error(message), { code: 'invalid-request' }); }

function nonBlank(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} is required.`);
  return value.trim();
}

function decodeNoteContent(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0) throw invalid('contentBase64 must be canonical base64.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw invalid('contentBase64 must be canonical base64.');
  if (bytes.length > MAX_NOTE_BYTES) throw invalid('Note content exceeds the bounded Topic Page limit.');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw invalid('Note content must be valid UTF-8.');
  return text;
}

async function readJson(req) {
  if (req?.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const encoded = JSON.stringify(req.body);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw invalid('Request body exceeds the bounded Topic Page limit.');
    return { body: req.body, bytes: Buffer.byteLength(encoded) };
  }
  if (typeof req?.body === 'string') {
    const bytes = Buffer.byteLength(req.body);
    if (bytes > MAX_REQUEST_BYTES) throw invalid('Request body exceeds the bounded Topic Page limit.');
    try { return { body: JSON.parse(req.body), bytes }; } catch { throw invalid('Request body must be valid JSON.'); }
  }
  if (typeof req?.readBody === 'function') {
    const body = await req.readBody();
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_REQUEST_BYTES) throw invalid('Request body exceeds the bounded Topic Page limit.');
    try { return { body: JSON.parse(body), bytes }; } catch { throw invalid('Request body must be valid JSON.'); }
  }
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > MAX_REQUEST_BYTES) throw invalid('Request body exceeds the bounded Topic Page limit.');
      chunks.push(bytes);
    }
    try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes: size }; } catch { throw invalid('Request body must be valid JSON.'); }
  }
  throw invalid('A JSON request body is required.');
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    res.statusCode = 507;
    res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'response-too-large', message: 'Topic Page action response exceeded its bounded limit.' }));
    return;
  }
  res.statusCode = statusCode;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.setHeader?.('Cache-Control', 'no-store');
  res.end(body);
}

function topic(service, topicId) {
  const current = service.topics?.get?.(topicId) ?? service.topics?.getTopic?.(topicId);
  if (!current) throw Object.assign(new Error('The requested Topic does not exist.'), { code: 'source-recovery' });
  return current;
}

function assertTopicRevision(service, topicId, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw invalid('A non-negative expected Topic revision is required.');
  const current = topic(service, topicId);
  if (current.revision !== expectedRevision) throw Object.assign(new Error('The Topic revision is stale.'), { code: 'conflict', currentRevision: current.revision });
  if (current.lifecycle !== 'active') throw Object.assign(new Error('The Topic is not available as a workspace.'), { code: 'source-recovery' });
  return current;
}

function reference(service, topicId, referenceId) {
  if (typeof service.getTopicSourceReference === 'function') return service.getTopicSourceReference({ topicId, referenceId });
  const value = service.metadata?.getSourceReference?.(referenceId);
  if (!value || value.topicId !== topicId) throw Object.assign(new Error('The exact Topic-owned Source Reference was not found.'), { code: 'source-recovery' });
  return value;
}

function assertNoteReference(service, body, { create = false } = {}) {
  if (typeof service.assertExactNoteReference === 'function') return service.assertExactNoteReference(body, { create });
  const source = reference(service, body.topicId, body.referenceId);
  const folders = (service.listTopicSourceReferences?.(body.topicId) ?? service.metadata?.listSourceReferences?.(body.topicId) ?? []).filter((item) => item.sourceSystem === 'obsidian' && item.sourceKind === 'note_folder');
  const folder = folders.length === 1 ? folders[0] : null;
  if (!folder) throw Object.assign(new Error('The exact Topic Note Folder Source Reference is required.'), { code: 'source-recovery' });
  if (create) {
    if (source.sourceSystem !== 'obsidian' || source.sourceKind !== 'note_folder' || source.referenceId !== folder.referenceId) throw Object.assign(new Error('Note creation requires the exact Note Folder Source Reference.'), { code: 'source-recovery' });
    return source;
  }
  if (source.sourceSystem !== 'obsidian' || source.sourceKind !== 'note') throw Object.assign(new Error('The exact Topic-owned Note Source Reference is required.'), { code: 'source-recovery' });
  const folderRoot = service.metadata?.getSourceLocator?.(folder.referenceId)?.locator ?? folder.externalSourceId;
  if (source.externalSourceId !== `${String(folderRoot).replace(/\/+$/u, '')}/${body.path}`) throw Object.assign(new Error('The Note Source Reference does not match the requested path.'), { code: 'source-recovery' });
  const replay = service.metadata?.getOperation?.(body.logicalOperationId);
  if (source.observedRevision !== body.expectedRevision && !replay) throw Object.assign(new Error('The Note Source Reference revision is stale.'), { code: 'conflict' });
  return source;
}

function assertConversationReference(service, body) {
  const source = reference(service, body.topicId, body.referenceId);
  if (source.sourceSystem !== 'openclaw' || source.sourceKind !== 'session') throw Object.assign(new Error('The Conversation Source Reference kind is invalid.'), { code: 'source-recovery' });
  return source;
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('A closed Topic Page action request is required.');
  const fields = ACTION_FIELDS[body.action];
  if (!fields || Object.keys(body).some((key) => !fields.includes(key))) throw invalid('The Topic Page action contains unsupported fields.');
  if (body.schemaVersion !== 1 || !isCanonicalUuid(body.logicalOperationId)) throw invalid('schemaVersion 1 and a canonical logicalOperationId are required.');
  if (!isCanonicalUuid(body.topicId)) throw invalid('A canonical topicId is required.');
  if (body.action === 'conversations.create') {
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) throw invalid('A non-negative expected Topic revision is required.');
    if (body.label !== undefined) nonBlank(body.label, 'label');
    const session = body.authoritativeSession;
    const allowed = ['key', 'sessionId', 'revision', 'idempotencyKey', 'label'];
    if (!session || typeof session !== 'object' || Array.isArray(session) || Object.keys(session).some((key) => !allowed.includes(key))) throw invalid('A closed authoritative Session result is required.');
    for (const key of allowed) nonBlank(session[key], `authoritativeSession.${key}`);
    if (session.idempotencyKey !== body.logicalOperationId || session.label !== body.label) throw invalid('The authoritative Session result must match the exact Conversation operation and label.');
  } else if (body.action === 'chat.send') {
    nonBlank(body.referenceId, 'referenceId');
    nonBlank(body.message, 'message');
  } else if (body.action.startsWith('notes.')) {
    if (!Number.isInteger(body.expectedTopicRevision) || body.expectedTopicRevision < 0) throw invalid('A non-negative expected Topic revision is required.');
    if (body.action !== 'notes.create' && (typeof body.expectedRevision !== 'string' || body.expectedRevision.trim() === '')) throw invalid('An exact expected Note revision is required.');
  } else if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw invalid('A non-negative expected Topic revision is required.');
  }
  if ((body.action === 'chat.send' || body.action.startsWith('conversations.')) && body.action !== 'conversations.create') nonBlank(body.referenceId, 'referenceId');
  if (body.action.startsWith('notes.')) {
    nonBlank(body.referenceId, 'referenceId');
    nonBlank(body.path, 'path');
    if (body.action === 'notes.create' || body.action === 'notes.edit') {
      decodeNoteContent(body.contentBase64);
    } else nonBlank(body.destinationPath, 'destinationPath');
  }
  return body;
}

function assertRequestBounds(body, bytes) {
  if (bytes > MAX_REQUEST_BYTES) throw invalid('Topic Page mutations exceed the bounded envelope.');
}

function mutationValue(value) {
  const result = value?.value ?? value?.result ?? value ?? {};
  const note = result?.note ?? result;
  const publicReferenceId = result?.sourceReference?.referenceId ?? note?.sourceReference?.referenceId ?? result?.referenceId;
  return {
    ...(typeof publicReferenceId === 'string' ? { referenceId: publicReferenceId } : {}),
    ...(typeof note?.path === 'string' ? { path: note.path } : {}),
    ...(typeof note?.previousPath === 'string' ? { previousPath: note.previousPath } : {}),
    ...(typeof note?.revision === 'string' ? { revision: note.revision } : {}),
    ...(typeof result?.status === 'string' ? { status: result.status } : {})
  };
}

async function execute(service, body, runtime = {}) {
  const { action } = body;
  if (action === 'conversations.create') {
    assertTopicRevision(service, body.topicId, body.expectedRevision);
    return service.sessionsCreate({ schemaVersion: 1, topicId: body.topicId, ...(body.label === undefined ? {} : { label: body.label }), isPrimary: false, logicalOperationId: body.logicalOperationId }, { authoritativeSession: body.authoritativeSession });
  }
  if (action === 'chat.send') {
    assertConversationReference(service, body);
    return service.sessionsSend({ schemaVersion: 1, topicId: body.topicId, referenceId: body.referenceId, message: body.message, logicalOperationId: body.logicalOperationId });
  }
  assertTopicRevision(service, body.topicId, body.action.startsWith('notes.') ? body.expectedTopicRevision : body.expectedRevision);
  if (action === 'conversations.close' || action === 'conversations.reopen') {
    assertConversationReference(service, body);
    return action.endsWith('close') ? service.sessionsClose({ schemaVersion: 1, topicId: body.topicId, referenceId: body.referenceId, logicalOperationId: body.logicalOperationId }) : service.sessionsReopen({ schemaVersion: 1, topicId: body.topicId, referenceId: body.referenceId, logicalOperationId: body.logicalOperationId });
  }
  assertNoteReference(service, body, { create: action === 'notes.create' });
  const method = { 'notes.create': 'notesCreate', 'notes.edit': 'notesEdit', 'notes.rename': 'notesRename', 'notes.move': 'notesMove' }[action];
  const text = body.contentBase64 === undefined ? undefined : decodeNoteContent(body.contentBase64);
  return service[method]({ schemaVersion: 1, topicId: body.topicId, referenceId: body.referenceId, path: body.path, ...(text === undefined ? {} : { text }), ...(body.destinationPath === undefined ? {} : { destinationPath: body.destinationPath }), ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }), logicalOperationId: body.logicalOperationId });
}

export function createTopicPageActionsHandler(service) {
  return async (req, res) => {
    if (!allowOpaqueFrameRequest(req, res, { method: 'POST', headers: ['Content-Type'] })) { sendJson(res, 403, { schemaVersion: 1, status: 'error', code: 'origin-not-allowed', message: 'Topic Page action origin is not allowed.' }); return true; }
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader?.('Cache-Control', 'no-store'); res.end(); return true; }
    if (req.method !== 'POST') { sendJson(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed', message: 'Topic Page actions are POST-only.' }); return true; }
    try {
      if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers?.['content-type'] ?? ''))) throw invalid('JSON content type is required.');
      const request = await readJson(req);
      const body = validateBody(request.body);
      assertRequestBounds(body, request.bytes);
      const result = await execute(service, body);
      sendJson(res, 200, { schemaVersion: 1, status: result?.status ?? result?.value?.status ?? 'applied', logicalOperationId: body.logicalOperationId, result: { action: body.action, topicId: body.topicId, referenceId: body.referenceId ?? null, ...mutationValue(result) } });
    } catch (error) {
      const code = String(error?.code ?? 'invalid-request');
      const status = code === 'invalid-request' ? 400 : code === 'conflict' || code === 'primary-session' ? 409 : 422;
      sendJson(res, status, { schemaVersion: 1, status: 'error', code, message: code === 'conflict' ? 'The Topic Page action conflicted with newer authoritative state.' : 'The Topic Page action was not applied.' });
    }
    return true;
  };
}

export const createTopicPageHttpHandler = createTopicPageActionsHandler;
export const topicPageActionRoute = ROUTE;
