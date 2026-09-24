import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { registerBridgeMethods, registerNativeSessionNavigation } from './bridge/register.mjs';
import { createRequestScopedConversationRuntime } from './bridge/gateway-method-dispatch.mjs';
import { pluginConfigSchema } from './plugin-config.mjs';
import { createAttentionActionHandler } from './attention/http-route.mjs';
import { createMetadataService } from './plugin-service.mjs';
import { topicContextToolFactory } from './search/tool.mjs';
import { createTopicsHttpHandler } from './topics/http.mjs';
import { createDashboardReadHttpHandler, createDashboardActionsHttpHandler } from './dashboard/http-route.mjs';
import { createTopicAnalysisReadHttpHandler, createTopicAnalysisActionsHttpHandler } from './topics/analysis-http.mjs';
import { topicAnalysisToolFactory } from './topics/analysis-tool.mjs';
import { topicDocumentFileToolFactory } from './documents/tool.mjs';
import { topicNoteMaintenanceToolFactory } from './maintenance/tool.mjs';
import { commitmentCaptureToolFactory } from './open-loops/commitment-tool.mjs';
import { capacityReviewToolFactory } from './open-loops/capacity-review-tool.mjs';
import { sourceTopicResolverToolFactory, sourceNoteCaptureToolFactory, sourceCommitmentCaptureToolFactory, intakeReceiptToolFactory, intakeSourcePlanToolFactory, intakeSourceAccountToolFactory, intakeOutcomeToolFactory } from './open-loops/source-intake-tool.mjs';
import { pendingClarificationToolFactory, interpretClarificationToolFactory } from './open-loops/clarification-tool.mjs';
import { briefingPublishToolFactory } from './daily-workspace/briefing-tool.mjs';
import { registerConversationCaptureHook } from './open-loops/conversation-capture-hook.mjs';
import { createTopicMaintenanceCompletionSubscription } from './maintenance/completion.mjs';
import { createTopicPageActionsHandler } from './topics/page-http.mjs';
import { createSearchRebuildHttpHandler, searchRebuildRoute } from './search/http-route.mjs';
import { assertFirstLiveTopicAction, FIRST_LIVE_FEATURES } from './release-scope.mjs';

export { runNoteMaintenance } from './plugin-service.mjs';

export const pluginId = 'command-center';
export const routeId = 'command-center';
export const pluginPath = '/plugins/command-center';

const legacyPaths = [pluginPath, `${pluginPath}/styles.css`, `${pluginPath}/markdown.js`, `${pluginPath}/app.js`];

/** @typedef {import('openclaw/plugin-sdk/plugin-entry').OpenClawPluginApi} OpenClawPluginApi */

function unavailableFirstLiveFeature(_req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 501;
  res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'feature-unavailable', retryable: false, message: 'This feature is not available in the first live release. Use the native Topics page.' }));
  return true;
}

function gateControlUiMutation(handler, allowed) {
  if (allowed) return handler;
  return async (req, res) => {
    if (req.method !== 'POST') return handler(req, res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 422;
    res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'capability-unavailable', message: 'Control UI grant is unavailable.' }));
    return true;
  };
}

export default definePluginEntry({
  id: pluginId,
  name: 'Command Center',
  description: 'A responsive Command Center control destination.',
  configSchema: pluginConfigSchema,
  /** @param {OpenClawPluginApi} api */
  register(api) {
    api.registerCli?.(async context => {
      const { registerReconciliationCli } = await import('./migration/reconcile-cli.mjs');
      registerReconciliationCli(context);
    }, { descriptors: [{ name: 'command-center', description: 'Command Center existing-data reconciliation', hasSubcommands: true }] });
    // Metadata discovery registers only lazy CLI declarations and must not
    // acquire the full activation's services or notification emitter.
    if (api.registrationMode === 'cli-metadata') return;
    api.registerSessionCatalog?.({
      id: 'command-center',
      label: 'Command Center native Sessions',
      audience: 'gateway-operators',
      supportsProcessHomeIsolation: true,
      resolveCreateSession: () => ({ model: api.pluginConfig?.conversationModel ?? 'openai/gpt-5.6-luna', agentRuntime: 'openclaw' }),
      list: async () => [],
      read: async () => ({ sessions: [] })
    });
    // Native contributions and exact HTTP capabilities are declared in the
    // manifest. The host owns authentication; no iframe grant is manufactured.
    const controlUiMutationsAllowed = api.pluginConfig?.controlUiGrant !== false;
    let notificationEmitter;
    if (FIRST_LIVE_FEATURES.notifications) {
      if (typeof api.notifications?.registerEmitter !== 'function') throw new Error('Command Center requires the published notification emitter API.');
      notificationEmitter = api.notifications.registerEmitter({
        version: 1,
        id: 'command-center-attention-v1',
        requiredScopes: ['operator.read'],
        destinations: [{ id: 'attention-card', pageId: 'attention' }]
      });
      if (!notificationEmitter || typeof notificationEmitter.bindCurrentOperator !== 'function') throw new Error('Command Center notification emitter registration was refused.');
    }
    const service = createMetadataService(api, { notificationEmitter });
    api.lifecycle?.registerRuntimeLifecycle?.({ id: 'command-center-notifications', cleanup: ({ reason }) => {
      // Session reset/delete is not a plugin shutdown: Topic services and
      // metadata must remain alive to report and repair the missing binding.
      if (reason === 'disable' || reason === 'restart') return service.stop();
    } });
    const sourceProxy = new Proxy({}, {
      get(_target, property) {
        return (...args) => {
          const implementation = service.sourceService?.[property];
          if (typeof implementation !== 'function') throw new Error('Command Center source service is not ready.');
          return implementation.apply(service.sourceService, args);
        };
      }
    });
    const serviceProxy = new Proxy({}, {
      get(_target, property) {
        if (property === 'status') return async () => {
          const status = await sourceProxy.status();
          if (api.pluginConfig?.controlUiGrant !== false || status.mode === 'recovery-only') return status;
          return {
            ...status,
            mode: 'degraded',
            diagnostics: [...(status.diagnostics ?? []), { code: 'control-ui-grant-unavailable', capability: 'control-ui-grant' }],
            unavailableCapabilities: [...new Set([...(status.unavailableCapabilities ?? []), 'control-ui-grant'])]
          };
        };
        if (property === 'topics') return service.topicService;
        if (property === 'dashboard') return { get: (input, runtime) => service.dashboardGet(input, runtime) };
        if (property === 'dashboardGet') return (input, runtime) => service.dashboardGet(input, runtime);
        if (property === 'briefingSetRead') return (input) => service.briefingSetRead(input);
        if (property === 'routineDecide') return (input) => service.routineDecide(input);
        if (property === 'openLoopsList') return (input) => service.openLoopsList(input);
        if (property === 'openLoopsGet') return (input) => service.openLoopsGet(input);
        if (property === 'openLoopsCapture') return (input) => service.openLoopsCapture(input);
        if (property === 'openLoopsIngestSelected') return (input) => service.openLoopsIngestSelected(input);
        if (property === 'openLoopsDecide') return (input, runtime) => service.openLoopsDecide(input, runtime);
        if (property === 'openLoopsClarify') return (input) => service.openLoopsClarify(input);
        if (property === 'openLoopsResumeFollowUp') return (input, runtime) => service.openLoopsResumeFollowUp(input, runtime);
        if (property === 'openLoopsPaymentStatus') return (input, runtime) => service.openLoopsPaymentStatus(input, runtime);
        if (property === 'openLoopsOrganize') return (input, runtime) => service.openLoopsOrganize(input, runtime);
        if (property === 'openLoopsRenovationRequirement') return (input, runtime) => service.openLoopsRenovationRequirement(input, runtime);
        if (property === 'openLoopsRenovationPurchase') return (input, runtime) => service.openLoopsRenovationPurchase(input, runtime);
        if (property === 'openLoopsRenovationPurchaseCorrection') return (input, runtime) => service.openLoopsRenovationPurchaseCorrection(input, runtime);
        if (property === 'openLoopsRenovationReplacement') return (input, runtime) => service.openLoopsRenovationReplacement(input, runtime);
        if (property === 'openLoopsRenovationFulfilment') return (input, runtime) => service.openLoopsRenovationFulfilment(input, runtime);
        if (property === 'openLoopsRenovationStage') return (input) => service.openLoopsRenovationStage(input);
        if (property === 'openLoopsRenovationStagePrerequisites') return (input) => service.openLoopsRenovationStagePrerequisites(input);
        if (property === 'openLoopsRenovationDecisionConflict') return (input) => service.openLoopsRenovationDecisionConflict(input);
        if (property === 'openLoopsRenovationDecisionRevise') return (input) => service.openLoopsRenovationDecisionRevise(input);
        if (property === 'dashboardUpdateSettings') return (input) => service.dashboardUpdateSettings(input);
        if (property === 'notificationReconcile') return (runtime) => service.notificationReconcile(runtime);
        if (property === 'notificationCaptureBinding') return () => service.notificationCaptureBinding();
        if (property === 'topicAnalysis') return { get: () => service.topicAnalysisRead() };
        if (property === 'topicAnalysisRun') return (input) => service.topicAnalysisRun(input);
        if (property === 'analysisSchedule') return service.topicAnalysisSchedule;
        if (property === 'topicAnalysisSchedule') return service.topicAnalysisSchedule;
        if (property === 'analysisRunner') return service.topicAnalysisRunner;
        if (property === 'topicAnalysisRunner') return service.topicAnalysisRunner;
        if (property === 'searchRebuild') return (input) => service.searchRebuild(input);
        if (property === 'searchPrepareRebuild') return (input, runtime) => service.searchPrepareRebuild(input, runtime);
        if (property === 'review') return service.topicReview;
        if (property === 'topicReview') return service.topicReview;
        return sourceProxy[property];
      }
    });
    // Old bookmarks must not open a second UI that advertises deferred writes.
    // Native module assets are served by the host's declared plugin UI loader.
    for (const path of legacyPaths) {
      api.registerHttpRoute({
        path,
        auth: path === pluginPath ? 'gateway' : 'plugin',
        match: 'exact',
        handler: unavailableFirstLiveFeature
      });
    }
    api.registerHttpRoute({
      path: '/plugins/command-center/api/attention/actions',
      auth: 'gateway',
      match: 'exact',
      handler: gateControlUiMutation(FIRST_LIVE_FEATURES.dashboard ? createAttentionActionHandler(serviceProxy) : unavailableFirstLiveFeature, controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/dashboard',
      auth: 'gateway',
      match: 'exact',
      handler: FIRST_LIVE_FEATURES.dashboard ? createDashboardReadHttpHandler(serviceProxy) : unavailableFirstLiveFeature
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/dashboard/actions',
      auth: 'gateway',
      match: 'exact',
      handler: gateControlUiMutation(FIRST_LIVE_FEATURES.notifications ? createDashboardActionsHttpHandler(serviceProxy) : unavailableFirstLiveFeature, controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topics/actions',
      auth: 'gateway',
      match: 'exact',
      handler: gateControlUiMutation(FIRST_LIVE_FEATURES.topicProvisioning || FIRST_LIVE_FEATURES.structuralChanges ? createTopicsHttpHandler(serviceProxy) : unavailableFirstLiveFeature, controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topic/actions',
      auth: 'gateway',
      match: 'exact',
      handler: gateControlUiMutation(createTopicPageActionsHandler(serviceProxy, {
        assertAction: assertFirstLiveTopicAction,
        createConversationRuntime: () => createRequestScopedConversationRuntime()
      }), controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: searchRebuildRoute,
      auth: 'gateway',
      match: 'exact',
      handler: gateControlUiMutation(FIRST_LIVE_FEATURES.search ? createSearchRebuildHttpHandler(serviceProxy) : unavailableFirstLiveFeature, controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topic-analysis',
      auth: 'gateway',
      match: 'exact',
      handler: FIRST_LIVE_FEATURES.analysis ? createTopicAnalysisReadHttpHandler(serviceProxy) : unavailableFirstLiveFeature
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topic-analysis/actions',
      auth: 'gateway',
      match: 'exact',
      handler: gateControlUiMutation(FIRST_LIVE_FEATURES.analysis ? createTopicAnalysisActionsHttpHandler(serviceProxy) : unavailableFirstLiveFeature, controlUiMutationsAllowed)
    });
    registerBridgeMethods(api, serviceProxy, { mutationsAllowed: controlUiMutationsAllowed });
    registerNativeSessionNavigation(api, serviceProxy, { mutationsAllowed: controlUiMutationsAllowed });
    if (FIRST_LIVE_FEATURES.search) api.registerTool(topicContextToolFactory({ retrieve: (input) => service.topicContextRetrieve(input) }), { name: 'command_center_topic_context', optional: true });
    if (FIRST_LIVE_FEATURES.analysis) api.registerTool(topicAnalysisToolFactory({ run: (input) => service.topicAnalysisRun(input) }), { name: 'command_center_topic_analysis', optional: true });
    if (FIRST_LIVE_FEATURES.topicDocuments) api.registerTool(topicDocumentFileToolFactory({ file: (input) => service.sourceService.documentsFileAttachment(input) }), { name: 'command_center_file_topic_attachment', optional: true });
    if (FIRST_LIVE_FEATURES.noteMaintenance) api.registerTool(topicNoteMaintenanceToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_update_working_note', optional: true });
    api.registerTool(commitmentCaptureToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_capture_commitment', optional: true });
    api.registerTool(capacityReviewToolFactory({ getOwner: () => service.capacityReview }), { name: 'command_center_open_capacity_review', optional: true });
    api.registerTool(sourceTopicResolverToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_resolve_source_topic', optional: true });
    api.registerTool(sourceNoteCaptureToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_save_source_note', optional: true });
    api.registerTool(sourceCommitmentCaptureToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_capture_source_commitment', optional: true });
    api.registerTool(intakeSourcePlanToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_plan_intake_source', optional: true });
    api.registerTool(intakeSourceAccountToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_get_intake_source_account', optional: true });
    api.registerTool(pendingClarificationToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_get_pending_clarification', optional: true });
    api.registerTool(interpretClarificationToolFactory({ interpret: (input, authority) => service.openLoopsInterpretClarification(input, { ...authority, deferFollowUp: true }) }), { name: 'command_center_interpret_clarification', optional: true });
    api.registerTool(intakeOutcomeToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_record_intake_outcome', optional: true });
    api.registerTool(intakeReceiptToolFactory({ getOwners: () => service.getTopicMaintenanceOwners() }), { name: 'command_center_record_intake_receipt', optional: true });
    api.registerTool(briefingPublishToolFactory({
      getOwner: () => service.dailyWorkspace,
      resolveSessionKey: context => {
        if (typeof context?.sessionId !== 'string' || !context.sessionId) return undefined;
        const list = api.runtime?.agent?.session?.listSessionEntries;
        if (typeof list !== 'function') return undefined;
        const matches = list({ agentId: context.agentId ?? 'main', readOnly: true })
          .filter(row => row?.entry?.sessionId === context.sessionId && typeof row.sessionKey === 'string' && row.sessionKey);
        return matches.length === 1 ? matches[0].sessionKey : undefined;
      }
    }), { name: 'command_center_publish_briefing', optional: true });
    registerConversationCaptureHook(api);
    // The host exposes the same subscription contract in both its current
    // flat SDK form and its nested facade form. Prefer the facade where it is
    // present, but never silently drop automatic maintenance for a host that
    // provides only the flat contract.
    const registerAgentEventSubscription = api.agent?.events?.registerAgentEventSubscription ?? api.registerAgentEventSubscription;
    if (FIRST_LIVE_FEATURES.noteMaintenance && typeof registerAgentEventSubscription === 'function') {
      registerAgentEventSubscription(createTopicMaintenanceCompletionSubscription({ getOwners: () => ({ sourceService: service.sourceService, metadata: service.sourceService?.metadata, maintenanceSchedule: service.sourceService?.maintenanceSchedule }) }));
    }
    api.registerService(service);
  }
});
