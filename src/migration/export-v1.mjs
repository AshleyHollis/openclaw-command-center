import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const rootKeys = ['schemaVersion', 'source', 'channels'];
const channelKeys = ['channelId', 'displayName', 'messages'];
const occurrenceKeys = ['messageId', 'displayOrder', 'author', 'timestamp', 'text', 'edits', 'replyToMessageId', 'reactions', 'thread', 'attachments'];
const normalizedExports = new WeakSet();
export class LegacyDiscordExportError extends Error { constructor(code, message, details = {}) { super(message); this.name = 'LegacyDiscordExportError'; this.code = code; Object.assign(this, details); } }
function fail(message, details) { throw new LegacyDiscordExportError('invalid-export', message, details); }
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`); return value; }
function closed(value, keys, field) { object(value, field); for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${field} contains unsupported field ${key}`); }
function string(value, field, { allowEmpty = false } = {}) { if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) fail(`${field} must be a ${allowEmpty ? '' : 'non-blank '}string`); return value; }
function timestamp(value, field) { const result = string(value, field); const parsed = Date.parse(result); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) fail(`${field} must be a canonical ISO timestamp`); return result; }
function nullableString(value, field) { if (value !== null && typeof value !== 'string') fail(`${field} must be null or a string`); return value; }
function integer(value, field) { if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be a non-negative integer`); return value; }
function attachmentUrl(value, field) {
  const url = nullableString(value, field);
  if (url === null) return null;
  let parsed;
  try { parsed = new URL(url); } catch { fail(`${field} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(`${field} must be an absolute credential-free HTTP(S) URL`);
  return url;
}
function normalizeAttachment(value, index) { closed(value, ['id', 'url', 'filename', 'contentType', 'sizeBytes'], `attachments[${index}]`); return Object.freeze({ id: string(value.id, `attachments[${index}].id`), url: attachmentUrl(value.url, `attachments[${index}].url`), filename: string(value.filename, `attachments[${index}].filename`, { allowEmpty: true }), contentType: nullableString(value.contentType, `attachments[${index}].contentType`), sizeBytes: value.sizeBytes === null ? null : integer(value.sizeBytes, `attachments[${index}].sizeBytes`) }); }
function normalizeOccurrence(value, channelId, index) {
  closed(value, occurrenceKeys, `channels[${channelId}].messages[${index}]`);
  const author = object(value.author, 'author'); closed(author, ['id', 'displayName'], 'author');
  const rawEdits = value.edits ?? [];
  const rawReactions = value.reactions ?? [];
  const rawAttachments = value.attachments ?? [];
  if (!Array.isArray(rawEdits) || !Array.isArray(rawReactions) || !Array.isArray(rawAttachments)) fail('edits, reactions, and attachments must be arrays when supplied');
  const sourceTimestamp = timestamp(value.timestamp, 'timestamp');
  const edits = rawEdits.map((edit, editIndex) => { closed(edit, ['editedAt', 'text'], `edits[${editIndex}]`); return Object.freeze({ editedAt: timestamp(edit.editedAt, `edits[${editIndex}].editedAt`), text: string(edit.text, `edits[${editIndex}].text`, { allowEmpty: true }) }); });
  if (edits.some((edit) => edit.editedAt < sourceTimestamp)) fail('edits must not precede the source timestamp');
  for (let editIndex = 1; editIndex < edits.length; editIndex += 1) if (edits[editIndex].editedAt < edits[editIndex - 1].editedAt) fail('edits must be chronological');
  const reactions = rawReactions.map((reaction, reactionIndex) => { closed(reaction, ['emoji', 'count', 'authorIds'], `reactions[${reactionIndex}]`); if (!Array.isArray(reaction.authorIds) || reaction.authorIds.some((id) => typeof id !== 'string' || id.trim() === '')) fail(`reactions[${reactionIndex}].authorIds must be non-empty strings`); if (new Set(reaction.authorIds).size !== reaction.authorIds.length) fail(`reactions[${reactionIndex}].authorIds must be unique`); const count = integer(reaction.count, `reactions[${reactionIndex}].count`); if (count !== reaction.authorIds.length) fail(`reactions[${reactionIndex}].count must match authorIds`); return Object.freeze({ emoji: string(reaction.emoji, `reactions[${reactionIndex}].emoji`, { allowEmpty: true }), count, authorIds: Object.freeze([...reaction.authorIds]) }); });
  const thread = value.thread === undefined || value.thread === null ? null : (() => { closed(value.thread, ['id', 'parentMessageId', 'name'], 'thread'); return Object.freeze({ id: string(value.thread.id, 'thread.id'), parentMessageId: nullableString(value.thread.parentMessageId, 'thread.parentMessageId'), name: string(value.thread.name, 'thread.name', { allowEmpty: true }) }); })();
  const attachments = rawAttachments.map(normalizeAttachment);
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) fail('attachments must have unique identities within an occurrence');
  return Object.freeze({ messageId: string(value.messageId, 'messageId'), displayOrder: integer(value.displayOrder, 'displayOrder'), author: Object.freeze({ id: string(author.id, 'author.id'), displayName: string(author.displayName, 'author.displayName', { allowEmpty: true }) }), timestamp: sourceTimestamp, text: string(value.text, 'text', { allowEmpty: true }), edits: Object.freeze(edits), replyToMessageId: value.replyToMessageId === undefined ? null : nullableString(value.replyToMessageId, 'replyToMessageId'), reactions: Object.freeze(reactions), thread, attachments: Object.freeze(attachments) });
}
export function normalizeLegacyDiscordExport(value) {
  if (normalizedExports.has(value)) return value;
  closed(value, rootKeys, 'export');
  if (value.schemaVersion !== 1 || value.source !== 'discord') fail('schemaVersion 1 with source discord is required');
  if (!Array.isArray(value.channels)) fail('channels must be an array');
  const channels = value.channels.map((channel, index) => { closed(channel, channelKeys, `channels[${index}]`); const channelId = string(channel.channelId, `channels[${index}].channelId`); if (!Array.isArray(channel.messages)) fail(`channels[${index}].messages must be an array`); const occurrences = channel.messages.map((message, messageIndex) => normalizeOccurrence(message, channelId, messageIndex)); const messageIds = new Set(occurrences.map((occurrence) => occurrence.messageId)); const orders = new Set(occurrences.map((occurrence) => occurrence.displayOrder)); if (messageIds.size !== occurrences.length) fail(`channels[${index}] contains duplicate message identities`); if (orders.size !== occurrences.length) fail(`channels[${index}] contains duplicate displayOrder positions`); const threads = new Map(); for (const occurrence of occurrences) { if (occurrence.replyToMessageId !== null && !messageIds.has(occurrence.replyToMessageId)) fail(`channels[${index}] contains a dangling reply relationship`); if (occurrence.thread && occurrence.thread.parentMessageId !== null && !messageIds.has(occurrence.thread.parentMessageId)) fail(`channels[${index}] contains a dangling thread relationship`); if (occurrence.thread) { const identity = JSON.stringify({ parentMessageId: occurrence.thread.parentMessageId, name: occurrence.thread.name }); const existing = threads.get(occurrence.thread.id); if (existing !== undefined && existing !== identity) fail(`channels[${index}] contains conflicting thread provenance`); threads.set(occurrence.thread.id, identity); } } occurrences.sort((left, right) => left.displayOrder - right.displayOrder); return Object.freeze({ channelId, displayName: string(channel.displayName, `channels[${index}].displayName`, { allowEmpty: true }), occurrences: Object.freeze(occurrences) }); });
  if (new Set(channels.map((channel) => channel.channelId)).size !== channels.length) fail('export contains duplicate channel identities');
  const normalized = Object.freeze({ schemaVersion: 1, source: 'discord', channels: Object.freeze(channels) }); normalizedExports.add(normalized); return normalized;
}
export async function readLegacyDiscordExport(exportPath) { const filename = string(exportPath, 'exportPath'); let stat; try { stat = await lstat(filename); } catch (error) { throw new LegacyDiscordExportError('export-unavailable', 'The configured export could not be inspected.', { cause: error }); } if (!stat.isFile() || stat.isSymbolicLink()) throw new LegacyDiscordExportError('export-unsafe', 'The configured export must be a regular non-symlink file.'); const canonical = await realpath(filename); if (path.resolve(canonical) !== path.resolve(filename)) throw new LegacyDiscordExportError('export-unsafe', 'The configured export path must not resolve through a symlink.'); let parsed; try { parsed = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { throw new LegacyDiscordExportError('invalid-export', 'The configured export is not valid JSON.', { cause: error }); } return normalizeLegacyDiscordExport(parsed); }
export function legacyDiscordExportDigest(value) { const normalized = normalizedExports.has(value) ? value : normalizeLegacyDiscordExport(value); return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`; }
export function selectMappedLegacyDiscordChannels(exportValue, mappings) { const normalized = normalizedExports.has(exportValue) ? exportValue : normalizeLegacyDiscordExport(exportValue); const byId = new Map(normalized.channels.map((channel) => [channel.channelId, channel])); return mappings.map((mapping) => { const channel = byId.get(mapping.channelId); if (!channel) throw new LegacyDiscordExportError('missing-channel', `Configured source channel ${mapping.channelId} is absent from the export.`); return Object.freeze({ mapping, channel }); }); }
