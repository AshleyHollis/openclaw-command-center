import { BRIDGE_CONTRACTS, READ_METHODS, WRITE_METHODS, sanitizeBridgeResult, validateBridgeRequest } from './contracts.mjs';
import { errorResult, SourceServiceError } from '../sources/errors.mjs';

const handlerMap = Object.freeze({
  'command-center.v1.sources.status': (service) => service.status(),
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
  'command-center.v1.search.query': (service, params) => service.searchQuery(params)
});

export function registerBridgeMethods(api, service) {
  if (!api?.registerGatewayMethod) throw new TypeError('registerGatewayMethod is required');
  if (!service) throw new TypeError('authoritative source service is required');
  const registered = [];
  for (const method of [...READ_METHODS, ...WRITE_METHODS]) {
    const contract = BRIDGE_CONTRACTS[method];
    const handler = handlerMap[method];
    api.registerGatewayMethod(method, async ({ req, params, context, respond }) => {
      const requestId = req?.id ?? null;
      try {
        if (!context) throw new SourceServiceError('unauthenticated', 'Authenticated Gateway request context is required.');
        validateBridgeRequest(method, params, { mutation: WRITE_METHODS.includes(method) });
        const result = await handler(service, { ...params, requestId });
        const logicalOperationId = params.logicalOperationId ?? null;
        respond(true, { schemaVersion: 1, status: result?.status ?? 'applied', requestId, logicalOperationId, result: sanitizeBridgeResult(method, result) });
      } catch (error) {
        respond(false, null, errorResult(error, { requestId, logicalOperationId: params?.logicalOperationId ?? null }));
      }
    }, { scope: contract.scope });
    registered.push(method);
  }
  return Object.freeze(registered);
}

export const registerCommandCenterBridge = registerBridgeMethods;
