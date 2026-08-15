import { createUnavailableArchiveBridge } from './archive-bridge.mjs';
import { createPersistenceService } from './service.mjs';

export const persistenceRuntimeServiceId = 'command-center-persistence';

/**
 * Bind the public persistence boundary to OpenClaw's documented long-lived
 * plugin-service lifecycle. `stateDir` is supplied by the host; no state
 * discovery is performed here. The current pinned SDK exposes no archive
 * receipt seam, so destructive migrations remain fail-closed by default.
 */
export function createCommandCenterPersistenceRuntimeService({
  createService = createPersistenceService,
  archiveBridgeFactory = () => createUnavailableArchiveBridge()
} = {}) {
  let persistence;
  return Object.freeze({
    id: persistenceRuntimeServiceId,
    async start(context) {
      if (persistence) return;
      persistence = createService({
        stateDirectory: context?.stateDir,
        archiveBridge: archiveBridgeFactory(context)
      });
      await persistence.initialize();
    },
    async stop() {
      const active = persistence;
      persistence = undefined;
      await active?.close();
    }
  });
}
