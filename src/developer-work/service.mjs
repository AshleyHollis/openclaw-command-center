import { createHash } from 'node:crypto';
import { normalizeDeveloperEvent } from './contract.mjs';

export const DEVELOPER_WORK_CAPABILITY_ID = 'developer-work.v1';

const reasonByKind = Object.freeze({
  input: 'developer-input-required',
  'product-decision': 'developer-input-required',
  approval: 'developer-approval-required',
  review: 'developer-review-required',
  'deployment-incident': 'developer-deployment-incident'
});
const terminalTypes = new Set(['request_resolved', 'request_withdrawn']);
const activityOnlyTypes = new Set(['feature_completed', 'deployment_succeeded', 'validation_completed']);
const incidentTypes = new Set(['production_deployment_failed', 'production_rollback', 'production_recovered']);

function identity(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function requestState(event) {
  return event.eventType === 'request_resolved' ? 'resolved' : event.eventType === 'request_withdrawn' ? 'withdrawn' : 'active';
}

function operationOutcome(event) {
  return ['production_deployment_failed'].includes(event.eventType) || event.outcome?.code === 'rollback-failed' ? 'failed' : 'applied';
}

export function developerHandoffUrl(baseUrl, workId, requestId) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !/^\/[A-Za-z0-9/_-]*$/u.test(base.pathname)) throw new TypeError('DEV Control UI base URL must be a credential-free HTTPS path.');
  const target = new URL(`${base.pathname.replace(/\/$/u, '')}/plugin`, base.origin);
  target.search = new URLSearchParams({ plugin: 'command-center', id: 'developer-work', 'p.workId': workId, 'p.requestId': requestId }).toString();
  return target.href;
}

function occurrenceFor(producerId, event, devBaseUrl, acceptedAt) {
  const request = event.request;
  const requestIdentity = identity(producerId, event.workId, request.requestId);
  const transition = { producerId, workId: event.workId, requestId: request.requestId, eventId: event.eventId, requestKind: request.kind, state: requestState(event) };
  const facts = {
    developerWork: true,
    producerId,
    eventType: event.eventType,
    projectAlias: event.context.projectAlias,
    workId: event.workId,
    requestId: request.requestId,
    requestKind: request.kind,
    ...(request.summary ? { summary: request.summary } : {}),
    ...(request.question ? { question: request.question } : {}),
    ...(request.choices ? { choices: request.choices } : {}),
    ...(event.session && devBaseUrl ? { devHandoffUrl: developerHandoffUrl(devBaseUrl, event.workId, request.requestId) } : {}),
    ...(event.context.deploymentId ? { deploymentId: event.context.deploymentId } : {}),
    ...(event.outcome ? { outcome: event.outcome.code } : {}),
    ...(incidentTypes.has(event.eventType) ? { outcomeObservedAt: acceptedAt } : {})
  };
  if (['input', 'product-decision', 'approval'].includes(request.kind)) facts['blocked-work'] = true;
  if (request.kind === 'deployment-incident') facts['failed-operation'] = true;
  return Object.freeze({
    schemaVersion: 1,
    sourceCapabilityId: DEVELOPER_WORK_CAPABILITY_ID,
    stableSubjectId: `developer-request:${requestIdentity}`,
    attentionReason: reasonByKind[request.kind],
    occurrenceId: `developer-event:${identity(producerId, event.eventId)}`,
    occurrenceVersion: String(event.workRevision),
    occurredAt: event.occurredAt,
    evidenceFacts: facts,
    transitionEvidence: transition
  });
}

function recordActivity(metadata, producerId, event) {
  const activityIdentity = identity(producerId, event.eventId);
  return metadata.recordActivity({
    activityId: `developer-activity:${activityIdentity}`,
    logicalOperationId: `developer-event:${activityIdentity}`,
    transportRequestId: event.eventId,
    operationKind: `developer-work.${event.eventType}`,
    outcome: operationOutcome(event),
    observedRevision: String(event.workRevision),
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt
  });
}

export function createDeveloperWorkService({ metadata, attention, devBaseUrl } = {}) {
  if (!metadata?.acceptDeveloperEvent || !metadata?.listPendingDeveloperEvents || !attention?.registerSourceCapability || !attention?.ingest) throw new TypeError('Developer Work requires durable metadata and Attention owners.');
  if (devBaseUrl !== undefined) developerHandoffUrl(devBaseUrl, 'work', 'request');
  let closed = false;
  let draining = null;

  const currentRequest = (producerId, event) => metadata.getDeveloperRequest({ producerId, workId: event.workId, requestId: event.request.requestId });
  const isCurrent = (producerId, event) => {
    const current = currentRequest(producerId, event);
    return current?.revision === event.workRevision && current.lastEventId === event.eventId && current.kind === event.request.kind && current.state === requestState(event);
  };

  attention.registerSourceCapability({
    sourceCapabilityId: DEVELOPER_WORK_CAPABILITY_ID,
    sourceKind: 'developer-work',
    monitoring: false,
    revisionOrdering: 'positive-integer',
    actions: [],
    verifyTransition: occurrence => {
      const proof = occurrence.transitionEvidence;
      if (!proof) return false;
      const current = metadata.getDeveloperRequest({ producerId: proof.producerId, workId: proof.workId, requestId: proof.requestId });
      return current?.revision === Number(occurrence.occurrenceVersion) && current.lastEventId === proof.eventId && current.kind === proof.requestKind && current.state === proof.state;
    },
    deriveEvidence: occurrence => occurrence.evidenceFacts,
    commitGuard: (db, occurrence) => {
      const proof = occurrence.transitionEvidence;
      if (!proof || !db) return false;
      const row = db.prepare(`SELECT r.kind, r.revision, r.state, r.last_event_id, e.event_id
        FROM developer_work_requests r JOIN developer_work_receipts e
          ON e.producer_id = r.producer_id AND e.work_id = r.work_id AND e.event_id = r.last_event_id
        WHERE r.producer_id = ? AND r.work_id = ? AND r.request_id = ?`).get(proof.producerId, proof.workId, proof.requestId);
      return row?.revision === Number(occurrence.occurrenceVersion) && row.last_event_id === proof.eventId && row.kind === proof.requestKind && row.state === proof.state && row.event_id === proof.eventId;
    }
  });

  async function project(item) {
    const { receipt, event } = item;
    const producerId = receipt.producerId;
    if (event.request && isCurrent(producerId, event)) {
      const result = await attention.ingest(occurrenceFor(producerId, event, devBaseUrl, receipt.acceptedAt));
      if (terminalTypes.has(event.eventType) && !result.activity) recordActivity(metadata, producerId, event);
      if (incidentTypes.has(event.eventType)) recordActivity(metadata, producerId, event);
    } else if (terminalTypes.has(event.eventType) || incidentTypes.has(event.eventType) || activityOnlyTypes.has(event.eventType)) {
      // Outcomes survive a later unrelated event on the same work stream.
      recordActivity(metadata, producerId, event);
    }
    metadata.markDeveloperEventProjected({ producerId, eventId: event.eventId, eventDigest: receipt.eventDigest });
  }

  function drain() {
    if (closed) throw new Error('Developer Work service is closed.');
    const run = (draining ?? Promise.resolve()).catch(() => {}).then(async () => {
      for (;;) {
        const pending = metadata.listPendingDeveloperEvents({ limit: 100 });
        if (pending.length === 0) return;
        for (const item of pending) await project(item);
      }
    });
    draining = run;
    run.finally(() => { if (draining === run) draining = null; }).catch(() => {});
    return draining;
  }

  async function accept({ producerId, role, allowedProjects, event, watermark } = {}) {
    if (closed) throw new Error('Developer Work service is closed.');
    const normalized = normalizeDeveloperEvent(event, { producerId, role, allowedProjects });
    const receipt = metadata.acceptDeveloperEvent({ producerId, event: normalized, watermark });
    // Acknowledgement means durable receipt, even when the separate projection
    // transaction must be retried during the next drain/startup.
    try { await drain(); } catch { /* receipt remains visibly pending */ }
    return Object.freeze({ ...(metadata.getDeveloperReceipt({ producerId, eventId: normalized.eventId }) ?? receipt), duplicate: receipt.duplicate });
  }

  return Object.freeze({ accept, drain, close() { closed = true; } });
}
