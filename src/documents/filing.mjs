import { createHash } from 'node:crypto';
import path from 'node:path';
import { createNativeAttachmentReader } from './native-attachments.mjs';
import { sourceError, assertNoUnexpectedKeys, nonBlank } from '../sources/errors.mjs';
import { revisionForBytes } from '../sources/reference.mjs';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';

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
  constructor({ sourceService, metadata, mediaLoader, attachmentReader } = {}) {
    if (!sourceService || !metadata || typeof mediaLoader !== 'function') throw new TypeError('Topic document filing requires source, metadata, and managed-media capabilities.');
    this.sourceService = sourceService;
    this.metadata = metadata;
    this.mediaLoader = mediaLoader;
    this.attachmentReader = attachmentReader ?? createNativeAttachmentReader();
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

  assertReviewCurrent(runtime) {
    if (typeof runtime?.assertCurrent !== 'function' || runtime.assertCurrent()?.then) throw sourceError('unauthenticated', 'Current synchronous native request authority is required.');
  }

  reviewTargetBasis(binding) {
    const topic = this.metadata.getTopic(binding.topicId);
    const session = this.metadata.getSourceReference(binding.referenceId);
    const state = this.metadata.getSessionState(binding.referenceId);
    const sessionLocator = this.metadata.getSourceLocator(binding.referenceId);
    const folders = this.metadata.listSourceReferences(binding.topicId).filter(reference => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
    const folder = this.metadata.getSourceReference(binding.folderReferenceId);
    const locator = this.metadata.getSourceLocator(binding.folderReferenceId);
    if (!topic || session?.topicId !== binding.topicId || session.sourceSystem !== 'openclaw' || session.sourceKind !== 'session' || (sessionLocator?.locator ?? session.externalSourceId) !== binding.sessionKey || state?.sessionId !== binding.sessionId || state.status !== 'open' || folder?.topicId !== binding.topicId || folder.sourceSystem !== 'obsidian' || folder.sourceKind !== 'note_folder' || !locator || folders.length !== 1 || folders[0].referenceId !== binding.folderReferenceId) throw sourceError('source-recovery', 'The exact current review destination is unavailable.');
    return JSON.stringify([
      topic.topicId, topic.revision, topic.lifecycle, topic.paraCategory,
      session.referenceId, session.externalSourceId, state.sessionId, state.status,
      sessionLocator?.locator, sessionLocator?.locatorVersion, sessionLocator?.observedRevision,
      folder.referenceId, folder.externalSourceId, folder.observedRevision,
      locator.locator, locator.locatorVersion, locator.observedRevision, locator.ownership,
    ]);
  }

  captureReviewTarget(binding, runtime) {
    const basis = this.reviewTargetBasis(binding);
    const assertCurrent = () => {
      if (this.reviewTargetBasis(binding) !== basis) throw sourceError('conflict', 'The Topic or Note Folder changed during attachment review.');
      this.sourceService.assertDocumentReviewConversation?.(binding);
    };
    runtime.captureReviewFence?.(assertCurrent);
    return assertCurrent;
  }

  attachmentIdentity(binding) {
    const agentId = binding.sessionKey.split(':')[1];
    return { agentId, sessionKey: binding.sessionKey, sessionId: binding.sessionId };
  }

  async listAttachments(input = {}, runtime) {
    assertNoUnexpectedKeys(input, ['topicId', 'sessionKey', 'sessionId', 'offset'], 'Conversation attachment selection');
    nonBlank(input.sessionId, 'sessionId');
    this.assertReviewCurrent(runtime);
    const binding = await this.resolveBoundConversation(input);
    if (input.topicId !== undefined && input.topicId !== binding.topicId) throw sourceError('cross-topic', 'Attachment review requires the exact linked Topic.');
    const assertTargetCurrent = this.captureReviewTarget(binding, runtime);
    const page = await this.attachmentReader.list(this.attachmentIdentity(binding), { offset: input.offset });
    const latest = await this.resolveBoundConversation(input);
    if (latest.topicId !== binding.topicId || latest.referenceId !== binding.referenceId || latest.folderReferenceId !== binding.folderReferenceId) throw sourceError('source-recovery', 'The exact Topic destination changed during attachment selection.');
    assertTargetCurrent();
    this.assertReviewCurrent(runtime);
    return Object.freeze({ ...page, topicId: binding.topicId, topicName: binding.name, sessionKey: binding.sessionKey, sessionId: binding.sessionId });
  }

  async reviewAttachment(input = {}, runtime) {
    assertNoUnexpectedKeys(input, ['topicId', 'sessionKey', 'sessionId', 'selection', 'subfolder'], 'Topic attachment review');
    nonBlank(input.sessionId, 'sessionId');
    const destination = safeSubfolder(input.subfolder);
    this.assertReviewCurrent(runtime);
    const binding = await this.resolveBoundConversation(input);
    if (input.topicId !== undefined && input.topicId !== binding.topicId) throw sourceError('cross-topic', 'Attachment review requires the exact linked Topic.');
    const assertTargetCurrent = this.captureReviewTarget(binding, runtime);
    const identity = this.attachmentIdentity(binding);
    const attachment = await this.attachmentReader.resolve(identity, input.selection);
    this.readOwnedAttachmentReference({ topicId: binding.topicId, mediaRef: attachment.mediaRef });
    const source = await this.loadExactMedia(attachment.mediaRef);
    if (attachment.sizeBytes !== null && attachment.sizeBytes !== source.bytes.length || attachment.contentType && source.contentType && attachment.contentType !== source.contentType) throw sourceError('conflict', 'The original managed attachment no longer matches its accepted native media fact.');
    await this.attachmentReader.resolve(identity, attachment.selection);
    const latest = await this.resolveBoundConversation(input);
    if (latest.topicId !== binding.topicId || latest.referenceId !== binding.referenceId || latest.folderReferenceId !== binding.folderReferenceId) throw sourceError('source-recovery', 'The exact Topic destination changed during attachment review.');
    this.readOwnedAttachmentReference({ topicId: binding.topicId, mediaRef: attachment.mediaRef });
    assertTargetCurrent();
    this.assertReviewCurrent(runtime);
    const filename = filedName(safeFilename(attachment.fileName ?? source.fileName, `attachment-${sourceToken(attachment.mediaRef)}`), sourceToken(attachment.mediaRef));
    return Object.freeze({ schemaVersion: 1, status: 'review', topicId: binding.topicId, topicName: binding.name,
      selection: attachment.selection,
      source: Object.freeze({ sessionKey: binding.sessionKey, sessionId: binding.sessionId, referenceId: binding.referenceId, entryId: attachment.selection.entryId, createdAt: attachment.createdAt }),
      document: Object.freeze({ path: `${destination}/${filename}`, revision: source.digest, contentType: attachment.contentType ?? source.contentType, sizeBytes: source.bytes.length }) });
  }

  async loadExactMedia(mediaRef) {
    const loaded = await this.mediaLoader(mediaRef, { maxBytes: MAX_ATTACHMENT_BYTES, optimizeImages: false });
    if (!loaded || !Buffer.isBuffer(loaded.buffer)) throw sourceError('unavailable', 'The managed attachment could not be read.');
    if (loaded.buffer.length > MAX_ATTACHMENT_BYTES) throw sourceError('response-too-large', 'The managed original exceeds the bounded filing limit.');
    return Object.freeze({
      bytes: Buffer.from(loaded.buffer),
      digest: revisionForBytes(loaded.buffer),
      contentType: typeof loaded.contentType === 'string' ? loaded.contentType : null,
      fileName: typeof loaded.fileName === 'string' ? loaded.fileName : null,
    });
  }

  frozenRequest(input, runtime) {
    assertNoUnexpectedKeys(input, ['topicId', 'sessionKey', 'sessionId', 'selection', 'subfolder', 'logicalOperationId'], 'Prepared attachment filing');
    assertNoUnexpectedKeys(input.selection, ['entryId', 'mediaIndex', 'offset', 'generation'], 'Native attachment selection');
    const { entryId, mediaIndex, offset, generation } = input.selection;
    if (!Number.isSafeInteger(mediaIndex) || mediaIndex < 0 || !Number.isSafeInteger(offset) || offset < 0) throw sourceError('invalid-request', 'The exact bounded attachment selection is required.');
    return { principalId: nonBlank(runtime?.principalId, 'principalId'), topicId: nonBlank(input.topicId, 'topicId'),
      sessionKey: nonBlank(input.sessionKey, 'sessionKey'), sessionId: nonBlank(input.sessionId, 'sessionId'),
      selection: { entryId: nonBlank(entryId, 'entryId'), mediaIndex, offset, generation: nonBlank(generation, 'generation') },
      subfolder: safeSubfolder(input.subfolder) };
  }

  preparedReceipt(record) {
    const { intent } = record;
    return Object.freeze({ schemaVersion: 2, status: record.state === 'applied' ? 'filed' : record.currentStep === 'prepared' ? 'prepared' : 'unknown', logicalOperationId: record.logicalOperationId,
      topicId: record.topicId, topicName: intent.topicName, source: Object.freeze({ referenceId: intent.sessionReferenceId, sessionKey: intent.request.sessionKey,
        sessionId: intent.request.sessionId, entryId: intent.request.selection.entryId, createdAt: intent.sourceCreatedAt }),
      document: Object.freeze({ path: intent.documentPath, revision: intent.sourceDigest, contentType: intent.contentType, sizeBytes: intent.sizeBytes }) });
  }

  async prepareAttachment(input = {}, runtime) {
    this.assertReviewCurrent(runtime);
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const request = this.frozenRequest(input, runtime);
    const retained = this.metadata.getTopicOperation(logicalOperationId);
    if (retained) {
      if (retained.operationKind !== 'documents.file.v2' || JSON.stringify(retained.intent.request) !== JSON.stringify(request)) throw sourceError('intent-mismatch', 'The filing operation retains its original principal, source and destination request.');
      const binding = await this.resolveBoundConversation(request);
      if (this.reviewTargetBasis(binding) !== retained.intent.targetBasis) throw sourceError('conflict', 'The original filing destination changed.');
      this.assertReviewCurrent(runtime);
      if (retained.state === 'applied') {
        const checked = await this.checkPreparedAttachment({ logicalOperationId, topicId: request.topicId, sessionKey: request.sessionKey, sessionId: request.sessionId }, runtime);
        if (checked.status !== 'applied') throw sourceError('source-recovery', 'The original completed filing no longer has causal publication proof.');
        return checked.value;
      }
      return Object.freeze({ ...this.preparedReceipt(retained), canFile: retained.currentStep === 'prepared' && typeof runtime.admitAttachment === 'function' });
    }
    const binding = await this.resolveBoundConversation(request);
    const targetBasis = this.reviewTargetBasis(binding);
    const { logicalOperationId: _id, ...reviewInput } = input;
    const review = await this.reviewAttachment(reviewInput, runtime);
    const attachment = await this.attachmentReader.resolve(this.attachmentIdentity(binding), request.selection);
    if (this.reviewTargetBasis(binding) !== targetBasis) throw sourceError('conflict', 'The original filing destination changed during preparation.');
    this.sourceService.assertDocumentReviewConversation?.(binding);
    this.assertReviewCurrent(runtime);
    const intent = { version: 2, request, topicName: review.topicName, targetBasis, sessionReferenceId: binding.referenceId,
      folderReferenceId: binding.folderReferenceId, mediaRef: attachment.mediaRef, sourceDigest: review.document.revision,
      documentPath: review.document.path, contentType: review.document.contentType, sizeBytes: review.document.sizeBytes, sourceCreatedAt: review.source.createdAt,
      noteLogicalOperationId: stableUuid('command-center.documents.file.v2.note', logicalOperationId) };
    const record = this.metadata.prepareDocumentFiling({ logicalOperationId, topicId: binding.topicId, operationKind: 'documents.file.v2', intent, state: 'pending', currentStep: 'prepared' }, () => {
      this.assertReviewCurrent(runtime);
      if (this.reviewTargetBasis(binding) !== targetBasis) throw sourceError('conflict', 'The original filing destination changed.');
      this.sourceService.assertDocumentReviewConversation?.(binding);
    });
    if (record.state === 'applied') return (await this.checkPreparedAttachment({ logicalOperationId, topicId: request.topicId, sessionKey: request.sessionKey, sessionId: request.sessionId }, runtime)).value;
    return Object.freeze({ ...this.preparedReceipt(record), canFile: record.currentStep === 'prepared' && typeof runtime.admitAttachment === 'function' });
  }

  async resolveOriginalFiling(input, runtime) {
    assertNoUnexpectedKeys(input, ['logicalOperationId', 'topicId', 'sessionKey', 'sessionId'], 'Retained attachment filing');
    this.assertReviewCurrent(runtime);
    const id = assertLogicalOperationId(input.logicalOperationId);
    const record = this.metadata.getTopicOperation(id);
    if (record?.operationKind !== 'documents.file.v2' || record.intent?.version !== 2) throw sourceError('source-recovery', 'This is not an original v2 filing intent; legacy attempts require their original recovery path.');
    const { request } = record.intent;
    if (request.principalId !== runtime?.principalId || request.topicId !== input.topicId || request.sessionKey !== input.sessionKey || request.sessionId !== input.sessionId) throw sourceError('cross-topic', 'The original filing principal and Conversation scope are required.');
    const binding = await this.resolveBoundConversation(request);
    const assertTarget = () => {
      if (this.reviewTargetBasis(binding) !== record.intent.targetBasis) throw sourceError('conflict', 'The original filing destination changed.');
      this.sourceService.assertDocumentReviewConversation?.(binding);
      this.readOwnedAttachmentReference({ topicId: record.topicId, mediaRef: record.intent.mediaRef });
    };
    runtime.captureReviewFence?.(assertTarget);
    const assertCurrent = () => { this.assertReviewCurrent(runtime); assertTarget(); };
    assertCurrent();
    if (!binding.notes.recovery?.enabled) throw sourceError('capability-unavailable', 'Durable Note recovery is required for original filing.');
    return { record, binding, assertCurrent };
  }

  noteIntent(record) {
    return { logicalOperationId: record.intent.noteLogicalOperationId, requestId: record.logicalOperationId,
      referenceId: record.intent.folderReferenceId, path: record.intent.documentPath, sourceKind: 'document', contentRevision: record.intent.sourceDigest };
  }

  async checkPreparedAttachment(input, runtime, deliver = false) {
    const { record, binding, assertCurrent } = await this.resolveOriginalFiling(input, runtime);
    const noteInput = this.noteIntent(record);
    return binding.notes.recovery.runExactReconciliation(noteInput, 'create', async () => {
      const recovered = await binding.notes.recovery.reconcile(noteInput, 'create');
      assertCurrent();
      const outcome = recovered?.outcome ?? (record.currentStep === 'prepared' ? 'not-applied' : 'unknown');
      if (outcome !== 'applied') return Object.freeze({ schemaVersion: 2, status: outcome, logicalOperationId: record.logicalOperationId, value: null });
      const fence = await binding.notes.recovery.captureCreateCompletionFence(noteInput);
      let result;
      try {
        const value = this.metadata.completeDocumentFiling({ logicalOperationId: record.logicalOperationId }, () => { assertCurrent(); fence.assertCurrent(); });
        result = Object.freeze({ schemaVersion: 2, status: 'applied', logicalOperationId: record.logicalOperationId, value });
        if (deliver) { assertCurrent(); fence.assertCurrent(); if (runtime.deliverResult?.(result)?.then) throw sourceError('unauthenticated', 'Synchronous document delivery is required.'); }
      }
      finally { await fence.close(); }
      return result;
    });
  }

  async filePreparedAttachment(input, runtime) {
    const { record, binding, assertCurrent } = await this.resolveOriginalFiling(input, runtime);
    const noteInput = this.noteIntent(record);
    return binding.notes.recovery.runExactReconciliation(noteInput, 'create', async () => {
      const current = this.metadata.getTopicOperation(record.logicalOperationId);
      if (current.currentStep !== 'prepared') return this.checkPreparedAttachment(input, runtime, true);
      // The native implementation is deliberately supplied by authenticated
      // host runtime, never JSON or configuration. No fallback promotes a read
      // snapshot into source commit authority.
      if (typeof runtime.admitAttachment !== 'function') throw sourceError('capability-unavailable', 'Native accepted attachment admission is unavailable.');
      const claim = this.metadata.claimDocumentFiling({ logicalOperationId: current.logicalOperationId }, assertCurrent);
      if (!claim.dispatch) return this.checkPreparedAttachment(input, runtime, true);
      const source = await this.loadExactMedia(record.intent.mediaRef);
      if (source.digest !== record.intent.sourceDigest || source.bytes.length !== record.intent.sizeBytes) throw sourceError('conflict', 'The original attachment bytes changed.');
      const admission = await runtime.admitAttachment({ ...this.attachmentIdentity(binding), selection: record.intent.request.selection,
        mediaRef: record.intent.mediaRef, sourceDigest: record.intent.sourceDigest, sizeBytes: record.intent.sizeBytes });
      if (typeof admission?.withCommit !== 'function') throw sourceError('capability-unavailable', 'Native synchronous attachment admission is unavailable.');
      assertCurrent();
      await binding.notes.create({ ...noteInput, content: source.bytes }, { commit: effect => admission.withCommit(() => { assertCurrent(); return effect(); }) });
      return this.checkPreparedAttachment(input, runtime, true);
    });
  }

  async reopenPreparedAttachment(input, runtime) {
    const { record, binding, assertCurrent } = await this.resolveOriginalFiling(input, runtime);
    if (record.state !== 'applied' || !record.result?.value) throw sourceError('source-recovery', 'Only a completed original filing can be reopened.');
    return binding.notes.recovery.runExactReconciliation(this.noteIntent(record), 'create', async () => {
    const checked = await this.checkPreparedAttachment(input, runtime);
    if (checked.status !== 'applied') throw sourceError('source-recovery', 'The original document no longer has causal publication proof.');
    const document = await binding.notes.read({ path: record.intent.documentPath, referenceId: record.result.value.document.referenceId, sourceKind: 'document', observe: false });
    if (document.revision !== record.intent.sourceDigest) throw sourceError('conflict', 'The original filed document changed.');
    const final = await binding.notes.recovery.reconcile(this.noteIntent(record), 'create');
    if (final?.outcome !== 'applied') throw sourceError('conflict', 'The original document was replaced during reopening.');
    const fence = await binding.notes.recovery.captureCreateCompletionFence(this.noteIntent(record));
    const result = Object.freeze({ schemaVersion: 2, status: 'filed', logicalOperationId: record.logicalOperationId, source: record.result.value.source, document: record.result.value.document });
    try {
      assertCurrent(); fence.assertCurrent();
      if (runtime.deliverResult?.(result)?.then) throw sourceError('unauthenticated', 'Synchronous original document delivery is required.');
    }
    finally { await fence.close(); }
    // Existing reader APIs own content/preview delivery. This command returns
    // their exact Source Reference plus retained Conversation/message lineage.
    return result;
    });
  }

  readOwnedAttachmentReference({ topicId, mediaRef }) {
    const referenceId = `attachment:${createHash('sha256').update(mediaRef).digest('hex')}`;
    const existing = this.metadata.getSourceReference?.(referenceId);
    if (existing && (existing.topicId !== topicId || existing.sourceSystem !== 'openclaw' || existing.sourceKind !== 'attachment' || existing.externalSourceId !== mediaRef)) {
      throw sourceError('cross-topic', 'This managed attachment is already owned by another source binding.');
    }
    return existing ?? null;
  }

  ensureAttachmentReference({ topicId, mediaRef, digest }) {
    const existing = this.readOwnedAttachmentReference({ topicId, mediaRef });
    const referenceId = `attachment:${createHash('sha256').update(mediaRef).digest('hex')}`;
    const reference = { version: 1, referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'attachment', externalSourceId: mediaRef, observedRevision: digest };
    return existing ? this.metadata.observeSourceReference(reference) : this.metadata.createSourceReference(reference);
  }

  async file(input = {}) {
    assertNoUnexpectedKeys(input, ['sessionKey', 'sessionId', 'mediaRef', 'subfolder', 'requestId'], 'Topic attachment filing request');
    const sessionKey = nonBlank(input.sessionKey, 'sessionKey');
    const mediaRef = canonicalInboundMediaRef(input.mediaRef);
    const firstBinding = await this.resolveBoundConversation({ sessionKey, sessionId: input.sessionId });
    this.readOwnedAttachmentReference({ topicId: firstBinding.topicId, mediaRef });
    const source = await this.loadExactMedia(mediaRef);
    const filename = filedName(safeFilename(source.fileName, `attachment-${sourceToken(mediaRef)}`), sourceToken(mediaRef));
    const documentPath = `${safeSubfolder(input.subfolder)}/${filename}`;
    const logicalOperationId = stableUuid('command-center.documents.file.v1', firstBinding.topicId, firstBinding.referenceId, firstBinding.sessionId, mediaRef, documentPath);
    const requestId = input.requestId ?? logicalOperationId;
    const intent = Object.freeze({ sessionKey, sessionId: firstBinding.sessionId, sessionReferenceId: firstBinding.referenceId, folderReferenceId: firstBinding.folderReferenceId, mediaRef, sourceDigest: source.digest, documentPath, contentType: source.contentType, sizeBytes: source.bytes.length });
    const noteInput = Object.freeze({ logicalOperationId, requestId, referenceId: firstBinding.folderReferenceId, path: documentPath, content: source.bytes, sourceKind: 'document' });
    const execute = async () => {
      const current = await this.resolveBoundConversation({ sessionKey, sessionId: firstBinding.sessionId });
      if (current.topicId !== firstBinding.topicId || current.referenceId !== firstBinding.referenceId || current.folderReferenceId !== firstBinding.folderReferenceId) throw sourceError('source-recovery', 'Topic ownership changed before attachment filing.');
      const currentSource = await this.loadExactMedia(mediaRef);
      if (currentSource.digest !== source.digest || currentSource.bytes.length !== source.bytes.length) throw sourceError('conflict', 'The managed attachment changed before filing.');
      this.readOwnedAttachmentReference({ topicId: current.topicId, mediaRef });
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
        // Matching current bytes cannot identify our publication. Consult the
        // existing Note owner's retained create inode and original operation.
        const recovery = current.notes.recovery;
        if (!recovery?.enabled) return { outcome: 'unknown' };
        const recovered = await recovery.reconcile(noteInput, 'create');
        if (recovered?.outcome !== 'applied') return { outcome: recovered?.outcome ?? 'unknown' };
        const document = recovered.value?.note;
        const attachment = this.metadata.getSourceReference?.(`attachment:${createHash('sha256').update(mediaRef).digest('hex')}`);
        if (document?.path !== documentPath || document.revision !== source.digest || document.sourceReference?.sourceKind !== 'document') return { outcome: 'conflict' };
        if (attachment && (attachment.topicId !== current.topicId || attachment.sourceSystem !== 'openclaw' || attachment.sourceKind !== 'attachment' || attachment.externalSourceId !== mediaRef || attachment.observedRevision !== source.digest)) return { outcome: 'conflict' };
        // Repair only the binding of this already-proven publication. This does
        // not create or replace a file, or infer an effect from equal content.
        const sourceReference = attachment ?? this.ensureAttachmentReference({ topicId: current.topicId, mediaRef, digest: source.digest });
        return { outcome: 'applied', value: publicReceipt({ topicId: current.topicId, sourceReference, document, mediaRef, contentType: source.contentType, sizeBytes: source.bytes.length, logicalOperationId }) };
      } catch (error) {
        if (error?.code === 'not-found' || error?.code === 'ENOENT') return { outcome: 'unknown' };
        throw error;
      }
    };
    const coordinate = () => {
      const existing = this.sourceService.coordinator.journal?.get(logicalOperationId) ?? this.metadata.getOperation?.(logicalOperationId);
      // A retained attempt is recovery-only, even when its Note owner proves
      // not-applied. Explicit reconciliation must never enter fresh execution.
      return this.sourceService.coordinator[existing ? 'reconcile' : 'mutate']({ operationKind: 'documents.file', requestId, logicalOperationId, topicId: firstBinding.topicId, referenceId: firstBinding.referenceId, intent, execute, reconcile });
    };
    const recovery = firstBinding.notes.recovery;
    // Retain the existing Note exclusion through verification, source binding
    // and the coordinator's durable filing receipt, as for ordinary Note writes.
    return recovery?.enabled ? recovery.runExactReconciliation(noteInput, 'create', coordinate) : coordinate();
  }
}

export function createTopicDocumentFilingService(options) {
  return new TopicDocumentFilingService(options);
}
