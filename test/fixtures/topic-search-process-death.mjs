import { readFile } from 'node:fs/promises';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { publishTopicSearchSnapshot } from '../../src/search/rebuild.mjs';
import { openProjectionStore } from '../../src/search/projection-store.mjs';

const [stateDir, mode, preparedFile] = process.argv.slice(2);
const prepared = JSON.parse(await readFile(preparedFile, 'utf8'));
if (mode === 'group') {
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, search: true } });
  try { await publishTopicSearchSnapshot({ stateDir, prepared, metadata }); }
  finally { metadata.close(); }
} else if (mode === 'note') {
  const store = await openProjectionStore({ stateDir, kind: 'note' });
  try { await store.rebuild({ topicIds: prepared.topicIds, rows: prepared.notes, sourceRevision: prepared.noteSourceRevision }); }
  finally { store.close(); }
} else throw new Error(`Unknown crash fixture mode: ${mode}`);
throw new Error('The configured process-death point was not reached.');
