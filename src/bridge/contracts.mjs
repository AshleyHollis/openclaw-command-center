import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { sourceError } from '../sources/errors.mjs';
import { validateScheduleDeclaration, validateScheduleUpdatePatch } from '../sources/scheduler-input.mjs';

export const READ_METHODS = Object.freeze([
  'command-center.v1.sources.status',
  'command-center.v1.notes.browse',
  'command-center.v1.notes.read',
  'command-center.v1.sessions.history',
  'command-center.v1.sessions.navigate',
  'command-center.v1.reminders.list',
  'command-center.v1.schedules.list',
  'command-center.v1.schedules.get',
  'command-center.v1.metadata.read',
  'command-center.v1.analysis.read',
  'command-center.v1.search.query'
]);

export const WRITE_METHODS = Object.freeze([
  'command-center.v1.notes.create',
  'command-center.v1.notes.edit',
  'command-center.v1.notes.rename',
  'command-center.v1.notes.move',
  'command-center.v1.sessions.create',
  'command-center.v1.sessions.send',
  'command-center.v1.sessions.close',
  'command-center.v1.sessions.reopen',
  'command-center.v1.reminders.snooze',
  'command-center.v1.reminders.complete',
  'command-center.v1.schedules.create',
  'command-center.v1.schedules.update',
  'command-center.v1.schedules.set-enabled',
  'command-center.v1.schedules.run',
  'command-center.v1.metadata.write',
  'command-center.v1.attention.act',
  'command-center.v1.analysis.run'
]);

const common = ['schemaVersion'];
const stringFields = new Set(['topicId', 'referenceId', 'sessionReferenceId', 'scheduleReferenceId', 'path', 'notePath', 'sourcePath', 'newPath', 'destinationPath', 'text', 'content', 'expectedRevision', 'expectedConfigRevision', 'logicalOperationId', 'message', 'attentionId', 'actionId', 'query', 'operation']);
const objectFields = new Set(['patch', 'declaration', 'input', 'value']);

function parameterSchema(field) {
  if (field === 'schemaVersion') return Object.freeze({ const: 1 });
  if (stringFields.has(field)) return Object.freeze({ type: 'string', minLength: 1 });
  if (objectFields.has(field)) return Object.freeze({ type: 'object' });
  if (field === 'enabled' || field === 'isPrimary') return Object.freeze({ type: 'boolean' });
  if (field === 'limit') return Object.freeze({ type: 'integer', minimum: 1 });
  if (field === 'offset') return Object.freeze({ type: 'integer', minimum: 0 });
  return Object.freeze({ type: 'string' });
}

function actionResultSchema(method) {
  const properties = {
    schemaVersion: Object.freeze({ const: 1 }),
    status: Object.freeze({ type: 'string' }),
    mode: Object.freeze({ type: 'string' }),
    requestId: Object.freeze({ type: ['string', 'null'] }),
    logicalOperationId: Object.freeze({ type: ['string', 'null'] }),
    value: Object.freeze({ type: ['object', 'array', 'null'] }),
    note: Object.freeze({ type: 'object' }),
    sourceReference: Object.freeze({ type: 'object' }),
    sessionKey: Object.freeze({ type: 'string' }),
    job: Object.freeze({ type: 'object' }),
    results: Object.freeze({ type: 'array' }),
    activity: Object.freeze({ type: 'array' }),
    diagnostics: Object.freeze({ type: 'array' }),
    unavailableCapabilities: Object.freeze({ type: 'array' }),
    metadataSchemaVersion: Object.freeze({ type: ['integer', 'null'] }),
    path: Object.freeze({ type: 'string' }),
    text: Object.freeze({ type: 'string' }),
    revision: Object.freeze({ type: 'string' }),
    messages: Object.freeze({ type: 'array' }),
    topics: Object.freeze({ type: 'array' }),
    topic: Object.freeze({ type: ['object', 'null'] }),
    sourceReferences: Object.freeze({ type: 'array' }),
    preferences: Object.freeze({ type: ['object', 'null'] }),
    query: Object.freeze({ type: 'string' }),
    limit: Object.freeze({ type: 'integer' }),
    analysisId: Object.freeze({ type: 'string' }),
    observedRevision: Object.freeze({ type: ['string', 'null'] }),
    referenceId: Object.freeze({ type: 'string' }),
    topicId: Object.freeze({ type: 'string' }),
    sourceSystem: Object.freeze({ type: 'string' }),
    sourceKind: Object.freeze({ type: 'string' }),
    externalSourceId: Object.freeze({ type: 'string' }),
    version: Object.freeze({ const: 1 }),
    createdAt: Object.freeze({ type: 'string' }),
    updatedAt: Object.freeze({ type: 'string' }),
    sessionId: Object.freeze({ type: 'string' }),
    offset: Object.freeze({ type: 'integer' }),
    nextOffset: Object.freeze({ type: 'integer' }),
    hasMore: Object.freeze({ type: 'boolean' }),
    totalMessages: Object.freeze({ type: 'integer' }),
    completeSnapshot: Object.freeze({ type: 'boolean' }),
    defaults: Object.freeze({ type: 'object' }),
    sessionInfo: Object.freeze({ type: 'object' }),
    thinkingLevel: Object.freeze({ type: ['string', 'null'] }),
    fastMode: Object.freeze({ type: ['boolean', 'null'] }),
    toolOverrides: Object.freeze({ type: ['object', 'null'] }),
    verboseLevel: Object.freeze({ type: ['string', 'null'] }),
    inFlightRun: Object.freeze({ type: 'object' }),
    agentsList: Object.freeze({ type: 'array' }),
    metadata: Object.freeze({ type: 'object' })
  };
  const arrayResult = method.endsWith('notes.browse') || method.endsWith('reminders.list') || method.endsWith('schedules.list');
  const allowed = method.endsWith('sources.status')
    ? ['schemaVersion', 'mode', 'metadataSchemaVersion', 'diagnostics', 'unavailableCapabilities']
    : method.endsWith('notes.read')
    ? ['schemaVersion', 'path', 'text', 'revision', 'sourceReference']
    : method.endsWith('sessions.history')
    ? ['sessionKey', 'sessionId', 'messages', 'offset', 'nextOffset', 'hasMore', 'totalMessages', 'completeSnapshot', 'defaults', 'sessionInfo', 'thinkingLevel', 'fastMode', 'toolOverrides', 'verboseLevel', 'inFlightRun', 'agentsList', 'metadata']
    : method.endsWith('sessions.navigate')
    ? ['schemaVersion', 'status', 'sessionKey', 'sourceReference']
    : method.endsWith('schedules.get')
    ? ['schemaVersion', 'sourceReference', 'job']
    : method.endsWith('metadata.read')
    ? ['schemaVersion', 'topic', 'topics', 'sourceReferences', 'preferences', 'activity', 'version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt', 'updatedAt']
    : method.endsWith('search.query')
    ? ['schemaVersion', 'query', 'limit', 'results']
    : method.endsWith('analysis.read')
    ? ['status', 'analysisId', 'observedRevision']
    : ['schemaVersion', 'status', 'requestId', 'logicalOperationId', 'value', 'note', 'sourceReference', 'job', 'results', 'activity'];
  const itemProperties = Object.freeze(Object.fromEntries([
    'schemaVersion', 'path', 'revision', 'sourceReference', 'job'
  ].map((key) => [key, properties[key]])));
  return Object.freeze({
    type: arrayResult ? 'array' : 'object',
    additionalProperties: false,
    ...(arrayResult ? { items: Object.freeze({ type: 'object', additionalProperties: false, properties: itemProperties }) } : {
      properties: Object.freeze(Object.fromEntries(allowed.map((key) => [key, properties[key]])))
    })
  });
}
const required = Object.freeze({
  'command-center.v1.notes.browse': ['topicId'],
  'command-center.v1.notes.read': ['topicId'],
  'command-center.v1.notes.create': ['topicId'],
  'command-center.v1.notes.edit': ['topicId', 'expectedRevision'],
  'command-center.v1.notes.rename': ['topicId', 'expectedRevision'],
  'command-center.v1.notes.move': ['topicId', 'expectedRevision'],
  'command-center.v1.sessions.history': ['topicId'],
  'command-center.v1.sessions.navigate': ['topicId'],
  'command-center.v1.sessions.create': ['topicId'],
  'command-center.v1.sessions.send': ['topicId', 'message'],
  'command-center.v1.sessions.close': ['topicId'],
  'command-center.v1.sessions.reopen': ['topicId'],
  'command-center.v1.reminders.list': ['topicId'],
  'command-center.v1.reminders.snooze': ['topicId', 'expectedConfigRevision', 'patch'],
  'command-center.v1.reminders.complete': ['topicId', 'expectedConfigRevision'],
  'command-center.v1.schedules.list': ['topicId'],
  'command-center.v1.schedules.get': ['topicId'],
  'command-center.v1.schedules.create': ['topicId', 'referenceId', 'declaration'],
  'command-center.v1.schedules.update': ['topicId', 'expectedConfigRevision', 'patch'],
  'command-center.v1.schedules.set-enabled': ['topicId', 'expectedConfigRevision', 'enabled'],
  'command-center.v1.schedules.run': ['topicId'],
  'command-center.v1.analysis.read': ['topicId'],
  'command-center.v1.analysis.run': ['topicId', 'input'],
  'command-center.v1.attention.act': ['topicId', 'attentionId', 'actionId'],
  'command-center.v1.search.query': ['topicId', 'query'],
  'command-center.v1.metadata.write': ['operation', 'value']
});
const fields = Object.freeze({
  'command-center.v1.sources.status': [],
  'command-center.v1.notes.browse': ['topicId'],
  'command-center.v1.notes.read': ['topicId', 'path', 'notePath'],
  'command-center.v1.notes.create': ['topicId', 'path', 'notePath', 'text', 'content', 'logicalOperationId'],
  'command-center.v1.notes.edit': ['topicId', 'path', 'notePath', 'text', 'content', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.notes.rename': ['topicId', 'path', 'newPath', 'destinationPath', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.notes.move': ['topicId', 'sourcePath', 'path', 'destinationPath', 'newPath', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.sessions.history': ['topicId', 'referenceId', 'sessionReferenceId', 'limit', 'offset', 'messageId'],
  'command-center.v1.sessions.navigate': ['topicId', 'referenceId', 'sessionReferenceId'],
  'command-center.v1.sessions.create': ['topicId', 'label', 'isPrimary', 'logicalOperationId'],
  'command-center.v1.sessions.send': ['topicId', 'referenceId', 'sessionReferenceId', 'message', 'logicalOperationId'],
  'command-center.v1.sessions.close': ['topicId', 'referenceId', 'sessionReferenceId', 'isPrimary', 'logicalOperationId'],
  'command-center.v1.sessions.reopen': ['topicId', 'referenceId', 'sessionReferenceId', 'isPrimary', 'logicalOperationId'],
  'command-center.v1.reminders.list': ['topicId'],
  'command-center.v1.reminders.snooze': ['topicId', 'referenceId', 'scheduleReferenceId', 'expectedConfigRevision', 'patch', 'logicalOperationId'],
  'command-center.v1.reminders.complete': ['topicId', 'referenceId', 'scheduleReferenceId', 'expectedConfigRevision', 'logicalOperationId'],
  'command-center.v1.schedules.get': ['topicId', 'referenceId', 'scheduleReferenceId'],
  'command-center.v1.schedules.list': ['topicId'],
  'command-center.v1.schedules.create': ['topicId', 'referenceId', 'declaration', 'logicalOperationId'],
  'command-center.v1.schedules.update': ['topicId', 'referenceId', 'scheduleReferenceId', 'expectedConfigRevision', 'patch', 'logicalOperationId'],
  'command-center.v1.schedules.set-enabled': ['topicId', 'referenceId', 'scheduleReferenceId', 'expectedConfigRevision', 'enabled', 'logicalOperationId'],
  'command-center.v1.schedules.run': ['topicId', 'referenceId', 'scheduleReferenceId', 'logicalOperationId'],
  'command-center.v1.metadata.read': ['topicId', 'referenceId'],
  'command-center.v1.metadata.write': ['operation', 'value', 'logicalOperationId'],
  'command-center.v1.analysis.read': ['topicId'],
  'command-center.v1.analysis.run': ['topicId', 'input', 'logicalOperationId'],
  'command-center.v1.attention.act': ['topicId', 'attentionId', 'actionId', 'logicalOperationId'],
  'command-center.v1.search.query': ['topicId', 'query', 'limit']
});

export const BRIDGE_CONTRACTS = Object.freeze(Object.fromEntries([...READ_METHODS, ...WRITE_METHODS].map((method) => {
  const contractFields = [...common, ...(fields[method] ?? []), ...(WRITE_METHODS.includes(method) ? ['logicalOperationId'] : [])];
  const properties = Object.freeze(Object.fromEntries(
    contractFields.map((key) => [key, parameterSchema(key)])
  ));
  return [method, Object.freeze({
    method,
    version: 1,
    scope: READ_METHODS.includes(method) ? 'operator.read' : 'operator.write',
    closed: true,
    fields: Object.freeze(contractFields),
    paramsSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties,
      required: Object.freeze([
        'schemaVersion',
        ...(required[method] ?? []),
        ...(WRITE_METHODS.includes(method) ? ['logicalOperationId'] : [])
      ])
    }),
    resultSchema: Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ schemaVersion: Object.freeze({ const: 1 }), status: Object.freeze({ type: 'string' }), requestId: Object.freeze({ type: ['string', 'null'] }), logicalOperationId: Object.freeze({ type: ['string', 'null'] }), result: actionResultSchema(method) }), required: Object.freeze(['schemaVersion', 'status', 'requestId', 'logicalOperationId', 'result']) })
  })];
})));

export function validateBridgeRequest(method, params, { mutation = WRITE_METHODS.includes(method) } = {}) {
  const contract = BRIDGE_CONTRACTS[method];
  if (!contract) throw sourceError('invalid-request', 'Unsupported Command Center bridge method.');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw sourceError('invalid-request', 'Bridge request params must be an object.');
  for (const key of Object.keys(params)) if (!contract.fields.includes(key)) throw sourceError('invalid-request', `Unsupported bridge request field: ${key}`);
  if (params.schemaVersion !== 1) throw sourceError('unsupported-version', 'Bridge request schemaVersion must be 1.');
  for (const [key, schema] of Object.entries(contract.paramsSchema.properties)) {
    if (params[key] === undefined) continue;
    const expected = schema.type;
    const valid = expected === undefined
      || expected === 'integer' && Number.isInteger(params[key])
      || expected === 'object' && params[key] !== null && typeof params[key] === 'object' && !Array.isArray(params[key])
      || expected === 'array' && Array.isArray(params[key])
      || expected === typeof params[key];
    if (!valid) throw sourceError('invalid-request', `${key} must be a ${expected}.`);
    if (schema.minLength !== undefined && params[key].trim().length < schema.minLength) throw sourceError('invalid-request', `${key} must be a non-blank string.`);
    if (schema.minimum !== undefined && params[key] < schema.minimum) throw sourceError('invalid-request', `${key} must be at least ${schema.minimum}.`);
  }
  for (const key of required[method] ?? []) if (params[key] === undefined || params[key] === null || params[key] === '') throw sourceError('invalid-request', `Bridge request requires ${key}.`);
  const requiresPath = method.startsWith('command-center.v1.notes.') && !method.endsWith('.browse');
  if (requiresPath && !(typeof params.path === 'string' || typeof params.notePath === 'string' || typeof params.sourcePath === 'string')) throw sourceError('invalid-request', 'Bridge Note request requires a path.');
  if (['notes.create', 'notes.edit'].some((suffix) => method.endsWith(suffix)) && !(typeof params.text === 'string' || typeof params.content === 'string')) throw sourceError('invalid-request', 'Bridge Note request requires Markdown text.');
  if (method.endsWith('notes.rename') && !(typeof params.newPath === 'string' || typeof params.destinationPath === 'string')) throw sourceError('invalid-request', 'Bridge rename requires a destination path.');
  if (method.endsWith('notes.move') && !(typeof params.newPath === 'string' || typeof params.destinationPath === 'string')) throw sourceError('invalid-request', 'Bridge move requires a destination path.');
  if (method.includes('.sessions.') && !method.endsWith('.create') && !(typeof params.referenceId === 'string' || typeof params.sessionReferenceId === 'string')) throw sourceError('invalid-request', 'Bridge Session request requires an exact Source Reference.');
  if (method.endsWith('.metadata.read') && params.referenceId !== undefined && typeof params.topicId !== 'string') throw sourceError('invalid-request', 'Bridge metadata Source Reference reads require topicId ownership.');
  if ((method.includes('.reminders.') && !method.endsWith('.list')) || (method.includes('.schedules.') && !method.endsWith('.list') && !method.endsWith('.create'))) {
    if (!(typeof params.referenceId === 'string' || typeof params.scheduleReferenceId === 'string')) throw sourceError('invalid-request', 'Bridge scheduler request requires an exact Source Reference.');
  }
  if (params.enabled !== undefined && typeof params.enabled !== 'boolean') throw sourceError('invalid-request', 'enabled must be a boolean.');
  for (const key of ['patch', 'declaration', 'input', 'value']) if (params[key] !== undefined && (!params[key] || typeof params[key] !== 'object' || Array.isArray(params[key]))) throw sourceError('invalid-request', `${key} must be an object.`);
  if (method.endsWith('.schedules.create')) validateScheduleDeclaration(params.declaration);
  if (method.endsWith('.schedules.update')) validateScheduleUpdatePatch(params.patch);
  if (method.endsWith('.analysis.run') && Object.keys(params.input).length !== 0) throw sourceError('invalid-request', 'Topic Analysis input does not support caller-defined fields.');
  if (mutation && !isCanonicalUuid(params.logicalOperationId)) throw sourceError('invalid-request', 'Mutations require a canonical logicalOperationId.');
  return contract;
}

function matchesType(value, expected) {
  const choices = Array.isArray(expected) ? expected : [expected];
  return choices.some((type) => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : typeof value === type);
}

function sanitize(value, schema, field) {
  if (schema.const !== undefined && value !== schema.const) throw sourceError('source-recovery', `${field} returned an unsupported contract version.`);
  if (schema.type !== undefined && !matchesType(value, schema.type)) throw sourceError('source-recovery', `${field} returned an invalid result type.`);
  if (schema.type === 'array' && schema.items) return value.map((item, index) => sanitize(item, schema.items, `${field}[${index}]`));
  if (schema.type === 'object' && schema.properties) {
    const result = {};
    for (const [key, child] of Object.entries(schema.properties)) if (value[key] !== undefined) result[key] = sanitize(value[key], child, `${field}.${key}`);
    for (const key of schema.required ?? []) if (result[key] === undefined) throw sourceError('source-recovery', `${field} omitted required result field ${key}.`);
    return result;
  }
  return value;
}

function copyClosed(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('source-recovery', `${field} returned an invalid object.`);
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function sanitizeSourceReference(value) {
  return copyClosed(value, ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt', 'updatedAt'], 'Source Reference');
}

function sanitizeSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = value.kind === 'at' ? ['kind', 'at'] : value.kind === 'every' ? ['kind', 'everyMs', 'anchorMs'] : value.kind === 'cron' ? ['kind', 'expr', 'tz', 'staggerMs'] : ['kind'];
  return copyClosed(value, keys, 'Schedule');
}

function sanitizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = value.kind === 'systemEvent' ? ['kind', 'text'] : value.kind === 'agentTurn' ? ['kind', 'message', 'model', 'thinking'] : ['kind'];
  return copyClosed(value, keys, 'Schedule payload');
}

function sanitizeJob(value) {
  const result = copyClosed(value, ['id', 'declarationKey', 'displayName', 'owner', 'agentId', 'name', 'description', 'enabled', 'deleteAfterRun', 'createdAtMs', 'updatedAtMs', 'configRevision', 'schedule', 'payload', 'nextRunAtMs', 'lastRunAtMs', 'lastRunStatus', 'lastDelivered', 'lastDeliveryStatus'], 'Scheduler job');
  if (result.schedule !== undefined) result.schedule = sanitizeSchedule(result.schedule);
  if (result.payload !== undefined) result.payload = sanitizePayload(result.payload);
  return result;
}

function sanitizeNote(value) {
  const result = copyClosed(value, ['schemaVersion', 'path', 'text', 'revision', 'sourceReference'], 'Note');
  if (result.sourceReference !== undefined) result.sourceReference = sanitizeSourceReference(result.sourceReference);
  return result;
}

function sanitizeMutationValue(method, value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return value;
  const allowed = ['schemaVersion', 'status', 'logicalOperationId', 'key', 'sessionKey', 'sessionId', 'runId', 'referenceId', 'topicId', 'isPrimary', 'updatedAt', 'observedRevision', 'attentionId', 'actionId', 'analysisId', 'paraCategory', 'lifecycle', 'createdAt', 'displayLabel', 'sortOrder', 'collapsed', 'aspect', 'state', 'policyId', 'version', 'digest', 'proposalId', 'revision', 'note', 'sourceReference', 'job'];
  const result = copyClosed(value, allowed, `${method} mutation result`);
  if (result.note !== undefined) result.note = sanitizeNote(result.note);
  if (result.sourceReference !== undefined) result.sourceReference = sanitizeSourceReference(result.sourceReference);
  if (result.job !== undefined) result.job = sanitizeJob(result.job);
  return result;
}

export function sanitizeBridgeResult(method, result) {
  const contract = BRIDGE_CONTRACTS[method];
  if (!contract) throw sourceError('invalid-request', 'Unsupported Command Center bridge method.');
  const sanitized = sanitize(result, contract.resultSchema.properties.result, 'Bridge result');
  if (sanitized?.sourceReference !== undefined) sanitized.sourceReference = sanitizeSourceReference(sanitized.sourceReference);
  if (sanitized?.note !== undefined) sanitized.note = sanitizeNote(sanitized.note);
  if (sanitized?.job !== undefined) sanitized.job = sanitizeJob(sanitized.job);
  if (sanitized?.value !== undefined) sanitized.value = sanitizeMutationValue(method, sanitized.value);
  if (Array.isArray(sanitized)) return sanitized.map((item) => ({ ...item, ...(item.sourceReference === undefined ? {} : { sourceReference: sanitizeSourceReference(item.sourceReference) }), ...(item.job === undefined ? {} : { job: sanitizeJob(item.job) }) }));
  return sanitized;
}
