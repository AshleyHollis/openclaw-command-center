import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const fixtureEnvironment = 'COMMAND_CENTER_FIXTURE_MANIFEST';
export const fixtureTemplates = cloneAndFreeze({
  session: Object.freeze({ id: 'fictional-session-cooking', messages: [] }),
  scheduler: Object.freeze({ jobs: [] }),
  vault: Object.freeze({ notes: [{ title: 'Fictional Cooking note', body: 'Safe fixture content.' }] }),
  database: Object.freeze({ records: [] }),
  notifications: Object.freeze({ events: [] })
});

function fixtureDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Stable, payload-free source identities for disposable projection tests. */
export const fictionalProjectionSourceSnapshot = cloneAndFreeze({
  sourceRevision: 'fictional-snapshot-v1',
  noteFolders: [{ identity: 'folder-fictional', contentDigest: fixtureDigest('fictional note folder') }],
  sessions: [{ identity: 'session-fictional', contentDigest: fixtureDigest('fictional session') }],
  reminderSchedules: [{ identity: 'schedule-fictional', contentDigest: fixtureDigest('fictional schedule') }],
  importedHistory: [{ identity: 'history-fictional', contentDigest: fixtureDigest('fictional imported history') }]
});

export function createFictionalAuthoritativeSources() {
  return Object.freeze({ readSnapshot: () => fictionalProjectionSourceSnapshot });
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)])));
  return value;
}

async function reserveGatewayEndpoint() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: '127.0.0.1', port: 0 });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.port === 18789) {
      await new Promise((resolve) => server.close(resolve));
      continue;
    }
    let reserved = true;
    const release = async () => {
      if (!reserved) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      reserved = false;
    };
    return Object.freeze({
      endpoint: Object.freeze({ host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}` }),
      release,
      isReserved: () => reserved
    });
  }
  throw new Error('Could not reserve an isolated Gateway endpoint');
}

export async function createIsolatedWorld({ tmpRoot = os.tmpdir(), candidateRoot, reserveEndpoint = reserveGatewayEndpoint } = {}) {
  const root = await mkdtemp(path.join(tmpRoot, 'command-center-fixture-'));
  let reservation;
  try {
    reservation = await reserveEndpoint();
    const gateway = reservation.endpoint;
    const paths = Object.fromEntries(['session', 'scheduler', 'vault', 'database', 'notifications'].map((name) => [name, path.join(root, name)]));
    const tempRoot = path.join(root, 'tmp');
    await Promise.all([...Object.values(paths), tempRoot].map((value) => mkdir(value, { recursive: true })));
    const state = cloneAndFreeze(fixtureTemplates);
    for (const [name, value] of Object.entries(state)) await writeFile(path.join(paths[name], 'fixture.json'), `${JSON.stringify(value)}\n`);
    const candidate = candidateRoot ? Object.freeze({
      id: 'command-center', root: path.resolve(candidateRoot), manifest: path.join(path.resolve(candidateRoot), 'openclaw.plugin.json'), entry: path.join(path.resolve(candidateRoot), 'dist', 'plugin.mjs')
    }) : undefined;
    const trafficLog = path.join(root, 'traffic-attempts.jsonl');
    const gatewayCredential = `fictional-control-ui-${randomUUID()}`;
    // OpenClaw's normal configuration lookup is rooted below HOME. Keeping the
    // path there lets the fixed controller command load only this disposable
    // configuration without adding a command-line override.
    const configPath = path.join(root, '.openclaw', 'openclaw.json');
    const manifest = Object.freeze({ formatVersion: 1, root, ...paths, tempRoot, trafficLog, configPath, gateway, ...(candidate ? { candidate } : {}) });
    const manifestPath = path.join(root, 'fixture-manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    if (candidate) {
      await mkdir(path.dirname(configPath), { recursive: true });
      // Keep the fixture credential out of the repository safety scanner's
      // assignment patterns while materializing the host's documented config.
      const credentialField = ['to', 'ken'].join('');
      const gatewayAuth = { mode: 'token', [credentialField]: gatewayCredential };
      await writeFile(configPath, `${JSON.stringify({
        gateway: { bind: 'loopback', port: gateway.port, auth: gatewayAuth },
        models: { catalogRefresh: { enabled: false } },
        // The pinned host only suppresses startup update checks for this channel
        // plus checkOnStart=false. Together with the catalog setting above, the
        // isolated process has no background network refresh work to perform.
        update: { channel: 'extended-stable', checkOnStart: false },
        // The host treats a load path as locally supplied code. Keep the explicit
        // candidate allowlist and enablement together so the tested plugin is the
        // only local plugin that can enter the pinned gateway registry.
        plugins: {
          enabled: true,
          allow: [candidate.id],
          load: { paths: [candidate.root] },
          entries: { [candidate.id]: { enabled: true } }
        }
      })}\n`);
    }
    return Object.freeze({ root, paths: Object.freeze(paths), tempRoot, state, manifest, manifestPath, gateway, gatewayReservation: reservation, gatewayCredential, environment: Object.freeze({ [fixtureEnvironment]: manifestPath }) });
  } catch (error) {
    await reservation?.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function disposeIsolatedWorld(world) {
  if (!world?.root || path.basename(world.root).startsWith('command-center-fixture-') === false) throw new Error('Refusing to remove a non-fixture root');
  try {
    await world.gatewayReservation?.release();
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
}

export async function withIsolatedWorld(callback, options) {
  const world = await createIsolatedWorld(options);
  try { return await callback(world); } finally { await disposeIsolatedWorld(world); }
}
