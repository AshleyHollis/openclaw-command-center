import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readNoteFolderIdentity, setHostFilesystemIdentityReader } from '../../src/sources/note-folder-identity.mjs';
import { descriptorEnvironment, parseHostDescriptor } from '../../src/host-harness.mjs';

let identityReadQueue = Promise.resolve();

// Acceptance setup runs beside, rather than inside, the Gateway process. Read
// through the same pinned host helper so seeded metadata matches the identity
// the activated plugin will verify.
async function readIdentity(folder) {
  const descriptor = parseHostDescriptor(process.env[descriptorEnvironment]);
  if (descriptor.schemaVersion !== 2) throw new Error('Packaged host identity setup requires an authenticated runtime root');
  const runtimeModule = path.join(descriptor.runtimeRoot, 'node_modules', 'openclaw', 'dist', 'plugin-sdk', 'file-access-runtime.js');
  const fileAccess = await import(pathToFileURL(runtimeModule).href);
  const release = setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  try { return await readNoteFolderIdentity(folder); }
  finally { release(); }
}

export function readHostNoteFolderIdentity(folder) {
  const read = identityReadQueue.then(() => readIdentity(folder));
  identityReadQueue = read.catch(() => {});
  return read;
}
