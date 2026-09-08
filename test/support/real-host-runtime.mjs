import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chromium } from 'playwright';
import { HarnessFailure, redact, stopPinnedHost } from '../../src/host-harness.mjs';
import { assertWebSocketDestination, boundedTrafficEvidence } from '../../src/isolation.mjs';
import { recordBounded } from '../../src/browser-evidence.mjs';
import { createGatewayFrameWaiter } from '../../src/acceptance-gateway.mjs';

// One owner for real browser/transport behavior shared by retained native and
// pending-cutover compatibility/migration journeys. No response substitutes.
export const EXTERNAL_OPERATION_TIMEOUT_MS = 60_000;
// The UI retains queued requests for 180s while honoring the host's rolling
// quotas. Queue time remains inside all performance measurements.
export const BRIDGE_UI_OPERATION_BUDGET_MS = 185_000;
export const acceptanceSignalContext = new AsyncLocalStorage();

export function createGatewayDeviceIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return Object.freeze({ privateKey, publicKey: rawPublicKey.toString('base64url'), deviceId: createHash('sha256').update(rawPublicKey).digest('hex') });
}

function signedGatewayDevice(identity, { nonce, credential, scopes, client }) {
  const signedAt = Date.now();
  const payload = ['v3', identity.deviceId, client.id, client.mode, 'operator', scopes.join(','), String(signedAt), credential, nonce, client.platform.toLowerCase(), ''].join('|');
  return { id: identity.deviceId, publicKey: identity.publicKey, signature: sign(null, Buffer.from(payload), identity.privateKey).toString('base64url'), signedAt, nonce };
}

export async function withDeadline(label, operation, timeoutMs = EXTERNAL_OPERATION_TIMEOUT_MS, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const pending = Promise.resolve().then(() => operation(controller.signal));
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  void pending.then(async (value) => {
    if (!timedOut) return;
    try {
      if (value?.child) await stopPinnedHost(value.child);
      else await value?.close?.();
    } catch { /* a timed-out operation remains failed; cleanup is best effort */ }
  }, () => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new HarnessFailure('operation-timeout', `${label} exceeded its ${timeoutMs} ms deadline`)); }, timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

export function stopHostOnAbort(signal, host) {
  const stop = () => { void stopPinnedHost(host.child); };
  signal?.addEventListener('abort', stop, { once: true });
  return () => signal?.removeEventListener('abort', stop);
}

export async function launchManagedBrowser(options) {
  const server = await chromium.launchServer({ ...options, args: ['--no-proxy-server', ...(options?.args ?? [])] });
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return { browser, server, close: async () => { await browser.close(); await server.close().catch(() => {}); } };
  } catch (error) {
    await server.kill().catch(() => {});
    throw error;
  }
}

export async function closeManagedBrowser(managed, signal) {
  if (!managed) return;
  const forceClose = () => { void managed.server.kill(); };
  if (signal?.aborted) forceClose();
  else signal?.addEventListener('abort', forceClose, { once: true });
  try { await managed.close(); }
  finally { signal?.removeEventListener('abort', forceClose); }
}

export function redactBrowserEvidence(value) {
  return redact(String(value).replace(/([?#&](?:token|password|secret|key)=)[^&#\s]+/gi, '$1[redacted]'), 300);
}

export function boundedHostEvidence(diagnostics) {
  return {
    stdout: diagnostics.stdout,
    stderr: diagnostics.stderr,
    category: diagnostics.category,
    traffic: boundedTrafficEvidence(diagnostics.guard.attempts)
  };
}

export async function configureEvidencePage(page, browserGuard, evidence, { destinationForRequest } = {}) {
  page.setDefaultTimeout(BRIDGE_UI_OPERATION_BUDGET_MS);
  await page.route('**/*', async (route) => {
    const request = route.request();
    const hostName = new URL(request.url()).hostname;
    const destination = destinationForRequest?.(request) ?? hostName;
    try { browserGuard.assert(destination, 'browser'); recordBounded(evidence.requests, redactBrowserEvidence(`${request.method()} ${request.url()}`)); await route.continue(); }
    catch (error) { recordBounded(evidence.errors, redactBrowserEvidence(error.message)); await route.abort(); }
  });
  await page.routeWebSocket('**/*', (socket) => {
    try { assertWebSocketDestination(browserGuard, socket.url()); socket.connectToServer(); }
    catch (error) { recordBounded(evidence.errors, redactBrowserEvidence(error.message)); }
  });
  page.on('console', (message) => recordBounded(evidence.console, redactBrowserEvidence(message.text())));
  page.on('pageerror', (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
  page.on('response', (response) => {
    let pathName = '[invalid-url]';
    try { pathName = new URL(response.url()).pathname; } catch { /* bounded invalid URL evidence below */ }
    recordBounded(evidence.responses, redactBrowserEvidence(`${response.status()} ${response.request().method()} ${pathName}`));
  });
}

class GatewayConnectFailure extends Error {
  constructor(error, requestSite) {
    super(`Authenticated Gateway connect failed: ${error?.code ?? 'unknown'}`, { cause: requestSite });
    // Only the frozen host's exact startup contract is eligible for polling.
    // Generic UNAVAILABLE, profile/auth failures and method refusals are not.
    this.startupPending = error?.code === 'UNAVAILABLE' && error?.retryable === true
      && error?.details?.reason === 'startup-sidecars';
  }
}

export function isGatewayStartupPending(error) {
  return error instanceof GatewayConnectFailure && error.startupPending === true;
}

export async function requestAuthenticatedGateway({ gatewayUrl, credential, method, params = {}, scopes = ['operator.read'], responseTimeoutMs = 10_000, signal, deviceIdentity, controlUiBuildId }) {
  const requestSite = new Error(`Authenticated Gateway request site: ${method}`);
  signal ??= acceptanceSignalContext.getStore();
  signal?.throwIfAborted();
  const controlUi = controlUiBuildId !== undefined;
  if (controlUi) assert.ok(typeof controlUiBuildId === 'string' && controlUiBuildId.trim());
  if (controlUi) assert.ok(deviceIdentity, 'Control UI preparation requires a signed device identity');
  const socket = controlUi
    ? new WebSocket(gatewayUrl.replace(/^http/u, 'ws'), { headers: { Origin: new URL(gatewayUrl).origin } })
    : new WebSocket(gatewayUrl.replace(/^http/u, 'ws'));
  const waitForFrame = createGatewayFrameWaiter(socket, { method, signal, requestSite });
  const abortSocket = () => socket.close();
  signal?.addEventListener('abort', abortSocket, { once: true });
  try {
    const challengePromise = waitForFrame((frame) => frame?.type === 'event' && frame.event === 'connect.challenge', 10_000, 'challenge');
    const openedPromise = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('Gateway connection aborted.')); };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(`Authenticated Gateway connection failed${closeDetail()}.`)); };
      const onClose = () => { cleanup(); reject(new Error(`Authenticated Gateway connection closed${closeDetail()}.`)); };
      const closeDetail = () => {
        const code = Number(socket.closeCode);
        const reason = String(socket.reason ?? '').slice(0, 120);
        return Number.isInteger(code) && code > 0 ? ` (code ${code}${reason ? `: ${reason}` : ''})` : '';
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Authenticated Gateway connection timed out.')); }, 10_000);
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      socket.addEventListener('close', onClose, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const [, challenge] = await Promise.all([openedPromise, challengePromise]);
    assert.equal(typeof challenge.payload?.nonce, 'string');
    const connectId = `command-center-acceptance-connect-${randomUUID()}`;
    const client = controlUi ? { id: 'openclaw-control-ui', version: '1', platform: 'test', mode: 'ui', buildId: controlUiBuildId }
      : { id: 'cli', version: '1', platform: 'test', mode: 'cli' };
    const device = deviceIdentity ? signedGatewayDevice(deviceIdentity, { nonce: challenge.payload.nonce, credential, scopes, client }) : undefined;
    socket.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client, caps: [], commands: [], role: 'operator', scopes, auth: { ['to' + 'ken']: credential }, ...(device ? { device } : {}) } }));
    const connected = await waitForFrame((frame) => frame?.type === 'res' && frame.id === connectId);
    if (!connected.ok) throw new GatewayConnectFailure(connected.error, requestSite);
    const requestId = `command-center-acceptance-${randomUUID()}`;
    socket.send(JSON.stringify({ type: 'req', id: requestId, method, params }));
    const response = await waitForFrame((frame) => frame?.type === 'res' && frame.id === requestId, responseTimeoutMs, 'method-response');
    if (!response.ok) {
      const detail = redactBrowserEvidence(response.error?.message ?? 'no bounded detail');
      throw new Error(`Authenticated ${method} failed: ${response.error?.code ?? 'unknown'} (${detail})`);
    }
    return response.payload;
  } finally { signal?.removeEventListener('abort', abortSocket); socket.close(); }
}

export async function readAuthenticatedHistory({ gatewayUrl, credential, sessionKey, signal }) {
  return requestAuthenticatedGateway({ gatewayUrl, credential, method: 'chat.history', params: { sessionKey }, signal });
}
