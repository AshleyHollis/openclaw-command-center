/** Read the exact authoritative Note through the operator-owned native connection. */
export async function readNativeNote(host, descriptor) {
  let offset = 0;
  let total;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (;;) {
    host.signal.throwIfAborted();
    const response = await host.request('command-center.v1.notes.read', {
      schemaVersion: 1, topicId: descriptor.topicId, referenceId: descriptor.referenceId,
      path: descriptor.path, observedRevision: descriptor.observedRevision, offset
    });
    host.signal.throwIfAborted();
    const value = response?.result ?? response;
    if (value?.path !== descriptor.path || value?.revision !== descriptor.observedRevision ||
        value?.sourceReference?.topicId !== descriptor.topicId || value?.sourceReference?.referenceId !== descriptor.referenceId) {
      throw new Error('The exact authoritative Note is unavailable.');
    }
    if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > 8 * 1024 * 1024 + 1 ||
        (total !== undefined && total !== value.totalBytes) || value.byteOffset !== offset ||
        !Number.isSafeInteger(value.nextOffset) || value.nextOffset < offset || value.nextOffset > value.totalBytes ||
        value.complete !== (value.nextOffset === value.totalBytes) || (!value.complete && value.nextOffset === offset)) {
      throw new Error('The authoritative Note changed during retrieval.');
    }
    let bytes = Uint8Array.from(atob(value.contentBase64), (character) => character.charCodeAt(0));
    if (value.contentEncoding === 'gzip') {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const parts = [];
      let length = 0;
      try {
        for (;;) {
          host.signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > value.nextOffset - offset) throw new Error('The authoritative Note chunk exceeds its declared length.');
          parts.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      bytes = new Uint8Array(length);
      let position = 0;
      for (const part of parts) { bytes.set(part, position); position += part.length; }
    } else if (value.contentEncoding !== 'identity') throw new Error('Unsupported authoritative Note encoding.');
    host.signal.throwIfAborted();
    if (bytes.length !== value.nextOffset - offset) throw new Error('The authoritative Note chunk length is invalid.');
    total = value.totalBytes;
    text += decoder.decode(bytes, { stream: !value.complete });
    if (value.complete) return { text, revision: value.revision, sourceReference: value.sourceReference };
    offset = value.nextOffset;
  }
}
