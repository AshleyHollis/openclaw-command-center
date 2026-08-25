import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { serveShellAsset } from './asset-handler.mjs';
import { registerBridgeMethods } from './bridge/register.mjs';
import { legacyDiscordMigrationConfigSchema } from './migration/config.mjs';
import { createAttentionActionHandler } from './attention/http-route.mjs';
import { createMetadataService } from './plugin-service.mjs';

export { runNoteMaintenance } from './plugin-service.mjs';

export const pluginId = 'command-center';
export const routeId = 'command-center';
export const pluginPath = '/plugins/command-center';

const assets = new Map([
  [`${pluginPath}`, ['index.html', 'text/html; charset=utf-8']],
  [`${pluginPath}/styles.css`, ['styles.css', 'text/css; charset=utf-8']]
]);

/** @typedef {import('openclaw/plugin-sdk/plugin-entry').OpenClawPluginApi} OpenClawPluginApi */

async function serveShell(req, res) {
  return serveShellAsset(req, res, { assets });
}

export default definePluginEntry({
  id: pluginId,
  name: 'Command Center',
  description: 'A responsive Command Center control destination.',
  configSchema: { type: 'object', properties: { legacyDiscordMigration: legacyDiscordMigrationConfigSchema }, additionalProperties: false },
  /** @param {OpenClawPluginApi} api */
  register(api) {
    const service = createMetadataService(api);
    const serviceProxy = new Proxy({}, {
      get(_target, property) {
        return (...args) => {
          const implementation = service.sourceService?.[property];
          if (typeof implementation !== 'function') throw new Error('Command Center source service is not ready.');
          return implementation.apply(service.sourceService, args);
        };
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
    registerBridgeMethods(api, serviceProxy);
    api.registerService(service);
  }
});
