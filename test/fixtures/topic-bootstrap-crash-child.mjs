import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { inspectNoteFolderCandidate } from '../../src/sources/note-folder-identity.mjs';
import { adoptExistingTopic } from '../../src/topics/bootstrap.mjs';

const [mode, boundary] = process.argv.slice(2);
assert.ok(['crash', 'resume'].includes(mode) && ['before', 'after'].includes(boundary));
const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
assert.ok(stateDir && process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
const sqliteUrl = pathToFileURL(require.resolve('openclaw/plugin-sdk/sqlite-runtime')).href;
const hooks = registerHooks({ resolve: (specifier, context, nextResolve) => specifier === 'openclaw/plugin-sdk/sqlite-runtime' ? { url: sqliteUrl, shortCircuit: true } : nextResolve(specifier, context) });
const metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { notes: true, sessions: true } });
process.send?.({ phase: 'sdk-ready' });
const operationId = 'aba026c1-4a1b-4e45-a9ee-aa00673b94d1';
const topicId = 'd258a4f1-caaa-499e-8d61-a26f27060e39';
const folder = path.join(stateDir, 'vault', 'cookbook');
try {
  let input;
  if (mode === 'crash') {
    await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'Overview.md'), 'Existing cookbook knowledge.');
    input = { logicalOperationId: operationId, intent: { schemaVersion: 1, mappingDigest: 'a'.repeat(64), topicId, name: 'Cookbook', paraCategory: 'resource',
      folder: await inspectNoteFolderCandidate(folder), primary: { agentId: 'main', sessionKey: `agent:main:command-center:topic:${topicId}:primary`, sessionId: operationId, lifecycleRevision: operationId, creation: 'if-absent' } } };
    // The native SDK boundary is held immediately before/after its actual
    // conditional commit. The parent kills this process, not a simulated owner.
    const interruptedStore = { ...sessionStore, patchSessionEntry: async request => {
      const result = boundary === 'after' ? await sessionStore.patchSessionEntry(request) : undefined;
      assert.equal(metadata.getTopicBootstrap(operationId).phase, 'creating');
      assert.equal(metadata.getTopic(topicId), null);
      assert.ok(process.send);
      process.send({ boundary: `native-primary-${boundary}-commit` });
      await new Promise(() => {});
      return result;
    } };
    await adoptExistingTopic({ metadata, sessionStore: interruptedStore, input, mode: 'execute', assertCurrent: () => {} });
    assert.fail('Parent did not interrupt the requested boundary');
  } else {
    const pending = metadata.getTopicBootstrap(operationId);
    assert.equal(pending.phase, 'creating');
    input = { logicalOperationId: operationId, intent: pending.intent };
    const scope = { agentId: 'main', sessionKey: pending.intent.primary.sessionKey, readConsistency: 'latest' };
    const nativeBefore = sessionStore.getSessionEntry(scope);
    const resume = () => adoptExistingTopic({ metadata, sessionStore, input, mode: 'resume', assertCurrent: () => {} });
    if (boundary === 'before') {
      assert.equal(nativeBefore, undefined);
      await assert.rejects(resume(), { code: 'bootstrap-creation-unknown' });
      assert.equal(sessionStore.getSessionEntry(scope), undefined, 'unknown dispatch must not recreate a Session');
      assert.deepEqual(metadata.getTopicBootstrap(operationId), pending);
      assert.equal(metadata.getTopic(topicId), null);
    } else {
      assert.equal(nativeBefore.sessionId, operationId);
      const applied = await resume();
      assert.equal(applied.phase, 'applied');
      assert.equal(metadata.getSessionState(applied.sessionReferenceId).sessionId, operationId);
      assert.deepEqual(sessionStore.getSessionEntry(scope), nativeBefore, 'resume binds the original effect without rewriting it');
      assert.deepEqual(await adoptExistingTopic({ metadata, sessionStore, input, mode: 'verify', assertCurrent: () => {} }), applied);
    }
    assert.equal(await readFile(path.join(folder, 'Overview.md'), 'utf8'), 'Existing cookbook knowledge.');
    console.log(`verified bootstrap ${boundary}-commit recovery`);
  }
} finally { metadata.close(); hooks.deregister(); }
