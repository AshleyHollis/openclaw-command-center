import { readBoundedJson } from '../http/json-body.mjs';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { createRequestScopedGatewayRequest } from '../bridge/gateway-method-dispatch.mjs';

const ROUTE = '/plugins/command-center/api/topic/actions';
const MAX_NOTE_BYTES = 8 * 1024 * 1024 + 1;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;

const ACTION_FIELDS = Object.freeze({
  'conversations.create': ['schemaVersion', 'action', 'topicId', 'label', 'expectedRevision', 'logicalOperationId', 'authoritativeSession'],
  'conversations.creation.inspect': ['schemaVersion', 'action', 'topicId'],
  'conversations.creation.reconcile': ['schemaVersion', 'action', 'topicId', 'logicalOperationId'],
  'conversations.creation.acknowledge': ['schemaVersion', 'action', 'topicId', 'logicalOperationId', 'referenceId'],
  'chat.send': ['schemaVersion', 'action', 'topicId', 'referenceId', 'message', 'logicalOperationId'],
  'conversations.close': ['schemaVersion', 'action', 'topicId', 'referenceId', 'expectedRevision', 'logicalOperationId'],
  'conversations.reopen': ['schemaVersion', 'action', 'topicId', 'referenceId', 'expectedRevision', 'logicalOperationId'],
  'notes.create': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'contentBase64', 'expectedTopicRevision', 'logicalOperationId'],
  'notes.create.reconcile': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'contentBase64', 'expectedTopicRevision', 'logicalOperationId'],
  'notes.edit': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'contentBase64', 'expectedRevision', 'expectedTopicRevision', 'logicalOperationId'],
  'notes.edit.reconcile': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'contentBase64', 'expectedRevision', 'expectedTopicRevision', 'logicalOperationId'],
  'notes.rename': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'destinationPath', 'expectedRevision', 'expectedTopicRevision', 'logicalOperationId'],
  'notes.move': ['schemaVersion', 'action', 'topicId', 'referenceId', 'path', 'destinationPath', 'expectedRevision', 'expectedTopicRevision', 'logicalOperationId']
});

const createsNote = (action) => action === 'notes.create' || action === 'notes.create.reconcile';
export { ACTION_FIELDS as topicPageActionFields };
const reconcilesNote = (action) => action === 'notes.create.reconcile' || action === 'notes.edit.reconcile';
const conversationRecoveryMethods = Object.freeze({
  'conversations.creation.inspect': 'sessionsCreationInspect',
  'conversations.creation.reconcile': 'sessionsCreationReconcile',
  'conversations.creation.acknowledge': 'sessionsCreationAcknowledge'
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

async function readJson(req) { return readBoundedJson(req, MAX_REQUEST_BYTES); }

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
  if (body.schemaVersion !== 1 || body.action !== 'conversations.creation.inspect' && !isCanonicalUuid(body.logicalOperationId)) throw invalid('schemaVersion 1 and a canonical logicalOperationId are required.');
  if (!isCanonicalUuid(body.topicId)) throw invalid('A canonical topicId is required.');
  if (Object.hasOwn(conversationRecoveryMethods, body.action)) {
    if (body.action === 'conversations.creation.acknowledge') nonBlank(body.referenceId, 'referenceId');
    return body;
  }
  if (body.action === 'conversations.create') {
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) throw invalid('A non-negative expected Topic revision is required.');
    if (body.label !== undefined) nonBlank(body.label, 'label');
    const session = body.authoritativeSession;
    if (session !== undefined) {
      const allowed = ['key', 'sessionId', 'revision', 'idempotencyKey', 'label'];
      if (!session || typeof session !== 'object' || Array.isArray(session) || Object.keys(session).some((key) => !allowed.includes(key))) throw invalid('A closed authoritative Session result is required.');
      for (const key of allowed) nonBlank(session[key], `authoritativeSession.${key}`);
      if (session.idempotencyKey !== body.logicalOperationId || session.label !== body.label) throw invalid('The authoritative Session result must match the exact Conversation operation and label.');
    }
  } else if (body.action === 'chat.send') {
    nonBlank(body.referenceId, 'referenceId');
    nonBlank(body.message, 'message');
  } else if (body.action.startsWith('notes.')) {
    if (!Number.isInteger(body.expectedTopicRevision) || body.expectedTopicRevision < 0) throw invalid('A non-negative expected Topic revision is required.');
    if (!createsNote(body.action) && (typeof body.expectedRevision !== 'string' || body.expectedRevision.trim() === '')) throw invalid('An exact expected Note revision is required.');
  } else if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw invalid('A non-negative expected Topic revision is required.');
  }
  if ((body.action === 'chat.send' || body.action.startsWith('conversations.')) && body.action !== 'conversations.create') nonBlank(body.referenceId, 'referenceId');
  if (body.action.startsWith('notes.')) {
    nonBlank(body.referenceId, 'referenceId');
    nonBlank(body.path, 'path');
    if (createsNote(body.action) || body.action === 'notes.edit' || body.action === 'notes.edit.reconcile') {
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

async function execute(service, body, createConversationRuntime) {
  const { action } = body;
  if (Object.hasOwn(conversationRecoveryMethods, action)) {
    if (!createConversationRuntime) throw invalid('Conversation recovery requires authenticated native request authority.');
    const runtime = await createConversationRuntime();
    return service[conversationRecoveryMethods[action]]({ schemaVersion: 1, topicId: body.topicId,
      ...(body.logicalOperationId === undefined ? {} : { logicalOperationId: body.logicalOperationId }),
      ...(body.referenceId === undefined ? {} : { referenceId: body.referenceId }) }, runtime);
  }
  if (action === 'conversations.create') {
    if (!createConversationRuntime) assertTopicRevision(service, body.topicId, body.expectedRevision);
    // The full owner contract retains legacy adoption for deferred coverage;
    // first-live registration refuses that envelope before reaching this path.
    // Native creation stays inside this authenticated HTTP request's SDK scope.
    if (createConversationRuntime && body.authoritativeSession !== undefined) throw invalid('Conditional Conversation creation requires native request authority.');
    const runtime = createConversationRuntime ? await createConversationRuntime() : body.authoritativeSession === undefined
      ? { gatewayRequest: createRequestScopedGatewayRequest() }
      : { authoritativeSession: body.authoritativeSession };
    return service.sessionsCreate({ schemaVersion: 1, topicId: body.topicId, ...(body.label === undefined ? {} : { label: body.label }), isPrimary: false, logicalOperationId: body.logicalOperationId,
      ...(createConversationRuntime ? { expectedTopicRevision: body.expectedRevision } : {}) }, runtime);
  }
  if (action === 'chat.send') {
    assertConversationReference(service, body);
    return service.sessionsSend({ schemaVersion: 1, topicId: body.topicId, referenceId: body.referenceId, message: body.message, logicalOperationId: body.logicalOperationId });
  }
  // Confirmation uses current ownership, not the optimistic revision precondition
  // for a new write. The authenticated route still requires write authority.
  if (!reconcilesNote(action)) assertTopicRevision(service, body.topicId, body.action.startsWith('notes.') ? body.expectedTopicRevision : body.expectedRevision);
  if (action === 'conversations.close' || action === 'conversations.reopen') {
    assertConversationReference(service, body);
    return action.endsWith('close') ? service.sessionsClose({ schemaVersion: 1, topicId: body.topicId, referenceId: body.referenceId, logicalOperationId: body.logicalOperationId }) : service.sessionsReopen({ schemaVersion: 1, topicId: body.topicId, referenceId: body.referenceId, logicalOperationId: body.logicalOperationId });
  }
  assertNoteReference(service, body, { create: createsNote(action) });
  const method = { 'notes.create': 'notesCreate', 'notes.create.reconcile': 'notesCreateReconcile', 'notes.edit': 'notesEdit', 'notes.edit.reconcile': 'notesEditReconcile', 'notes.rename': 'notesRename', 'notes.move': 'notesMove' }[action];
  const text = body.contentBase64 === undefined ? undefined : decodeNoteContent(body.contentBase64);
  return service[method]({ schemaVersion: 1, topicId: body.topicId, referenceId: body.referenceId, path: body.path, ...(text === undefined ? {} : { text }), ...(body.destinationPath === undefined ? {} : { destinationPath: body.destinationPath }), ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }), logicalOperationId: body.logicalOperationId });
}

export function createTopicPageActionsHandler(service, { assertAction, createConversationRuntime } = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed', message: 'Topic Page actions are POST-only.' }); return true; }
    let noteSave = false;
    try {
      if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers?.['content-type'] ?? ''))) throw invalid('JSON content type is required.');
      const request = await readJson(req);
      // Registration supplies the build-owned release policy. It runs before
      // domain validation, source lookup or dispatch and is never caller input.
      assertAction?.(request.body);
      const body = validateBody(request.body);
      noteSave = createsNote(body.action) || body.action === 'notes.edit' || body.action === 'notes.edit.reconcile';
      assertRequestBounds(body, request.bytes);
      const result = await execute(service, body, createConversationRuntime);
      if (body.action === 'conversations.creation.inspect') {
        // Only the closed owner projection is exposed. Never return the journal,
        // principal, native locator or a different operator's stored intent.
        sendJson(res, 200, { schemaVersion: 1, status: result.status,
          ...(result.logicalOperationId === undefined ? {} : { logicalOperationId: result.logicalOperationId }),
          result: { action: body.action, topicId: body.topicId,
            ...(result.expectedTopicRevision === undefined ? {} : { expectedTopicRevision: result.expectedTopicRevision }),
            ...(result.label === undefined ? {} : { label: result.label }),
            ...(result.referenceId === undefined ? {} : { referenceId: result.referenceId }) } });
        return true;
      }
      sendJson(res, 200, { schemaVersion: 1, status: result?.status ?? result?.value?.status ?? 'applied', logicalOperationId: body.logicalOperationId, result: { action: body.action, topicId: body.topicId, referenceId: body.referenceId ?? null, ...(reconcilesNote(body.action) ? { path: body.path } : {}), ...mutationValue(result) } });
    } catch (error) {
      const code = String(error?.code ?? 'invalid-request');
      if (code === 'feature-unavailable') {
        sendJson(res, 501, { schemaVersion: 1, status: 'error', code, retryable: false, message: 'This feature is not available in the first live release.' });
        return true;
      }
      const status = code === 'invalid-request' ? 400 : code === 'conflict' || code === 'primary-session' ? 409 : 422;
      const message = code === 'conflict' ? 'The Topic Page action conflicted with newer authoritative state.' : status === 422 ? noteSave ? 'The Note save outcome is still unknown.' : 'The Topic Page action outcome could not be confirmed.' : 'The Topic Page action was not applied.';
      sendJson(res, status, { schemaVersion: 1, status: 'error', code, message });
    }
    return true;
  };
}

export const createTopicPageHttpHandler = createTopicPageActionsHandler;
export const topicPageActionRoute = ROUTE;
