import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { sourceError } from '../sources/errors.mjs';
import { validateScheduleDeclaration, validateScheduleUpdatePatch } from '../sources/scheduler-input.mjs';

export const READ_METHODS = Object.freeze([
  'command-center.v1.sources.status',
  'command-center.v1.migration.status',
  'command-center.v1.migration.review-failures',
  'command-center.v1.topics.list',
  'command-center.v1.topics.get',
  'command-center.v1.topics.recovery.status',
  'command-center.v1.topics.structural-change.preview',
  'command-center.v1.topics.archive.preview',
  'command-center.v1.topics.restore.preview',
  'command-center.v1.topics.structural-preview',
  'command-center.v1.topics.archive-preview',
  'command-center.v1.notes.browse',
  'command-center.v1.notes.read',
  'command-center.v1.sessions.browse',
  'command-center.v1.sessions.history',
  'command-center.v1.sessions.navigate',
  'command-center.v1.reminders.list',
  'command-center.v1.schedules.list',
  'command-center.v1.schedules.get',
  'command-center.v1.metadata.read',
  'command-center.v1.analysis.read',
  'command-center.v1.search.query',
  'command-center.v1.attention.list',
  'command-center.v1.attention.get',
  'command-center.v1.activity.list',
  'command-center.v1.activity.get',
  'command-center.v1.dashboard.get'
]);

export const WRITE_METHODS = Object.freeze([
  'command-center.v1.migration.resume',
  'command-center.v1.reminders.create',
  'command-center.v1.topics.create',
  'command-center.v1.topics.provisioning.retry',
  'command-center.v1.topics.provisioning.rollback',
  'command-center.v1.topics.rename',
  'command-center.v1.topics.replace-primary-session',
  'command-center.v1.topics.structural-change.confirm',
  'command-center.v1.topics.archive.confirm',
  'command-center.v1.topics.restore.confirm',
  'command-center.v1.topics.recovery.verify',
  'command-center.v1.topics.recovery.relink',
  'command-center.v1.topics.recovery.replace',
  'command-center.v1.topics.retry',
  'command-center.v1.topics.rollback',
  'command-center.v1.topics.structural-confirm',
  'command-center.v1.topics.archive-confirm',
  'command-center.v1.topics.restore',
  'command-center.v1.topics.recovery-verify',
  'command-center.v1.topics.recovery-relink',
  'command-center.v1.topics.recovery-replace',
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
  'command-center.v1.analysis.run',
  'command-center.v1.search.prepare-rebuild'
]);

const common = ['schemaVersion'];
const stringFields = new Set(['topicId', 'referenceId', 'sourceReferenceId', 'sessionReferenceId', 'scheduleReferenceId', 'path', 'notePath', 'sourcePath', 'newPath', 'destinationPath', 'text', 'content', 'expectedConfigRevision', 'expectedSourceRevision', 'logicalOperationId', 'structuralChangeId', 'message', 'attentionId', 'episodeId', 'activityId', 'actionId', 'approvalId', 'query', 'operation', 'cursor', 'sourceCapabilityId', 'stableSubjectId', 'name', 'paraCategory', 'previewDigest', 'digest', 'kind', 'replacementLocator', 'sessionKey', 'sessionId']);
const objectFields = new Set(['patch', 'declaration', 'input', 'value', 'preview', 'authoritativeSession']);
const arrayFields = new Set(['expectedRevisions']);

function parameterSchema(field, method) {
  if (field === 'schemaVersion') return Object.freeze({ const: 1 });
  if (field === 'includeClosed' && method === 'command-center.v1.sessions.browse') return Object.freeze({ type: 'boolean' });
  if (field === 'expectedRevision') return Object.freeze({ type: method.includes('.topics.') ? 'integer' : 'string' });
  if (arrayFields.has(field)) return Object.freeze({ type: 'array' });
  if (stringFields.has(field)) return Object.freeze({ type: 'string', minLength: 1 });
  if (objectFields.has(field)) return Object.freeze({ type: 'object' });
  if (field === 'enabled' || field === 'isPrimary') return Object.freeze({ type: 'boolean' });
  if (field === 'limit') return Object.freeze({ type: 'integer', minimum: 1, maximum: 100 });
  if (field === 'offset') return Object.freeze({ type: 'integer', minimum: 0 });
  if (field === 'activityLimit') return Object.freeze({ type: 'integer', minimum: 1, maximum: 50 });
  if (field === 'activityOffset') return Object.freeze({ type: 'integer', minimum: 0 });
  if (field === 'expectedEpisodeRevision' || field === 'expectedMigrationRevision') return Object.freeze({ type: 'integer', minimum: 1 });
  return Object.freeze({ type: 'string' });
}

function actionResultSchema(method) {
  if (method === 'command-center.v1.search.query') {
    const sourceReference = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({
      version: { const: 1 }, referenceId: { type: 'string' }, topicId: { type: 'string' }, sourceSystem: { type: 'string' }, sourceKind: { type: 'string' }, externalSourceId: { type: 'string' }, observedRevision: { type: ['string', 'null'] }, createdAt: { type: ['string', 'null'] }, updatedAt: { type: ['string', 'null'] }
    }), required: ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'observedRevision', 'createdAt', 'updatedAt'] });
    const highlights = Object.freeze({ type: 'array', items: Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ start: { type: 'integer' }, end: { type: 'integer' } }), required: ['start', 'end'] }) });
    const noteNavigation = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ kind: { const: 'note' }, topicId: { type: 'string' }, referenceId: { type: 'string' }, path: { type: 'string' }, heading: { type: ['string', 'null'] }, observedRevision: { type: ['string', 'null'] } }), required: ['kind', 'topicId', 'referenceId', 'path', 'heading', 'observedRevision'] });
    const conversationNavigation = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ kind: { const: 'conversation' }, topicId: { type: 'string' }, referenceId: { type: 'string' }, sessionKey: { type: 'string' }, sessionId: { type: 'string' }, messageId: { type: ['string', 'null'] } }), required: ['kind', 'topicId', 'referenceId', 'sessionKey', 'sessionId', 'messageId'] });
    const shared = { topicId: { type: 'string' }, sourceReference, snippet: { type: 'string' }, highlights, contextBefore: { type: 'string' }, contextAfter: { type: 'string' } };
    const note = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ kind: { const: 'note' }, ...shared, path: { type: 'string' }, heading: { type: ['string', 'null'] }, navigation: noteNavigation }), required: ['kind', 'topicId', 'sourceReference', 'path', 'heading', 'snippet', 'highlights', 'contextBefore', 'contextAfter', 'navigation'] });
    const provenance = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ role: { enum: ['primary', 'former-primary', 'topic-conversation'] }, status: { enum: ['open', 'closed'] }, importedPrimaryHistory: { type: 'boolean' } }), required: ['role', 'status', 'importedPrimaryHistory'] });
    const conversation = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ kind: { const: 'conversation' }, ...shared, sessionKey: { type: 'string' }, messageId: { type: ['string', 'null'] }, conversationName: { type: 'string' }, date: { type: 'string' }, originatingTopicId: { type: ['string', 'null'] }, provenance, navigation: conversationNavigation }), required: ['kind', 'topicId', 'sourceReference', 'sessionKey', 'messageId', 'conversationName', 'date', 'originatingTopicId', 'snippet', 'highlights', 'contextBefore', 'contextAfter', 'provenance', 'navigation'] });
    const group = (items) => Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ results: { type: 'array', items } }), required: ['results'] });
    return Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ schemaVersion: { const: 1 }, topicId: { type: 'string' }, query: { type: 'string' }, notes: group(note), conversations: group(conversation) }), required: ['schemaVersion', 'topicId', 'query', 'notes', 'conversations'] });
  }
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
    activity: Object.freeze({ type: method === 'command-center.v1.attention.act' ? ['object', 'null'] : method === 'command-center.v1.dashboard.get' ? 'object' : 'array' }),
    diagnostics: Object.freeze({ type: 'array' }),
    unavailableCapabilities: Object.freeze({ type: 'array' }),
    metadataSchemaVersion: Object.freeze({ type: ['integer', 'null'] }),
    path: Object.freeze({ type: 'string' }),
    text: Object.freeze({ type: 'string' }),
    contentBase64: Object.freeze({ type: 'string' }),
    byteOffset: Object.freeze({ type: 'integer' }),
    totalBytes: Object.freeze({ type: 'integer' }),
    complete: Object.freeze({ type: 'boolean' }),
    revision: Object.freeze({ type: ['string', 'integer', 'null'] }),
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
    replacementReferenceId: Object.freeze({ type: 'string' }),
    topicId: Object.freeze({ type: 'string' }),
    sourceSystem: Object.freeze({ type: 'string' }),
    sourceKind: Object.freeze({ type: 'string' }),
    externalSourceId: Object.freeze({ type: 'string' }),
    version: Object.freeze({ const: 1 }),
    createdAt: Object.freeze({ type: 'string' }),
    updatedAt: Object.freeze({ type: 'string' }),
    sessionId: Object.freeze({ type: 'string' }),
    offset: Object.freeze({ type: 'integer' }),
    nextOffset: Object.freeze({ type: ['integer', 'null'] }),
    hasMore: Object.freeze({ type: 'boolean' }),
    totalMessages: Object.freeze({ type: 'integer' }),
    completeSnapshot: Object.freeze({ type: 'boolean' }),
    defaults: Object.freeze({ type: 'object' }),
    sessionInfo: Object.freeze({ type: 'object' }),
    conversations: Object.freeze({ type: 'array', items: Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ referenceId: { type: 'string' }, sessionId: { type: 'string' }, displayName: { type: 'string' }, status: { enum: ['open', 'closed'] }, isPrimary: { type: 'boolean' }, wasPrimary: { type: 'boolean' }, updatedAt: { type: 'string' } }), required: ['referenceId', 'sessionId', 'displayName', 'status', 'isPrimary', 'wasPrimary', 'updatedAt'] }) }),
    thinkingLevel: Object.freeze({ type: ['string', 'null'] }),
    fastMode: Object.freeze({ type: ['boolean', 'null'] }),
    toolOverrides: Object.freeze({ type: ['object', 'null'] }),
    verboseLevel: Object.freeze({ type: ['string', 'null'] }),
    inFlightRun: Object.freeze({ type: 'object' }),
    agentsList: Object.freeze({ type: 'array' }),
    metadata: Object.freeze({ type: 'object' }),
    activeGroups: Object.freeze({ type: 'object' }),
    provisioning: Object.freeze({ type: 'array' }),
    recovery: Object.freeze({ type: ['array', 'object'] }),
    archived: Object.freeze({ type: 'array' }),
    retired: Object.freeze({ type: 'array' }),
    preview: Object.freeze({ type: 'object' }),
    enabled: Object.freeze({ type: 'boolean' }),
    complete: Object.freeze({ type: 'boolean' }),
    phase: Object.freeze({ type: 'string' }),
    actions: Object.freeze({ type: 'array' }),
    channels: Object.freeze({ type: 'array' }),
    failures: Object.freeze({ type: 'array' }),
    migrationRevision: Object.freeze({ type: 'integer' }),
    completion: Object.freeze({ type: 'object' }),
    episode: Object.freeze({ type: method === 'command-center.v1.attention.get' ? ['object', 'null'] : 'object' }),
    buckets: Object.freeze({ type: 'array' }),
    episodes: Object.freeze({ type: 'array' }),
    inProgress: Object.freeze({ type: 'array' }),
    records: Object.freeze({ type: 'array' }),
    record: Object.freeze({ type: ['object', 'null'] }),
    cursor: Object.freeze({ type: ['string', 'null'] }),
    attempt: Object.freeze({ type: ['object', 'null'] }),
    navigation: Object.freeze({ type: ['object', 'null'] }),
    approval: Object.freeze({ type: ['object', 'null'] }),
    serverTime: Object.freeze({ type: 'string' }),
    attention: Object.freeze({ type: 'array' }),
    attentionBadgeCount: Object.freeze({ type: 'integer' }),
    comingUp: Object.freeze({ type: 'array' }),
    activityOffset: Object.freeze({ type: 'integer' }),
    activityLimit: Object.freeze({ type: 'integer' }),
    notificationSettings: Object.freeze({ type: 'object' }),
    topicIds: Object.freeze({ type: 'array' })
  };
  const arrayResult = method.endsWith('notes.browse') || method.endsWith('reminders.list') || method.endsWith('schedules.list');
  const allowed = method.includes('.migration.')
    ? ['schemaVersion', 'enabled', 'phase', 'complete', 'actions', 'channels', 'failures', 'completion', 'migrationRevision']
    : method.endsWith('sources.status')
    ? ['schemaVersion', 'mode', 'metadataSchemaVersion', 'diagnostics', 'unavailableCapabilities']
    : method.endsWith('notes.read')
    ? ['schemaVersion', 'path', 'contentBase64', 'byteOffset', 'nextOffset', 'totalBytes', 'revision', 'complete', 'sourceReference']
    : method.endsWith('sessions.history')
    ? ['sessionKey', 'sessionId', 'messages', 'offset', 'nextOffset', 'hasMore', 'totalMessages', 'completeSnapshot', 'defaults', 'sessionInfo', 'thinkingLevel', 'fastMode', 'toolOverrides', 'verboseLevel', 'inFlightRun', 'agentsList', 'metadata']
    : method.endsWith('sessions.browse')
      ? ['schemaVersion', 'topicId', 'conversations']
    : method.endsWith('sessions.navigate')
    ? ['schemaVersion', 'status', 'sessionKey', 'sessionId', 'sourceReference']
    : method.endsWith('schedules.get')
    ? ['schemaVersion', 'sourceReference', 'job']
    : method.endsWith('metadata.read')
    ? ['schemaVersion', 'topic', 'topics', 'sourceReferences', 'preferences', 'activity', 'version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt', 'updatedAt']
    : method.endsWith('search.query')
    ? ['schemaVersion', 'query', 'limit', 'results']
    : method.endsWith('search.prepare-rebuild')
    ? ['schemaVersion', 'status', 'topicIds']
    : method.endsWith('topics.list')
    ? ['schemaVersion', 'activeGroups', 'provisioning', 'recovery', 'archived', 'retired']
    : method.endsWith('topics.get')
    ? ['schemaVersion', 'topic']
    : method.endsWith('topics.recovery.status')
    ? ['schemaVersion', 'recovery']
    : method.endsWith('topics.structural-change.preview') || method.endsWith('topics.archive.preview') || method.endsWith('topics.restore.preview') || method.endsWith('topics.structural-preview') || method.endsWith('topics.archive-preview')
    ? ['schemaVersion', 'preview']
    : method.endsWith('topics.recovery.verify') || method.endsWith('topics.recovery.relink') || method.endsWith('topics.recovery.replace') || method.endsWith('topics.recovery-verify') || method.endsWith('topics.recovery-relink') || method.endsWith('topics.recovery-replace')
    ? ['schemaVersion', 'status', 'replacementReferenceId', 'recovery']
    : method.endsWith('attention.list')
    ? ['schemaVersion', 'revision', 'buckets', 'episodes', 'inProgress']
    : method.endsWith('attention.get')
    ? ['schemaVersion', 'revision', 'episode']
    : method.endsWith('activity.list')
    ? ['schemaVersion', 'records', 'nextOffset', 'hasMore']
    : method.endsWith('activity.get')
    ? ['schemaVersion', 'record']
    : method.endsWith('dashboard.get')
    ? ['schemaVersion', 'serverTime', 'attention', 'attentionBadgeCount', 'inProgress', 'comingUp', 'topics', 'activity', 'activityOffset', 'activityLimit', 'notificationSettings']
    : method.endsWith('analysis.read')
    ? ['status', 'analysisId', 'observedRevision']
    : ['schemaVersion', 'status', 'requestId', 'logicalOperationId', 'value', 'note', 'sourceReference', 'job', 'results', 'activity', 'episode', 'attempt', 'navigation', 'approval'];
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
  'command-center.v1.migration.status': [],
  'command-center.v1.migration.review-failures': [],
  'command-center.v1.migration.resume': ['expectedMigrationRevision'],
  'command-center.v1.topics.structural-preview': ['topicId', 'paraCategory'],
  'command-center.v1.topics.archive-preview': ['topicId'],
  'command-center.v1.topics.retry': ['topicId'],
  'command-center.v1.topics.rollback': ['topicId'],
  'command-center.v1.topics.structural-confirm': ['topicId', 'paraCategory', 'structuralChangeId', 'previewDigest'],
  'command-center.v1.topics.archive-confirm': ['topicId', 'structuralChangeId', 'previewDigest'],
  'command-center.v1.topics.restore': ['topicId', 'paraCategory', 'structuralChangeId', 'previewDigest'],
  'command-center.v1.topics.recovery-verify': ['topicId', 'referenceId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.recovery-relink': ['topicId', 'referenceId', 'sessionKey', 'sessionId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.recovery-replace': ['topicId', 'referenceId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.get': ['topicId'],
  'command-center.v1.topics.recovery.status': ['topicId', 'referenceId'],
  'command-center.v1.topics.create': ['topicId', 'name', 'paraCategory', 'authoritativeSession'],
  'command-center.v1.topics.replace-primary-session': ['topicId', 'expectedRevision'],
  'command-center.v1.topics.provisioning.retry': ['topicId', 'expectedRevision'],
  'command-center.v1.topics.provisioning.rollback': ['topicId', 'expectedRevision'],
  'command-center.v1.topics.rename': ['topicId', 'name', 'expectedRevision'],
  'command-center.v1.topics.structural-change.preview': ['topicId', 'paraCategory', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.topics.structural-change.confirm': ['topicId', 'structuralChangeId', 'previewDigest', 'expectedRevision'],
  'command-center.v1.topics.archive.preview': ['topicId', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.topics.archive.confirm': ['topicId', 'structuralChangeId', 'previewDigest', 'expectedRevision'],
  'command-center.v1.topics.restore.preview': ['topicId', 'paraCategory', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.topics.restore.confirm': ['topicId', 'structuralChangeId', 'previewDigest', 'expectedRevision'],
  'command-center.v1.topics.recovery.verify': ['topicId', 'referenceId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.recovery.relink': ['topicId', 'referenceId', 'sessionKey', 'sessionId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.recovery.replace': ['topicId', 'referenceId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.notes.browse': ['topicId'],
  'command-center.v1.notes.read': ['topicId', 'referenceId', 'offset'],
  'command-center.v1.notes.create': ['topicId', 'referenceId'],
  'command-center.v1.notes.edit': ['topicId', 'referenceId', 'expectedRevision'],
  'command-center.v1.notes.rename': ['topicId', 'referenceId', 'expectedRevision'],
  'command-center.v1.notes.move': ['topicId', 'referenceId', 'expectedRevision'],
  'command-center.v1.sessions.history': ['topicId', 'referenceId'],
  'command-center.v1.sessions.browse': ['topicId'],
  'command-center.v1.sessions.navigate': ['topicId', 'referenceId'],
  'command-center.v1.sessions.create': ['topicId', 'authoritativeSession'],
  'command-center.v1.sessions.send': ['topicId', 'referenceId', 'message'],
  'command-center.v1.sessions.close': ['topicId', 'referenceId'],
  'command-center.v1.sessions.reopen': ['topicId', 'referenceId'],
  'command-center.v1.reminders.list': ['topicId'],
  'command-center.v1.reminders.create': ['topicId', 'declaration'],
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
  'command-center.v1.attention.act': ['topicId', 'sourceReferenceId', 'episodeId', 'expectedEpisodeRevision', 'expectedSourceRevision', 'actionId'],
  'command-center.v1.search.query': ['topicId', 'query'],
  'command-center.v1.search.prepare-rebuild': ['topicId', 'logicalOperationId'],
  'command-center.v1.metadata.write': ['operation', 'value'],
  'command-center.v1.attention.list': [],
  'command-center.v1.attention.get': ['episodeId'],
  'command-center.v1.activity.list': [],
  'command-center.v1.activity.get': ['activityId'],
  'command-center.v1.dashboard.get': ['activityOffset', 'activityLimit']
});
const fields = Object.freeze({
  'command-center.v1.migration.status': [],
  'command-center.v1.migration.review-failures': [],
  'command-center.v1.migration.resume': ['expectedMigrationRevision'],
  'command-center.v1.topics.structural-preview': ['topicId', 'paraCategory'],
  'command-center.v1.topics.archive-preview': ['topicId'],
  'command-center.v1.topics.retry': ['topicId'],
  'command-center.v1.topics.rollback': ['topicId'],
  'command-center.v1.topics.structural-confirm': ['topicId', 'paraCategory', 'structuralChangeId', 'previewDigest', 'expectedRevisions'],
  'command-center.v1.topics.archive-confirm': ['topicId', 'structuralChangeId', 'previewDigest', 'expectedRevisions'],
  'command-center.v1.topics.restore': ['topicId', 'paraCategory', 'structuralChangeId', 'previewDigest', 'expectedRevisions'],
  'command-center.v1.topics.recovery-verify': ['topicId', 'referenceId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.recovery-relink': ['topicId', 'referenceId', 'sessionKey', 'sessionId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.recovery-replace': ['topicId', 'referenceId', 'replacementLocator', 'sessionKey', 'sessionId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.list': [],
  'command-center.v1.topics.get': ['topicId'],
  'command-center.v1.topics.recovery.status': ['topicId', 'referenceId'],
  'command-center.v1.topics.create': ['topicId', 'name', 'paraCategory', 'authoritativeSession'],
  'command-center.v1.topics.replace-primary-session': ['topicId', 'expectedRevision'],
  'command-center.v1.topics.provisioning.retry': ['topicId', 'expectedRevision'],
  'command-center.v1.topics.provisioning.rollback': ['topicId', 'expectedRevision'],
  'command-center.v1.topics.rename': ['topicId', 'name', 'expectedRevision'],
  'command-center.v1.topics.structural-change.preview': ['topicId', 'paraCategory', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.topics.structural-change.confirm': ['topicId', 'paraCategory', 'structuralChangeId', 'previewDigest', 'expectedRevision', 'expectedRevisions'],
  'command-center.v1.topics.archive.preview': ['topicId', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.topics.archive.confirm': ['topicId', 'structuralChangeId', 'previewDigest', 'expectedRevision', 'expectedRevisions'],
  'command-center.v1.topics.restore.preview': ['topicId', 'paraCategory', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.topics.restore.confirm': ['topicId', 'paraCategory', 'structuralChangeId', 'previewDigest', 'expectedRevision', 'expectedRevisions'],
  'command-center.v1.topics.recovery.verify': ['topicId', 'referenceId', 'replacementLocator', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.recovery.relink': ['topicId', 'referenceId', 'sessionKey', 'sessionId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.topics.recovery.replace': ['topicId', 'referenceId', 'replacementLocator', 'sessionKey', 'sessionId', 'expectedRevision', 'expectedSourceRevision'],
  'command-center.v1.sources.status': [],
  'command-center.v1.notes.browse': ['topicId'],
  'command-center.v1.notes.read': ['topicId', 'referenceId', 'path', 'notePath', 'offset', 'observedRevision'],
  'command-center.v1.notes.create': ['topicId', 'referenceId', 'path', 'notePath', 'text', 'content', 'logicalOperationId'],
  'command-center.v1.notes.edit': ['topicId', 'referenceId', 'path', 'notePath', 'text', 'content', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.notes.rename': ['topicId', 'referenceId', 'path', 'newPath', 'destinationPath', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.notes.move': ['topicId', 'referenceId', 'sourcePath', 'path', 'destinationPath', 'newPath', 'expectedRevision', 'logicalOperationId'],
  'command-center.v1.sessions.history': ['topicId', 'referenceId', 'sessionReferenceId', 'limit', 'offset', 'messageId'],
  'command-center.v1.sessions.browse': ['topicId', 'includeClosed'],
  'command-center.v1.sessions.navigate': ['topicId', 'referenceId', 'sessionReferenceId'],
  'command-center.v1.sessions.create': ['topicId', 'label', 'isPrimary', 'logicalOperationId', 'authoritativeSession'],
  'command-center.v1.sessions.send': ['topicId', 'referenceId', 'message', 'logicalOperationId'],
  'command-center.v1.sessions.close': ['topicId', 'referenceId', 'sessionReferenceId', 'isPrimary', 'logicalOperationId'],
  'command-center.v1.sessions.reopen': ['topicId', 'referenceId', 'sessionReferenceId', 'isPrimary', 'logicalOperationId'],
  'command-center.v1.reminders.list': ['topicId'],
  'command-center.v1.reminders.create': ['topicId', 'declaration', 'logicalOperationId'],
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
  'command-center.v1.attention.act': ['topicId', 'sourceCapabilityId', 'stableSubjectId', 'episodeId', 'expectedEpisodeRevision', 'expectedSourceRevision', 'sourceReferenceId', 'actionId', 'input', 'approvalId', 'logicalOperationId'],
  'command-center.v1.search.query': ['topicId', 'query', 'limit'],
  'command-center.v1.search.prepare-rebuild': ['topicId', 'logicalOperationId'],
  'command-center.v1.attention.list': ['topicId', 'limit'],
  'command-center.v1.attention.get': ['episodeId'],
  'command-center.v1.activity.list': ['topicId', 'episodeId', 'offset', 'limit'],
  'command-center.v1.activity.get': ['activityId'],
  'command-center.v1.dashboard.get': ['activityOffset', 'activityLimit']
});

export const BRIDGE_CONTRACTS = Object.freeze(Object.fromEntries([...READ_METHODS, ...WRITE_METHODS].map((method) => {
  const contractFields = [...common, ...(fields[method] ?? []), ...(WRITE_METHODS.includes(method) ? ['logicalOperationId'] : [])];
  const properties = Object.freeze(Object.fromEntries(
    contractFields.map((key) => [key, parameterSchema(key, method)])
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
    const expectedTypes = Array.isArray(expected) ? expected : [expected];
    const valid = expected === undefined
      || expectedTypes.includes('integer') && Number.isInteger(params[key])
      || expectedTypes.includes(typeof params[key])
      || expected === 'object' && params[key] !== null && typeof params[key] === 'object' && !Array.isArray(params[key])
      || expected === 'array' && Array.isArray(params[key])
      || expected === typeof params[key];
    if (!valid) throw sourceError('invalid-request', `${key} must be a ${expected}.`);
    if (schema.enum && !schema.enum.includes(params[key])) throw sourceError('invalid-request', `${key} must be one of ${schema.enum.join(', ')}.`);
    if (schema.minLength !== undefined && params[key].trim().length < schema.minLength) throw sourceError('invalid-request', `${key} must be a non-blank string.`);
    if (schema.minimum !== undefined && params[key] < schema.minimum) throw sourceError('invalid-request', `${key} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && params[key] > schema.maximum) throw sourceError('invalid-request', `${key} must be at most ${schema.maximum}.`);
  }
  for (const key of required[method] ?? []) if (params[key] === undefined || params[key] === null || params[key] === '') throw sourceError('invalid-request', ['referenceId'].includes(key) && method.includes('.sessions.') ? 'Bridge Session request requires an exact Source Reference.' : `Bridge request requires ${key}.`);
  const requiresPath = method.startsWith('command-center.v1.notes.') && !method.endsWith('.browse');
  if (requiresPath && !(typeof params.path === 'string' || typeof params.notePath === 'string' || typeof params.sourcePath === 'string')) throw sourceError('invalid-request', 'Bridge Note request requires a path.');
  if (['notes.create', 'notes.edit'].some((suffix) => method.endsWith(suffix)) && !(typeof params.text === 'string' || typeof params.content === 'string')) throw sourceError('invalid-request', 'Bridge Note request requires Markdown text.');
  if (method.endsWith('notes.rename') && !(typeof params.newPath === 'string' || typeof params.destinationPath === 'string')) throw sourceError('invalid-request', 'Bridge rename requires a destination path.');
  if (method.endsWith('notes.move') && !(typeof params.newPath === 'string' || typeof params.destinationPath === 'string')) throw sourceError('invalid-request', 'Bridge move requires a destination path.');
  if (method.includes('.sessions.') && !method.endsWith('.create') && !method.endsWith('.browse') && !(typeof params.referenceId === 'string' || typeof params.sessionReferenceId === 'string')) throw sourceError('invalid-request', 'Bridge Session request requires an exact Source Reference.');
  if (method.endsWith('.metadata.read') && params.referenceId !== undefined && typeof params.topicId !== 'string') throw sourceError('invalid-request', 'Bridge metadata Source Reference reads require topicId ownership.');
  if ((method.includes('.reminders.') && !method.endsWith('.list') && !method.endsWith('.create')) || (method.includes('.schedules.') && !method.endsWith('.list') && !method.endsWith('.create'))) {
    if (!(typeof params.referenceId === 'string' || typeof params.scheduleReferenceId === 'string')) throw sourceError('invalid-request', 'Bridge scheduler request requires an exact Source Reference.');
  }
  if (params.enabled !== undefined && typeof params.enabled !== 'boolean') throw sourceError('invalid-request', 'enabled must be a boolean.');
  for (const key of ['patch', 'declaration', 'input', 'value']) if (params[key] !== undefined && (!params[key] || typeof params[key] !== 'object' || Array.isArray(params[key]))) throw sourceError('invalid-request', `${key} must be an object.`);
  if (params.authoritativeSession !== undefined) {
    const session = params.authoritativeSession;
    if (!session || typeof session !== 'object' || Array.isArray(session)) throw sourceError('invalid-request', 'authoritativeSession must be an object.');
    const allowed = ['key', 'sessionId', 'revision', 'idempotencyKey', 'label'];
    for (const key of Object.keys(session)) if (!allowed.includes(key)) throw sourceError('invalid-request', `Unsupported authoritativeSession field: ${key}`);
    for (const key of allowed) if (typeof session[key] !== 'string' || session[key].trim() === '') throw sourceError('invalid-request', `authoritativeSession.${key} must be a non-blank string.`);
    if (session.idempotencyKey !== params.logicalOperationId) throw sourceError('invalid-request', 'The authoritative Session idempotency key must match logicalOperationId.');
    const expectedLabel = method.endsWith('topics.create') ? params.name : params.label;
    if (session.label !== expectedLabel) throw sourceError('invalid-request', 'The authoritative Session label must match the requested label.');
  }
  if (method.endsWith('topics.create') && !isCanonicalUuid(params.topicId)) throw sourceError('invalid-request', 'Topic creation requires a canonical topicId.');
  if (method.endsWith('.schedules.create')) validateScheduleDeclaration(params.declaration);
  if (method.endsWith('.schedules.update')) validateScheduleUpdatePatch(params.patch);
  if (method.endsWith('.analysis.run') && Object.keys(params.input).length !== 0) throw sourceError('invalid-request', 'Topic Analysis input does not support caller-defined fields.');
  if (method.endsWith('.attention.act') && ['approval.approve', 'approval.reject'].includes(params.actionId) && (typeof params.approvalId !== 'string' || params.approvalId.trim() === '')) throw sourceError('invalid-request', 'Approval decisions require the exact approvalId.');
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

function sanitizeTopicSourceReference(value) {
  return copyClosed(value, ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'observedRevision', 'createdAt', 'updatedAt'], 'Topic Source Reference');
}

function sanitizeTopicLocator(value) {
  return copyClosed(value, ['referenceId', 'locatorVersion', 'ownership', 'observedRevision', 'createdAt', 'updatedAt'], 'Topic Source locator');
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

function sanitizeRecovery(value) {
  const result = copyClosed(value, ['recoveryId', 'topicId', 'referenceId', 'sourceKind', 'state', 'diagnostics', 'expectedRevision', 'createdAt', 'updatedAt'], 'Source Recovery');
  if (Array.isArray(result.diagnostics)) result.diagnostics = result.diagnostics.map((diagnostic) => ({
    topicId: result.topicId,
    referenceId: result.referenceId,
    sourceKind: result.sourceKind,
    expectedIdentity: result.sourceKind === 'note_folder' ? 'exact Note Folder identity' : 'exact Primary Session identity',
    check: String(diagnostic?.check ?? 'exact-identity').slice(0, 80),
    status: result.state === 'required' ? 'recovery-required' : 'verified',
    retryable: result.state === 'required'
  }));
  return result;
}

function sanitizeTopic(value) {
  const result = copyClosed(value, ['topicId', 'name', 'revision', 'paraCategory', 'lifecycle', 'health', 'usable', 'noteFolderReferenceId', 'provisioningOperationId', 'recovery', 'sourceReferences', 'locators', 'activatedAt', 'createdAt', 'updatedAt'], 'Topic');
  if (Array.isArray(result.recovery)) result.recovery = result.recovery.map(sanitizeRecovery);
  if (Array.isArray(result.sourceReferences)) result.sourceReferences = result.sourceReferences.map(sanitizeTopicSourceReference);
  if (Array.isArray(result.locators)) result.locators = result.locators.map(sanitizeTopicLocator);
  return result;
}

const publicParaCategories = new Set(['project', 'area', 'resource', 'archive']);

function sanitizePreviewChange(change = {}) {
  if (change.aspect === 'note-folder-location') return { aspect: change.aspect, ...(change.managed === undefined ? {} : { managed: change.managed }), fromConvention: 'current-managed', toConvention: 'target-conventional' };
  if (change.aspect === 'category' && publicParaCategories.has(change.from) && publicParaCategories.has(change.to)) return copyClosed(change, ['aspect', 'from', 'to', 'managed'], 'Structural Change change');
  return copyClosed(change, ['aspect', 'managed'], 'Structural Change change');
}

function sanitizePreview(value) {
  const result = copyClosed(value, ['kind', 'topicId', 'structuralChangeId', 'from', 'to', 'expectedRevisions', 'changes', 'commitments', 'policy', 'digest'], 'Structural Change preview');
  if (!publicParaCategories.has(result.from)) delete result.from;
  if (!publicParaCategories.has(result.to)) delete result.to;
  if (Array.isArray(result.expectedRevisions)) result.expectedRevisions = result.expectedRevisions.map((revision) => copyClosed(revision, ['source', 'id', 'revision'], 'Expected revision'));
  if (Array.isArray(result.changes)) result.changes = result.changes.map(sanitizePreviewChange);
  if (Array.isArray(result.commitments)) result.commitments = result.commitments.map((commitment) => copyClosed(commitment, ['referenceId', 'revision', 'kind', 'enabled', 'disposition'], 'Archive commitment'));
  return result;
}

function sanitizeGroups(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('source-recovery', 'Topic groups returned an invalid object.');
  return Object.fromEntries(['project', 'area', 'resource'].map((category) => [category, Array.isArray(value[category]) ? value[category].map(sanitizeTopic) : []]));
}

function sanitizeMutationValue(method, value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return value;
  const allowed = ['schemaVersion', 'status', 'logicalOperationId', 'key', 'sessionKey', 'sessionId', 'runId', 'referenceId', 'replacementReferenceId', 'topicId', 'isPrimary', 'updatedAt', 'observedRevision', 'attentionId', 'actionId', 'analysisId', 'paraCategory', 'lifecycle', 'createdAt', 'displayLabel', 'sortOrder', 'collapsed', 'aspect', 'state', 'policyId', 'version', 'digest', 'proposalId', 'revision', 'name', 'usable', 'topic', 'recovery', 'sourceReferences', 'locators', 'result', 'note', 'sourceReference', 'job'];
  const result = copyClosed(value, allowed, `${method} mutation result`);
  if (result.topic && typeof result.topic === 'object') result.topic = sanitizeTopic(result.topic);
  if (Array.isArray(result.recovery)) result.recovery = result.recovery.map(sanitizeRecovery);
  if (Array.isArray(result.sourceReferences)) result.sourceReferences = result.sourceReferences.map(method.includes('.topics.') ? sanitizeTopicSourceReference : sanitizeSourceReference);
  if (Array.isArray(result.locators)) result.locators = result.locators.map(method.includes('.topics.') ? sanitizeTopicLocator : (locator) => copyClosed(locator, ['referenceId', 'locatorVersion', 'locator', 'ownership', 'observedRevision', 'createdAt', 'updatedAt'], 'Source locator'));
  if (result.note !== undefined) result.note = sanitizeNote(result.note);
  if (result.sourceReference !== undefined) result.sourceReference = method.includes('.topics.') ? sanitizeTopicSourceReference(result.sourceReference) : sanitizeSourceReference(result.sourceReference);
  if (result.job !== undefined) result.job = sanitizeJob(result.job);
  return result;
}

function sanitizeAttentionEpisode(value) {
  const result = copyClosed(value, ['episodeId', 'generation', 'sourceCapabilityId', 'stableSubjectId', 'attentionReason', 'state', 'severity', 'attentionSince', 'occurredAt', 'terminalAt', 'snoozedUntil', 'revision', 'sourceRevision', 'topicId', 'sourceReferenceId', 'diagnosis', 'evidenceFacts', 'updatedAt', 'createdAt', 'sourceKind', 'due', 'actions', 'eligibleSnoozeChoices', 'notificationEligible'], 'Attention episode');
  if (result.diagnosis !== undefined) result.diagnosis = copyClosed(result.diagnosis, ['reason'], 'Attention diagnosis');
  if (result.evidenceFacts !== undefined) result.evidenceFacts = copyClosed(result.evidenceFacts, ['facts', 'due', 'dueAt', 'reminderDue', 'actionOutcome'], 'Attention evidence');
  if (result.actions !== undefined) result.actions = result.actions.slice(0, 3).map((action) => copyClosed(action, ['actionId', 'label', 'kind', 'target', 'parameterSchema', 'sideEffects', 'approvalMode', 'idempotency'], 'Attention action'));
  return result;
}

const activityKeys = ['activityId', 'episodeId', 'logicalOperationId', 'attemptId', 'topicId', 'sourceReferenceId', 'actorMode', 'actionId', 'operationKind', 'outcome', 'verificationRevision', 'occurredAt'];

function sanitizeAttentionValue(method, value) {
  if (method.endsWith('attention.act')) {
    const result = copyClosed(value, ['schemaVersion', 'status', 'episode', 'attempt', 'activity', 'navigation', 'approval'], 'Attention action result');
    if (result.episode != null) result.episode = sanitizeAttentionEpisode(result.episode);
    if (result.attempt != null) result.attempt = copyClosed(result.attempt, ['attemptId', 'episodeId', 'logicalOperationId', 'actionId', 'expectedEpisodeRevision', 'expectedSourceRevision', 'retryCount', 'state', 'outcome', 'verificationRevision', 'createdAt', 'updatedAt'], 'Attention attempt');
    if (result.activity != null) result.activity = copyClosed(result.activity, activityKeys, 'Activity record');
    return result;
  }
  if (method.endsWith('attention.get')) return { ...copyClosed(value, ['schemaVersion', 'revision', 'episode'], 'Attention get result'), episode: value.episode === null ? null : sanitizeAttentionEpisode(value.episode) };
  if (method.endsWith('attention.list')) return { ...copyClosed(value, ['schemaVersion', 'revision', 'buckets', 'episodes', 'inProgress'], 'Attention list result'), buckets: value.buckets.map((bucket) => bucket.map(sanitizeAttentionEpisode)), episodes: value.episodes.map(sanitizeAttentionEpisode), inProgress: (value.inProgress ?? []).map(sanitizeAttentionEpisode) };
  if (method.endsWith('activity.get')) return { ...copyClosed(value, ['schemaVersion', 'record'], 'Activity get result'), record: value.record === null ? null : copyClosed(value.record, activityKeys, 'Activity record') };
  if (method.endsWith('activity.list')) return { ...copyClosed(value, ['schemaVersion', 'records', 'nextOffset', 'hasMore'], 'Activity list result'), records: value.records.map((record) => copyClosed(record, activityKeys, 'Activity record')) };
  return value;
}

export function sanitizeBridgeResult(method, result) {
  const contract = BRIDGE_CONTRACTS[method];
  if (!contract) throw sourceError('invalid-request', 'Unsupported Command Center bridge method.');
  const sanitized = sanitize(result, contract.resultSchema.properties.result, 'Bridge result');
  if (sanitized?.topic !== undefined) sanitized.topic = sanitizeTopic(sanitized.topic);
  if (sanitized?.activeGroups !== undefined) sanitized.activeGroups = sanitizeGroups(sanitized.activeGroups);
  for (const key of ['provisioning', 'archived', 'retired']) if (Array.isArray(sanitized?.[key])) sanitized[key] = sanitized[key].map(sanitizeTopic);
  if (Array.isArray(sanitized?.recovery)) sanitized.recovery = sanitized.recovery.map(sanitizeTopic);
  if (sanitized?.preview !== undefined) sanitized.preview = sanitizePreview(sanitized.preview);
  if (sanitized?.recovery !== undefined && !Array.isArray(sanitized.recovery)) sanitized.recovery = sanitizeRecovery(sanitized.recovery);
  if (sanitized?.sourceReference !== undefined) sanitized.sourceReference = sanitizeSourceReference(sanitized.sourceReference);
  if (sanitized?.note !== undefined) sanitized.note = sanitizeNote(sanitized.note);
  if (sanitized?.job !== undefined) sanitized.job = sanitizeJob(sanitized.job);
  if (sanitized?.value !== undefined) sanitized.value = sanitizeMutationValue(method, sanitized.value);
  if (method.includes('.attention.') || method.includes('.activity.')) return sanitizeAttentionValue(method, sanitized);
  if (Array.isArray(sanitized)) return sanitized.map((item) => ({ ...item, ...(item.sourceReference === undefined ? {} : { sourceReference: sanitizeSourceReference(item.sourceReference) }), ...(item.job === undefined ? {} : { job: sanitizeJob(item.job) }) }));
  return sanitized;
}
