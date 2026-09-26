import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';

const stateDir = process.argv[2];
const sourceRoot = process.argv[4];
const availableCapabilities = Object.freeze({ notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true });
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fields = { noteFolders: 'folder-fictional', sessions: 'session-fictional', reminderSchedules: 'schedule-fictional', importedHistory: 'history-fictional' };
const snapshot = {
  sourceRevision: 'fictional-v1',
  ...Object.fromEntries(await Promise.all(Object.entries(fields).map(async ([field, identity]) => [field, [{ identity, contentDigest: digest(await readFile(path.join(sourceRoot, `${field}.fixture`))) }]])))
};
const service = openCommandCenterMetadataService({ stateDir, capabilities: availableCapabilities });
try { await service.rebuildProjections({ authoritativeSources: { readSnapshot: () => snapshot } }); } finally { service.close(); }
