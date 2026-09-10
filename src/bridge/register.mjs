import { BRIDGE_CONTRACTS, READ_METHODS, WRITE_METHODS, sanitizeBridgeResult, validateBridgeRequest } from './contracts.mjs';
import { assertNoUnexpectedKeys, errorResult, nonBlank, SourceServiceError } from '../sources/errors.mjs';
import { assertFirstLiveCommand, FIRST_LIVE_COMMANDS, FIRST_LIVE_FEATURES } from '../release-scope.mjs';
import { captureHistoryReadAuthority } from './read-authority.mjs';
import { createRequestScopedConversationRuntime } from './gateway-method-dispatch.mjs';

const schedulerRuntimeMethods = new Set([
  'command-center.v1.reminders.list',
  'command-center.v1.reminders.create',
  'command-center.v1.reminders.snooze',
  'command-center.v1.reminders.complete',
  'command-center.v1.schedules.get',
  'command-center.v1.schedules.list',
  'command-center.v1.schedules.create',
  'command-center.v1.schedules.update',
  'command-center.v1.schedules.set-enabled',
  'command-center.v1.schedules.run',
  'command-center.v1.attention.act',
  'command-center.v1.dashboard.get'
]);

function gatewayError(error, method) {
  const rawCode = String(error?.code ?? '').toUpperCase();
  const code = rawCode === 'INVALID_REQUEST' ? 'invalid-request'
    : rawCode === 'NOT_FOUND' ? 'not-found'
      : ['CONFLICT', 'CRON_JOB_CHANGED'].includes(rawCode) ? 'conflict'
        : 'unavailable';
  return new SourceServiceError(code, error?.message || `The authenticated ${method} request was refused.`);
}

export function createAuthenticatedCoreGateway({ req, client, context, isWebchatConnect, signal, sessionMutationAuthorization, sessionMutationCommitGuard }) {
  return Object.freeze({
    request(method, params, options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'requestId')) throw new SourceServiceError('invalid-request', 'Gateway request options are closed.');
      const handler = context?.getGatewayMethodRegistry?.()?.getHandler?.(method);
      if (typeof handler !== 'function') throw new SourceServiceError('capability-unavailable', `The authenticated ${method} method is unavailable.`);
      const scopedParams = method === 'sessions.create' && params && typeof params === 'object'
        ? { ...params, catalogId: 'command-center' }
        : params;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (ok, payload, error) => {
          if (settled) return;
          settled = true;
          if (ok) resolve(payload);
          else reject(gatewayError(error, method));
        };
        Promise.resolve(handler({
            req: { ...req, ...(options.requestId ? { id: options.requestId } : {}), method, params: scopedParams },
          params: scopedParams,
          client,
          context,
          isWebchatConnect,
          respond: finish,
          ...(sessionMutationAuthorization ? { sessionMutationAuthorization } : {}),
          ...(sessionMutationCommitGuard ? { sessionMutationCommitGuard } : {}),
          ...(signal ? { signal } : {})
        })).then(
          () => { if (!settled) finish(false, null, { message: `The authenticated ${method} request completed without an acknowledgement.` }); },
          (error) => { if (!settled) { settled = true; reject(gatewayError(error, method)); } }
        );
      });
    }
  });
}

function captureAuthenticatedConversationAuthority({ client, context, signal, sessionMutationAuthorization }) {
  // Token-authenticated isolated operators may not have an external profile.
  // Bind authority to another durable host-attested user/operator identity;
  // the current connection remains a separate lifetime fence.
  const principalId = client?.authenticatedUserProfile?.profileId
    ?? client?.authenticatedUserId
    ?? client?.authenticatedOperatorId;
  const connId = client?.connId;
  const role = client?.connect?.role;
  const scopes = JSON.stringify([...(client?.connect?.scopes ?? [])].sort());
  if (typeof principalId !== 'string' || !principalId.trim() || typeof connId !== 'string' || !connId.trim() || role !== 'operator' || typeof context?.getClientConnIds !== 'function') {
    throw new SourceServiceError('unauthenticated', `The authenticated operator connection is unavailable (client=${client ? 'present' : 'missing'}, connId=${typeof connId}, role=${String(role ?? 'missing')}, connectionRegistry=${typeof context?.getClientConnIds}).`);
  }
  const assertCurrent = () => {
    sessionMutationAuthorization?.assertCurrent?.();
    const currentIds = context.getClientConnIds(current => current === client);
    const currentPrincipal = client?.authenticatedUserProfile?.profileId
      ?? client?.authenticatedUserId
      ?? client?.authenticatedOperatorId;
    if (signal?.aborted || currentPrincipal !== principalId || client.connect?.role !== role || JSON.stringify([...(client.connect?.scopes ?? [])].sort()) !== scopes || !currentIds.has(connId)) {
      throw new SourceServiceError('unauthenticated', 'The original authenticated Conversation request is no longer available.');
    }
  };
  assertCurrent();
  return Object.freeze({ principalId, assertCurrent });
}

const handlerMap = Object.freeze({
  'command-center.v1.histories.list': (service, params, runtime) => service.historiesList(params, runtime),
  'command-center.v1.histories.read': (service, params, runtime) => service.historiesRead(params, runtime),
  'command-center.v1.histories.attachment-read': (service, params, runtime) => service.historiesAttachmentRead(params, runtime),
  'command-center.v1.sources.status': (service) => service.status(),
  'command-center.v1.migration.status': (service) => service.migrationStatus(),
  'command-center.v1.migration.review-failures': (service) => service.migrationReview(),
  'command-center.v1.migration.resume': (service, params) => service.migrationResume(params),
  'command-center.v1.topics.list': async (service) => service.topics.listDestinationVerified ? service.topics.listDestinationVerified() : service.topics.listDestination(),
  'command-center.v1.topics.get': async (service, params) => ({ topic: service.topics.getVerified ? await service.topics.getVerified(params.topicId) : service.topics.get(params.topicId) }),
  'command-center.v1.topics.recovery.status': async (service, params) => ({ recovery: await service.topics.inspectSourceRecovery(params) }),
  'command-center.v1.topics.create': async (service, params, runtime) => {
    const { authoritativeSession, ...input } = params;
    if (authoritativeSession === undefined && typeof runtime?.gatewayRequest !== 'function') throw new SourceServiceError('capability-unavailable', 'Topic creation requires authenticated HTTP dispatch.');
    return { value: await service.topics.create(input, { ...runtime, authoritativeSession }) };
  },
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
  'command-center.v1.sessions.topic-context': (service, params) => service.sessionTopicContext(params),
  'command-center.v1.sessions.group-preview': (service, params) => service.sessionGroupPreview(params),
  'command-center.v1.sessions.group': (service, params, runtime) => service.sessionGroup(params, runtime),
  'command-center.v1.sessions.create': (service, params, runtime) => {
    const { authoritativeSession, expectedRevision, ...input } = params;
    return service.sessionsCreate({ ...input, ...(expectedRevision === undefined ? {} : { expectedTopicRevision: expectedRevision }) }, {
      ...(authoritativeSession === undefined ? {} : { authoritativeSession }),
      ...(runtime?.creationAuthority ? { creationAuthority: runtime.creationAuthority } : {}),
      ...(typeof runtime?.gatewayRequest === 'function' ? { gatewayRequest: runtime.gatewayRequest } : {})
    });
  },
  'command-center.v1.sessions.send': (service, params, runtime) => service.sessionsSend(params, runtime),
  'command-center.v1.sessions.close': (service, params) => service.sessionsClose(params),
  'command-center.v1.sessions.reopen': (service, params) => service.sessionsReopen(params),
  'command-center.v1.reminders.list': (service, params, runtime) => service.remindersList(params, runtime),
  'command-center.v1.reminders.create': (service, params, runtime) => service.remindersCreate(params, runtime),
  'command-center.v1.reminders.snooze': async (service, params, runtime) => { const result = await service.remindersSnooze(params, runtime); await service.notificationReconcile?.(runtime); return result; },
  'command-center.v1.reminders.complete': async (service, params, runtime) => { const result = await service.remindersComplete(params, runtime); await service.notificationReconcile?.(runtime); return result; },
  'command-center.v1.schedules.get': (service, params, runtime) => service.schedulesGet(params, runtime),
  'command-center.v1.schedules.list': (service, params, runtime) => service.schedulesList(params, runtime),
  'command-center.v1.schedules.create': (service, params, runtime) => service.schedulesCreate(params, runtime),
  'command-center.v1.schedules.update': (service, params, runtime) => service.schedulesUpdate(params, runtime),
  'command-center.v1.schedules.set-enabled': (service, params, runtime) => service.schedulesSetEnabled(params, runtime),
  'command-center.v1.schedules.run': (service, params, runtime) => service.schedulesRun(params, runtime),
  'command-center.v1.metadata.read': (service, params) => service.metadataRead(params),
  'command-center.v1.metadata.write': (service, params) => service.metadataWrite(params),
  'command-center.v1.analysis.read': (service, params) => service.analysisRead(params),
  'command-center.v1.analysis.run': (service, params) => service.analysisRun(params),
  'command-center.v1.attention.act': async (service, params, runtime) => { const result = await service.attentionAct(params, runtime); await service.notificationReconcile?.(runtime); return result; },
  'command-center.v1.attention.list': (service, params) => service.attentionList(params),
  'command-center.v1.attention.get': (service, params) => service.attentionGet(params),
  'command-center.v1.activity.list': (service, params) => service.activityList(params),
  'command-center.v1.activity.get': (service, params) => service.activityGet(params),
  'command-center.v1.dashboard.get': (service, params, runtime) => service.dashboardGet(params, runtime),
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
        assertFirstLiveCommand('bridge', method);
        if (FIRST_LIVE_FEATURES.notifications) service.notificationCaptureBinding?.();
        // The host profile is canonical across HTTP and WebSocket. An invalid
        // profile must not switch an approval to a login label or legacy owner.
        const principal = client?.authenticatedUserProfile !== undefined
          ? client.authenticatedUserProfile?.profileId
          : client?.authenticatedOperatorId ?? client?.authenticatedUserId;
        const authenticatedOperatorId = typeof principal === 'string' && principal.trim() !== '' ? principal : null;
        if (method === 'command-center.v1.attention.act' && authenticatedOperatorId === null) throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for Attention actions.');
        const operatorId = method.startsWith('command-center.v1.attention.') ? authenticatedOperatorId : null;
        let runtime = {};
        if (method === 'command-center.v1.sessions.create') {
          if (client && context) {
            const authority = captureAuthenticatedConversationAuthority({ client, context, signal, sessionMutationAuthorization });
            const gateway = createAuthenticatedCoreGateway({ req, client, context, isWebchatConnect, signal, sessionMutationAuthorization, sessionMutationCommitGuard: sessionMutationAuthorization?.assertCurrent });
            runtime = { creationAuthority: authority, gatewayRequest: gateway.request };
          } else {
            // Native Control UI requests retain their authenticated operator in
            // the published plugin-runtime request scope even when the plugin
            // handler is invoked without a transport client object.
            runtime = await createRequestScopedConversationRuntime();
          }
        }
        if (method === 'command-center.v1.sessions.group') runtime = { creationAuthority: captureAuthenticatedConversationAuthority({ client, context, signal, sessionMutationAuthorization }) };
        const assertHistoryRead = method.startsWith('command-center.v1.histories.') || ['command-center.v1.sessions.topic-context', 'command-center.v1.sessions.group-preview'].includes(method) ? captureHistoryReadAuthority({ client, context, signal }) : null;
        if (assertHistoryRead) runtime = { assertCurrent: assertHistoryRead };
        if (schedulerRuntimeMethods.has(method) && client) runtime = { gateway: createAuthenticatedCoreGateway({ req, client, context, isWebchatConnect, signal }) };
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
        const sourceResult = await invokeBridgeMethod(handlerService, method, params, requestId, operatorId, runtime);
        // Keep durable migration failures visible without offering commands
        // that this release refuses. The migration owner's full contract stays
        // unchanged for future releases and bootstrap recovery.
        const result = ['command-center.v1.migration.status', 'command-center.v1.migration.review-failures'].includes(method)
          ? { ...sourceResult, actions: (sourceResult.actions ?? []).filter(action => FIRST_LIVE_COMMANDS.bridge.includes(action.method)) }
          : sourceResult;
        const logicalOperationId = params.logicalOperationId ?? null;
        if (assertHistoryRead) {
          if (Buffer.byteLength(JSON.stringify({ schemaVersion: 1, status: 'applied', requestId, logicalOperationId, result })) > 786_432) throw new SourceServiceError('source-recovery', 'The history response exceeds the bounded page size.');
          assertHistoryRead();
        }
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

/** Native host resolvers have a flat target contract, unlike the versioned service envelopes. */
export function registerNativeSessionNavigation(api, service, { mutationsAllowed = true } = {}) {
  api.registerGatewayMethod('command-center.v1.sessions.resolve-native', async ({ req, params, context, respond }) => {
    try {
      if (!context || context.authenticated === false) throw new SourceServiceError('unauthenticated', 'Authenticated Gateway request context is required.');
      if (!mutationsAllowed) throw new SourceServiceError('capability-unavailable', 'Control UI mutation grant is unavailable.');
      assertNoUnexpectedKeys(params, ['schemaVersion', 'topicId', 'referenceId', 'expectedSessionId'], 'Native Chat target');
      nonBlank(params.expectedSessionId, 'expectedSessionId');
      const { expectedSessionId, ...input } = params;
      // The caller cannot downgrade this to history-only resolution. The source
      // owner checks archive/close/recovery and the exact persisted link afresh.
      const target = await invokeBridgeMethod(service, 'command-center.v1.sessions.navigate', { ...input, nativeChat: true }, req?.id ?? null);
      if (target.sessionId !== expectedSessionId) throw new SourceServiceError('conflict', 'The authoritative Conversation changed before native Chat navigation.');
      respond(true, { sessionKey: target.sessionKey });
    } catch (error) {
      respond(false, null, errorResult(error, { requestId: req?.id ?? null }));
    }
  }, { scope: 'operator.read' });
}
