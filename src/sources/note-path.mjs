import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { sourceError } from './errors.mjs';

export function normalizeNotePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) {
    throw sourceError('invalid-path', 'Note paths must be non-empty, relative, NUL-free POSIX paths.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw sourceError('invalid-path', 'Note paths cannot contain empty, dot, or dot-dot segments.');
  if (!/\.md$/iu.test(value)) throw sourceError('invalid-path', 'Only Markdown Note paths are supported.');
  return segments.join('/');
}

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function assertRegularOrMissing(candidate, { allowMissing = false } = {}) {
  try {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) throw sourceError('unsafe-path', 'Symlinked Note paths are not supported.');
    if (!stat.isFile() && !stat.isDirectory()) throw sourceError('unsafe-path', 'Note paths must resolve to regular files and directories.');
    return stat;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') throw sourceError('not-found', 'The Note path was not found.');
    throw error;
  }
}

export async function assertSafeNotePath(root, notePath, { allowMissing = false, directory = false } = {}) {
  const normalized = normalizeNotePath(notePath);
  const canonicalRoot = await assertSafeDirectory(root);
  const candidate = path.resolve(canonicalRoot, ...normalized.split('/'));
  if (!isWithin(canonicalRoot, candidate)) throw sourceError('unsafe-path', 'The Note path escapes the Topic root.');
  let current = canonicalRoot;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    const stat = await assertRegularOrMissing(current, { allowMissing });
    if (!stat && allowMissing) break;
    if (stat?.isSymbolicLink()) throw sourceError('unsafe-path', 'Symlinked Note path components are not supported.');
    if (current !== candidate && stat && !stat.isDirectory()) throw sourceError('unsafe-path', 'A Note path component is not a directory.');
  }
  const finalStat = await assertRegularOrMissing(candidate, { allowMissing });
  if (finalStat && directory !== finalStat.isDirectory()) throw sourceError('unsafe-path', directory ? 'The Note Folder path must be a directory.' : 'The Note path must be a regular file.');
  return Object.freeze({ root: canonicalRoot, path: candidate, relativePath: normalized, stat: finalStat });
}

export async function assertSafeDirectory(root) {
  const originalStat = await lstat(root).catch(() => { throw sourceError('not-found', 'The Note Folder root was not found.'); });
  if (originalStat.isSymbolicLink()) throw sourceError('unsafe-path', 'The Note Folder root cannot be a symlink.');
  const parsed = path.parse(path.resolve(root));
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, path.resolve(root)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const component = await lstat(current).catch(() => null);
    if (component?.isSymbolicLink()) throw sourceError('unsafe-path', 'A Note Folder root component cannot be a symlink.');
  }
  const canonicalRoot = await realpath(root).catch(() => { throw sourceError('not-found', 'The Note Folder root was not found.'); });
  const stat = await lstat(canonicalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw sourceError('unsafe-path', 'The Note Folder root must be a real directory.');
  return canonicalRoot;
}
