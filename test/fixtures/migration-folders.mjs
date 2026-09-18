import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLegacyDiscordMigrationService } from '../../src/migration/service.mjs';

// Materialize the old fictional path vocabulary inside each test's own state.
// No verifier is replaced: the production directory, marker and SQLite lease
// owners run against real folders. Preserve lexical aliases for preflight tests.
export function migrationFixtureFolder(metadata, requested) {
  if (!requested.startsWith('/fictional/vault/')) return requested;
  const root = path.join(path.dirname(metadata.databasePath), 'fixture-vault');
  const result = `${root}/${requested.slice('/fictional/vault/'.length)}`;
  const relative = path.relative(root, path.resolve(result));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  mkdirSync(result, { recursive: true });
  return result;
}

export function migrationFixtureConfig(metadata, config) {
  if (!config || !Array.isArray(config.channels)) return config;
  return { ...config, channels: config.channels.map(channel => ({ ...channel,
    ...(typeof channel.noteFolderPath === 'string' ? { noteFolderPath: migrationFixtureFolder(metadata, channel.noteFolderPath) } : {})
  })) };
}

export function createMigrationFixtureService(options) {
  assert.equal(options.folderVerifier, undefined, 'Migration fixtures must use the real folder verifier');
  return createLegacyDiscordMigrationService({ ...options, config: migrationFixtureConfig(options.metadata, options.config) });
}
