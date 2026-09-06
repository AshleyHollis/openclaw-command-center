import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMetadataService } from '../src/plugin-service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createTopicSearchService } from '../src/search/service.mjs';

// Only the external runtime reader/event boundary is substituted. Topic
// ownership, source snapshots, SQLite projections and Search remain real.
const readerKey = Symbol.for('fictional.native-search-transcript-reader');
const readerModule = 'data:text/javascript,' + encodeURIComponent(`export async function readVisibleSessionTranscriptMessageEntries(input) { return globalThis[Symbol.for('fictional.native-search-transcript-reader')](input); }`);
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'openclaw/plugin-sdk/session-transcript-runtime'
    ? { url: readerModule, shortCircuit: true } : nextResolve(specifier, context);
} });
test.after(() => hook.deregister());

const topicId = 'fictional-native-search';
const sessionKey = 'agent:main:fictional-search';
const sessionId = 'fictional-search-session';
const referenceId = 'session:fictional-search';
const otherTopicId = 'fictional-other-search';
const otherKey = 'agent:main:fictional-other-search';
const target = { agentId: 'main', sessionKey, sessionId };
const entry = (id, text) => ({ entryId: id, createdAt: '2026-09-06T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } });

async function fixture(run, { deferredGateway = false } = {}) {
  const stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cc-native-search-')));
  const folder = path.join(stateDir, 'fictional-notes');
  await mkdir(folder);
  const listeners = new Set();
  const transcripts = new Map([[sessionKey, { sessionId, entries: [entry('initial', 'initial quartz')] }], [otherKey, { sessionId: 'other-session', entries: [entry('other', 'other garnet')] }]]);
  const controls = { read: null };
  const seed = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, search: true } });
  try {
    seed.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    seed.createSourceReference({ version: 1, referenceId: 'folder:fictional-search', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folder });
    seed.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey });
    seed.setSessionState({ referenceId, sessionId, status: 'open', isPrimary: true, updatedAt: '2026-09-06T00:00:00.000Z' });
    seed.setSourceLocator({ referenceId, locator: sessionKey, observedRevision: sessionId, ownership: 'external' });
    const otherFolder = path.join(stateDir, 'other-notes');
    await mkdir(otherFolder);
    seed.createTopic({ topicId: otherTopicId, paraCategory: 'area', lifecycle: 'active' });
    seed.createSourceReference({ version: 1, referenceId: 'other-folder', topicId: otherTopicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: otherFolder });
    seed.createSourceReference({ version: 1, referenceId: 'other-session', topicId: otherTopicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: otherKey });
    seed.setSessionState({ referenceId: 'other-session', sessionId: 'other-session', status: 'open', isPrimary: true, updatedAt: '2026-09-06T00:00:00.000Z' });
  } finally { seed.close(); }
  globalThis[readerKey] = async (input) => {
    const transcript = transcripts.get(input.sessionKey);
    if (input.agentId !== 'main' || transcript?.sessionId !== input.sessionId) throw new Error('The exact fictional Session is unavailable.');
    const snapshot = structuredClone(transcript.entries);
    await controls.read?.(input, snapshot);
    return snapshot;
  };
  const api = {
    logger: { warn() {} }, pluginConfig: {},
    runtime: {
      state: { resolveStateDir: () => stateDir },
      ...(deferredGateway ? { gateway: { isAvailable() { assert.fail('Startup must not probe request-bound Gateway authority.'); }, request() { throw new Error('No current Gateway request'); } } } : {}),
      agent: { session: { listSessionEntries: () => [...transcripts].map(([key, transcript]) => ({ sessionKey: key, entry: { sessionId: transcript.sessionId } })) } },
      events: { onSessionTranscriptUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); } }
    }
  };
  let service = createMetadataService(api);
  const emit = (update = { target }) => { for (const listener of listeners) listener(update); };
  const query = (text, selectedTopic = topicId) => service.searchService.query({ schemaVersion: 1, topicId: selectedTopic, query: text });
  try {
    await service.start();
    await new Promise((resolve) => setImmediate(resolve));
    await service.searchService.rebuild();
    await run({ get service() { return service; }, stateDir, transcripts, controls, listeners, emit, query,
      async restart() { await service.stop(); service = createMetadataService(api); await service.start(); }
    });
  } finally { await service.stop(); delete globalThis[readerKey]; await rm(stateDir, { recursive: true, force: true }); }
}

test('a native transcript event immediately denies stale Search then indexes authoritative content', async () => {
  await fixture(async ({ service, transcripts, emit, query }) => {
    assert.equal((await query('native sapphire')).conversations.results.length, 0);
    transcripts.get(sessionKey).entries.push(entry('external', 'native sapphire'));
    emit({ target, message: { content: 'untrusted event body must not be indexed' } });
    await assert.rejects(query('native sapphire'), (error) => error.code === 'capability-unavailable');
    await service.sourceService.settleSearchRefresh();
    assert.equal((await query('native sapphire')).conversations.results.length, 1);
    assert.equal((await query('untrusted')).conversations.results.length, 0);
  });
});

test('transcript updates during a rebuild stay denied and coalesce without dropping other Topics', async () => {
  await fixture(async ({ service, transcripts, controls, emit, query }) => {
    const reading = Promise.withResolvers(); const release = Promise.withResolvers();
    let reads = 0;
    controls.read = async (input) => {
      if (input.sessionKey !== sessionKey) return;
      reads++;
      if (reads === 1) { reading.resolve(); await release.promise; }
    };
    try {
      emit();
      await reading.promise;
      transcripts.get(sessionKey).entries.push(entry('newest', 'newest topaz'));
      for (let index = 0; index < 12; index++) emit();
      await assert.rejects(query('initial'), (error) => error.code === 'capability-unavailable');
    } finally { release.resolve(); }
    await service.sourceService.settleSearchRefresh();
    assert.equal((await query('newest topaz')).conversations.results.length, 1);
    assert.equal((await query('other garnet', otherTopicId)).conversations.results.length, 1);
    assert.ok(reads < 12, 'A burst must not cause one authoritative rescan per event.');
  });
});

test('runtime hints follow explicit Session relinking and refuse a replacement identity', async () => {
  await fixture(async ({ service, stateDir, transcripts, emit, query }) => {
    emit({ target: { ...target, sessionKey: 'agent:main:unowned' } });
    emit({ target: { ...target, agentId: 'unowned' } });
    assert.equal((await query('initial quartz')).conversations.results.length, 1);
    const newKey = 'agent:main:fictional-relinked'; const newId = 'relinked-session';
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, search: true } });
    try { metadata.applySessionRecoveryRelink({ referenceId, sessionKey: newKey, sessionId: newId, expectedSourceRevision: sessionId }); }
    finally { metadata.close(); }
    transcripts.set(newKey, { sessionId: newId, entries: [entry('relinked', 'relinked opal')] });
    emit();
    assert.equal((await query('other garnet', otherTopicId)).conversations.results.length, 1, 'Displaced source events must not invalidate current ownership.');
    emit({ target: { agentId: 'main', sessionKey: newKey, sessionId: newId } });
    await service.sourceService.settleSearchRefresh();
    assert.equal((await query('relinked opal')).conversations.results.length, 1);
    transcripts.set(newKey, { sessionId: 'unapproved-replacement', entries: [entry('replacement', 'replacement ruby')] });
    emit({ target: { agentId: 'main', sessionKey: newKey, sessionId: 'unapproved-replacement' } });
    await service.sourceService.settleSearchRefresh();
    await assert.rejects(query('replacement ruby'), (error) => error.code === 'capability-unavailable');
  });
});

test('failed event reconciliation stays denied and a later event can recover', async () => {
  await fixture(async ({ service, stateDir, transcripts, controls, emit, query }) => {
    controls.read = async () => { throw new Error('Fictional transcript read failure'); };
    emit();
    await service.sourceService.settleSearchRefresh();
    await assert.rejects(query('initial'), (error) => error.code === 'capability-unavailable');
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, search: true } });
    try {
      const reopened = createTopicSearchService({ stateDir, metadata });
      await assert.rejects(reopened.query({ schemaVersion: 1, topicId, query: 'initial' }), (error) => error.code === 'capability-unavailable');
    } finally { metadata.close(); }
    controls.read = null;
    transcripts.get(sessionKey).entries.push(entry('recovered', 'recovered amethyst'));
    emit();
    await service.sourceService.settleSearchRefresh();
    assert.equal((await query('recovered amethyst')).conversations.results.length, 1);
  });
});

test('stop unsubscribes and aborts owned transcript reconciliation before closing metadata', async () => {
  await fixture(async ({ service, controls, listeners, emit }) => {
    const reading = Promise.withResolvers(); const release = Promise.withResolvers();
    const staleListener = [...listeners][0];
    controls.read = async () => { reading.resolve(); await release.promise; };
    try {
      emit(); await reading.promise;
      await service.stop();
      assert.equal(listeners.size, 0);
      assert.doesNotThrow(() => staleListener({ target }));
    } finally { release.resolve(); controls.read = null; }
  });
});

test('restart denies the old Search generation and reconciles transcript events missed while stopped', async () => {
  await fixture(async ({ service, transcripts, controls, restart, query }) => {
    await service.stop();
    transcripts.get(sessionKey).entries.push(entry('missed', 'missed emerald'));
    const reading = Promise.withResolvers();
    const release = Promise.withResolvers();
    controls.read = async () => { reading.resolve(); await release.promise; };
    try {
      await restart();
      await assert.rejects(query('missed emerald'), (error) => error.code === 'capability-unavailable');
      await reading.promise;
    } finally { release.resolve(); controls.read = null; }
    // Observe startup completion through Search, without an explicit rebuild
    // that could mask a missing native startup reconciliation.
    await new Promise((resolve) => setImmediate(resolve));
    // The fixture's service getter follows the restarted activation.
    await assert.doesNotReject(async () => {
      for (let tries = 0; tries < 100; tries++) {
        try { assert.equal((await query('missed emerald')).conversations.results.length, 1); return; }
        catch (error) { if (error.code !== 'capability-unavailable') throw error; await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      assert.fail('Startup did not reconcile the missed transcript');
    });
  }, { deferredGateway: true });
});
