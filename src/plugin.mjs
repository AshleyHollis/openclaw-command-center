import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { serveShellAsset } from './asset-handler.mjs';
import { createCommandCenterPersistenceRuntimeService } from './persistence/runtime-service.mjs';
import { createPersistenceService } from './persistence/service.mjs';

export const pluginId = 'command-center';
export const routeId = 'command-center';
export const pluginPath = '/plugins/command-center';

// The public factory remains available for host integrations that supply a
// verified broad-archive receipt bridge. The registered service uses OpenClaw's
// documented stateDir lifecycle seam and leaves destructive migration closed
// until the pinned SDK exposes that archive-receipt contract.
export const createCommandCenterPersistenceService = createPersistenceService;
export { createCommandCenterPersistenceRuntimeService };

const assets = new Map([
  [`${pluginPath}`, ['index.html', 'text/html; charset=utf-8']],
  [`${pluginPath}/`, ['index.html', 'text/html; charset=utf-8']],
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
  /** @param {OpenClawPluginApi} api */
  register(api) {
    api.registerService(createCommandCenterPersistenceRuntimeService());
    // This public SDK seam asks Control UI to render the route in its default
    // scripts-only frame. Gateway auth makes the host mint a frame grant.
    api.session.controls.registerControlUiDescriptor({
      surface: 'tab',
      id: routeId,
      label: 'Command Center',
      group: 'control',
      path: pluginPath
    });
    api.registerHttpRoute({
      path: pluginPath,
      auth: 'gateway',
      match: 'prefix',
      handler: serveShell
    });
  }
});
