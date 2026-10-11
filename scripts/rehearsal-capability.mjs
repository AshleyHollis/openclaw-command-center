import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { parseHostDescriptor, verifyHost } from '../src/host-harness.mjs';
import { readBuiltReceipt } from '../src/build.mjs';
import { scanPublicEvidence } from '../src/safety.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.versions.node, process.env.REHEARSAL_NODE);
const descriptor = parseHostDescriptor();
await verifyHost(descriptor);
const require = createRequire(path.join(descriptor.runtimeRoot, 'package.json'));
const sdkPath = require.resolve('openclaw/plugin-sdk/file-access-runtime');
assert.ok(sdkPath.startsWith(`${path.join(descriptor.runtimeRoot, 'node_modules', 'openclaw')}${path.sep}`));
const { readDurableFilesystemIdentity } = await import(pathToFileURL(sdkPath).href);
const root = await mkdtemp(path.join(process.env.TMPDIR, 'capability-'));
let directory; let file; let browser;
try {
  directory = await open(root, 'r');
  await writeFile(path.join(root, 'fictional-note.txt'), 'Fictional capability fixture\n', { flag: 'wx' });
  file = await open(path.join(root, 'fictional-note.txt'), 'r');
  const identity = await readDurableFilesystemIdentity(directory.fd);
  assert.equal(identity.filesystem, 'btrfs');
  assert.match(identity.filesystemId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  assert.match(identity.subvolumeId, /^[1-9]\d*$/u);
  assert.deepEqual(await readDurableFilesystemIdentity(file.fd), identity);
  assert.deepEqual(await readDurableFilesystemIdentity(directory.fd), identity);
  assert.ok((await file.stat({ bigint: true })).ino > 0n);
  // The SDK must reject ordinary storage; never synthesize durable identity.
  const ordinary = await open(process.env.GITHUB_WORKSPACE, 'r');
  try { await assert.rejects(readDurableFilesystemIdentity(ordinary.fd), { code: 'capability-unavailable' }); }
  finally { await ordinary.close(); }
  browser = await chromium.launch({ headless: true });
  const build = await readBuiltReceipt();
  // Paths, UUIDs and inodes stay local. Only bounded version and binding facts
  // enter public evidence, after all fixture/browser cleanup has succeeded.
  const receipt = { schemaVersion: 1, kind: 'hosted-rehearsal-capability', linux: release(),
    node: process.versions.node, chromium: browser.version(), sourceCommit: process.env.GITHUB_SHA,
    workflowRun: process.env.GITHUB_RUN_ID, hostImage: process.env.IMAGE,
    hostReceipt: JSON.parse(process.env.EXPECTED_HOST_RECEIPT), buildDigest: build.digest,
    btrfsSdkIdentity: true, ordinaryStorageRejected: true, performanceQualified: false };
  await browser.close(); browser = null;
  await file.close(); file = null;
  await directory.close(); directory = null;
  await rm(root, { recursive: true });
  scanPublicEvidence([JSON.stringify(receipt)], { label: 'hosted-rehearsal-capability' });
  await writeFile(path.join(process.env.RUNNER_TEMP, 'rehearsal-capability.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
} finally {
  await browser?.close();
  await file?.close();
  await directory?.close();
  await rm(root, { recursive: true, force: true });
}
