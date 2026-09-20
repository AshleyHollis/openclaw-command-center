/** Process preload used only by the isolated acceptance child. */
import dns from 'node:dns';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { destinationFromConnectionArguments } from './child-traffic.mjs';
import { fixtureEnvironment } from './fixtures.mjs';
import { createHostedCatalogIsolationFetch } from './host-catalog-isolation.mjs';
import { isContainedIpcDestination, isLoopbackDestination } from './isolation.mjs';

const manifest = JSON.parse(readFileSync(process.env[fixtureEnvironment], 'utf8'));
const isolatedIpcRoot = typeof manifest.tempRoot === 'string' ? realpathSync(manifest.tempRoot) : null;
function record(entry) {
  appendFileSync(manifest.trafficLog, `${JSON.stringify(entry)}\n`);
}
function guard(value, source) {
  const target = destinationFromConnectionArguments(value);
  let containedIpc = false;
  if (isolatedIpcRoot && isContainedIpcDestination(target, manifest.tempRoot)) {
    try {
      const parent = realpathSync(path.dirname(target));
      containedIpc = parent === isolatedIpcRoot || isContainedIpcDestination(parent, isolatedIpcRoot);
    } catch { /* missing or inaccessible parents remain prohibited */ }
  }
  const permitted = isLoopbackDestination(target) || containedIpc;
  record({ destination: target, source, permitted });
  if (!permitted) throw new Error(`Prohibited isolated child ${source} destination`);
}

function wrap(module, method, source, connection = false) {
  const original = module[method];
  if (typeof original !== 'function') return;
  module[method] = function guarded(value, ...rest) {
    guard(connection ? destinationFromConnectionArguments(value, rest) : value, source);
    return original.call(this, value, ...rest);
  };
}

function wrapDns(module, method, source) {
  const original = module?.[method];
  if (typeof original !== 'function') return;
  module[method] = function guardedDns(hostname, ...rest) {
    guard(hostname, source);
    return original.call(this, hostname, ...rest);
  };
}

wrap(net, 'connect', 'net', true);
wrap(net, 'createConnection', 'net-create', true);
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(value, ...rest) {
  // net.connect() is guarded above. Its implementation subsequently invokes
  // Socket.connect() with an internal argument-less continuation; treating
  // that continuation as a new unknown destination rejects an already
  // admitted loopback connection. Direct Socket.connect() calls still carry
  // their destination and remain fail-closed through this branch.
  const target = destinationFromConnectionArguments(value, rest);
  if (target !== undefined) guard(target, 'net-socket');
  return socketConnect.call(this, value, ...rest);
};
wrap(tls, 'connect', 'tls', true);
wrap(http, 'request', 'http');
wrap(https, 'request', 'https');
wrap(http, 'get', 'http-get');
wrap(https, 'get', 'https-get');
wrap(http2, 'connect', 'http2');

for (const method of ['lookup', 'lookupService', 'reverse', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt']) {
  wrapDns(dns, method, `dns-${method}`);
  wrapDns(dns.promises, method, `dns-promises-${method}`);
  wrapDns(dns.Resolver?.prototype, method, `dns-resolver-${method}`);
  wrapDns(dns.promises?.Resolver?.prototype, method, `dns-promises-resolver-${method}`);
}

const nativeFetch = globalThis.fetch;
if (typeof nativeFetch === 'function') {
  const guardedFetch = function isolatedFetch(input, ...rest) {
    guard(input, 'fetch');
    return nativeFetch.call(this, input, ...rest);
  };
  // Suppress this one optional host refresh before it enters the generic
  // fetch/DNS/TLS path. It is not a permitted network destination because the
  // transport never begins. Every other fetch is checked above.
  globalThis.fetch = process.env.COMMAND_CENTER_DISABLE_HOSTED_PLUGIN_CATALOG === '1'
    ? createHostedCatalogIsolationFetch(guardedFetch)
    : guardedFetch;
}

const NativeWebSocket = globalThis.WebSocket;
if (typeof NativeWebSocket === 'function') {
  globalThis.WebSocket = class GuardedWebSocket extends NativeWebSocket {
    constructor(url, ...rest) {
      guard(url, 'websocket');
      super(url, ...rest);
    }
  };
}

// Built-in ESM named exports otherwise retain the pre-patch functions. Sync
// them after every mutation so imports in the host and its Node children use
// the same fail-closed guard.
syncBuiltinESMExports();
