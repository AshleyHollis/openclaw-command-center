import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { serveShellAsset } from './asset-handler.mjs';
import { openCommandCenterMetadataService } from './metadata/service.mjs';
import { registerBridgeMethods } from './bridge/register.mjs';
import { createAuthoritativeSourceService } from './sources/service.mjs';
import { createNoteMaintenanceService } from './maintenance/notes.mjs';

export const pluginId = 'command-center';
export const routeId = 'command-center';
export const pluginPath = '/plugins/command-center';

const assets = new Map([
  [`${pluginPath}`, ['index.html', 'text/html; charset=utf-8']],
  [`${pluginPath}/`, ['index.html', 'text/html; charset=utf-8']],
  [`${pluginPath}/styles.css`, ['styles.css', 'text/css; charset=utf-8']]
]);

let activeMaintenanceService;

export function runNoteMaintenance(input) {
  if (!activeMaintenanceService) throw new Error('Command Center Note maintenance is not ready.');
  return activeMaintenanceService.run(input);
}

/** @typedef {import('openclaw/plugin-sdk/plugin-entry').OpenClawPluginApi} OpenClawPluginApi */

async function serveShell(req, res) {
  return serveShellAsset(req, res, { assets });
}

function createMetadataService(api) {
  let metadataService;
  let sourceService;
  let maintenanceService;
  return {
    id: 'command-center-metadata',
    start() {
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const gatewayAvailable = typeof api.runtime?.gateway?.request === 'function';
      const capabilities = { notes: true, sessions: gatewayAvailable, scheduler: gatewayAvailable, activity: true, search: false, analysis: false, attention: false };
      metadataService = openCommandCenterMetadataService({
        stateDir,
        capabilities
      });
      sourceService = createAuthoritativeSourceService({
        metadata: metadataService,
        api,
        capabilities
      });
      maintenanceService = createNoteMaintenanceService({ sourceService, metadata: metadataService });
      activeMaintenanceService = maintenanceService;
    },
    stop() {
      sourceService?.close?.();
      metadataService?.close();
      metadataService = undefined;
      sourceService = undefined;
      maintenanceService = undefined;
      activeMaintenanceService = undefined;
    },
    get sourceService() {
      return sourceService;
    },
    get maintenanceService() {
      return maintenanceService;
    }
  };
}

export default definePluginEntry({
  id: pluginId,
  name: 'Command Center',
  description: 'A responsive Command Center control destination.',
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
    api.registerHttpRoute({
      path: pluginPath,
      auth: 'gateway',
      match: 'prefix',
      handler: serveShell
    });
    registerBridgeMethods(api, serviceProxy);
    api.registerService(service);
  }
});
