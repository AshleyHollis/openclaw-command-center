import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { TopicProvisioningService } from '../../src/topics/provisioning.mjs';

const [mode, boundary] = process.argv.slice(2);
assert.ok(['crash', 'resume'].includes(mode) && ['before', 'after'].includes(boundary));
const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
assert.ok(stateDir && process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
const resolved = new Map(['sqlite-runtime', 'file-access-runtime'].map(name => [`openclaw/plugin-sdk/${name}`, pathToFileURL(require.resolve(`openclaw/plugin-sdk/${name}`)).href]));
const hooks = registerHooks({ resolve: (specifier, context, nextResolve) => resolved.has(specifier) ? { url: resolved.get(specifier), shortCircuit: true } : nextResolve(specifier, context) });
const metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { notes: true, sessions: true } });
process.send?.({ phase: 'sdk-ready' });
const operationId = 'aba026c1-4a1b-4e45-a9ee-aa00673b94d1';
const topicId = 'd258a4f1-caaa-499e-8d61-a26f27060e39';
const vault = path.join(stateDir, 'vault');
const input = { logicalOperationId: operationId, topicId, name: 'Workshop', paraCategory: 'area', folderPath: path.join(vault, 'areas', 'workshop'), preparationDigest: 'a'.repeat(64) };
const runtime = { provisioningAuthority: { assertCurrent() {} } };
try {
  if (mode === 'crash') {
    await mkdir(vault, { recursive: true });
    await writeFile(path.join(vault, 'Existing.md'), 'Preserve existing knowledge.');
    const interruptedStore = { ...sessionStore, patchSessionEntry: async request => {
      const result = boundary === 'after' ? await sessionStore.patchSessionEntry(request) : undefined;
      assert.equal(metadata.getProvisioningPrimary(operationId).phase, 'creating');
      assert.equal(metadata.getTopic(topicId).lifecycle, 'provisioning');
      assert.ok(process.send);
      process.send({ boundary: `native-primary-${boundary}-commit` });
      await new Promise(() => {});
      return result;
    } };
    await new TopicProvisioningService({ metadata, noteVaultRoot: vault, sessionStore: interruptedStore }).create(input, runtime);
    assert.fail('Parent did not interrupt the requested boundary');
  } else {
    const pending = metadata.getProvisioningPrimary(operationId);
    assert.equal(pending.phase, 'creating');
    assert.equal(pending.intent.root.preparationDigest, input.preparationDigest);
    const originalFolder = metadata.getSourceLocator(`note-folder:${topicId}`);
    const marker = await readFile(path.join(input.folderPath, '.command-center-folder-identity'));
    const scope = { agentId: 'main', sessionKey: pending.intent.primary.sessionKey, readConsistency: 'latest' };
    const nativeBefore = sessionStore.getSessionEntry(scope);
    const owner = new TopicProvisioningService({ metadata, noteVaultRoot: vault, sessionStore });
    const resume = () => owner.retry({ logicalOperationId: operationId, topicId, expectedRevision: 0 }, runtime);
    if (boundary === 'before') {
      assert.equal(nativeBefore, undefined);
      await assert.rejects(resume(), { code: 'provisioning-creation-unknown' });
      assert.equal(sessionStore.getSessionEntry(scope), undefined, 'unknown dispatch must not recreate a Session');
      assert.deepEqual(metadata.getProvisioningPrimary(operationId), pending);
      assert.equal(metadata.getTopic(topicId).lifecycle, 'provisioning');
      assert.deepEqual(metadata.listSessionStates(), []);
    } else {
      assert.equal(nativeBefore.sessionId, pending.intent.primary.sessionId);
      const applied = await resume();
      assert.equal(applied.status, 'applied');
      assert.equal(applied.topic.lifecycle, 'active');
      assert.equal(metadata.getSessionState(pending.intent.primary.referenceId).sessionId, nativeBefore.sessionId);
      assert.deepEqual(sessionStore.getSessionEntry(scope), nativeBefore, 'resume binds the original effect without rewriting it');
      assert.deepEqual(await owner.create(input, runtime), applied);
    }
    assert.deepEqual(metadata.getSourceLocator(originalFolder.referenceId), originalFolder);
    assert.deepEqual(await readFile(path.join(input.folderPath, '.command-center-folder-identity')), marker);
    assert.equal(await readFile(path.join(vault, 'Existing.md'), 'utf8'), 'Preserve existing knowledge.');
    console.log(`verified provisioning ${boundary}-commit recovery`);
  }
} finally { metadata.close(); hooks.deregister(); }
