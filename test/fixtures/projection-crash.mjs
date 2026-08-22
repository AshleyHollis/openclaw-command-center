import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';

const stateDir = process.argv[2];
const sourcePath = process.argv[4];
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const snapshot = sourcePath ? JSON.parse(await readFile(sourcePath, 'utf8')) : { sourceRevision: 'fictional-v1', noteFolders: [{ identity: 'folder-fictional', contentDigest: digest('folder') }], sessions: [{ identity: 'session-fictional', contentDigest: digest('session') }], reminderSchedules: [{ identity: 'schedule-fictional', contentDigest: digest('schedule') }], importedHistory: [{ identity: 'history-fictional', contentDigest: digest('history') }] };
const service = openCommandCenterMetadataService({ stateDir });
try { await service.rebuildProjections({ authoritativeSources: { readSnapshot: () => snapshot } }); } finally { service.close(); }
