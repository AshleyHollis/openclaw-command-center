function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function bridgeProtocolResult(bridge, supportedRange) {
  const protocolVersion = bridge?.protocolVersion;
  const compatible = Number.isInteger(protocolVersion) && protocolVersion >= supportedRange.min && protocolVersion <= supportedRange.max;
  return { compatible, protocolVersion };
}

/**
 * The host owns the archive. Command Center only asks its supplied broad
 * archive bridge for a receipt and verifies that receipt against the exact
 * pre-migration state. No Command Center archive format is created here.
 */
export async function requireVerifiedSnapshot(bridge, expected) {
  if (!bridge || typeof bridge.createSnapshot !== 'function' || typeof bridge.verifySnapshot !== 'function') {
    throw new Error('A compatible broad-archive bridge is required before a destructive migration');
  }
  const receipt = await bridge.createSnapshot(expected);
  if (!receipt?.complete || !same(receipt.bindings, expected)) throw new Error('Broad-archive snapshot receipt is incomplete or mismatched');
  const verified = await bridge.verifySnapshot(receipt, expected);
  if (verified !== true) throw new Error('Broad-archive snapshot receipt could not be verified');
  return receipt;
}
