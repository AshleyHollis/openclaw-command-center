import { SourceServiceError } from '../sources/errors.mjs';
import { validatedOutlookWebLink } from '../native-ui/outlook-web-link.mjs';

/** Resolve accepted evidence through its current owner, never through cached card text. */
export async function readBillActionEvidence({ metadata, sourceService, loop, observation, assertCurrent }) {
  assertCurrent();
  sourceService.requireTopicService({ topicId: loop.topicId });
  const facts = observation.facts ?? {};
  const externalId = observation.source?.externalId;
  const sourceVersion = facts.sourceVersion;
  const noteTarget = {
    topicId: loop.topicId, referenceId: facts.sourceReferenceId,
    path: facts.sourcePath, observedRevision: facts.sourceReferenceVersion
  };
  let note;
  if ([noteTarget.referenceId, noteTarget.path, noteTarget.observedRevision].every(value => typeof value === 'string' && value.trim())) {
    try {
      const retained = await sourceService.notesRead({ schemaVersion: 1, ...noteTarget });
      assertCurrent();
      sourceService.assertExactNoteReference(noteTarget, { read: true });
      if (retained.revision === noteTarget.observedRevision) note = { kind: 'note', ...noteTarget, revision: retained.revision };
    } catch (error) {
      assertCurrent();
      if (error?.code === 'unauthenticated') throw error;
    }
  }
  assertCurrent();
  sourceService.requireTopicService({ topicId: loop.topicId });
  if (note) {
    try { sourceService.assertExactNoteReference(noteTarget, { read: true }); }
    catch { note = undefined; }
  }
  const locator = externalId && sourceVersion ? metadata.getEmailReaderLocator(externalId, sourceVersion) : null;
  let url;
  try { url = locator?.status === 'available' ? validatedOutlookWebLink(locator.webLink) : null; }
  catch { /* A missing exact email destination does not revoke an independently authorized Note. */ }
  if (!url && !note) throw new SourceServiceError('source-unavailable', 'The exact accepted email and retained Note are unavailable.');
  return Object.freeze({ available: true, topicId: loop.topicId,
    source: url ? Object.freeze({ kind: 'outlook', url }) : Object.freeze(note),
    ...(note ? { retainedNote: Object.freeze(note) } : {}) });
}
