import { enrollNoteFolderIdentity } from '../../src/sources/note-folder-identity.mjs';

// Real folder enrollment and metadata binding, shared by durable source fixtures.
// Unbound/replaced-folder refusal tests deliberately do not call this helper.
export async function enrollFixtureFolder(metadata, referenceId, folder) {
  const observedRevision = await enrollNoteFolderIdentity(folder);
  metadata.setSourceLocator({ referenceId, locator: folder, observedRevision, ownership: 'external' });
  return observedRevision;
}
