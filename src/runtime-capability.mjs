/**
 * Controller-pinned Control UI integration seam. The JSON document is kept as
 * the declarative mirror for preflight inspection and this module is the
 * source graph entry for runtime-facing harness code.
 */
export const runtimeCapability = Object.freeze({
  schemaVersion: 1,
  id: 'openclaw-control-ui-v1',
  bootstrap: Object.freeze({
    path: '/__openclaw__/control-ui-config.json',
    grantsField: 'pluginFrameGrants',
    providesCredential: false
  }),
  authentication: Object.freeze({
    mode: 'token',
    configPaths: Object.freeze(['gateway.auth.mode', 'gateway.auth.token']),
    urlFragmentParameter: 'token'
  }),
  diagnostics: Object.freeze({
    requiredEvidenceFields: Object.freeze(['readinessAttempts', 'url', 'status', 'error', 'bodyKeys'])
  })
});
