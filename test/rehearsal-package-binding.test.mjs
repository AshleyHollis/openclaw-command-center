import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateAssemblyInputs, validateAssemblyRequest, validateAssemblyRun, validatePackageBinding,
  validatePackageReceipt, restoreVerifiedProduct, retainedAssemblyProduct } from '../scripts/rehearsal-package-binding.mjs';
const sourceCommit = 'a'.repeat(40);
const receipt = { sourceCommit, buildDigest: 'b'.repeat(64), archive: { sha256: 'c'.repeat(64) } };
const bytes = Buffer.from(JSON.stringify(receipt));
const binding = { runId: '1234', sourceCommit, buildDigest: receipt.buildDigest, archiveSha256: receipt.archive.sha256,
  receiptSha256: createHash('sha256').update(bytes).digest('hex') };
test('selected CC package binds exact source, receipt bytes, archive and build', () => {
  assert.deepEqual(validatePackageBinding(binding, sourceCommit), binding);
  assert.deepEqual(validatePackageReceipt(binding, bytes), receipt);
});
test('mixed CC source, receipt tampering and stale archive/build tuples are refused', () => {
  assert.throws(() => validatePackageBinding(binding, 'd'.repeat(40)));
  assert.throws(() => validatePackageBinding({ ...binding, runId: '1234\nINJECT=true' }, sourceCommit));
  assert.throws(() => validatePackageReceipt(binding, Buffer.concat([bytes, Buffer.from('\n')])));
  for (const name of ['sourceCommit', 'buildDigest', 'archiveSha256']) {
    assert.throws(() => validatePackageReceipt({ ...binding, [name]: 'd'.repeat(name === 'sourceCommit' ? 40 : 64) }, bytes));
  }
});
test('private assembly binding admits exact completed run and byte-pinned installed host', async () => {
  const provenance = { image: `ghcr.io/ashleyhollis/openclaw@sha256:${'e'.repeat(64)}`,
    receipt: { schemaVersion: 2, commit: 'f'.repeat(40) } };
  const provenanceBytes = Buffer.from(JSON.stringify(provenance));
  const identity = { ccSourceCommit: retainedAssemblyProduct.sourceCommit,
    ccBuildDigest: retainedAssemblyProduct.buildDigest,
    ccArchiveSha256: retainedAssemblyProduct.archiveSha256, ccReceiptSha256: retainedAssemblyProduct.receiptSha256,
    provenanceSha256: createHash('sha256').update(provenanceBytes).digest('hex'),
    hostImage: provenance.image, hostReceipt: provenance.receipt };
  const identityBytes = Buffer.from(JSON.stringify(identity));
  const selected = { source: 'assembly', pairId: 'next2-7aaa-dc1-20261012', runId: '1234', runAttempt: '2',
    assemblySourceCommit: 'e'.repeat(40), ...retainedAssemblyProduct, provenanceSha256: identity.provenanceSha256,
    identitySha256: createHash('sha256').update(identityBytes).digest('hex') };
  const run = { id: 1234, run_attempt: 2, head_sha: selected.assemblySourceCommit,
    repository: { full_name: 'example/private-control' },
    path: '.github/workflows/assemble-sealed-image-pair.yml', status: 'completed', conclusion: 'success' };
  assert.deepEqual(validatePackageBinding(selected, retainedAssemblyProduct.sourceCommit), selected);
  validateAssemblyRequest(selected, '1234', '2');
  validateAssemblyRun(selected, run, 'example/private-control');
  assert.deepEqual(validateAssemblyInputs(selected, identityBytes, provenanceBytes).identity, identity);
  for (const mutate of [
    value => { value.pairId = 'other'; }, value => { value.runAttempt = '0'; },
    value => { value.identitySha256 = 'invalid'; }, value => { value.sourceCommit = 'd'.repeat(40); },
    value => { value.assemblySourceCommit = 'bad'; }
  ]) { const value = { ...selected }; mutate(value); assert.throws(() => validatePackageBinding(value, retainedAssemblyProduct.sourceCommit)); }
  assert.throws(() => validatePackageBinding({ ...selected, archiveSha256: 'f'.repeat(64) }, retainedAssemblyProduct.sourceCommit));
  assert.throws(() => validatePackageBinding({ ...selected, buildDigest: 'f'.repeat(64) }, retainedAssemblyProduct.sourceCommit));
  assert.notEqual(selected.sourceCommit, 'b'.repeat(40), 'private caller SHA is independent of frozen product SHA');
  for (const mutate of [
    value => { value.status = 'in_progress'; }, value => { value.conclusion = null; },
    value => { value.repository.full_name = 'example/other'; },
    value => { value.path = '.github/workflows/package-candidate.yml'; },
    value => { value.run_attempt = 1; }, value => { value.head_sha = 'a'.repeat(40); }
  ]) { const value = structuredClone(run); mutate(value); assert.throws(() => validateAssemblyRun(selected, value, 'example/private-control')); }
  assert.throws(() => validateAssemblyRequest(selected, '999', '2'));
  assert.throws(() => validateAssemblyRequest(selected, '1234', '1'));
  assert.throws(() => validateAssemblyInputs(selected, Buffer.concat([identityBytes, Buffer.from('\n')]), provenanceBytes));
  assert.throws(() => validateAssemblyInputs(selected, identityBytes, Buffer.concat([provenanceBytes, Buffer.from('\n')])));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cc-assembly-select-'));
  try {
    const artifact = path.join(temporary, 'selected-cc-package');
    await mkdir(artifact);
    await writeFile(path.join(artifact, 'run.json'), JSON.stringify(run));
    await writeFile(path.join(artifact, 'candidate-qualification-identity.json'), identityBytes);
    await writeFile(path.join(artifact, 'host-provenance.json'), provenanceBytes);
    const githubEnv = path.join(temporary, 'github-env');
    const env = { ...process.env, CC_PACKAGE_BINDING: JSON.stringify(selected), GITHUB_SHA: 'b'.repeat(40),
      RUNNER_TEMP: temporary, GITHUB_ENV: githubEnv, GITHUB_REPOSITORY: 'example/private-control',
      ASSEMBLY_RUN_ID: '1234', ASSEMBLY_RUN_ATTEMPT: '2' };
    const script = fileURLToPath(new URL('../scripts/rehearsal-package-binding.mjs', import.meta.url));
    execFileSync(process.execPath, [script, 'select'], { env });
    assert.match(await readFile(githubEnv, 'utf8'), /COMMAND_CENTER_SOURCE_COMMIT=dc1fb006d0c3c57821129e7d1d645e237b91b65f/u);
    assert.throws(() => execFileSync(process.execPath,
      [script, 'select'],
      { env: { ...env, CC_PACKAGE_BINDING: JSON.stringify({ ...selected, sourceCommit: 'a'.repeat(40) }) }, stdio: 'pipe' }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test('sealed dist is restored only from exact verified members into a pristine checkout', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cc-sealed-dist-'));
  const verifiedDirectory = path.join(temporary, 'verified');
  const checkoutDirectory = path.join(temporary, 'checkout');
  const contents = new Map([
    ['LICENSE', 'fictional license\n'], ['openclaw.plugin.json', '{"id":"command-center"}\n'],
    ['package.json', '{"name":"openclaw-command-center"}\n'],
    ['dist/.command-center-digest.json', '{"digest":"fictional"}\n'],
    ['dist/plugin.mjs', 'export const fictional = true;\n']
  ]);
  try {
    await mkdir(path.join(verifiedDirectory, 'dist'), { recursive: true });
    await mkdir(checkoutDirectory);
    for (const [name, value] of contents) {
      await writeFile(path.join(verifiedDirectory, name), value);
      if (!name.startsWith('dist/')) await writeFile(path.join(checkoutDirectory, name), value);
    }
    const receipt = { files: [...contents].map(([name, value]) => ({ path: name, sizeBytes: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex') })) };
    const restore = () => restoreVerifiedProduct({ verifiedDirectory, checkoutDirectory, receipt });
    await writeFile(path.join(verifiedDirectory, 'dist', 'extra.mjs'), 'extra');
    await assert.rejects(restore(), /missing or extra members/);
    await rm(path.join(verifiedDirectory, 'dist', 'extra.mjs'));
    await writeFile(path.join(checkoutDirectory, 'LICENSE'), 'different');
    await assert.rejects(restore(), /root manifest differs/);
    await writeFile(path.join(checkoutDirectory, 'LICENSE'), contents.get('LICENSE'));
    await mkdir(path.join(checkoutDirectory, 'dist'));
    await assert.rejects(restore(), /dist must be absent/);
    await rm(path.join(checkoutDirectory, 'dist'), { recursive: true });
    await writeFile(path.join(verifiedDirectory, 'dist', 'plugin.mjs'), 'tampered');
    await assert.rejects(restore(), /Verified product (size|byte) changed/);
    await writeFile(path.join(verifiedDirectory, 'dist', 'plugin.mjs'), contents.get('dist/plugin.mjs'));
    await restore();
    assert.deepEqual((await readdir(path.join(checkoutDirectory, 'dist'))).sort(),
      ['.command-center-digest.json', 'plugin.mjs']);
    assert.equal((await readFile(path.join(checkoutDirectory, 'dist', 'plugin.mjs'), 'utf8')),
      contents.get('dist/plugin.mjs'));
    await assert.rejects(restore(), /dist must be absent/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
