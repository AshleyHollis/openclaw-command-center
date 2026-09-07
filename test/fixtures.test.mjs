import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'node:net';
import { createIsolatedWorld, disposeIsolatedWorld, fixtureEnvironment, withIsolatedWorld } from '../src/fixtures.mjs';

let nextGatewayPort = 21000;
function reserveFixtureEndpoint() {
  let reserved = true;
  const port = nextGatewayPort++;
  return Object.freeze({
    endpoint: Object.freeze({ host: '127.0.0.1', port, url: `http://127.0.0.1:${port}` }),
    release: async () => { reserved = false; },
    isReserved: () => reserved
  });
}

test('fixtures are fresh, frozen, explicit, repeatable, and disposable', async () => {
  const first = await createIsolatedWorld({ reserveEndpoint: reserveFixtureEndpoint });
  const second = await createIsolatedWorld({ reserveEndpoint: reserveFixtureEndpoint });
  assert.notEqual(first.root, second.root);
  assert.notEqual(first.gateway.port, second.gateway.port);
  assert.equal(first.gateway.host, '127.0.0.1');
  assert.notEqual(first.gateway.port, 18789);
  assert.equal(first.gatewayReservation.isReserved(), true);
  assert.equal(Object.isFrozen(first.state.session), true);
  assert.equal(Object.isFrozen(first.state.session.messages), true);
  assert.deepEqual(JSON.parse(await readFile(first.manifestPath)), first.manifest);
  assert.equal(first.environment[fixtureEnvironment], first.manifestPath);
  await disposeIsolatedWorld(first);
  await assert.rejects(access(first.root));
  await disposeIsolatedWorld(second);
});

test('fixture cleanup runs after a failure', async () => {
  let root;
  await assert.rejects(withIsolatedWorld(async (world) => { root = world.root; throw new Error('fictional failure'); }, { reserveEndpoint: reserveFixtureEndpoint }));
  await assert.rejects(access(root));
});

test('fixture manifest supplies the built candidate to the isolated host seam', async () => {
  const world = await createIsolatedWorld({ candidateRoot: process.cwd(), reserveEndpoint: reserveFixtureEndpoint });
  try {
    assert.equal(world.manifest.candidate.id, 'command-center');
    assert.match(world.manifest.candidate.entry, /dist\/plugin\.mjs$/);
    assert.match(world.manifest.configPath, /\.openclaw\/openclaw\.json$/);
    assert.match(world.gatewayCredential, /^fictional-control-ui-/);
    assert.equal(world.manifest.gateway.url, world.gateway.url);
    assert.notEqual(world.gateway.port, 18789);
    assert.equal(world.manifest.tempRoot, world.tempRoot);
    const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    assert.equal(config.gateway.auth.mode, 'token');
    assert.equal(config.gateway.auth.token, world.gatewayCredential);
    assert.equal(config.gateway.port, world.gateway.port);
    assert.equal(config.gateway.controlUi?.experimental?.customPlugins, true);
    assert.equal(config.models.catalogRefresh.enabled, false);
    assert.deepEqual(config.update, { channel: 'extended-stable', checkOnStart: false });
    assert.equal(config.plugins.enabled, true);
    assert.deepEqual(config.plugins.allow, ['command-center']);
    assert.deepEqual(config.plugins.load.paths, [world.manifest.candidate.root]);
  } finally { await disposeIsolatedWorld(world); }
});

test('a released real fixture reservation can reacquire only its unchanged loopback endpoint', async () => {
  const world = await createIsolatedWorld({ candidateRoot: process.cwd() });
  const manifest = await readFile(world.manifestPath);
  const config = await readFile(world.manifest.configPath);
  const competitor = createServer(socket => socket.destroy());
  try {
    await world.gatewayReservation.release();
    await new Promise((resolve, reject) => { competitor.once('error', reject); competitor.listen(world.gateway.port, world.gateway.host, resolve); });
    await assert.rejects(world.gatewayReservation.reacquire(), { code: 'EADDRINUSE' });
    assert.equal(world.gatewayReservation.isReserved(), false);
    await new Promise(resolve => competitor.close(resolve));
    await world.gatewayReservation.reacquire();
    assert.equal(world.gatewayReservation.isReserved(), true);
    assert.deepEqual(await readFile(world.manifestPath), manifest);
    assert.deepEqual(await readFile(world.manifest.configPath), config);
    assert.equal(world.gatewayReservation.endpoint, world.gateway);
  } finally {
    if (competitor.listening) await new Promise(resolve => competitor.close(resolve));
    await disposeIsolatedWorld(world);
  }
});

test('reservation cancellation cannot leak an acquiring listener or retire an acquired owner', async () => {
  const world = await createIsolatedWorld();
  try {
    await world.gatewayReservation.release();
    const acquiring = new AbortController();
    const pending = world.gatewayReservation.reacquire({ signal: acquiring.signal });
    acquiring.abort(new Error('cancel acquisition'));
    await assert.rejects(pending, /cancel acquisition/u);
    const acquired = new AbortController();
    await world.gatewayReservation.reacquire({ signal: acquired.signal });
    acquired.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(world.gatewayReservation.isReserved(), true);
  } finally { await disposeIsolatedWorld(world); }
});
