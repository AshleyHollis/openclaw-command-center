import assert from 'node:assert/strict';
import test from 'node:test';
import { persistentFilesystemIdentity, sameFilesystemIdentity, transientFilesystemIdentity } from '../src/sources/filesystem-object-identity.mjs';

const stat = dev => ({ dev, ino: 42, birthtimeMs: 1234 });

test('persisted Note recovery identity survives device renumbering inside its verified Folder binding', () => {
  assert.equal(sameFilesystemIdentity(persistentFilesystemIdentity(stat(47)), transientFilesystemIdentity(stat(64))), true);
});

test('transient Note checks retain device fencing and persisted witnesses reject replacement inodes', () => {
  assert.equal(sameFilesystemIdentity(transientFilesystemIdentity(stat(47)), transientFilesystemIdentity(stat(64))), false);
  assert.equal(sameFilesystemIdentity(persistentFilesystemIdentity(stat(47)), persistentFilesystemIdentity({ ...stat(64), ino: 43 })), false);
});
