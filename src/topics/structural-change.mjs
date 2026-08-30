import { createHash } from 'node:crypto';

export function structuralChangeDigest(plan) {
  const canonical = canonicalJson(plan);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function canonicalJson(value) {
  const canonicalize = (item) => Array.isArray(item) ? item.map(canonicalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonicalize(item[key])]))
      : item;
  return JSON.stringify(canonicalize(value));
}

export function freezePlan(plan) {
  const digest = structuralChangeDigest(plan);
  const hex = digest.slice('sha256:'.length);
  const structuralChangeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(parseInt(hex.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0')}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
  return Object.freeze({ ...plan, structuralChangeId, digest, schemaVersion: 1 });
}

export function assertPreviewConfirmation(preview, input = {}) {
  const { digest: suppliedDigest, structuralChangeId: _structuralChangeId, schemaVersion: _schemaVersion, ...unsigned } = preview;
  if (suppliedDigest !== structuralChangeDigest(unsigned)) {
    const error = new Error('Structural Change preview is not canonical.');
    error.code = 'conflict';
    throw error;
  }
  const digest = input.previewDigest ?? input.digest;
  if (typeof digest !== 'string' || digest !== preview.digest) {
    const error = new Error('Structural Change preview digest is stale or missing.');
    error.code = 'conflict';
    error.currentDigest = preview.digest;
    throw error;
  }
  if (input.structuralChangeId !== preview.structuralChangeId) {
    const error = new Error('Structural Change identity is stale or missing.');
    error.code = 'conflict';
    throw error;
  }
  const expected = input.expectedRevisions ?? input.revisions;
  if (expected !== undefined) {
    const expectedJson = canonicalJson(expected);
    const previewJson = canonicalJson(preview.expectedRevisions ?? []);
    if (expectedJson !== previewJson) {
      const error = new Error('Structural Change expected revisions are incomplete or stale.');
      error.code = 'conflict';
      throw error;
    }
  }
  return preview;
}
