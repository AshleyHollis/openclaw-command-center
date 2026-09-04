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
  'command-center.v1.topics.create': async (service, params) => { const { authoritativeSession, ...input } = params; return { value: await service.topics.create(input, { authoritativeSession }) }; },
  'command-center.v1.topics.provisioning.retry': async (service, params, runtime) => ({ value: await service.topics.provisioningRetry(params, runtime) }),
  'command-center.v1.topics.provisioning.rollback': async (service, params) => ({ value: await service.topics.provisioningRollback(params) }),
  'command-center.v1.topics.rename': async (service, params) => ({ value: await service.topics.rename(params) }),
  'command-center.v1.topics.replace-primary-session': async (service, params, runtime) => ({ value: await service.topics.replacePrimarySession(params, runtime) }),
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
  'command-center.v1.sessions.browse': (service, params) => service.sessionsList(params),
  'command-center.v1.sessions.navigate': (service, params) => service.sessionsNavigate(params),
  'command-center.v1.sessions.create': (service, params) => { const { authoritativeSession, ...input } = params; return service.sessionsCreate(input, { authoritativeSession }); },
  'command-center.v1.sessions.send': (service, params, runtime) => service.sessionsSend(params, runtime),
  'command-center.v1.sessions.close': (service, params) => service.sessionsClose(params),
  'command-center.v1.sessions.reopen': (service, params) => service.sessionsReopen(params),
  'command-center.v1.reminders.list': (service, params) => service.remindersList(params),
  'command-center.v1.reminders.create': (service, params) => service.remindersCreate(params),
  'command-center.v1.reminders.snooze': async (service, params) => { const result = await service.remindersSnooze(params); await service.notificationReconcile?.(); return result; },
  'command-center.v1.reminders.complete': async (service, params) => { const result = await service.remindersComplete(params); await service.notificationReconcile?.(); return result; },
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
  'command-center.v1.attention.act': async (service, params) => { const result = await service.attentionAct(params); await service.notificationReconcile?.(); return result; },
  'command-center.v1.attention.list': (service, params) => service.attentionList(params),
  'command-center.v1.attention.get': (service, params) => service.attentionGet(params),
  'command-center.v1.activity.list': (service, params) => service.activityList(params),
  'command-center.v1.activity.get': (service, params) => service.activityGet(params),
  'command-center.v1.dashboard.get': (service, params) => service.dashboardGet(params),
  'command-center.v1.search.query': (service, params) => service.searchQuery(params),
  'command-center.v1.search.prepare-rebuild': (service, params) => service.searchPrepareRebuild(params)
});

export async function invokeBridgeMethod(service, method, params, requestId = null, authenticatedOperatorId = null, runtime = {}) {
  validateBridgeRequest(method, params, { mutation: WRITE_METHODS.includes(method) });
  const handler = handlerMap[method];
  if (!handler) throw new SourceServiceError('invalid-request', 'Unsupported Command Center method.');
  return sanitizeBridgeResult(method, await handler(service, { ...params, ...(requestId === null ? {} : { requestId }), ...(authenticatedOperatorId === null ? {} : { authenticatedOperatorId }) }, runtime));
}

export function registerBridgeMethods(api, service, { mutationsAllowed = true } = {}) {
  if (!api?.registerGatewayMethod) throw new TypeError('registerGatewayMethod is required');
  if (!service) throw new TypeError('authoritative source service is required');
  const registered = [];
  const handlerService = Object.prototype.hasOwnProperty.call(service ?? {}, 'source') && service?.topics
    ? new Proxy(service.source, { get(target, property) { return property === 'topics' ? service.topics : target[property]; } })
    : service;
  for (const method of [...READ_METHODS, ...WRITE_METHODS]) {
    const contract = BRIDGE_CONTRACTS[method];
    const handler = handlerMap[method];
    api.registerGatewayMethod(method, async ({ req, params, client, context, respond, isWebchatConnect, sessionMutationAuthorization, signal }) => {
      const requestId = req?.id ?? null;
      try {
        if (!context || context.authenticated === false) throw new SourceServiceError('unauthenticated', 'Authenticated Gateway request context is required.');
        if (!mutationsAllowed && WRITE_METHODS.includes(method)) throw new SourceServiceError('capability-unavailable', 'Control UI mutation grant is unavailable.');
        service.notificationCaptureBinding?.();
        if (method === 'command-center.v1.attention.act' && (typeof client?.authenticatedUserId !== 'string' || client.authenticatedUserId.trim() === '')) throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for Attention actions.');
        const operatorId = method.startsWith('command-center.v1.attention.') && typeof client?.authenticatedUserId === 'string' ? client.authenticatedUserId : null;
        let runtime = {};
        const coreSessionSend = method === 'command-center.v1.sessions.send' ? context.getGatewayMethodRegistry?.()?.getHandler?.('sessions.send') : null;
        if (method === 'command-center.v1.sessions.send' && client && typeof coreSessionSend === 'function') {
          runtime = {
            agentTurnDispatch: ({ sessionKey, message, runId }) => new Promise((resolve, reject) => {
              let settled = false;
              const params = { key: sessionKey, agentId: 'main', message, idempotencyKey: runId };
              const finish = (ok, payload, error) => {
                if (settled) return;
                settled = true;
                if (ok) resolve(payload);
                else reject(new SourceServiceError('unavailable', error?.message || 'The authenticated Session turn was refused.'));
              };
              Promise.resolve(coreSessionSend({ req: { ...req, method: 'sessions.send', params }, params, client, context, isWebchatConnect, respond: finish, ...(signal ? { signal } : {}) }))
                .then(() => { if (!settled) finish(false, null, { message: 'The authenticated Session turn completed without an acknowledgement.' }); }, reject);
            })
          };
        } else if (method === 'command-center.v1.sessions.send' && client && typeof context.createAgentTurnFacade === 'function') {
          const agentTurn = await context.createAgentTurnFacade({ client, isWebchatConnect, assertContextCurrent: sessionMutationAuthorization?.assertCurrent });
          runtime = { agentTurnDispatch: ({ sessionKey, sessionId, message, runId }) => agentTurn.dispatch({ message, agentId: 'main', sessionKey, sessionId, expectedExistingSessionId: sessionId, channel: 'webchat', deliver: false, idempotencyKey: runId }, { signal }) };
        }
        const result = await invokeBridgeMethod(handlerService, method, params, requestId, operatorId, runtime);
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
