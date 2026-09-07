import { isDeepStrictEqual } from 'node:util';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { readDiscordPreservationInventory } from './preservation-inventory.mjs';
import { preparePreservedHistoryMessages } from './preserved-history-transcript.mjs';
import { runPreservedHistoryImport } from './preserved-history-import.mjs';
import { readNativeHistoryInventory } from './native-history-source.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const mappingKeys = ['sourceChannelId', 'logicalOperationId', 'agentId', 'topicId', 'expectedTopicRevision'];
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Admits the complete pinned export before reserving or writing any destination.
// Native history is authoritative for imported messages; retained source files
// remain necessary for attachments. Serving those files is a separate boundary.
export async function prepareDiscordPreservation(options) {
  const { assertCurrent } = options;
  const checkAuthority = () => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then) fail('history-authority-unavailable');
  };
  checkAuthority();
  let mappings;
  let sourceOptions;
  try { mappings = freeze(structuredClone(options.mappings)); sourceOptions = freeze(structuredClone(options.sourceOptions)); }
  catch { fail('history-mapping-invalid'); }
  if (!Array.isArray(mappings) || mappings.some(mapping => !mapping || Object.keys(mapping).some(key => !mappingKeys.includes(key)) || !isCanonicalUuid(mapping.logicalOperationId) || typeof mapping.sourceChannelId !== 'string' || typeof mapping.agentId !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(mapping.agentId) || (mapping.topicId === null ? mapping.expectedTopicRevision !== null : typeof mapping.topicId !== 'string' || !mapping.topicId || !Number.isSafeInteger(mapping.expectedTopicRevision) || mapping.expectedTopicRevision < 0))) fail('history-mapping-invalid');
  if (new Set(mappings.map(mapping => mapping.sourceChannelId)).size !== mappings.length || new Set(mappings.map(mapping => mapping.logicalOperationId)).size !== mappings.length) fail('history-mapping-invalid');
  const inventory = await readDiscordPreservationInventory(sourceOptions);
  checkAuthority();
  if (mappings.length !== inventory.channels.length || mappings.some(mapping => !inventory.channels.some(row => row.channel.id === mapping.sourceChannelId))) fail('history-mapping-incomplete');
  const selected = inventory.channels.map(channel => {
    const mapping = mappings.find(item => item.sourceChannelId === channel.channel.id);
    const prepared = preparePreservedHistoryMessages({ sourceManifestSha256: inventory.bundle.manifestSha256, channel, attachments: inventory.attachments });
    const intent = { schemaVersion: 1, sourceManifestSha256: inventory.bundle.manifestSha256, trustedPublicKeySha256: inventory.bundle.publicKeySha256,
      sourceChannelId: prepared.sourceChannelId, sourceDigest: prepared.sourceDigest, expectedCount: prepared.expectedCount,
      agentId: mapping.agentId, topicId: mapping.topicId, expectedTopicRevision: mapping.expectedTopicRevision };
    return { mapping, prepared, intent };
  });
  return freeze({ selected, sourceManifestSha256: inventory.bundle.manifestSha256,
    trustedPublicKeySha256: inventory.bundle.publicKeySha256, attachmentCoverage: inventory.attachmentCoverage, counts: inventory.counts });
}

export async function importDiscordPreservation(options) {
  options = { ...options };
  if (!['execute', 'resume', 'verify'].includes(options.mode)) fail('history-mode-invalid');
  const admitted = await prepareDiscordPreservation(options);
  const histories = await importPreparedHistories(options, admitted);
  return freeze({ sourceManifestSha256: admitted.sourceManifestSha256, histories, attachmentCoverage: admitted.attachmentCoverage,
    accounting: { sourceChannels: admitted.counts.channels, verifiedHistories: histories.length,
      sourceMessages: admitted.counts.messages, verifiedMessages: histories.reduce((total, history) => total + history.verifiedCount, 0),
      sourceAttachments: admitted.counts.attachments, attachmentServingVerified: false } });
}

// Native source admission is distinct from signed Discord preservation. Both
// delegate effects and recovery to the same existing Imported History owner.
export async function prepareNativePreservation(options) {
  const { assertCurrent } = options;
  const checkAuthority = () => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then) fail('history-authority-unavailable');
  };
  checkAuthority();
  let mappings; let sourceOptions;
  try { mappings = freeze(structuredClone(options.mappings)); sourceOptions = freeze(structuredClone(options.sourceOptions)); }
  catch { fail('history-mapping-invalid'); }
  const keys = ['sourceFileName', 'logicalOperationId', 'agentId', 'topicId', 'expectedTopicRevision'];
  if (!Array.isArray(mappings) || mappings.length > 100 || mappings.some(mapping => !mapping || Object.keys(mapping).some(key => !keys.includes(key))
      || typeof mapping.sourceFileName !== 'string' || !isCanonicalUuid(mapping.logicalOperationId) || typeof mapping.agentId !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(mapping.agentId)
      || (mapping.topicId === null ? mapping.expectedTopicRevision !== null : typeof mapping.topicId !== 'string' || !mapping.topicId || !Number.isSafeInteger(mapping.expectedTopicRevision) || mapping.expectedTopicRevision < 0))) fail('history-mapping-invalid');
  if (new Set(mappings.map(item => item.sourceFileName)).size !== mappings.length || new Set(mappings.map(item => item.logicalOperationId)).size !== mappings.length) fail('history-mapping-invalid');
  const inventory = await readNativeHistoryInventory(sourceOptions);
  checkAuthority();
  if (mappings.length !== inventory.histories.length || mappings.some(mapping => !inventory.histories.some(item => item.sourceFile.name === mapping.sourceFileName))) fail('history-mapping-incomplete');
  const selected = inventory.histories.map(prepared => {
    const mapping = mappings.find(item => item.sourceFileName === prepared.sourceFile.name);
    const intent = { schemaVersion: 2, sourceKind: prepared.sourceKind, sourceInventorySha256: prepared.sourceInventorySha256,
      originalAgentId: prepared.originalAgentId, originalSessionId: prepared.originalSessionId, sourceFile: prepared.sourceFile,
      sourceDigest: prepared.sourceDigest, expectedCount: prepared.expectedCount,
      agentId: mapping.agentId, topicId: mapping.topicId, expectedTopicRevision: mapping.expectedTopicRevision };
    return { mapping, prepared, intent };
  });
  return freeze({ selected, sourceInventorySha256: inventory.sourceInventorySha256, counts: inventory.counts });
}

export async function importNativePreservation(options) {
  options = { ...options };
  if (!['execute', 'resume', 'verify'].includes(options.mode)) fail('history-mode-invalid');
  const admitted = await prepareNativePreservation(options);
  const histories = await importPreparedHistories(options, admitted);
  return freeze({ sourceInventorySha256: admitted.sourceInventorySha256, histories,
    accounting: { sourceFiles: admitted.counts.files, sourceHeaders: admitted.counts.headers,
      sourceMessages: admitted.counts.messages, sourceOtherRecords: admitted.counts.otherRecords, sourceEntries: admitted.counts.entries,
      verifiedHistories: histories.length, verifiedEntries: histories.reduce((total, history) => total + history.verifiedCount, 0) } });
}

async function importPreparedHistories(options, admitted) {
  const { metadata, mode, assertCurrent } = options;
  if (!['execute', 'resume', 'verify'].includes(mode)) fail('history-mode-invalid');
  const checkAuthority = () => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then) fail('history-authority-unavailable');
  };
  const histories = [];
  for (const item of admitted.selected) {
    checkAuthority();
    let reservation;
    if (mode === 'execute') {
      reservation = metadata.reserveImportedHistory({ logicalOperationId: item.mapping.logicalOperationId, intent: item.intent }, checkAuthority);
    } else {
      reservation = metadata.listImportedHistories().find(row => row.logicalOperationId === item.mapping.logicalOperationId);
      if (!reservation) fail('history-reservation-missing');
      if (!isDeepStrictEqual(reservation.intent, item.intent)) fail('intent-mismatch');
      if (mode === 'verify' && reservation.phase !== 'verified') fail('history-incomplete');
    }
    histories.push(await runPreservedHistoryImport({ ...options, metadata, historyId: reservation.historyId, prepared: item.prepared,
      allowCreate: mode !== 'verify' && reservation.phase === 'reserved', assertCurrent: checkAuthority }));
  }
  checkAuthority();
  return histories;
}
