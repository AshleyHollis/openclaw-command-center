import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { controlUiPluginUrl, isCommandCenterMetadataReady, isCommandCenterMigrationReady, isControlUiBootstrapUrl, isControlUiPluginUrl } from '../src/acceptance-readiness.mjs';
import * as readiness from '../src/acceptance-readiness.mjs';
import { metadataSchemaSql } from '../src/metadata/schema.mjs';

test('startup evidence retains phase duration and advancing counts without storing every poll', () => {
  const observations = [];
  for (let index = 0; index <= 1000; index += 1) {
    readiness.recordStartupObservation(observations, { stage: 'migration', elapsedMs: index * 250, status: 'observed', phase: 'importing', complete: false, importedCount: index, failureCode: null });
  }
  readiness.recordStartupObservation(observations, { stage: 'migration', elapsedMs: 250_250, status: 'observed', phase: 'verifying', complete: false, importedCount: 1000, failureCode: null });
  readiness.recordStartupObservation(observations, { stage: 'http', elapsedMs: 251_000, attempt: 1, status: 200 });
  assert.equal(observations.length, 3);
  assert.equal(observations[0].startedAtMs, 0);
  assert.equal(observations[0].elapsedMs, 250_000);
  assert.equal(observations[0].firstImportedCount, 0);
  assert.equal(observations[0].importedCount, 1000);
  assert.equal(observations[0].samples, 1001);
  assert.equal(observations[1].phase, 'verifying');
  assert.equal(observations[2].stage, 'http');
});

test('startup diagnosis distinguishes unavailable, advancing, review and complete migration without exposing source content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-startup-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'metadata.sqlite');
  assert.deepEqual(readiness.readCommandCenterMigrationProgress(filename), { status: 'unavailable' });
  assert.deepEqual(await readdir(root), [], 'diagnosis cannot create a missing store');
  const database = new DatabaseSync(filename);
  t.after(() => database.close());
  database.exec('PRAGMA user_version = 2');
  assert.deepEqual(readiness.readCommandCenterMigrationProgress(filename), { status: 'schema-pending', schemaVersion: 2 });
  database.exec(metadataSchemaSql);
  database.prepare('INSERT INTO migration_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-discord-v1', 1, 'private-config-digest', 'private-source-digest', 1, 'importing', null, 'private source detail', 0, '2026-09-07T00:00:00Z');
  const importing = readiness.readCommandCenterMigrationProgress(filename);
  assert.deepEqual(importing, { status: 'observed', phase: 'importing', complete: false, revision: 1, failureCode: null, channelCount: 0, completedChannels: 0, expectedCount: 0, importedCount: 0 });
  database.exec("UPDATE migration_state SET phase = 'review', revision = 2, failure_code = 'destination-corrupt'");
  const review = readiness.readCommandCenterMigrationProgress(filename);
  assert.equal(review.phase, 'review');
  assert.equal(review.revision, 2);
  assert.equal(review.failureCode, 'destination-corrupt');
  assert.equal(review.complete, false);
  database.prepare('INSERT INTO migration_completion VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-discord-v1', 1, 'private-config-digest', 'private-source-digest', 0, 0, 1, '2026-09-07T00:00:00Z');
  assert.equal(readiness.readCommandCenterMigrationProgress(filename).complete, true);
  assert.equal(JSON.stringify([importing, review, readiness.readCommandCenterMigrationProgress(filename)]).includes('private-'), false);
});

test('the authenticated external tab uses the pinned Control UI plugin route and token fragment', () => {
  assert.equal(controlUiPluginUrl({
    gatewayUrl: 'http://127.0.0.1:32123',
    pluginId: 'command-center',
    routeId: 'command-center',
    fragmentParameter: 'to' + 'ken',
    credential: 'fictional-gateway-credential'
  }), `http://127.0.0.1:32123/plugin?plugin=command-center&id=command-center#${'to' + 'ken'}=fictional-gateway-credential`);
});

test('mounted srcdoc provenance accepts only the exact authenticated Control UI parent route', () => {
  const options = { gatewayUrl: 'http://127.0.0.1:32123', pluginId: 'command-center', routeId: 'command-center' };
  assert.equal(isControlUiPluginUrl('http://127.0.0.1:32123/plugin?plugin=command-center&id=command-center', options), true);
  assert.equal(isControlUiPluginUrl('http://127.0.0.1:32123/plugins/command-center', options), false);
  assert.equal(isControlUiPluginUrl('http://127.0.0.1:32123/plugin?plugin=command-center&id=other', options), false);
  assert.equal(isControlUiPluginUrl('http://127.0.0.1:32124/plugin?plugin=command-center&id=command-center', options), false);
  assert.equal(isControlUiPluginUrl('http://127.0.0.1:32123/plugin?plugin=command-center&id=command-center&extra=true', options), false);
  assert.equal(isControlUiPluginUrl('not a URL', options), false);
});

test('browser bootstrap matching accepts only the pinned same-origin canonical path or root resource alias', () => {
  const gatewayUrl = 'http://127.0.0.1:32123';
  const bootstrapPath = '/__openclaw__/control-ui-config.json';

  assert.equal(isControlUiBootstrapUrl(
    `${gatewayUrl}${bootstrapPath}`,
    { gatewayUrl, bootstrapPath }
  ), true);
  assert.equal(isControlUiBootstrapUrl(
    `${gatewayUrl}/control-ui-config.json`,
    { gatewayUrl, bootstrapPath }
  ), true);
  assert.equal(isControlUiBootstrapUrl(
    `${gatewayUrl}/nested/control-ui-config.json`,
    { gatewayUrl, bootstrapPath }
  ), false);
  assert.equal(isControlUiBootstrapUrl(
    `http://127.0.0.1:32124${bootstrapPath}`,
    { gatewayUrl, bootstrapPath }
  ), false);
  assert.equal(isControlUiBootstrapUrl('not a URL', { gatewayUrl, bootstrapPath }), false);
});

test('metadata readiness requires the durable schema-8 service store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-readiness-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    assert.equal(isCommandCenterMetadataReady(databasePath), false);
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 2');
    database.close();
    assert.equal(isCommandCenterMetadataReady(databasePath), false);
    const upgraded = new DatabaseSync(databasePath);
    upgraded.exec('PRAGMA user_version = 8');
    upgraded.close();
    assert.equal(isCommandCenterMetadataReady(databasePath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration readiness requires the exact durable existing-data completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-readiness-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 8; CREATE TABLE migration_completion (completion_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL) STRICT;');
    assert.equal(isCommandCenterMigrationReady(databasePath), false);
    database.prepare('INSERT INTO migration_completion (completion_id, schema_version) VALUES (?, ?)').run('other-owner', 1);
    assert.equal(isCommandCenterMigrationReady(databasePath), false);
    database.prepare('INSERT INTO migration_completion (completion_id, schema_version) VALUES (?, ?)').run('legacy-discord-v1', 1);
    assert.equal(isCommandCenterMigrationReady(databasePath), true);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
