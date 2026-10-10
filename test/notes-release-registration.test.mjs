import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Enabled policies exist only in disposable fixture copies. Production policy
// and candidate admission remain unchanged; this is source registration proof.
async function fixture(t, flags) {
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-notes-registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(sourceRoot, 'src'), path.join(root, 'src'), { recursive: true });
  for (const name of ['package.json', 'openclaw.plugin.json']) await cp(path.join(sourceRoot, name), path.join(root, name));
  await symlink(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const policyPath = path.join(root, 'src/release-scope.mjs');
  let policy = await readFile(policyPath, 'utf8');
  for (const flag of ['noteProposals', 'topicNoteRecall']) policy = policy.replace(new RegExp(`${flag}: (?:true|false)`), `${flag}: false`);
  for (const flag of flags) {
    assert.ok(policy.includes(`${flag}: false`));
    policy = policy.replace(`${flag}: false`, `${flag}: true`);
  }
  await writeFile(policyPath, policy);
  const { default: plugin } = await import(pathToFileURL(path.join(root, 'src/plugin.mjs')).href);
  const tools = new Map();
  plugin.register({ pluginConfig: {}, registerHttpRoute() {}, registerGatewayMethod() {}, registerService() {},
    registerTool(factory, declaration) { tools.set(declaration.name, { factory, declaration }); },
    agent: { events: { registerAgentEventSubscription() {} } } });
  return { tools, root };
}

for (const flags of [[], ['noteProposals'], ['topicNoteRecall'], ['noteProposals', 'topicNoteRecall']]) {
  test(`Notes registration remains narrow with fixture gates ${flags.join(',') || 'disabled'}`, async t => {
    const { tools } = await fixture(t, flags);
    assert.equal(tools.has('command_center_recall_topic_notes'), flags.includes('topicNoteRecall'));
    for (const name of ['command_center_topic_context', 'command_center_topic_analysis', 'command_center_update_working_note', 'command_center_file_topic_attachment']) assert.equal(tools.has(name), false, name);
    assert.equal([...tools.keys()].some(name => /proposal/.test(name)), false, 'review proposals have no model dispatcher');
    if (!flags.includes('topicNoteRecall')) return;
    const { factory, declaration } = tools.get('command_center_recall_topic_notes');
    assert.equal(declaration.optional, true);
    const tool = factory({ sessionKey: 'agent:main:fictional-release', sessionId: 'fictional-incarnation' });
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['limit', 'query']);
    assert.equal(tool.parameters.additionalProperties, false);
    await assert.rejects(tool.execute('fictional-call', { query: 'fictional', topicId: 'forged-topic' }), error => error.code === 'invalid-request');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(tool.execute('fictional-call', { query: 'fictional' }, aborted.signal), error => error.name === 'AbortError');
  });
}

test('TEST Notes source enables only explicit review proposals', async () => {
  const { FIRST_LIVE_FEATURES } = await import('../src/release-scope.mjs');
  assert.equal(FIRST_LIVE_FEATURES.noteProposals, true);
  assert.equal(FIRST_LIVE_FEATURES.topicNoteRecall, false);
  assert.equal(FIRST_LIVE_FEATURES.noteMaintenance, false);
  assert.equal(FIRST_LIVE_FEATURES.search, false);
});
