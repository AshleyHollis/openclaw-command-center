import manifest from '../openclaw.plugin.json' with { type: 'json' };

// The manifest is the sole schema authoring surface. Build emits an equivalent
// data-only module inside dist so runtime configuration is covered by its digest.
export const pluginConfigSchema = manifest.configSchema;
