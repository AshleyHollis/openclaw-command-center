import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const records = () => [
  { type: 'session', version: 3, id: 'fictional-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/fictional/workspace' },
  { type: 'message', id: 'first', parentId: null, timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Keep this text 🌻' }] } },
  { type: 'message', id: 'tool', parentId: 'first', timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'fictional_tool', arguments: { value: 7 } }] } },
  { type: 'compaction', id: 'event', parentId: 'first', timestamp: '2026-01-01T00:03:00.000Z', summary: 'Retain this branch event', firstKeptEntryId: 'first' }
];

async function fixture(t, entries = records()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-native-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const file = { name: 'fictional-session.jsonl.bak-123-456', sizeBytes: bytes.length, sha256: sha256(bytes) };
  const inventory = { snapshot: '/fictional/backup', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fictional/backup/state/agents/main/sessions', files: [file], disposition: 'retained-not-imported; do not reactivate deleted Sessions' };
  await writeFile(path.join(root, file.name), bytes);
  const inventoryBytes = Buffer.from(JSON.stringify(inventory));
  await writeFile(path.join(root, 'inventory.json'), inventoryBytes);
  return { root, file, bytes, inventory, options: { root, expectedInventorySha256: sha256(inventoryBytes), originalAgentId: 'main' } };
}

test('native history admission preserves every record and original branch as inert read-only provenance', async t => {
  const { readNativeHistoryInventory } = await import('../src/migration/native-history-source.mjs');
  const source = await fixture(t);
  const admitted = await readNativeHistoryInventory(source.options);
  assert.deepEqual(admitted.counts, { files: 1, headers: 1, messages: 2, otherRecords: 1, entries: 3 });
  const prepared = admitted.histories[0];
  assert.equal(prepared.sourceKind, 'native-jsonl-history-v1');
  assert.equal(prepared.originalSessionId, 'fictional-session');
  assert.equal(prepared.expectedCount, 3);
  assert.deepEqual(prepared.source.header, records()[0]);
  assert.deepEqual(prepared.source.file, source.file);
  assert.equal(prepared.entries[0].message.content, 'Keep this text 🌻');
  assert.equal(prepared.entries[0].parentId, null);
  assert.equal(prepared.entries[2].parentId, prepared.entries[1].eventId);
  assert.equal(prepared.entries[2].message.__openclaw.importedNativeHistoryV1.rawEntry.parentId, 'first');
  for (const [index, entry] of prepared.entries.entries()) {
    assert.equal(entry.message.role, 'user');
    assert.equal(typeof entry.message.content, 'string');
    assert.deepEqual(entry.message.__openclaw.importedNativeHistoryV1.rawEntry, records()[index + 1]);
    assert.equal(entry.message.__openclaw.importedNativeHistoryV1.sourceOrdinal, index + 1);
    assert.equal(entry.message.__openclaw.importedHistoryV1, undefined);
    assert.match(entry.idempotencyKey, /^command-center:native-history:v1:/);
    assert.ok(Object.isFrozen(entry.message.__openclaw.importedNativeHistoryV1.rawEntry));
  }
  assert.deepEqual(await readNativeHistoryInventory(source.options), admitted);
});

test('native history refuses an unapproved inventory and changed source bytes', async t => {
  const { readNativeHistoryInventory } = await import('../src/migration/native-history-source.mjs');
  const source = await fixture(t);
  await assert.rejects(readNativeHistoryInventory({ ...source.options, expectedInventorySha256: '0'.repeat(64) }), { code: 'native-history-trust-mismatch' });
  await writeFile(path.join(source.root, source.file.name), Buffer.from(source.bytes.toString().replace('Keep this text', 'Lose this text')));
  await assert.rejects(readNativeHistoryInventory(source.options), { code: 'native-history-file-mismatch' });
});

for (const [name, change] of [
  ['duplicate record', entries => entries.push(entries[1])],
  ['second header', entries => entries.push({ ...entries[0], id: 'second-session' })],
  ['unresolved parent', entries => { entries[2].parentId = 'not-retained'; }],
  ['forward parent', entries => { entries[1].parentId = 'event'; }],
  ['wrong Session identity', entries => { entries[0].id = 'different-session'; }],
  ['missing entry identity', entries => { delete entries[1].id; }],
  ['invalid timestamp', entries => { entries[1].timestamp = 'not-a-time'; }]
]) test(`native history refuses ${name} without inferring a replacement`, async t => {
  const { readNativeHistoryInventory } = await import('../src/migration/native-history-source.mjs');
  const entries = records(); change(entries);
  const source = await fixture(t, entries);
  await assert.rejects(readNativeHistoryInventory(source.options), { code: 'native-history-source-invalid' });
});

for (const [name, change] of [
  ['parent traversal', file => { file.name = '../fictional-session.jsonl'; }],
  ['absolute path', file => { file.name = '/fictional-session.jsonl'; }],
  ['oversized file', file => { file.sizeBytes = 32 * 1024 * 1024 + 1; }]
]) test(`native history rejects ${name} before reading any source`, async t => {
  const { readNativeHistoryInventory } = await import('../src/migration/native-history-source.mjs');
  const source = await fixture(t); change(source.inventory.files[0]);
  const bytes = Buffer.from(JSON.stringify(source.inventory));
  await writeFile(path.join(source.root, 'inventory.json'), bytes);
  await assert.rejects(readNativeHistoryInventory({ ...source.options, expectedInventorySha256: sha256(bytes) }),
    { code: name === 'oversized file' ? 'native-history-size-limit' : 'native-history-source-invalid' });
});

test('native history refuses a redirected source even when target bytes match', async t => {
  const { readNativeHistoryInventory } = await import('../src/migration/native-history-source.mjs');
  const source = await fixture(t);
  const original = path.join(source.root, source.file.name);
  const target = path.join(source.root, 'fictional-target');
  await writeFile(target, source.bytes);
  await rm(original);
  await symlink(target, original);
  await assert.rejects(readNativeHistoryInventory(source.options), { code: 'native-history-source-invalid' });
});

for (const malformed of ['unterminated', 'invalid-utf8']) test(`native history refuses ${malformed} JSONL even when its hash was approved`, async t => {
  const { readNativeHistoryInventory } = await import('../src/migration/native-history-source.mjs');
  const source = await fixture(t);
  const bytes = malformed === 'unterminated' ? source.bytes.subarray(0, -1) : Buffer.concat([source.bytes, Buffer.from([0xff, 0x0a])]);
  source.inventory.files[0] = { ...source.file, sizeBytes: bytes.length, sha256: sha256(bytes) };
  await writeFile(path.join(source.root, source.file.name), bytes);
  const inventoryBytes = Buffer.from(JSON.stringify(source.inventory));
  await writeFile(path.join(source.root, 'inventory.json'), inventoryBytes);
  await assert.rejects(readNativeHistoryInventory({ ...source.options, expectedInventorySha256: sha256(inventoryBytes) }), { code: 'native-history-source-invalid' });
});

test('native history bounds amplified destination bytes before returning a prepared source', async t => {
  const { readNativeHistoryInventory } = await import('../src/migration/native-history-source.mjs');
  const entries = [{ ...records()[0], preservedHeaderDetail: 'x'.repeat(131_072) }];
  for (let index = 0; index < 520; index++) entries.push({ ...records()[1], id: `entry-${index}`, parentId: null });
  const source = await fixture(t, entries);
  await assert.rejects(readNativeHistoryInventory(source.options), { code: 'native-history-size-limit' });
});

test('native history shares its destination byte budget across all admitted files', async t => {
  const { readNativeHistoryInventory } = await import('../src/migration/native-history-source.mjs');
  const entries = [{ ...records()[0], preservedHeaderDetail: 'x'.repeat(131_072) }];
  for (let index = 0; index < 260; index++) entries.push({ ...records()[1], id: `entry-${index}`, parentId: null });
  const source = await fixture(t, entries);
  assert.equal((await readNativeHistoryInventory(source.options)).counts.entries, 260);
  entries[0].id = 'fictional-second';
  const bytes = Buffer.from(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const file = { name: 'fictional-second.jsonl', sizeBytes: bytes.length, sha256: sha256(bytes) };
  await writeFile(path.join(source.root, file.name), bytes);
  source.inventory.files.push(file);
  const inventoryBytes = Buffer.from(JSON.stringify(source.inventory));
  await writeFile(path.join(source.root, 'inventory.json'), inventoryBytes);
  await assert.rejects(readNativeHistoryInventory({ ...source.options, expectedInventorySha256: sha256(inventoryBytes) }), { code: 'native-history-size-limit' });
});
