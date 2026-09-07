import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createTopicService } from '../../src/topics/service.mjs';

const [stateDir, role] = process.argv.slice(2);
// Resolve the actual SDK before announcing ready; this does not replace its lock.
await import('openclaw/plugin-sdk/sqlite-runtime');
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
const entries = new Map();
const gateway = { async request(method, input) {
  if (method !== 'sessions.create') throw new Error(`Unexpected external Session request: ${method}`);
  const key = `agent:main:fictional:${input.idempotencyKey}`;
  const entry = { sessionId: randomUUID(), updatedAt: Date.now(), label: input.label, pluginOwnerId: 'command-center' };
  entries.set(key, entry); return { key, entry };
} };
const sessionStore = {
  listSessionEntries: () => [...entries].map(([sessionKey, entry]) => ({ sessionKey, entry })),
  getSessionEntry: ({ sessionKey }) => entries.get(sessionKey),
  async patchSessionEntry({ sessionKey, fallbackEntry, replaceEntry, update }) {
    const existingEntry = entries.get(sessionKey); const current = existingEntry ?? fallbackEntry;
    const patch = await update(current, { existingEntry }); if (!patch) return null;
    const next = replaceEntry ? patch : { ...current, ...patch }; entries.set(sessionKey, next); return next;
  }
};
const topics = createTopicService({ metadata, noteVaultRoot: path.join(stateDir, 'vault'), gateway, sessionStore });
const release = Promise.withResolvers();
process.on('message', (message) => { if (message.type === 'release') release.resolve(); });
const originalOpen = filesystem.open; const originalLstat = filesystem.lstat;
let reportedLock = false;
filesystem.lstat = async (...args) => {
  if (String(args[0]).endsWith('note-filesystem-coordinator.sqlite') && !reportedLock) { reportedLock = true; process.send({ type: 'lock-attempt' }); }
  return originalLstat(...args);
};
filesystem.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (role === 'holder' && String(args[0]).endsWith('/.command-center-folder-identity')) {
    // Atomic staging has already published complete bytes. Pause the real
    // verification read before the enclosing operation can bind metadata.
    const originalStat = handle.stat.bind(handle);
    let held = false;
    handle.stat = async (...values) => {
      if (!held) { held = true; process.send({ type: 'marker-held' }); await release.promise; }
      return originalStat(...values);
    };
  }
  return handle;
};
syncBuiltinESMExports();
process.send({ type: 'ready' });
await new Promise((resolve) => process.on('message', (message) => { if (message.type === 'start') resolve(); }));
try {
  const result = role === 'recovery' ? await topics.recoveryVerify({ topicId: 'fictional-recovery', referenceId: ' folder:fictional ', expectedRevision: metadata.getTopic('fictional-recovery').revision, expectedSourceRevision: 'unbound:folder:fictional', replacementLocator: path.join(stateDir, 'vault/Projects/Shared Folder'), logicalOperationId: randomUUID() })
    : await topics.create({ topicId: `fictional-${role}`, name: 'Shared Folder', paraCategory: 'project', logicalOperationId: randomUUID() });
  process.send({ type: 'outcome', status: 'applied', result });
} catch (error) { process.send({ type: 'outcome', status: 'error', code: error.code, message: error.message }); }
finally { metadata.close(); process.disconnect(); }
