import assert from 'node:assert/strict';
import test from 'node:test';
import { createNoteFolderIdentityV2 } from '../src/sources/note-folder-identity-format.mjs';

const markerId = '11111111-1111-4111-8111-111111111111';
const object = (dev, ino, birthtimeNs) => ({ dev: BigInt(dev), ino: BigInt(ino), birthtimeNs: BigInt(birthtimeNs) });
const filesystem = subvolumeId => ({ version: 1, filesystem: 'btrfs', filesystemId: '11111111-2222-4333-8444-555555555555', subvolumeId });

test('persisted Note Folder identity survives a remount device-number change', () => {
  const first = createNoteFolderIdentityV2({ markerId, filesystemIdentity: filesystem('272'), directory: object(47, 10, 20), marker: object(47, 11, 21) });
  const remounted = createNoteFolderIdentityV2({ markerId, filesystemIdentity: filesystem('272'), directory: object(64, 10, 20), marker: object(64, 11, 21) });
  assert.equal(remounted, first);
});

test('persisted Note Folder identity rejects replacement objects and another subvolume', () => {
  const original = createNoteFolderIdentityV2({ markerId, filesystemIdentity: filesystem('272'), directory: object(47, 10, 20), marker: object(47, 11, 21) });
  assert.notEqual(createNoteFolderIdentityV2({ markerId, filesystemIdentity: filesystem('272'), directory: object(47, 12, 20), marker: object(47, 11, 21) }), original);
  assert.notEqual(createNoteFolderIdentityV2({ markerId, filesystemIdentity: filesystem('300'), directory: object(47, 10, 20), marker: object(47, 11, 21) }), original);
});
