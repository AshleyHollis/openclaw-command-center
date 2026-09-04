import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { serveShellAsset } from './asset-handler.mjs';
import { registerBridgeMethods } from './bridge/register.mjs';
import { legacyDiscordMigrationConfigSchema } from './migration/config.mjs';
import { createAttentionActionHandler } from './attention/http-route.mjs';
import { createMetadataService } from './plugin-service.mjs';
import { topicContextToolFactory } from './search/tool.mjs';
import { createTopicsHttpHandler } from './topics/http.mjs';
import { createDashboardReadHttpHandler, createDashboardActionsHttpHandler } from './dashboard/http-route.mjs';
import { createTopicAnalysisReadHttpHandler, createTopicAnalysisActionsHttpHandler } from './topics/analysis-http.mjs';
import { topicAnalysisToolFactory } from './topics/analysis-tool.mjs';
import { createTopicPageActionsHandler } from './topics/page-http.mjs';
import { createSearchRebuildHttpHandler, searchRebuildRoute } from './search/http-route.mjs';

export { runNoteMaintenance } from './plugin-service.mjs';

export const pluginId = 'command-center';
export const routeId = 'command-center';
export const pluginPath = '/plugins/command-center';

const assets = new Map([
  [`${pluginPath}`, ['index.html', 'text/html; charset=utf-8']],
  [`${pluginPath}/styles.css`, ['styles.css', 'text/css; charset=utf-8']],
  [`${pluginPath}/markdown.js`, ['markdown.js', 'text/javascript; charset=utf-8']],
  [`${pluginPath}/app.js`, ['app.js', 'text/javascript; charset=utf-8']]
]);

/** @typedef {import('openclaw/plugin-sdk/plugin-entry').OpenClawPluginApi} OpenClawPluginApi */

async function serveShell(req, res) {
  return serveShellAsset(req, res, { assets });
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
  configSchema: { type: 'object', properties: { legacyDiscordMigration: legacyDiscordMigrationConfigSchema, topics: { type: 'object', properties: { noteRoot: { type: 'string', minLength: 1, pattern: '\\S' } }, required: ['noteRoot'], additionalProperties: false }, sourceCapabilities: { type: 'object', properties: Object.fromEntries(['notes', 'sessions', 'scheduler', 'activity', 'search', 'analysis', 'attention'].map((name) => [name, { const: false }])), additionalProperties: false }, controlUiGrant: { const: false } }, additionalProperties: false },
  /** @param {OpenClawPluginApi} api */
  register(api) {
    const controlUiMutationsAllowed = api.pluginConfig?.controlUiGrant !== false;
    if (typeof api.notifications?.registerEmitter !== 'function') throw new Error('Command Center requires the published notification emitter API.');
    const notificationEmitter = api.notifications.registerEmitter({
      version: 1,
      id: 'command-center-attention-v1',
      requiredScopes: ['operator.read'],
      destinations: [{ id: 'attention-card', tabId: routeId }]
    });
    if (!notificationEmitter || typeof notificationEmitter.bindCurrentOperator !== 'function') throw new Error('Command Center notification emitter registration was refused.');
    const service = createMetadataService(api, { notificationEmitter });
    api.lifecycle?.registerRuntimeLifecycle?.({ id: 'command-center-notifications', cleanup: () => service.stop() });
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
    // This public SDK seam asks Control UI to render the route in its default
    // scripts-only frame. Gateway auth makes the host mint a frame grant.
    if (api.pluginConfig?.controlUiGrant !== false) api.session.controls.registerControlUiDescriptor({
      surface: 'tab',
      id: routeId,
      label: 'Command Center',
      group: 'control',
      path: pluginPath,
      capabilityBridge: {
        protocolVersion: 1,
        requiredMethods: [
          'command-center.v1.sources.status',
          'command-center.v1.topics.list',
          'command-center.v1.topics.get',
          'command-center.v1.sessions.browse',
          'command-center.v1.sessions.history',
          'command-center.v1.sessions.navigate',
          'command-center.v1.sessions.send',
          'command-center.v1.attention.act',
          'command-center.v1.notes.browse',
          'command-center.v1.notes.read',
          'command-center.v1.search.query',
          'command-center.v1.search.prepare-rebuild',
          'sessions.create',
          'ui.session.navigate'
        ],
        optionalMethods: []
      }
    });
    for (const path of assets.keys()) {
      api.registerHttpRoute({
        path,
        auth: path === pluginPath ? 'gateway' : 'plugin',
        match: 'exact',
        handler: serveShell
      });
    }
    api.registerHttpRoute({
      path: '/plugins/command-center/api/attention/actions',
      auth: 'plugin',
      match: 'exact',
      handler: gateControlUiMutation(createAttentionActionHandler(serviceProxy), controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/dashboard',
      auth: 'plugin',
      match: 'exact',
      handler: createDashboardReadHttpHandler(serviceProxy)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/dashboard/actions',
      auth: 'plugin',
      match: 'exact',
      handler: gateControlUiMutation(createDashboardActionsHttpHandler(serviceProxy), controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topics/actions',
      auth: 'plugin',
      match: 'exact',
      handler: gateControlUiMutation(createTopicsHttpHandler(serviceProxy), controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topic/actions',
      auth: 'plugin',
      match: 'exact',
      handler: gateControlUiMutation(createTopicPageActionsHandler(serviceProxy), controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: searchRebuildRoute,
      auth: 'plugin',
      match: 'exact',
      handler: gateControlUiMutation(createSearchRebuildHttpHandler(serviceProxy), controlUiMutationsAllowed)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topic-analysis',
      auth: 'plugin',
      match: 'exact',
      handler: createTopicAnalysisReadHttpHandler(serviceProxy)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topic-analysis/actions',
      auth: 'plugin',
      match: 'exact',
      handler: gateControlUiMutation(createTopicAnalysisActionsHttpHandler(serviceProxy), controlUiMutationsAllowed)
    });
    registerBridgeMethods(api, serviceProxy, { mutationsAllowed: controlUiMutationsAllowed });
    api.registerTool(topicContextToolFactory({ retrieve: (input) => service.topicContextRetrieve(input) }), { name: 'command_center_topic_context', optional: true });
    api.registerTool(topicAnalysisToolFactory({ run: (input) => service.topicAnalysisRun(input) }), { name: 'command_center_topic_analysis', optional: true });
    api.registerService(service);
  }
});
