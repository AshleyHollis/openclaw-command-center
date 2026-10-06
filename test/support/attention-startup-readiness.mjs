import { fetchJsonWithDeadline } from '../../src/host-harness.mjs';
import { readNativeControlUiReadiness } from './first-live-native-journey.mjs';

// The Node WebSocket error erases the refused-listener cause. Probe HTTP first
// so the existing readiness owner can retry only known transport failures,
// inside its original deadline. Health is not authenticated plugin readiness.
export async function readAttentionStartupReadiness({ world, signal }, {
  fetchImpl, readCatalog = readNativeControlUiReadiness
} = {}) {
  signal?.throwIfAborted();
  const { response, body, parseError } = await fetchJsonWithDeadline(`${world.gateway.url}/healthz`, { signal }, {
    label: 'Attention startup listener', timeoutMs: 10_000, ...(fetchImpl ? { fetchImpl } : {})
  });
  if (!response.ok) throw new Error(`Attention startup listener refused HTTP ${response.status}.`);
  if (response.status !== 200 || parseError || body?.ok !== true || body?.status !== 'live') {
    throw new Error('Attention startup listener returned an invalid liveness response.');
  }
  signal?.throwIfAborted();
  return readCatalog({ world, signal });
}

// Reuse the signed Control UI fixture's normal host-issued build identity.
// A signed CLI is intentionally ephemeral and cannot attest a durable operator.
export async function readAttentionControlUiBuildId({ world, signal }, { fetchImpl } = {}) {
  signal?.throwIfAborted();
  const { response, body, parseError } = await fetchJsonWithDeadline(`${world.gateway.url}/__openclaw__/control-ui-config.json`, {
    headers: { authorization: `Bearer ${world.gatewayCredential}` }, redirect: 'error', signal
  }, { label: 'Attention authenticated Control UI build identity', timeoutMs: 10_000, ...(fetchImpl ? { fetchImpl } : {}) });
  if (response.status !== 200 || !response.ok) throw new Error(`Attention Control UI build identity refused HTTP ${response.status}.`);
  if (parseError || typeof body?.serverBuildId !== 'string' || !body.serverBuildId.trim()) {
    throw new Error('Attention Control UI build identity is invalid.');
  }
  signal?.throwIfAborted();
  return body.serverBuildId;
}
