import assert from 'node:assert/strict';
import test from 'node:test';
import { createNoteFolderIdentityV2, readStableMountIdentity } from '../src/sources/note-folder-identity-format.mjs';

const markerId = '11111111-1111-4111-8111-111111111111';
const object = (dev, ino, birthtimeNs) => ({ dev: BigInt(dev), ino: BigInt(ino), birthtimeNs: BigInt(birthtimeNs) });

test('persisted Note Folder identity survives a remount device-number change', () => {
  const first = createNoteFolderIdentityV2({ markerId, mountIdentity: 'stable-mount', directory: object(47, 10, 20), marker: object(47, 11, 21) });
  const remounted = createNoteFolderIdentityV2({ markerId, mountIdentity: 'stable-mount', directory: object(64, 10, 20), marker: object(64, 11, 21) });
  assert.equal(remounted, first);
});

test('persisted Note Folder identity rejects replacement objects and another subvolume', () => {
  const original = createNoteFolderIdentityV2({ markerId, mountIdentity: 'subvolume-a', directory: object(47, 10, 20), marker: object(47, 11, 21) });
  assert.notEqual(createNoteFolderIdentityV2({ markerId, mountIdentity: 'subvolume-a', directory: object(47, 12, 20), marker: object(47, 11, 21) }), original);
  assert.notEqual(createNoteFolderIdentityV2({ markerId, mountIdentity: 'subvolume-b', directory: object(47, 10, 20), marker: object(47, 11, 21) }), original);
});

test('stable mount identity uses Btrfs root and subvolume evidence rather than major:minor device number', async () => {
  const line = dev => `1 0 ${dev} /@/state /vault rw - btrfs /dev/mapper/data rw,subvolid=272,subvol=/@`;
  const first = await readStableMountIdentity('/vault/topic', { mountInfo: async () => line('0:47') });
  const remounted = await readStableMountIdentity('/vault/topic', { mountInfo: async () => line('0:64') });
  const snapshot = await readStableMountIdentity('/vault/topic', { mountInfo: async () => line('0:64').replace('subvolid=272', 'subvolid=300') });
  assert.equal(remounted, first); assert.notEqual(snapshot, first);
});
