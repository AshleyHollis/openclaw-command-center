import { createHash } from 'node:crypto';
import path from 'node:path';
import { sourceError, assertNoUnexpectedKeys, nonBlank } from '../sources/errors.mjs';
import { revisionForBytes } from '../sources/reference.mjs';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function canonicalInboundMediaRef(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw sourceError('invalid-request', 'A canonical managed inbound attachment reference is required.');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw sourceError('invalid-request', 'The attachment reference is invalid.'); }
  if (parsed.protocol !== 'media:' || parsed.hostname !== 'inbound' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw sourceError('invalid-request', 'Only managed inbound attachments can be filed.');
  }
  let id;
  try { id = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')); } catch { throw sourceError('invalid-request', 'The attachment reference is invalid.'); }
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw sourceError('invalid-request', 'The attachment reference is invalid.');
  }
  return `media://inbound/${encodeURIComponent(id)}`;
}

function stableUuid(...parts) {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 0x3 | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sourceToken(mediaRef) {
  return createHash('sha256').update(mediaRef).digest('hex').slice(0, 12);
}

function safeSegment(value, field) {
  if (typeof value !== 'string' || value.trim() !== value || !value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0') || /[\x00-\x1f\x7f]/u.test(value)) {
    throw sourceError('invalid-path', `${field} must be a safe relative path segment.`);
  }
  return value;
}

function safeSubfolder(value) {
  if (value === undefined) return 'Documents';
  if (typeof value !== 'string' || value.trim() !== value || !value) throw sourceError('invalid-path', 'subfolder must be a non-empty relative path.');
  const parts = value.split('/').map((part) => safeSegment(part, 'subfolder'));
  return `Documents/${parts.join('/')}`;
}

function safeFilename(value, fallback) {
  const source = typeof value === 'string' ? value.trim() : '';
  const candidate = source.replace(/[\\/\0\x00-\x1f\x7f]/gu, '_').replace(/^\.+/u, '').trim();
  const name = candidate || fallback;
  if (name.length > 180) {
    const extension = path.posix.extname(name).slice(0, 24);
    return `${name.slice(0, 180 - extension.length)}${extension}`;
  }
  return name;
}

function filedName(filename, token) {
  const extension = path.posix.extname(filename);
  const base = extension ? filename.slice(0, -extension.length) : filename;
  return `${base}--${token}${extension}`;
}

function publicReceipt({ topicId, sourceReference, document, mediaRef, contentType, sizeBytes, logicalOperationId }) {
  return Object.freeze({
    schemaVersion: 1,
    status: 'filed',
    topicId,
    logicalOperationId,
    source: Object.freeze({ referenceId: sourceReference.referenceId, mediaRef, revision: sourceReference.observedRevision }),
    document: Object.freeze({ referenceId: document.sourceReference.referenceId, path: document.path, revision: document.revision, contentType: contentType ?? null, sizeBytes }),
  });
}

/**
 * The sole owner of moving a native managed attachment into a verified Topic
 * folder. It intentionally accepts only `media://inbound` identities and
 * delegates durable file publication/recovery to the existing Note owner.
 */
export class TopicDocumentFilingService {
  constructor({ sourceService, metadata, mediaLoader } = {}) {
    if (!sourceService || !metadata || typeof mediaLoader !== 'function') throw new TypeError('Topic document filing requires source, metadata, and managed-media capabilities.');
    this.sourceService = sourceService;
    this.metadata = metadata;
    this.mediaLoader = mediaLoader;
  }

  async resolveBoundConversation({ sessionKey, sessionId }) {
    const binding = await this.sourceService.sessionTopicContext({ sessionKey });
    if (binding.status !== 'bound') throw sourceError('source-recovery', 'This Conversation is not linked to a Topic. Choose an exact Topic before filing attachments.');
    if (sessionId !== undefined && binding.sessionId !== sessionId) throw sourceError('source-recovery', 'The invoking Conversation was replaced before attachment filing.');
    const service = this.sourceService.requireTopicService({ topicId: binding.topicId }, { write: true, requiredSourceKinds: ['note_folder', 'session'] });
    const folders = this.sourceService.listTopicSourceReferences(binding.topicId).filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
    if (folders.length !== 1) throw sourceError('source-recovery', 'The linked Topic does not have one exact verified Note Folder.');
    return Object.freeze({ ...binding, folderReferenceId: folders[0].referenceId, notes: service.notes });
  }

  async loadExactMedia(mediaRef) {
    const loaded = await this.mediaLoader(mediaRef, { maxBytes: MAX_ATTACHMENT_BYTES, optimizeImages: false });
    if (!loaded || !Buffer.isBuffer(loaded.buffer)) throw sourceError('unavailable', 'The managed attachment could not be read.');
    return Object.freeze({
      bytes: Buffer.from(loaded.buffer),
      digest: revisionForBytes(loaded.buffer),
      contentType: typeof loaded.contentType === 'string' ? loaded.contentType : null,
      fileName: typeof loaded.fileName === 'string' ? loaded.fileName : null,
    });
  }

  ensureAttachmentReference({ topicId, mediaRef, digest }) {
    const referenceId = `attachment:${createHash('sha256').update(mediaRef).digest('hex')}`;
    const existing = this.metadata.getSourceReference?.(referenceId);
    if (existing && (existing.topicId !== topicId || existing.sourceSystem !== 'openclaw' || existing.sourceKind !== 'attachment' || existing.externalSourceId !== mediaRef)) {
      throw sourceError('cross-topic', 'This managed attachment is already owned by another source binding.');
    }
    const reference = { version: 1, referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'attachment', externalSourceId: mediaRef, observedRevision: digest };
    return existing ? this.metadata.observeSourceReference(reference) : this.metadata.createSourceReference(reference);
  }

  async file(input = {}) {
    assertNoUnexpectedKeys(input, ['sessionKey', 'sessionId', 'mediaRef', 'subfolder', 'requestId'], 'Topic attachment filing request');
    const sessionKey = nonBlank(input.sessionKey, 'sessionKey');
    const mediaRef = canonicalInboundMediaRef(input.mediaRef);
    const firstBinding = await this.resolveBoundConversation({ sessionKey, sessionId: input.sessionId });
    const source = await this.loadExactMedia(mediaRef);
    const filename = filedName(safeFilename(source.fileName, `attachment-${sourceToken(mediaRef)}`), sourceToken(mediaRef));
    const documentPath = `${safeSubfolder(input.subfolder)}/${filename}`;
    const logicalOperationId = stableUuid('command-center.documents.file.v1', firstBinding.topicId, firstBinding.referenceId, firstBinding.sessionId, mediaRef, documentPath);
    const requestId = input.requestId ?? logicalOperationId;
    const intent = Object.freeze({ sessionKey, sessionId: firstBinding.sessionId, sessionReferenceId: firstBinding.referenceId, folderReferenceId: firstBinding.folderReferenceId, mediaRef, sourceDigest: source.digest, documentPath, contentType: source.contentType, sizeBytes: source.bytes.length });
    const execute = async () => {
      const current = await this.resolveBoundConversation({ sessionKey, sessionId: firstBinding.sessionId });
      if (current.topicId !== firstBinding.topicId || current.referenceId !== firstBinding.referenceId || current.folderReferenceId !== firstBinding.folderReferenceId) throw sourceError('source-recovery', 'Topic ownership changed before attachment filing.');
      const currentSource = await this.loadExactMedia(mediaRef);
      if (currentSource.digest !== source.digest || currentSource.bytes.length !== source.bytes.length) throw sourceError('conflict', 'The managed attachment changed before filing.');
      const created = await current.notes.create({ logicalOperationId, requestId, referenceId: current.folderReferenceId, path: documentPath, content: currentSource.bytes, sourceKind: 'document' });
      const document = created.note;
      if (!document || document.path !== documentPath || document.revision !== source.digest || document.sourceReference?.sourceKind !== 'document') throw sourceError('conflict', 'The filed document did not retain its verified identity.');
      const sourceReference = this.ensureAttachmentReference({ topicId: current.topicId, mediaRef, digest: source.digest });
      return publicReceipt({ topicId: current.topicId, sourceReference, document, mediaRef, contentType: source.contentType, sizeBytes: source.bytes.length, logicalOperationId });
    };
    const reconcile = async () => {
      const current = await this.resolveBoundConversation({ sessionKey, sessionId: firstBinding.sessionId });
      if (current.topicId !== firstBinding.topicId || current.referenceId !== firstBinding.referenceId || current.folderReferenceId !== firstBinding.folderReferenceId) return { outcome: 'conflict' };
      try {
        const document = await current.notes.read({ path: documentPath, sourceKind: 'document' });
        const attachment = this.metadata.getSourceReference?.(`attachment:${createHash('sha256').update(mediaRef).digest('hex')}`);
        if (document.revision !== source.digest || document.sourceReference?.sourceKind !== 'document' || !attachment || attachment.topicId !== current.topicId || attachment.sourceSystem !== 'openclaw' || attachment.sourceKind !== 'attachment' || attachment.externalSourceId !== mediaRef || attachment.observedRevision !== source.digest) return { outcome: 'conflict' };
        return { outcome: 'applied', value: publicReceipt({ topicId: current.topicId, sourceReference: attachment, document, mediaRef, contentType: source.contentType, sizeBytes: source.bytes.length, logicalOperationId }) };
      } catch (error) {
        if (error?.code === 'not-found' || error?.code === 'ENOENT') return { outcome: 'not-applied' };
        throw error;
      }
    };
    return this.sourceService.coordinator.mutate({ operationKind: 'documents.file', requestId, logicalOperationId, topicId: firstBinding.topicId, referenceId: firstBinding.referenceId, intent, execute, reconcile });
  }
}

export function createTopicDocumentFilingService(options) {
  return new TopicDocumentFilingService(options);
}
