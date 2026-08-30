import { digest, occurrenceKey } from './contracts.mjs';

export function identityDigest({ sourceCapabilityId, stableSubjectId, attentionReason }) {
  return digest({ sourceCapabilityId, stableSubjectId, attentionReason });
}

export function episodeIdentity(occurrence) {
  return Object.freeze({
    sourceCapabilityId: occurrence.sourceCapabilityId,
    stableSubjectId: occurrence.stableSubjectId,
    attentionReason: occurrence.attentionReason,
    identityDigest: identityDigest(occurrence)
  });
}

export function exactOccurrenceKey(occurrence) {
  return occurrenceKey(occurrence);
}

export function episodeId(identity, generation) {
  return `attention:${identity.identityDigest}:${generation}`;
}
