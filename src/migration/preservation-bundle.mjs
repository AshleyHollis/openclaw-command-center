import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function safeRelativePath(value) {
  if (typeof value !== 'string' || /[\\:\x00-\x1f]/.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) fail('preservation-path-unsafe');
  return value;
}
async function readSourceFile(root, relativePath, limit = 32 * 1024 * 1024) {
  const filename = path.join(root, safeRelativePath(relativePath));
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || path.resolve(await realpath(filename)) !== filename) fail('preservation-path-unsafe');
  if (!Number.isSafeInteger(metadata.size) || metadata.size > limit) fail('preservation-size-limit');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== metadata.dev || before.ino !== metadata.ino) fail('preservation-source-changed');
    if (before.size > limit) fail('preservation-size-limit');
    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || path.resolve(await realpath(filename)) !== filename) fail('preservation-source-changed');
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}
// Shared bounded file read only; each source owner still admits its own root,
// independently approved inventory and source-specific content contract.
export { readSourceFile as readPreservedSourceFile };
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// This is source admission, not an import-completion or release receipt. The
// caller supplies independently approved manifest and signer identities; the
// bundle's own public key is never its own trust authority.
export async function readDiscordPreservationBundle(options) {
  try { return await readVerifiedBundle(options); }
  catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('preservation-')) throw error;
    // Filesystem/crypto/parser exceptions can contain private paths or bytes.
    fail('preservation-source-unavailable');
  }
}

async function readVerifiedBundle({ root, expectedManifestSha256, trustedPublicKeySha256 } = {}) {
  if (![expectedManifestSha256, trustedPublicKeySha256].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail('preservation-trust-required');
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('preservation-path-unsafe');
  root = path.resolve(root);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || path.resolve(await realpath(root)) !== root) fail('preservation-path-unsafe');
  const manifestBytes = await readSourceFile(root, 'manifest.json', 8 * 1024 * 1024);
  const publicPem = await readSourceFile(root, 'signing-public.pem', 16 * 1024);
  const signature = await readSourceFile(root, 'manifest.json.sig', 4096);
  if (sha256(manifestBytes) !== expectedManifestSha256 || sha256(publicPem) !== trustedPublicKeySha256) fail('preservation-trust-mismatch');
  const key = createPublicKey(publicPem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, manifestBytes, key, signature)) fail('preservation-signature-invalid');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.discordRest?.files)) fail('preservation-manifest-invalid');
  const snapshot = new Map();
  const identities = new Set();
  let totalBytes = 0;
  for (const item of manifest.discordRest.files) {
    safeRelativePath(item?.path);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('preservation-manifest-invalid');
    totalBytes += item.bytes;
    if (item.bytes > 32 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024 || manifest.discordRest.files.length > 4096) fail('preservation-size-limit');
    const identity = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    if (identities.has(identity)) fail('preservation-manifest-invalid');
    identities.add(identity);
    const bytes = await readSourceFile(root, item.path);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) fail('preservation-file-mismatch');
    snapshot.set(item.path, bytes);
  }
  const summaryBytes = await readSourceFile(root, 'rest-summary.json', 8 * 1024 * 1024);
  if (sha256(summaryBytes) !== manifest.discordRest.summarySha256) fail('preservation-summary-mismatch');
  return Object.freeze({
    manifestSha256: expectedManifestSha256,
    publicKeySha256: trustedPublicKeySha256,
    baseline: freeze(manifest.baseline),
    manifest: freeze(manifest),
    summary: freeze(JSON.parse(summaryBytes)),
    filePaths: Object.freeze([...snapshot.keys()]),
    readFile(relativePath) {
      if (!snapshot.has(relativePath)) fail('preservation-file-unlisted');
      return Buffer.from(snapshot.get(relativePath));
    }
  });
}
