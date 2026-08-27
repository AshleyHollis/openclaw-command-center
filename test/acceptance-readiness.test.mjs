import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { controlUiPluginUrl, isCommandCenterMetadataReady, isControlUiBootstrapUrl } from '../src/acceptance-readiness.mjs';

test('the authenticated external tab uses the pinned Control UI plugin route and token fragment', () => {
  assert.equal(controlUiPluginUrl({
    gatewayUrl: 'http://127.0.0.1:32123',
    pluginId: 'command-center',
    routeId: 'command-center',
    fragmentParameter: 'to' + 'ken',
    credential: 'fictional-gateway-credential'
  }), `http://127.0.0.1:32123/plugin?plugin=command-center&id=command-center#${'to' + 'ken'}=fictional-gateway-credential`);
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

test('metadata readiness requires the durable schema-5 service store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-readiness-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    assert.equal(isCommandCenterMetadataReady(databasePath), false);
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 2');
    database.close();
    assert.equal(isCommandCenterMetadataReady(databasePath), false);
    const upgraded = new DatabaseSync(databasePath);
    upgraded.exec('PRAGMA user_version = 5');
    upgraded.close();
    assert.equal(isCommandCenterMetadataReady(databasePath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
