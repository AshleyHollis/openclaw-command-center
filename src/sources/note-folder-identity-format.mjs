import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const pattern = new RegExp(`^note-folder:([12]):(${uuid}):([0-9a-f]{64})$`, 'u');
const decode = value => String(value).replace(/\\040/gu, ' ').replace(/\\011/gu, '\t').replace(/\\134/gu, '\\');

export function parseNoteFolderIdentity(value) {
  const match = typeof value === 'string' ? pattern.exec(value) : null;
  return match ? Object.freeze({ version: Number(match[1]), markerId: match[2], digest: match[3] }) : null;
}

export const isNoteFolderIdentity = value => parseNoteFolderIdentity(value) !== null;

export function createNoteFolderIdentityV2({ markerId, mountIdentity, directory, marker }) {
  if (!new RegExp(`^${uuid}$`, 'u').test(markerId) || typeof mountIdentity !== 'string' || !mountIdentity) throw new TypeError('A stable Note Folder witness is required.');
  const stable = value => `${value.ino}:${value.birthtimeNs}`;
  const digest = createHash('sha256').update(`${mountIdentity}:${stable(directory)}:${stable(marker)}`).digest('hex');
  return `note-folder:2:${markerId}:${digest}`;
}

export async function readStableMountIdentity(target, { mountInfo } = {}) {
  if (!mountInfo && process.platform !== 'linux') throw Object.assign(new Error('Stable mount identity is unavailable.'), { code: 'capability-unavailable' });
  mountInfo ??= () => readFile('/proc/self/mountinfo', 'utf8');
  const canonical = path.resolve(target); let best = null;
  for (const line of String(await mountInfo()).split('\n')) {
    const [left, right] = line.split(' - '); if (!right) continue;
    const fields = left.split(' '); const mounted = decode(fields[4] ?? '');
    const relative = path.relative(mounted, canonical);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (best && best.mountPoint.length >= mounted.length) continue;
    const after = right.split(' '); const superOptions = after.slice(2).join(',').split(',');
    best = { mountPoint: mounted, root: decode(fields[3] ?? ''), fileSystem: after[0] ?? '', source: decode(after[1] ?? ''), subvolume: superOptions.find(value => value.startsWith('subvolid=')) ?? '' };
  }
  if (!best) throw Object.assign(new Error('The Note Folder mount identity is unavailable.'), { code: 'capability-unavailable' });
  return createHash('sha256').update(JSON.stringify([best.fileSystem, best.source, best.root, best.subvolume])).digest('hex');
}
