import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readPreservedSourceFile } from './preservation-bundle.mjs';

const fail = (code = 'native-history-source-invalid') => { throw Object.assign(new Error(code), { code }); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,300}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => sha256(JSON.stringify(canonical(value)));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function prepare(bytes, file, inventory, sourceInventorySha256, originalAgentId, budget) {
  if (bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256) fail('native-history-file-mismatch');
  const lines = decode(bytes).split('\n');
  // Truncated JSONL is not a complete source, even when its last JSON happens
  // to parse. Empty lines have no Session identity and may be ignored.
  if (lines.pop() !== '') fail();
  const records = lines.filter(line => line.trim()).map(line => {
    if (Buffer.byteLength(line) > 262_144) fail('native-history-size-limit');
    const record = JSON.parse(line);
    if (!record || Array.isArray(record) || typeof record !== 'object') fail();
    return record;
  });
  if (!records.length || records.length > 100_001) fail('native-history-size-limit');
  const [header, ...rawEntries] = records;
  budget.entries += rawEntries.length;
  if (budget.entries > 100_000) fail('native-history-size-limit');
  if (header.type !== 'session' || !identity(header.id) || !Number.isSafeInteger(header.version)
      || !file.name.startsWith(`${header.id}.jsonl`)) fail();
  const source = { kind: 'native-jsonl-history-v1', inventorySha256: sourceInventorySha256,
    snapshotManifestSha256: inventory.manifestSha256, originalAgentId, originalSessionId: header.id, file, header };
  const seen = new Set([header.id]);
  let parentId = null;
  let messages = 0;
  const entries = rawEntries.map((rawEntry, index) => {
    if (!identity(rawEntry.id) || seen.has(rawEntry.id) || !identity(rawEntry.type) || rawEntry.type === 'session'
        || !(rawEntry.parentId === null || (identity(rawEntry.parentId) && seen.has(rawEntry.parentId)))) fail();
    seen.add(rawEntry.id);
    const timestamp = typeof rawEntry.timestamp === 'string' ? Date.parse(rawEntry.timestamp) : NaN;
    if (!Number.isSafeInteger(timestamp)) fail();
    let content;
    let senderName = `Session event: ${rawEntry.type}`;
    if (rawEntry.type === 'message') {
      const original = rawEntry.message;
      if (!original || Array.isArray(original) || typeof original !== 'object' || !identity(original.role)) fail();
      messages++;
      senderName = original.role;
      content = typeof original.content === 'string' ? original.content : Array.isArray(original.content)
        ? original.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
    }
    const key = digest(['native-jsonl-history-v1', sourceInventorySha256, originalAgentId, file.name, rawEntry.id]);
    const eventId = `cc-native-history-${key}`;
    const idempotencyKey = `command-center:native-history:v1:${key}`;
    // All original assistant/tool payloads and branch structure remain inert
    // provenance. Native destination entries form a fresh read-only sequence.
    const message = { role: 'user', content: content || senderName, timestamp, idempotencyKey,
      __openclaw: { senderName, importedNativeHistoryV1: { schemaVersion: 1, disposition: 'historical',
        source, sourceOrdinal: index + 1, rawEntry } } };
    const entry = { eventId, parentId, idempotencyKey, message };
    const entryBytes = Buffer.byteLength(JSON.stringify(entry));
    budget.bytes += entryBytes;
    if (entryBytes > 524_288 || budget.bytes > 64 * 1024 * 1024) fail('native-history-size-limit');
    parentId = eventId;
    return entry;
  });
  return { sourceKind: source.kind, sourceInventorySha256, originalAgentId, originalSessionId: header.id,
    sourceFile: file, source, expectedCount: entries.length, sourceDigest: digest({ source, entries }), entries,
    counts: { messages, otherRecords: entries.length - messages } };
}

// Admission is pinned to an independently retained inventory digest, not a
// Discord signature, directory listing, filename heuristic or current Session.
// This owner only reads preserved copies; it grants no destination writes.
export async function readNativeHistoryInventory(options) {
  try {
    const { root: suppliedRoot, expectedInventorySha256, originalAgentId } = structuredClone(options);
    if (!hashValue(expectedInventorySha256) || typeof originalAgentId !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(originalAgentId)) fail('native-history-trust-required');
    if (typeof suppliedRoot !== 'string' || !path.isAbsolute(suppliedRoot)) fail();
    const root = path.resolve(suppliedRoot);
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) fail();
    const inventoryBytes = await readPreservedSourceFile(root, 'inventory.json', 8 * 1024 * 1024);
    if (sha256(inventoryBytes) !== expectedInventorySha256) fail('native-history-trust-mismatch');
    const inventory = JSON.parse(decode(inventoryBytes));
    if (!inventory || !hashValue(inventory.manifestSha256) || typeof inventory.snapshot !== 'string'
        || typeof inventory.sourceDirectory !== 'string' || !inventory.sourceDirectory.endsWith(`/agents/${originalAgentId}/sessions`)
        || !Array.isArray(inventory.files) || inventory.files.length > 100) fail();
    const names = new Set();
    let totalBytes = 0;
    // Admit the complete layout and byte budget before reading any transcript.
    for (const file of inventory.files) {
      if (!file || Object.keys(file).some(key => !['name', 'sizeBytes', 'sha256'].includes(key))
          || typeof file.name !== 'string' || !/^[A-Za-z0-9_-]+\.jsonl(?:[.][A-Za-z0-9_.-]+)?$/.test(file.name)
          || file.name.length > 255 || !hashValue(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1) fail();
      const key = file.name.toLowerCase();
      if (names.has(key)) fail();
      names.add(key);
      totalBytes += file.sizeBytes;
      if (file.sizeBytes > 32 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024) fail('native-history-size-limit');
    }
    const histories = [];
    // Source bytes alone do not bound output: full preserved headers and native
    // provenance appear in every destination entry. Share both budgets across
    // the entire inventory and stop before retaining an over-budget entry.
    const budget = { entries: 0, bytes: 0 };
    for (const file of inventory.files) histories.push(prepare(await readPreservedSourceFile(root, file.name), file, inventory, expectedInventorySha256, originalAgentId, budget));
    return freeze({ sourceInventorySha256: expectedInventorySha256, histories,
      counts: { files: histories.length, headers: histories.length,
        messages: histories.reduce((sum, item) => sum + item.counts.messages, 0),
        otherRecords: histories.reduce((sum, item) => sum + item.counts.otherRecords, 0),
        entries: histories.reduce((sum, item) => sum + item.expectedCount, 0) } });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('native-history-')) throw error;
    // Filesystem/parser errors can contain private paths or transcript text.
    fail();
  }
}
