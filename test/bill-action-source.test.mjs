import test from 'node:test';
import assert from 'node:assert/strict';
import { readBillActionEvidence } from '../src/open-loops/bill-action-source.mjs';

function fixture() {
  let current = true;
  const value = {
    metadata: { getEmailReaderLocator: () => null },
    sourceService: { requireTopicService() { if (!current) throw new Error('access revoked'); }, assertExactNoteReference() {}, notesRead: async () => ({ revision: 'note-1' }) },
    loop: { topicId: 'fictional-topic' },
    observation: { source: { externalId: 'fictional-account:mail-101', version: 'commitment:fictional' }, facts: { sourceVersion: 'mail-1', sourceReferenceId: 'fictional-note', sourcePath: 'bills/BILL-101.md', sourceReferenceVersion: 'note-1' } },
    assertCurrent() { if (!current) throw Object.assign(new Error('authority revoked'), { code: 'unauthenticated' }); }
  };
  return { value, revoke: () => { current = false; } };
}

test('exact independently authorized retained Note is available without an email link', async () => {
  const { value } = fixture();
  const result = await readBillActionEvidence(value);
  assert.equal(result.source.kind, 'note');
  assert.equal(result.source.revision, 'note-1');
});

test('unsafe Outlook link cannot suppress a valid Note fallback', async () => {
  const { value } = fixture();
  value.metadata.getEmailReaderLocator = () => ({ status: 'available', webLink: 'https://fictional.invalid/mail/101' });
  assert.equal((await readBillActionEvidence(value)).source.kind, 'note');
});

test('Note revision replacement does not expose retained copied evidence', async () => {
  const { value } = fixture();
  value.sourceService.notesRead = async () => ({ revision: 'note-2' });
  await assert.rejects(readBillActionEvidence(value), error => error.code === 'source-unavailable');
});

test('revocation during awaited Note read refuses publication', async () => {
  const { value, revoke } = fixture();
  value.sourceService.notesRead = async () => { revoke(); return { revision: 'note-1' }; };
  await assert.rejects(readBillActionEvidence(value), error => error.code === 'unauthenticated');
});

test('email locator revocation during Note read refuses stale Outlook destination', async () => {
  const { value } = fixture();
  let available = true;
  value.metadata.getEmailReaderLocator = () => available ? { status: 'available', webLink: 'https://outlook.office.com/mail/inbox/id/fictional-101' } : { status: 'unavailable' };
  value.sourceService.notesRead = async () => { available = false; throw new Error('Note unavailable'); };
  await assert.rejects(readBillActionEvidence(value), error => error.code === 'source-unavailable');
});

test('Note reference removal during read refuses stale Note destination', async () => {
  const { value } = fixture();
  value.sourceService.notesRead = async () => {
    value.sourceService.assertExactNoteReference = () => { throw new Error('reference removed'); };
    return { revision: 'note-1' };
  };
  await assert.rejects(readBillActionEvidence(value), error => error.code === 'source-unavailable');
});

test('synthetic commitment revision is never used as accepted email locator version', async () => {
  const { value } = fixture();
  delete value.observation.facts.sourceVersion;
  value.metadata.getEmailReaderLocator = () => { throw new Error('must not guess email version'); };
  assert.equal((await readBillActionEvidence(value)).source.kind, 'note');
});
