import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../openclaw.plugin.json' with { type: 'json' };
import plugin from '../src/plugin.mjs';
import { legacyDiscordMigrationConfigSchema } from '../src/migration/config.mjs';

test('runtime and discovery share the entire closed plugin configuration schema', () => {
  assert.deepEqual(plugin.configSchema, manifest.configSchema);
  assert.equal(plugin.configSchema.additionalProperties, false);
  const source = plugin.configSchema.properties.preservedHistorySource;
  assert.equal(source.additionalProperties, false);
  assert.deepEqual(source.required, ['root', 'expectedManifestSha256', 'trustedPublicKeySha256']);
  assert.equal(source.properties.attachmentDispositions.items.additionalProperties, false);
});

test('shared schema preserves existing migration limits and fail-closed capability switches', () => {
  assert.deepEqual(legacyDiscordMigrationConfigSchema, manifest.configSchema.properties.legacyDiscordMigration);
  assert.equal(legacyDiscordMigrationConfigSchema.properties.channels.maxItems, 100);
  for (const name of ['notes', 'sessions', 'scheduler', 'activity', 'search', 'analysis', 'attention']) {
    assert.deepEqual(plugin.configSchema.properties.sourceCapabilities.properties[name], { const: false });
  }
  assert.equal(plugin.configSchema.properties.sourceCapabilities.additionalProperties, false);
  assert.deepEqual(plugin.configSchema.properties.controlUiGrant.const, false);
});
