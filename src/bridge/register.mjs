import { BRIDGE_CONTRACTS, READ_METHODS, WRITE_METHODS, sanitizeBridgeResult, validateBridgeRequest } from './contracts.mjs';
import { errorResult, SourceServiceError } from '../sources/errors.mjs';

const handlerMap = Object.freeze({
  'command-center.v1.sources.status': (service) => service.status(),
  'command-center.v1.migration.status': (service) => service.migrationStatus(),
  'command-center.v1.migration.review-failures': (service) => service.migrationReview(),
  'command-center.v1.migration.resume': (service, params) => service.migrationResume(params),
  'command-center.v1.topics.list': async (service) => service.topics.listDestinationVerified ? service.topics.listDestinationVerified() : service.topics.listDestination(),
  'command-center.v1.topics.get': async (service, params) => ({ topic: service.topics.getVerified ? await service.topics.getVerified(params.topicId) : service.topics.get(params.topicId) }),
  'command-center.v1.topics.recovery.status': async (service, params) => ({ recovery: await service.topics.inspectSourceRecovery(params) }),
  'command-center.v1.topics.create': async (service, params) => ({ value: await service.topics.create(params) }),
  'command-center.v1.topics.provisioning.retry': async (service, params) => ({ value: await service.topics.provisioningRetry(params) }),
  'command-center.v1.topics.provisioning.rollback': async (service, params) => ({ value: await service.topics.provisioningRollback(params) }),
  'command-center.v1.topics.rename': async (service, params) => ({ value: await service.topics.rename(params) }),
  'command-center.v1.topics.replace-primary-session': async (service, params) => ({ value: await service.topics.replacePrimarySession(params) }),
  'command-center.v1.topics.structural-change.preview': (service, params) => ({ preview: service.topics.recategorizationPreview(params) }),
  'command-center.v1.topics.structural-change.confirm': async (service, params) => ({ value: await service.topics.recategorizationConfirm(params) }),
  'command-center.v1.topics.archive.preview': async (service, params) => ({ preview: await service.topics.archivePreview(params) }),
  'command-center.v1.topics.archive.confirm': async (service, params) => ({ value: await service.topics.archiveConfirm(params) }),
  'command-center.v1.topics.restore.preview': (service, params) => ({ preview: service.topics.restorePreview(params) }),
  'command-center.v1.topics.restore.confirm': async (service, params) => ({ value: await service.topics.restoreConfirm(params) }),
  'command-center.v1.topics.recovery.verify': (service, params) => service.topics.recoveryVerify(params),
  'command-center.v1.topics.recovery.relink': (service, params) => service.topics.recoveryRelink(params),
  'command-center.v1.topics.recovery.replace': (service, params) => service.topics.recoveryReplace(params),
  'command-center.v1.topics.retry': async (service, params) => ({ value: await service.topics.retry(params) }),
  'command-center.v1.topics.rollback': async (service, params) => ({ value: await service.topics.rollback(params) }),
  'command-center.v1.topics.structural-preview': (service, params) => ({ preview: service.topics.recategorizePreview(params) }),
  'command-center.v1.topics.structural-confirm': async (service, params) => ({ value: await service.topics.recategorizeConfirm(params) }),
  'command-center.v1.topics.archive-preview': async (service, params) => ({ preview: await service.topics.archivePreview(params) }),
  'command-center.v1.topics.archive-confirm': async (service, params) => ({ value: await service.topics.archiveConfirm(params) }),
  'command-center.v1.topics.restore': async (service, params) => ({ value: await service.topics.restoreConfirm(params) }),
  'command-center.v1.topics.recovery-verify': (service, params) => service.topics.recoveryVerify(params),
  'command-center.v1.topics.recovery-relink': (service, params) => service.topics.recoveryRelink(params),
  'command-center.v1.topics.recovery-replace': (service, params) => service.topics.recoveryReplace(params),
  'command-center.v1.notes.browse': (service, params) => service.notesBrowse(params),
  'command-center.v1.notes.read': (service, params) => service.notesRead(params),
  'command-center.v1.notes.create': (service, params) => service.notesCreate(params),
  'command-center.v1.notes.edit': (service, params) => service.notesEdit(params),
  'command-center.v1.notes.rename': (service, params) => service.notesRename(params),
  'command-center.v1.notes.move': (service, params) => service.notesMove(params),
  'command-center.v1.sessions.history': (service, params) => service.sessionsHistory(params),
  'command-center.v1.sessions.navigate': (service, params) => service.sessionsNavigate(params),
  'command-center.v1.sessions.create': (service, params) => service.sessionsCreate(params),
  'command-center.v1.sessions.send': (service, params) => service.sessionsSend(params),
  'command-center.v1.sessions.close': (service, params) => service.sessionsClose(params),
  'command-center.v1.sessions.reopen': (service, params) => service.sessionsReopen(params),
  'command-center.v1.reminders.list': (service, params) => service.remindersList(params),
  'command-center.v1.reminders.snooze': (service, params) => service.remindersSnooze(params),
  'command-center.v1.reminders.complete': (service, params) => service.remindersComplete(params),
  'command-center.v1.schedules.get': (service, params) => service.schedulesGet(params),
  'command-center.v1.schedules.list': (service, params) => service.schedulesList(params),
  'command-center.v1.schedules.create': (service, params) => service.schedulesCreate(params),
  'command-center.v1.schedules.update': (service, params) => service.schedulesUpdate(params),
  'command-center.v1.schedules.set-enabled': (service, params) => service.schedulesSetEnabled(params),
  'command-center.v1.schedules.run': (service, params) => service.schedulesRun(params),
  'command-center.v1.metadata.read': (service, params) => service.metadataRead(params),
  'command-center.v1.metadata.write': (service, params) => service.metadataWrite(params),
  'command-center.v1.analysis.read': (service, params) => service.analysisRead(params),
  'command-center.v1.analysis.run': (service, params) => service.analysisRun(params),
  'command-center.v1.attention.act': (service, params) => service.attentionAct(params),
  'command-center.v1.attention.list': (service, params) => service.attentionList(params),
  'command-center.v1.attention.get': (service, params) => service.attentionGet(params),
  'command-center.v1.activity.list': (service, params) => service.activityList(params),
  'command-center.v1.activity.get': (service, params) => service.activityGet(params),
  'command-center.v1.search.query': (service, params) => service.searchQuery(params)
});

export async function invokeBridgeMethod(service, method, params, requestId = null, authenticatedOperatorId = null) {
  validateBridgeRequest(method, params, { mutation: WRITE_METHODS.includes(method) });
  const handler = handlerMap[method];
  if (!handler) throw new SourceServiceError('invalid-request', 'Unsupported Command Center method.');
  return sanitizeBridgeResult(method, await handler(service, { ...params, ...(requestId === null ? {} : { requestId }), ...(authenticatedOperatorId === null ? {} : { authenticatedOperatorId }) }));
}

export function registerBridgeMethods(api, service) {
  if (!api?.registerGatewayMethod) throw new TypeError('registerGatewayMethod is required');
  if (!service) throw new TypeError('authoritative source service is required');
  const registered = [];
  const handlerService = Object.prototype.hasOwnProperty.call(service ?? {}, 'source') && service?.topics
    ? new Proxy(service.source, { get(target, property) { return property === 'topics' ? service.topics : target[property]; } })
    : service;
  for (const method of [...READ_METHODS, ...WRITE_METHODS]) {
    const contract = BRIDGE_CONTRACTS[method];
    const handler = handlerMap[method];
    api.registerGatewayMethod(method, async ({ req, params, client, context, respond }) => {
      const requestId = req?.id ?? null;
      try {
        if (!context || context.authenticated === false) throw new SourceServiceError('unauthenticated', 'Authenticated Gateway request context is required.');
        if (method === 'command-center.v1.attention.act' && (typeof client?.authenticatedUserId !== 'string' || client.authenticatedUserId.trim() === '')) throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for Attention actions.');
        const operatorId = method.startsWith('command-center.v1.attention.') && typeof client?.authenticatedUserId === 'string' ? client.authenticatedUserId : null;
        const result = await invokeBridgeMethod(handlerService, method, params, requestId, operatorId);
        const logicalOperationId = params.logicalOperationId ?? null;
        respond(true, { schemaVersion: 1, status: result?.status ?? 'applied', requestId, logicalOperationId, result });
      } catch (error) {
        respond(false, null, errorResult(error, { requestId, logicalOperationId: params?.logicalOperationId ?? null }));
      }
    }, { scope: contract.scope });
    registered.push(method);
  }
  return Object.freeze(registered);
}

export const registerCommandCenterBridge = registerBridgeMethods;
