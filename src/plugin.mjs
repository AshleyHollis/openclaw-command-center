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
      resolveCreateSession: () => ({ model: 'openai/gpt-5.6-luna', agentRuntime: 'openclaw' }),
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
    api.registerService(service);
  }
});
