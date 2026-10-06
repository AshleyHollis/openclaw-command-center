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
