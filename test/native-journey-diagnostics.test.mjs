import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchManagedBrowser } from './support/real-host-runtime.mjs';
import { retainNativeJourneyDiagnostics } from './support/native-journey-diagnostics.mjs';

test('private diagnostics retain shadow and slotted control evidence without credentials or input values', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-native-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managed = await launchManagedBrowser({ headless: true, timeout: 30_000 });
  try {
    const page = await managed.browser.newPage();
    await page.setContent('<div data-region="main"><openclaw-fixture-shell><button>Slotted creation</button></openclaw-fixture-shell></div><dialog data-region="left" aria-hidden="true"></dialog><textarea>Fictional private draft</textarea>');
    await page.evaluate(() => {
      const shell = document.querySelector('openclaw-fixture-shell');
      shell.attachShadow({ mode: 'open' }).innerHTML = '<a href="#fictional-fragment=fictional-auth" aria-label="New conversation">Create</a><slot></slot>';
    });
    await retainNativeJourneyDiagnostics(page, root, 'fixture-controls');
    const inventoryText = await readFile(path.join(root, 'fixture-controls-dom.json'), 'utf8');
    const inventory = JSON.parse(inventoryText);
    assert.ok(inventory.controls.some(control => control.tag === 'a' && control.label === 'New conversation' && control.owner === 'openclaw-fixture-shell'));
    assert.ok(inventory.controls.some(control => control.tag === 'button' && control.text === 'Slotted creation'));
    const slottedButton = inventory.controls.find(control => control.text === 'Slotted creation');
    assert.ok(inventory.owners.some(owner => owner.tag === 'slot' && owner.assigned.some(assigned => assigned.nodeId === slottedButton.nodeId)));
    assert.ok(inventory.owners.some(owner => owner.tag === 'dialog' && owner.region === 'left' && owner.ariaHidden === 'true' && owner.visible === false));
    assert.ok(inventory.owners.some(owner => owner.tag === 'div' && owner.region === 'main' && owner.visible));
    assert.doesNotMatch(inventoryText, /fictional-auth|Fictional private draft|href/);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'fixture-controls-capture.json'), 'utf8')),
      { schemaVersion: 1, name: 'fixture-controls', dom: 'retained', screenshot: 'retained' });
    assert.ok((await stat(path.join(root, 'fixture-controls.png'))).size > 0);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(root, 'fixture-controls-dom.json'))).mode & 0o777, 0o600);
  } finally { await managed.close(); }
});

test('closed page diagnostics preserve failure and remain disabled without a destination', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-native-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = { evaluate() { throw new Error('closed'); }, locator() { return {}; }, screenshot() { throw new Error('closed'); } };
  await retainNativeJourneyDiagnostics(page, undefined, 'disabled');
  await assert.rejects(stat(path.join(root, 'disabled-capture.json')), { code: 'ENOENT' });
  await retainNativeJourneyDiagnostics(page, root, 'closed');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'closed-capture.json'), 'utf8')),
    { schemaVersion: 1, name: 'closed', dom: 'failed', screenshot: 'failed' });
});
