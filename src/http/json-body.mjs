function invalid(message) { return Object.assign(new Error(message), { code: 'invalid-request' }); }

// One byte-accounting rule for native requests and in-process HTTP adapters.
export async function readBoundedJson(req, maxBytes) {
  function checked(bytes) {
    if (bytes.byteLength > maxBytes) throw invalid('Request body is too large.');
    return bytes;
  }
  function encoded(value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return checked(Buffer.from(value));
    if (typeof value !== 'string') throw invalid('Request body must be JSON.');
    return checked(Buffer.from(value, 'utf8'));
  }
  let bytes;
  if (req?.body !== undefined) {
    bytes = encoded(typeof req.body === 'object' && req.body !== null && !ArrayBuffer.isView(req.body) ? JSON.stringify(req.body) : req.body);
  } else if (typeof req?.readBody === 'function') {
    bytes = encoded(await req.readBody());
  } else if (typeof req?.[Symbol.asyncIterator] === 'function') {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      const part = encoded(chunk); size += part.byteLength;
      if (size > maxBytes) throw invalid('Request body is too large.');
      chunks.push(part);
    }
    bytes = Buffer.concat(chunks, size);
  } else bytes = Buffer.alloc(0);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { body: JSON.parse(text || '{}'), bytes: bytes.byteLength };
  } catch { throw invalid('Request body must be valid UTF-8 JSON.'); }
}
