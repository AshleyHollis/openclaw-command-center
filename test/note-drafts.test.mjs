import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';

let browser;
let html;
let app;
before(async () => {
  [html, app] = await Promise.all(['index.html', 'app.js'].map(name => readFile(new URL(`../src/ui/${name}`, import.meta.url), 'utf8')));
  browser = await launchPinnedChromium();
});
after(async () => { await browser?.close(); });

// Exercise the actual presentation/owner seam. This does not qualify the host bridge.
async function withNote(run) {
  const page = await browser.newPage();
  try {
    await page.setContent(html.replace('<script defer src="/plugins/command-center/app.js"></script>', '').replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', ''));
    await page.addScriptTag({ content: app });
    await page.evaluate(async () => {
      applyOperatingState({ mode: 'ready', unavailableCapabilities: [] }); setWorkspaceVisible(true);
      workspace.topic = { topicId: 'fictional-topic', revision: 1, noteFolderReferenceId: 'fictional-folder' };
      window.noteSource = { text: 'Original A', revision: 'r1', sourceReference: { referenceId: 'fictional-a', topicId: 'fictional-topic' } };
      readNoteChunks = async () => structuredClone(noteSource);
      window.a = { kind: 'note', topicId: 'fictional-topic', referenceId: 'fictional-a', path: 'a.md', observedRevision: 'r1' };
      await openAuthoritativeNote(a, { moveFocus: false });
    });
    await run(page);
  } finally { await page.close(); }
}

test('a clean Note refresh adopts authoritative content and revision together', () => withNote(async page => {
  await page.evaluate(async () => {
    noteSource.text = 'External A'; noteSource.revision = 'r2';
    await openAuthoritativeNote({ ...a, observedRevision: 'r2' }, { moveFocus: false });
  });
  assert.equal(await page.locator('#note-content').inputValue(), 'External A');
}));

test('a dirty Note refresh never silently rebases its save precondition', () => withNote(async page => {
  await page.locator('#note-content').fill('Unsaved A');
  await page.evaluate(async () => {
    noteSource.text = 'External A'; noteSource.revision = 'r2';
    await openAuthoritativeNote({ ...a, observedRevision: 'r2' }, { moveFocus: false });
    pageAction = async (_action, input) => { window.sentRevision = input.expectedRevision; throw new Error('conflict'); };
    await saveNote();
  });
  assert.equal(await page.evaluate(() => sentRevision), 'r1');
  assert.equal(await page.locator('#note-content').inputValue(), 'Unsaved A');
}));

test('creating a Note does not transfer the selected Note draft', () => withNote(async page => {
  await page.locator('#note-content').fill('Unsaved A');
  await page.evaluate(() => {
    pageAction = async (_action, input) => { noteSource = { text: decodeText(input.contentBase64), revision: 'b1', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-b' } }; return { revision: 'b1' }; };
    loadNotes = async () => { workspace.notes = [{ path: 'b.md', revision: 'b1', sourceReference: noteSource.sourceReference }]; };
    openNoteDialog('notes.create', document.querySelector('#note-new'));
  });
  await page.locator('#note-action-path').fill('b.md'); await page.locator('#note-action-text').fill('New B');
  await page.locator('#note-action-submit').click();
  await page.waitForFunction(() => !document.querySelector('#note-action-dialog').open);
  assert.equal(await page.locator('#note-content').inputValue(), 'New B');
  await page.evaluate(async () => {
    noteSource = { text: 'Original A', revision: 'r1', sourceReference: { referenceId: 'fictional-a', topicId: 'fictional-topic' } };
    await openAuthoritativeNote(a, { moveFocus: false });
  });
  assert.equal(await page.locator('#note-content').inputValue(), 'Unsaved A');
}));

for (const newerEdit of [false, true]) test(`save completion owns the reselected draft (newer edit: ${newerEdit})`, () => withNote(async page => {
  await page.locator('#note-content').fill('Saving A');
  await page.evaluate(() => { pageAction = () => new Promise(resolve => { window.finishSave = resolve; }); window.saving = saveNote(); });
  await page.evaluate(() => openAuthoritativeNote(a, { moveFocus: false }));
  if (newerEdit) await page.locator('#note-content').fill('Newer A');
  await page.evaluate(async () => { finishSave({ revision: 'r2' }); await saving; });
  assert.equal(await page.evaluate(() => workspace.note.revision), 'r2');
  assert.equal(await page.locator('#note-content').inputValue(), newerEdit ? 'Newer A' : 'Saving A');
  assert.equal((await page.locator('#note-revision').textContent()).includes('unsaved draft'), newerEdit);
}));

test('a read begun before save completion cannot downgrade the saved draft', () => withNote(async page => {
  await page.locator('#note-content').fill('Saving A');
  await page.evaluate(async () => {
    pageAction = () => new Promise(resolve => { window.finishSave = resolve; });
    window.saving = saveNote();
    readNoteChunks = () => new Promise(resolve => { window.finishRead = resolve; });
    window.opening = openAuthoritativeNote(a, { moveFocus: false });
    finishSave({ revision: 'r2' }); await saving;
    finishRead({ text: 'Original A', revision: 'r1', sourceReference: a }); await opening;
  });
  assert.equal(await page.locator('#note-content').inputValue(), 'Saving A');
  assert.equal(await page.evaluate(() => workspace.note.revision), 'r2');
}));

test('only one save per Note is in flight and a failed save can be retried', () => withNote(async page => {
  await page.locator('#note-content').fill('Saving A');
  await page.evaluate(async () => {
    window.calls = 0; const failures = [];
    pageAction = () => { calls++; return new Promise((_resolve, reject) => { failures.push(reject); }); };
    window.saving = saveNote();
    const second = saveNote();
    for (const reject of failures) reject(new Error('fixture conflict'));
    await Promise.all([saving, second]);
  });
  assert.equal(await page.evaluate(() => calls), 1);
  await page.evaluate(async () => { pageAction = async () => { calls++; return { revision: 'r2' }; }; await saveNote(); });
  assert.equal(await page.evaluate(() => calls), 2);
  assert.equal(await page.evaluate(() => workspace.note.revision), 'r2');
}));

test('relocating a dirty Note adopts only its mutation receipt, never a later external revision', () => withNote(async page => {
  await page.locator('#note-content').fill('Unsaved A');
  await page.evaluate(async () => {
    pageAction = async () => ({ note: { revision: 'renamed-r1' } });
    loadNotes = async () => {
      noteSource = { text: 'External renamed A', revision: 'external-r2', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-renamed' } };
      workspace.notes = [{ path: 'renamed.md', revision: 'external-r2', sourceReference: noteSource.sourceReference }];
    };
    openNoteDialog('notes.rename', document.querySelector('#note-rename'));
    document.querySelector('#note-action-path').value = 'renamed.md';
    await submitNoteAction({ preventDefault() {} });
  });
  assert.equal(await page.locator('#note-content').inputValue(), 'Unsaved A');
  assert.equal(await page.evaluate(() => workspace.note.revision), 'renamed-r1');
}));
