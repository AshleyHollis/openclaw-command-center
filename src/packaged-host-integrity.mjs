import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

// Packaged-host receipt v2: depth-first, ordinal-sorted paths, file bytes and
// executable bit, or relative link target. Include dist and dependencies;
// Git's ignored-file inventory cannot authenticate an installed runtime.
export async function packagedHostDigest(root) {
  const hash = createHash('sha256');
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      if (['.git', '.bundle-digest', '.codex-ticket-ssd.json'].includes(name)) throw new Error('Runtime contains source/control metadata');
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(directory, name);
      const metadata = await lstat(file);
      if (metadata.isDirectory()) await visit(file, relative);
      else if (metadata.isFile()) {
        hash.update(`f\0${relative}\0${metadata.mode & 0o111 ? 'x' : '-'}\0`);
        hash.update(await readFile(file));
        hash.update('\0');
      } else if (metadata.isSymbolicLink()) {
        const link = await readlink(file);
        const target = path.relative(root, path.resolve(directory, link));
        if (path.isAbsolute(link) || target === '..' || target.startsWith(`..${path.sep}`) || path.isAbsolute(target)) throw new Error('Runtime link escapes its root');
        const resolved = path.relative(root, await realpath(file));
        if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new Error('Runtime link resolves outside its root');
        hash.update(`l\0${relative}\0${link}\0`);
      } else throw new Error('Runtime contains a special file');
    }
  }
  if (!(await lstat(root)).isDirectory()) throw new Error('Runtime root must be a directory, not a link');
  await visit(root);
  return `sha256:${hash.digest('hex')}`;
}
