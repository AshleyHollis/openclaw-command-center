import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopicMaintenanceSchedule } from '../src/maintenance/schedule.mjs';

test('maintenance scheduling records exact durable intent before a single native tagged turn', async () => {
  const rows = new Map(); const calls = [];
  const context = async () => ({ status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'native-a' });
  const service = createTopicMaintenanceSchedule({ sourceService: { sessionTopicContext: context }, metadata: { getTopicOperation: id => rows.get(id), recordTopicOperation: row => (rows.set(row.logicalOperationId, row), row) }, unscheduleSessionTurnsByTag: async () => ({ removed: 0, failed: 0 }), scheduleSessionTurn: async input => (calls.push(input), { id: 'native-job' }), now: () => '2026-09-13T00:00:00.000Z' });
  const result = await service.schedule({ sessionKey: 'agent:main:a', reason: 'a filed receipt' });
  assert.equal(result.status, 'scheduled'); assert.equal(calls.length, 1); assert.equal(calls[0].sessionKey, 'agent:main:a'); assert.equal(calls[0].delayMs, 15 * 60 * 1000); assert.equal(calls[0].deliveryMode, 'none'); assert.match(calls[0].tag, /^command-center-note-maintenance-/u);
  assert.equal(rows.get(result.logicalOperationId).state, 'applied');
});

test('maintenance scheduling refuses a changed exact Conversation before native dispatch', async () => {
  let count = 0; let calls = 0;
  const service = createTopicMaintenanceSchedule({ sourceService: { sessionTopicContext: async () => (++count === 1 ? { status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'native-a' } : { status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'replaced' }) }, metadata: { getTopicOperation: () => null, recordTopicOperation: row => row }, unscheduleSessionTurnsByTag: async () => ({ removed: 0, failed: 0 }), scheduleSessionTurn: async () => { calls++; }, now: () => '2026-09-13T00:00:00.000Z' });
  await assert.rejects(service.schedule({ sessionKey: 'agent:main:a', reason: 'completion' }), /binding changed/u); assert.equal(calls, 0);
});

test('maintenance scheduling coalesces concurrent completions and replaces a replayed pending turn by tag', async () => {
  const rows = new Map(); const cleanups = []; const dispatches = [];
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const binding = { status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'native-a' };
  const service = createTopicMaintenanceSchedule({
    sourceService: { sessionTopicContext: async () => binding },
    metadata: { getTopicOperation: id => rows.get(id), recordTopicOperation: row => (rows.set(row.logicalOperationId, row), row) },
    unscheduleSessionTurnsByTag: async input => (cleanups.push(input), { removed: cleanups.length === 1 ? 0 : 1, failed: 0 }),
    scheduleSessionTurn: async input => { dispatches.push(input); await delayed; return { id: `job-${dispatches.length}` }; },
    now: () => '2026-09-13T00:00:00.000Z'
  });
  const first = service.schedule({ sessionKey: 'agent:main:a', reason: 'first receipt' });
  const second = service.schedule({ sessionKey: 'agent:main:a', reason: 'second receipt' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatches.length, 1);
  release(); const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.logicalOperationId, secondResult.logicalOperationId);
  await service.schedule({ sessionKey: 'agent:main:a', reason: 'later receipt' });
  assert.equal(cleanups.length, 2); assert.equal(dispatches.length, 2);
  assert.equal(rows.values().next().value.state, 'applied');
});

test('maintenance coalesces linked Conversation completions by Topic and dispatches only to its exact Primary', async () => {
  const rows = new Map(); const dispatches = []; const cleanups = [];
  const contexts = new Map([
    ['agent:main:primary', { status: 'bound', topicId: 'topic-a', referenceId: 'session:primary', sessionKey: 'agent:main:primary', sessionId: 'native-primary' }],
    ['agent:main:linked', { status: 'bound', topicId: 'topic-a', referenceId: 'session:linked', sessionKey: 'agent:main:linked', sessionId: 'native-linked' }]
  ]);
  const metadata = {
    getTopicOperation: id => rows.get(id), recordTopicOperation: row => (rows.set(row.logicalOperationId, row), row),
    listSourceReferences: () => [
      { topicId: 'topic-a', referenceId: 'session:primary', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:primary' },
      { topicId: 'topic-a', referenceId: 'session:linked', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:linked' }
    ],
    getSessionState: id => id === 'session:primary' ? { status: 'open', isPrimary: true, sessionId: 'native-primary' } : { status: 'open', isPrimary: false, sessionId: 'native-linked' }
  };
  const service = createTopicMaintenanceSchedule({ sourceService: { sessionTopicContext: async ({ sessionKey }) => contexts.get(sessionKey) }, metadata,
    unscheduleSessionTurnsByTag: async input => (cleanups.push(input), { removed: 0, failed: 0 }), scheduleSessionTurn: async input => (dispatches.push(input), { id: 'job' }) });
  const [first, second] = await Promise.all([service.schedule({ sessionKey: 'agent:main:linked', reason: 'linked work' }), service.schedule({ sessionKey: 'agent:main:primary', reason: 'primary work' })]);
  assert.equal(first.logicalOperationId, second.logicalOperationId); assert.equal(dispatches.length, 1); assert.equal(dispatches[0].sessionKey, 'agent:main:primary'); assert.equal(cleanups[0].sessionKey, 'agent:main:primary');
});

test('maintenance scheduling refuses to dispatch beside an incompletely cancelled prior turn', async () => {
  let dispatches = 0;
  const binding = { status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'native-a' };
  const row = new Map();
  const service = createTopicMaintenanceSchedule({
    sourceService: { sessionTopicContext: async () => binding },
    metadata: { getTopicOperation: id => row.get(id), recordTopicOperation: value => (row.set(value.logicalOperationId, value), value) },
    unscheduleSessionTurnsByTag: async () => ({ removed: 0, failed: 1 }),
    scheduleSessionTurn: async () => { dispatches++; return { id: 'must-not-run' }; },
    now: () => '2026-09-13T00:00:00.000Z'
  });
  await assert.rejects(service.schedule({ sessionKey: 'agent:main:a', reason: 'receipt' }), /could not be removed safely/u);
  assert.equal(dispatches, 0);
  assert.equal(row.values().next().value.currentStep, 'prior-turn-cancel-failed');
});
