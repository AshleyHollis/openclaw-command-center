import { createHash } from 'node:crypto';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const pattern = new RegExp(`^note-folder:([12]):(${uuid}):([0-9a-f]{64})$`, 'u');

export function parseNoteFolderIdentity(value) {
  const match = typeof value === 'string' ? pattern.exec(value) : null;
  return match ? Object.freeze({ version: Number(match[1]), markerId: match[2], digest: match[3] }) : null;
}

export const isNoteFolderIdentity = value => parseNoteFolderIdentity(value) !== null;

export function createNoteFolderIdentityV2({ markerId, filesystemIdentity, directory, marker }) {
  if (!new RegExp(`^${uuid}$`, 'u').test(markerId) || filesystemIdentity?.version !== 1 || filesystemIdentity?.filesystem !== 'btrfs' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(filesystemIdentity?.filesystemId) || !/^[1-9][0-9]*$/u.test(filesystemIdentity?.subvolumeId)) throw new TypeError('A stable Btrfs filesystem witness is required.');
  const stable = value => `${value.ino}:${value.birthtimeNs}`;
  const filesystem = JSON.stringify([filesystemIdentity.filesystem, filesystemIdentity.filesystemId, filesystemIdentity.subvolumeId]);
  const digest = createHash('sha256').update(`${filesystem}:${stable(directory)}:${stable(marker)}`).digest('hex');
  return `note-folder:2:${markerId}:${digest}`;
}
