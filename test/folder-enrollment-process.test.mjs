import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createTopicService } from '../src/topics/service.mjs';

function participant(stateDir, role) {
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/note-runtime-loader.mjs', import.meta.url)), fileURLToPath(new URL('./fixtures/folder-enrollment-process.mjs', import.meta.url)), stateDir, role], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = []; let errors = '';
  child.stderr.on('data', (value) => { errors += value; });
  child.on('message', (message) => messages.push(message));
  const ended = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  async function wait(type) {
    const deadline = Date.now() + 45_000;
    while (!messages.some((message) => message.type === type)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child ended before ${type}: ${errors}`);
      if (Date.now() > deadline) throw new Error(`Child timed out before ${type}: ${errors}`);
      await delay(10);
    }
    return messages.find((message) => message.type === type);
  }
  return { child, messages, ended, wait };
}

for (const mode of ['release', 'sigkill', 'padded-recovery']) test(`two-process Folder enrollment: ${mode}`, { skip: process.platform !== 'linux', timeout: 90000 }, async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-process-')); const children = []; let metadata;
  try {
    await fs.mkdir(path.join(stateDir, 'vault'));
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    if (mode === 'padded-recovery') {
      metadata.createTopic({ topicId: 'fictional-recovery', paraCategory: 'project', lifecycle: 'active' });
      metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional', topicId: 'fictional-recovery', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'note-folder:fictional-recovery' });
    }
    metadata.close(); metadata = null;
    const holder = participant(stateDir, 'holder'); const contender = participant(stateDir, mode === 'padded-recovery' ? 'recovery' : 'contender'); children.push(holder, contender);
    await Promise.all(children.map((child) => child.wait('ready')));
    holder.child.send({ type: 'start' }); await holder.wait('marker-held');
    const marker = path.join(stateDir, 'vault/Projects/Shared Folder/.command-center-folder-identity');
    const markerBytes = await fs.readFile(marker);
    assert.equal(JSON.parse(markerBytes).version, 1, 'published marker bytes must already be complete');
    const markerIdentity = await fs.stat(marker, { bigint: true });
    const note = path.join(path.dirname(marker), 'Overview.md');
    await fs.writeFile(note, 'Preserve this existing Note.');
    contender.child.send({ type: 'start' });
    const first = await Promise.race([contender.wait('lock-attempt'), contender.wait('outcome')]);
    assert.equal(first.type, 'lock-attempt', JSON.stringify(first));
    await delay(100);
    assert.equal(contender.messages.some((message) => message.type === 'outcome'), false, 'A live enrollment holder must block the contender before marker inspection.');
    if (mode === 'sigkill') { holder.child.kill('SIGKILL'); assert.equal((await holder.ended).signal, 'SIGKILL'); }
    else holder.child.send({ type: 'release' });
    const outcome = await contender.wait('outcome'); await contender.ended;
    if (mode === 'sigkill') assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
    else { assert.equal(outcome.status, 'error'); assert.equal(outcome.code, 'conflict'); }
    if (mode !== 'sigkill') { assert.equal((await holder.wait('outcome')).status, 'applied'); await holder.ended; }
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const topics = createTopicService({ metadata, noteVaultRoot: path.join(stateDir, 'vault') });
    const folder = path.dirname(marker);
    const owners = metadata.listSourceLocators().filter((locator) => locator.locator === folder);
    assert.equal(owners.length, 1);
    assert.equal(await fs.readFile(note, 'utf8'), 'Preserve this existing Note.');
    if (mode === 'sigkill') {
      assert.deepEqual(await fs.readFile(marker), markerBytes, 'adoption must preserve the published marker');
      assert.equal((await fs.stat(marker, { bigint: true })).ino, markerIdentity.ino);
      assert.equal(owners[0].referenceId, 'note-folder:fictional-contender');
      assert.equal(owners[0].ownership, 'adopted', 'adoption never claims creation/cleanup authority');
      assert.equal(topics.get('fictional-holder').lifecycle, 'provisioning');
      assert.equal(topics.get('fictional-contender').usable, true);
      const operation = metadata.listTopicOperations('fictional-holder')[0];
      assert.notEqual(operation.state, 'applied');
      await assert.rejects(topics.retry({ topicId: 'fictional-holder', logicalOperationId: operation.logicalOperationId, expectedRevision: metadata.getTopic('fictional-holder').revision }), { code: 'conflict' });
      assert.equal(metadata.getSourceLocator('note-folder:fictional-holder'), null);
    } else {
      assert.equal(owners[0].referenceId, 'note-folder:fictional-holder');
      assert.equal(topics.get('fictional-holder').usable, true);
    }
  } finally {
    for (const child of children) if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL');
    await Promise.all(children.map((child) => child.ended)); metadata?.close(); await fs.rm(stateDir, { recursive: true, force: true });
  }
});
