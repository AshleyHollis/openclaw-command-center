import path from 'node:path';
import { openCommandCenterMetadataService } from '../metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../metadata/path.mjs';
import { createNativeDeveloperWorkCompanion } from './native-companion.mjs';

// Importable library entry only. This module does not register a plugin, tool,
// RPC method or background delivery. The Gateway installation owner must pin
// this artifact and its configuration; no request may supply installation.
export function openInstalledNativeDeveloperWorkCompanion({ installation, gatewayRequest, chatBaseUrl, now } = {}) {
  if (!installation || typeof installation !== 'object' || Array.isArray(installation) ||
      Object.keys(installation).some(key => !['stateDir', 'sourceEnvironment', 'producerId', 'role', 'allowedProjects'].includes(key)) ||
      typeof installation.stateDir !== 'string' || !path.isAbsolute(installation.stateDir) ||
      path.normalize(installation.stateDir) !== installation.stateDir ||
      typeof installation.sourceEnvironment !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(installation.sourceEnvironment) ||
      typeof installation.producerId !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/u.test(installation.producerId) ||
      !['worker', 'controller'].includes(installation.role) ||
      !Array.isArray(installation.allowedProjects) || installation.allowedProjects.length === 0 ||
      installation.allowedProjects.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(value)) ||
      new Set(installation.allowedProjects).size !== installation.allowedProjects.length) {
    throw new TypeError('A fixed installation-owned Developer Work scope is required.');
  }
  // Preparation may create/migrate this exact CC ledger. Do it before any
  // future host admission; a held synchronous callback must only commit work.
  const metadata = openCommandCenterMetadataService({ stateDir: installation.stateDir,
    capabilities: { notes: false, sessions: false, scheduler: false, activity: true, analysis: false, attention: true, search: false } });
  try {
    if (metadata.databasePath !== resolveCommandCenterDatabasePath(installation.stateDir) ||
        metadata.getOperatingStatus().mode === 'recovery-only') throw new Error('Fixed Developer Work ledger is unavailable.');
    const authority = Object.freeze({ producerId: installation.producerId, role: installation.role,
      allowedProjects: Object.freeze([...installation.allowedProjects]) });
    const companion = createNativeDeveloperWorkCompanion({ metadata, authority, gatewayRequest, chatBaseUrl, now });
    let closed = false;
    return Object.freeze({
      // The installation owner must also pin sourceEnvironment to the host SDK's
      // authoritative selection before a submission adapter can be attached.
      sourceEnvironment: installation.sourceEnvironment,
      check: companion.check,
      chatTarget: companion.chatTarget,
      reconcile({ logicalOperationId, draft } = {}) {
        if (closed) throw Object.assign(new Error('Developer Work companion is closed.'), { code: 'producer-closed' });
        return metadata.reconcileDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId, draft });
      },
      close() { if (closed) return; closed = true; companion.close(); metadata.close(); }
    });
  } catch (error) { metadata.close(); throw error; }
}
