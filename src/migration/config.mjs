import { createHash } from 'node:crypto';

const channelKeys = ['channelId', 'topicId', 'paraCategory', 'noteFolderPath'];
const rootKeys = ['schemaVersion', 'exportPath', 'channels'];
const categories = new Set(['project', 'area', 'resource', 'archive']);
function fail(message) { throw new TypeError(`legacyDiscordMigration: ${message}`); }
function nonBlank(value, field) { if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be a non-blank string`); return value; }
function closed(value, keys, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`); for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${field} contains unsupported field ${key}`); }

export const legacyDiscordMigrationConfigSchema = Object.freeze({ type: 'object', additionalProperties: false, required: ['schemaVersion', 'exportPath', 'channels'], properties: Object.freeze({ schemaVersion: Object.freeze({ const: 1 }), exportPath: Object.freeze({ type: 'string', minLength: 1 }), channels: Object.freeze({ type: 'array', minItems: 1, maxItems: 100, items: Object.freeze({ type: 'object', additionalProperties: false, required: channelKeys, properties: Object.freeze({ channelId: { type: 'string', minLength: 1 }, topicId: { type: 'string', minLength: 1 }, paraCategory: { enum: [...categories] }, noteFolderPath: { type: 'string', minLength: 1 } }) }) }) }) });

export function normalizeLegacyDiscordMigration(value) {
  closed(value, rootKeys, 'configuration');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  const exportPath = nonBlank(value.exportPath, 'exportPath');
  if (!Array.isArray(value.channels) || value.channels.length === 0) fail('channels must be a non-empty array');
  if (value.channels.length > 100) fail('channels must contain at most 100 mappings');
  const channels = value.channels.map((channel, index) => {
    closed(channel, channelKeys, `channels[${index}]`);
    const result = { channelId: nonBlank(channel.channelId, `channels[${index}].channelId`), topicId: nonBlank(channel.topicId, `channels[${index}].topicId`), paraCategory: channel.paraCategory, noteFolderPath: nonBlank(channel.noteFolderPath, `channels[${index}].noteFolderPath`) };
    if (!categories.has(result.paraCategory)) fail(`channels[${index}].paraCategory is unsupported`);
    return Object.freeze(result);
  });
  for (const [field, label] of [['channelId', 'channel'], ['topicId', 'Topic'], ['noteFolderPath', 'Note Folder']]) { const seen = new Set(); for (const channel of channels) if (seen.has(channel[field])) fail(`duplicate ${label} identity`); else seen.add(channel[field]); }
  return Object.freeze({ schemaVersion: 1, exportPath, channels: Object.freeze(channels) });
}
export function normalizeOptionalLegacyDiscordMigration(value) { return value === undefined || value === null ? null : normalizeLegacyDiscordMigration(value); }
export function legacyDiscordMigrationConfigDigest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(normalizeLegacyDiscordMigration(value))).digest('hex')}`; }
