import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createAcceptedChatReplayService } from '../../src/open-loops/accepted-chat-replay.mjs';
import { installHostFileAccessFixture } from './host-file-access-fixture.mjs';
import { enrollFixtureFolder } from './note-folder-fixture.mjs';

export function mixedChatPlan() {
  return { schemaVersion: 1, sessionKey: 'agent:main:fictional-chat', sessionId: 'fictional-session-v1', sourceKind: 'chat', sourceExternalId: 'fictional-accepted-input', sourceVersion: 'fictional-logical-revision-v1', checkpoint: 'fictional-checkpoint', observedAt: '2026-10-01T01:00:00.000Z', processorVersion: 'fictional-processor-v1', acceptedExtraction: { schemaVersion: 1, proposedTopic: 'Fictional Topic', notePath: 'Inbox/derived.md', knowledgeMarkdown: '# Fictional knowledge\nPreserve the reference.\n', knowledgeOutcomeId: 'fictional-information', obligations: [{ obligationId: 'fictional-choice', title: 'Choose fictional delivery', provenance: 'inferred', classification: 'decision' }, { obligationId: 'fictional-reply', title: 'Reply with fictional reference', provenance: 'explicit', classification: 'obligation' }], noAction: { outcomeId: 'fictional-quiet', summary: 'No additional action required' } }, outcomes: [{ outcomeId: 'fictional-choice', kind: 'decision' }, { outcomeId: 'fictional-reply', kind: 'obligation' }, { outcomeId: 'fictional-information', kind: 'information' }, { outcomeId: 'fictional-quiet', kind: 'no-action' }] };
}

export async function createAcceptedChatNoteFixture(parent, options = {}) {
  const { createAuthoritativeSourceService } = await import('../../src/sources/service.mjs');
  const root = path.join(parent, 'notes');
  const stateDir = path.join(parent, 'state');
  await mkdir(path.join(root, 'Inbox'), { recursive: true });
  const release = installHostFileAccessFixture();
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  if (!metadata.getTopic('topic-fictional')) {
    metadata.createTopic({ topicId: 'topic-fictional', name: 'Fictional Topic', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'conversation:fictional', topicId: 'topic-fictional', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-chat' });
    metadata.setSessionState({ referenceId: 'conversation:fictional', sessionId: 'fictional-session-v1', status: 'open', isPrimary: true, displayName: 'Fictional Conversation', updatedAt: '2026-10-01T00:00:00.000Z' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional', topicId: 'topic-fictional', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: root });
    await enrollFixtureFolder(metadata, 'folder:fictional', root);
  }
  let active = true;
  const runtime = { principalId: 'fictional-operator', assertCurrent() { if (!active) throw Object.assign(new Error('fictional revoked authority'), { code: 'unauthenticated' }); options.assertCurrent?.(metadata); } };
  const makeSources = () => createAuthoritativeSourceService({ metadata, root, capabilities: { notes: true, sessions: true },
    sessionStore: { listSessionEntries: () => [{ sessionKey: 'agent:main:fictional-chat', entry: { sessionId: 'fictional-session-v1' } }] },
    fsSafeRootFactory: async rootDir => ({ rootDir, rootReal: rootDir, resolve: async relative => path.join(rootDir, relative), open: async relative => ({ handle: await open(path.join(rootDir, relative), 'r') }) }),
    beforeAtomicCommit: options.beforeAtomicCommit, afterAtomicPublish: options.afterAtomicPublish });
  let sourceService = makeSources();
  return { root, runtime, metadata: () => metadata, sources: () => sourceService, owner: () => createAcceptedChatReplayService({ metadata, sourceService }), revoke() { active = false; },
    reopen() { sourceService.close(); metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } }); sourceService = makeSources(); },
    close() { sourceService.close(); metadata.close(); release(); } };
}
