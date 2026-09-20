export const transientFilesystemIdentity = stat => stat ? { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs } : null;
export const persistentFilesystemIdentity = stat => stat ? { version: 2, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs } : null;

export function sameFilesystemIdentity(left, right) {
  if (!left || !right || left.ino !== right.ino) return false;
  if (left.version === 2 || right.version === 2) return left.birthtimeMs === right.birthtimeMs;
  return left.dev === right.dev && (left.birthtimeMs === undefined || right.birthtimeMs === undefined || left.birthtimeMs === right.birthtimeMs);
}
