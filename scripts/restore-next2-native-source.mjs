import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const nativeSource = Object.freeze({
  bundleSha256: '3395b701b574f2d0c6d7ef5b5f1126304bedba8da77f32b4f958f50624f557a0',
  bundleBytes: 53893,
  prerequisite: '6f17361bd93a84978601eb4c884129ebd714a49b',
  ref: 'refs/heads/work/next2-discord-metadata-native',
  commit: '7aaa0289cc95f683decddfca1cc506e550d24b48',
  tree: 'd53ac1c0b4c7b9dc66273c8907da8e82606ba0ed',
  lockSha256: '0645753229db4c30c75ec2de46e3921d701c1105498f430348f25eae76cf202e'
});

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function git(checkout, ...args) {
  const result = spawnSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(result.status, 0, `Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export async function verifyNativeLock(checkout, expectedSha256 = nativeSource.lockSha256) {
  assert.equal(sha(await readFile(path.join(checkout, 'pnpm-lock.yaml'))), expectedSha256,
    'Restored native pnpm lock SHA256 changed');
}

export async function verifyNext2Bundle(bundle) {
  assert.ok(path.isAbsolute(bundle));
  const bytes = await readFile(bundle);
  assert.equal(bytes.length, nativeSource.bundleBytes, 'Native source bundle length changed');
  assert.equal(sha(bytes), nativeSource.bundleSha256, 'Native source bundle SHA256 changed');
}

export async function restoreNext2NativeSource(bundle, checkout) {
  assert.ok(path.isAbsolute(checkout));
  await verifyNext2Bundle(bundle);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), nativeSource.prerequisite);
  assert.equal(git(checkout, 'status', '--porcelain'), '', 'Prerequisite checkout is dirty');
  git(checkout, 'bundle', 'verify', bundle);
  git(checkout, 'fetch', '--no-tags', bundle, nativeSource.ref);
  assert.equal(git(checkout, 'rev-parse', 'FETCH_HEAD'), nativeSource.commit);
  git(checkout, 'checkout', '--detach', nativeSource.commit);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), nativeSource.commit);
  assert.equal(git(checkout, 'rev-parse', 'HEAD^{tree}'), nativeSource.tree);
  await verifyNativeLock(checkout);
  assert.equal(git(checkout, 'status', '--porcelain'), '', 'Restored native source is dirty');
  git(checkout, 'fsck', '--no-reflogs');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, 'Usage: restore-next2-native-source.mjs <bundle> <checkout>');
  await restoreNext2NativeSource(process.argv[2], process.argv[3]);
}
