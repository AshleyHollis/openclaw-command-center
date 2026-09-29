import { createHash } from 'node:crypto';

export const DEVELOPER_EVENT_SCHEMA_VERSION = 1;
export const DEVELOPER_EVENT_MAX_BYTES = 16 * 1024;

const humanTypes = new Map([
  ['human_input_required', 'input'],
  ['product_decision_required', 'product-decision'],
  ['approval_required', 'approval'],
  ['feature_ready_for_review', 'review']
]);
const controllerTypes = new Set(['production_deployment_failed', 'production_rollback', 'production_recovered']);
const terminalTypes = new Set(['request_resolved', 'request_withdrawn']);
const activityTypes = new Set(['feature_completed', 'deployment_succeeded', 'validation_completed']);
const eventTypes = new Set([...humanTypes.keys(), ...controllerTypes, ...terminalTypes, ...activityTypes]);
const outcomeCodes = new Map([
  ['production_deployment_failed', new Set(['failed'])],
  ['production_rollback', new Set(['rolled-back', 'rollback-failed'])],
  ['production_recovered', new Set(['recovered'])],
  ['request_resolved', new Set(['answered', 'approved', 'reviewed', 'recovered'])],
  ['request_withdrawn', new Set(['withdrawn', 'cancelled', 'invalidated'])],
  ['feature_completed', new Set(['completed'])],
  ['deployment_succeeded', new Set(['succeeded'])],
  ['validation_completed', new Set(['validated'])]
]);
const phases = new Set(['investigating', 'implementing', 'validating', 'waiting', 'reviewing', 'deploying', 'completed', 'failed', 'cancelled']);
const requestKinds = new Set(['input', 'product-decision', 'approval', 'review', 'deployment-incident']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function fail(message) { throw new TypeError(message); }
function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`${name} has an invalid shape`);
  return value;
}
function bounded(value, name, maxBytes, { optional = false, maxCharacters = maxBytes } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxCharacters || Buffer.byteLength(value, 'utf8') > maxBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/u.test(value)) fail(`${name} is invalid`);
  return value;
}
function opaque(value, name, maxBytes = 128) {
  const result = bounded(value, name, maxBytes);
  if (/\s/u.test(result) || /:\/\//u.test(result)) fail(`${name} must be an opaque reference`);
  return result;
}
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
  return value;
}
export function developerEventDigest(event) {
  return `sha256:${createHash('sha256').update(JSON.stringify(ordered(event))).digest('hex')}`;
}

export function normalizeDeveloperEvent(input, { producerId, role, allowedProjects } = {}) {
  const value = object(input, 'developer event', ['schemaVersion', 'eventId', 'workId', 'workRevision', 'eventType', 'occurredAt', 'context', 'session', 'request', 'outcome']);
  if (value.schemaVersion !== DEVELOPER_EVENT_SCHEMA_VERSION) fail('Unsupported developer event schema');
  if (typeof value.eventId !== 'string' || !uuid.test(value.eventId)) fail('eventId must be a UUID');
  const workId = opaque(value.workId, 'workId');
  if (!Number.isSafeInteger(value.workRevision) || value.workRevision < 1) fail('workRevision must be a positive safe integer');
  if (!eventTypes.has(value.eventType)) fail('eventType is unsupported');
  if (typeof value.occurredAt !== 'string' || !instant.test(value.occurredAt) || Number.isNaN(Date.parse(value.occurredAt))) fail('occurredAt must be an RFC 3339 instant');
  const context = object(value.context, 'context', ['projectAlias', 'repository', 'issue', 'pullRequest', 'phase', 'candidateId', 'deploymentId', 'originatingWorkId']);
  const projectAlias = opaque(context.projectAlias, 'context.projectAlias', 80);
  if (allowedProjects && !allowedProjects.includes(projectAlias)) fail('Project is not admitted for this producer');
  const normalizedContext = { projectAlias };
  for (const key of ['repository', 'issue', 'pullRequest', 'candidateId', 'deploymentId', 'originatingWorkId']) if (context[key] !== undefined) normalizedContext[key] = opaque(context[key], `context.${key}`);
  if (context.phase !== undefined) {
    if (!phases.has(context.phase)) fail('context.phase is unsupported');
    normalizedContext.phase = context.phase;
  }
  let session;
  if (value.session !== undefined) {
    const source = object(value.session, 'session', ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision']);
    session = Object.fromEntries(['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision'].map(key => [key, opaque(source[key], `session.${key}`, key === 'sessionKey' ? 512 : 128)]));
  }
  let request;
  if (value.request !== undefined) {
    const source = object(value.request, 'request', ['requestId', 'kind', 'expectedRequestRevision', 'summary', 'question', 'choices', 'expiresAt']);
    if (!requestKinds.has(source.kind)) fail('request.kind is unsupported');
    if (!Number.isSafeInteger(source.expectedRequestRevision) || source.expectedRequestRevision < 0) fail('request.expectedRequestRevision is invalid');
    request = { requestId: opaque(source.requestId, 'request.requestId'), kind: source.kind, expectedRequestRevision: source.expectedRequestRevision };
    if (source.summary !== undefined) request.summary = bounded(source.summary, 'request.summary', 640, { maxCharacters: 160 });
    if (source.question !== undefined) request.question = bounded(source.question, 'request.question', 4000, { maxCharacters: 1000 });
    if (source.choices !== undefined) {
      if (!Array.isArray(source.choices) || source.choices.length > 5 || source.choices.length === 0) fail('request.choices is invalid');
      request.choices = source.choices.map((choice, index) => bounded(choice, `request.choices[${index}]`, 480, { maxCharacters: 120 }));
    }
    if (source.expiresAt !== undefined) {
      if (typeof source.expiresAt !== 'string' || !instant.test(source.expiresAt) || Number.isNaN(Date.parse(source.expiresAt))) fail('request.expiresAt is invalid');
      request.expiresAt = source.expiresAt;
    }
  }
  let outcome;
  if (value.outcome !== undefined) {
    const source = object(value.outcome, 'outcome', ['code', 'requestId', 'deploymentId', 'candidateId']);
    outcome = { code: opaque(source.code, 'outcome.code', 64) };
    for (const key of ['requestId', 'deploymentId', 'candidateId']) if (source[key] !== undefined) outcome[key] = opaque(source[key], `outcome.${key}`);
  }
  const isController = controllerTypes.has(value.eventType) || value.eventType === 'deployment_succeeded';
  if (!opaque(producerId, 'producerId', 128) || !['worker', 'controller'].includes(role)) fail('Producer authority is required');
  if ((isController || request?.kind === 'deployment-incident') && role !== 'controller') fail('Controller authority is required');
  if ((humanTypes.has(value.eventType) || ['feature_completed', 'validation_completed'].includes(value.eventType) || terminalTypes.has(value.eventType) && request?.kind !== 'deployment-incident') && role !== 'worker') fail('Worker authority is required');
  if (outcome && !outcomeCodes.get(value.eventType)?.has(outcome.code)) fail('outcome.code is unsupported for this event');
  if (humanTypes.has(value.eventType)) {
    if (!request || request.kind !== humanTypes.get(value.eventType) || !session || outcome) fail('Human request evidence is incomplete');
    if (!request.summary || !request.question) fail('Human request requires bounded text');
  } else if (controllerTypes.has(value.eventType)) {
    if (!request || request.kind !== 'deployment-incident' || !normalizedContext.deploymentId || !outcome || outcome.deploymentId !== normalizedContext.deploymentId) fail('Deployment incident evidence is incomplete');
    if (value.eventType === 'production_deployment_failed' && (request.expectedRequestRevision !== 0 || !request.summary)) fail('New deployment incident requires original revision and summary');
    if (value.eventType !== 'production_deployment_failed' && request.expectedRequestRevision === 0) fail('Deployment update requires prior request revision');
  } else if (terminalTypes.has(value.eventType)) {
    if (!request || request.expectedRequestRevision === 0 || !outcome || outcome.requestId !== request.requestId) fail('Terminal event must target an existing exact request');
  } else if (request || !outcome) fail('Activity event must contain only a result');
  if (request?.kind === 'deployment-incident' && (!normalizedContext.deploymentId || outcome?.deploymentId !== normalizedContext.deploymentId)) fail('Deployment incident evidence is incomplete');
  if (value.eventType === 'deployment_succeeded' && (!normalizedContext.deploymentId || outcome?.deploymentId !== normalizedContext.deploymentId)) fail('Deployment success requires exact deployment identity');
  const event = { schemaVersion: 1, eventId: value.eventId.toLowerCase(), workId, workRevision: value.workRevision, eventType: value.eventType, occurredAt: value.occurredAt, context: normalizedContext, ...(session ? { session } : {}), ...(request ? { request } : {}), ...(outcome ? { outcome } : {}) };
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > DEVELOPER_EVENT_MAX_BYTES) fail('Developer event exceeds 16 KiB');
  return Object.freeze(ordered(event));
}
