import assert from 'node:assert/strict';

// The resolver preserves artifact provenance even for a locally built exact
// source. Build-info supplies its commit; it must not be relabelled as ref.
export function validateProducedNativePackageMetadata(metadata, nativeSha) {
  assert.equal(metadata.name, 'openclaw');
  assert.equal(metadata.packageSourceSha, nativeSha);
  assert.equal(metadata.version, '2026.10.1');
  if (metadata.source === 'ref') {
    assert.equal(metadata.packageRef, nativeSha);
  } else {
    assert.equal(metadata.source, 'artifact', 'Unsupported native package provenance');
    assert.equal(metadata.packageRef, '');
    assert.equal(metadata.packageTrustedReason, 'package-build-info');
  }
  return metadata;
}
