import { readNoteFolderIdentity, setHostFilesystemIdentityReader } from '../../src/sources/note-folder-identity.mjs';

// Acceptance setup runs beside, rather than inside, the Gateway process. Read
// through the same pinned host helper so seeded metadata matches the identity
// the activated plugin will verify.
export async function readHostNoteFolderIdentity(folder) {
  const fileAccess = await import('openclaw/plugin-sdk/file-access-runtime');
  const release = setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  try { return await readNoteFolderIdentity(folder); }
  finally { release(); }
}
