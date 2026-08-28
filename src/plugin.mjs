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

export { runNoteMaintenance } from './plugin-service.mjs';

export const pluginId = 'command-center';
export const routeId = 'command-center';
export const pluginPath = '/plugins/command-center';

const assets = new Map([
  [`${pluginPath}`, ['index.html', 'text/html; charset=utf-8']],
  [`${pluginPath}/styles.css`, ['styles.css', 'text/css; charset=utf-8']],
  [`${pluginPath}/app.js`, ['app.js', 'text/javascript; charset=utf-8']]
]);

/** @typedef {import('openclaw/plugin-sdk/plugin-entry').OpenClawPluginApi} OpenClawPluginApi */

async function serveShell(req, res) {
  return serveShellAsset(req, res, { assets });
}

export default definePluginEntry({
  id: pluginId,
  name: 'Command Center',
  description: 'A responsive Command Center control destination.',
  configSchema: { type: 'object', properties: { legacyDiscordMigration: legacyDiscordMigrationConfigSchema, topics: { type: 'object', properties: { noteRoot: { type: 'string', minLength: 1, pattern: '\\S' } }, required: ['noteRoot'], additionalProperties: false } }, additionalProperties: false },
  /** @param {OpenClawPluginApi} api */
  register(api) {
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
        if (property === 'topics') return service.topicService;
        if (property === 'dashboard') return { get: (input) => service.dashboardGet(input) };
        if (property === 'dashboardGet') return (input) => service.dashboardGet(input);
        if (property === 'dashboardUpdateSettings') return (input) => service.dashboardUpdateSettings(input);
        if (property === 'notificationReconcile') return () => service.notificationReconcile();
        if (property === 'notificationCaptureBinding') return () => service.notificationCaptureBinding();
        if (property === 'topicAnalysis') return { get: () => service.topicAnalysisRead() };
        if (property === 'topicAnalysisRun') return (input) => service.topicAnalysisRun(input);
        if (property === 'analysisSchedule') return service.topicAnalysisSchedule;
        if (property === 'topicAnalysisSchedule') return service.topicAnalysisSchedule;
        if (property === 'analysisRunner') return service.topicAnalysisRunner;
        if (property === 'topicAnalysisRunner') return service.topicAnalysisRunner;
        if (property === 'review') return service.topicReview;
        if (property === 'topicReview') return service.topicReview;
        return sourceProxy[property];
      }
    });
    // This public SDK seam asks Control UI to render the route in its default
    // scripts-only frame. Gateway auth makes the host mint a frame grant.
    api.session.controls.registerControlUiDescriptor({
      surface: 'tab',
      id: routeId,
      label: 'Command Center',
      group: 'control',
      path: pluginPath
    });
    for (const path of assets.keys()) {
      api.registerHttpRoute({
        path,
        auth: 'gateway',
        match: 'exact',
        handler: serveShell
      });
    }
    api.registerHttpRoute({
      path: '/plugins/command-center/api/attention/actions',
      auth: 'plugin',
      match: 'exact',
      handler: createAttentionActionHandler(serviceProxy)
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
      handler: createDashboardActionsHttpHandler(serviceProxy)
    });
    api.registerHttpRoute({
      path: '/plugins/command-center/api/topics/actions',
      auth: 'plugin',
      match: 'exact',
      handler: createTopicsHttpHandler(serviceProxy)
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
      handler: createTopicAnalysisActionsHttpHandler(serviceProxy)
    });
    registerBridgeMethods(api, serviceProxy);
    api.registerTool(topicContextToolFactory({ retrieve: (input) => service.topicContextRetrieve(input) }), { name: 'command_center_topic_context', optional: true });
    api.registerTool(topicAnalysisToolFactory({ run: (input) => service.topicAnalysisRun(input) }), { name: 'command_center_topic_analysis', optional: true });
    api.registerService(service);
  }
});
