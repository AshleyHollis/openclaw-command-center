const hostedCatalogOrigin = 'https://clawhub.ai';
const hostedCatalogPath = '/v1/feeds/plugins';

export function isHostedPluginCatalogRequest(input) {
  try {
    const url = new URL(input instanceof URL ? input.href : String(input));
    return url.origin === hostedCatalogOrigin && url.pathname === hostedCatalogPath;
  } catch {
    return false;
  }
}

/**
 * The pinned host prewarms its optional public plugin catalog after readiness.
 * In an isolated run, reject that internal refresh before it reaches the
 * network guard, DNS, or TLS. Because no transport operation is attempted, it
 * must not be written to the network-traffic log as an allowed destination.
 */
export function createHostedCatalogIsolationFetch(fetchImpl) {
  async function isolatedFetch(input, init) {
    if (isHostedPluginCatalogRequest(input)) {
      throw new Error('Isolated host disables the optional hosted plugin catalog');
    }
    return await fetchImpl(input, init);
  }
  // The pinned host recognizes this marker and uses the supplied fetch before
  // creating a DNS-pinned dispatcher, so the optional catalog never reaches
  // DNS or TLS in this isolated process.
  Object.defineProperty(isolatedFetch, 'mock', { value: Object.freeze({ isolated: true }) });
  return isolatedFetch;
}
