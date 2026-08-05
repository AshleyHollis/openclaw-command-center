import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultAssetRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function assetParts(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) {
    throw new Error('Asset path must be a non-empty relative path');
  }
  const normalized = path.normalize(relative);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Asset path escapes its root: ${relative}`);
  }
  return normalized.split(path.sep);
}

async function validatedAssetPath(assetRoot, relative) {
  const root = path.resolve(assetRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Built asset root is unsafe');
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  let finalStat;
  const parts = assetParts(relative);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (!inside(canonicalRoot, current)) throw new Error(`Asset path escapes its root: ${relative}`);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlinked asset is not allowed: ${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Asset path has a non-directory component: ${relative}`);
    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`Built asset is not a file: ${relative}`);
    finalStat = stat;
  }
  const canonicalTarget = await realpath(current);
  if (!inside(canonicalRoot, canonicalTarget)) throw new Error(`Asset path escapes its root: ${relative}`);
  return { target: canonicalTarget, stat: finalStat };
}

async function readValidatedAsset(assetRoot, relative) {
  const checked = await validatedAssetPath(assetRoot, relative);
  const handle = await open(checked.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== checked.stat.dev || opened.ino !== checked.stat.ino) {
      throw new Error(`Built asset changed while opening: ${relative}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function serveShellAsset(req, res, { assetRoot = defaultAssetRoot, assets } = {}) {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  const asset = assets?.get(pathname);
  if (!asset) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return true;
  }
  if (!Array.isArray(asset) || typeof asset[0] !== 'string' || typeof asset[1] !== 'string') {
    throw new Error('Built asset declaration is invalid');
  }
  const body = await readValidatedAsset(assetRoot, asset[0]);
  res.statusCode = 200;
  res.setHeader('content-type', asset[1]);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}
