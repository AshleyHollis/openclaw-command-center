import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serveShellAsset } from '../src/asset-handler.mjs';

const assets = new Map([
  ['/plugins/command-center', ['index.html', 'text/html; charset=utf-8']],
  ['/plugins/command-center/nested', ['nested/index.html', 'text/html; charset=utf-8']]
]);

function response() {
  return {
    headers: new Map(),
    statusCode: undefined,
    body: undefined,
    setHeader(name, value) { this.headers.set(name, value); },
    end(value) { this.body = value; }
  };
}

async function withAssets(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-assets-'));
  const assetRoot = path.join(root, 'ui');
  try {
    await mkdir(path.join(assetRoot, 'nested'), { recursive: true });
    await writeFile(path.join(assetRoot, 'index.html'), '<safe shell>');
    await writeFile(path.join(assetRoot, 'nested', 'index.html'), '<safe nested shell>');
    await run({ root, assetRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('serves a validated built shell asset', async () => {
  await withAssets(async ({ assetRoot }) => {
    const res = response();
    assert.equal(await serveShellAsset({ method: 'GET', url: '/plugins/command-center' }, res, { assetRoot, assets }), true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(String(res.body), '<safe shell>');
  });
});

test('handler rejects final and intermediate asset symlinks before serving content', async () => {
  await withAssets(async ({ root, assetRoot }) => {
    const outside = path.join(root, 'outside.html');
    await writeFile(outside, '<outside>');
    await rm(path.join(assetRoot, 'index.html'));
    await symlink(outside, path.join(assetRoot, 'index.html'));
    await assert.rejects(
      serveShellAsset({ method: 'GET', url: '/plugins/command-center' }, response(), { assetRoot, assets }),
      /Symlinked asset/
    );

    await rm(path.join(assetRoot, 'nested'), { recursive: true });
    await symlink(path.dirname(outside), path.join(assetRoot, 'nested'));
    await assert.rejects(
      serveShellAsset({ method: 'GET', url: '/plugins/command-center/nested' }, response(), { assetRoot, assets }),
      /Symlinked asset/
    );
  });
});
