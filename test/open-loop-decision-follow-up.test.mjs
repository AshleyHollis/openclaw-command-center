import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createOpenLoopReminderCoordinator, openLoopReminderOperationId, openLoopReminderReferenceId } from '../src/open-loops/reminder-coordinator.mjs';

test('accepted user decisions remain discoverable for follow-up after restart without reviving older revisions', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-decision-follow-up-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    metadata.createTopic({ topicId: 'fictional-renovation', paraCategory: 'project', lifecycle: 'active' });
    const created = metadata.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'fictional-bill-intake', message: {
      schemaVersion: 1, channel: 'email', source: { system: 'fictional-mail', externalId: 'fictional-invoice', version: 'v1' },
      occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', historicalBaseline: false,
      topicId: 'fictional-renovation', disposition: 'confirmed-obligation', requestKind: 'payment', explicitRequest: true,
      summary: 'Pay fictional renovation invoice', payee: 'Fictional Builder', purpose: 'fictional work',
      amount: 10000, currency: 'AUD', dueAt: '2026-10-01T00:00:00.000Z', invoiceId: 'FICTIONAL-1',
      attachmentIds: ['fictional-attachment'], evidenceSelectors: ['attachment:1:invoice-number']
    } });
    metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-defer', loopId: created.loop.loopId,
      expectedRevision: 1, decision: 'defer', reviewAt: '2026-10-02T00:00:00.000Z', actorId: 'fictional-operator',
      rationale: 'Wait for the fictional correction.', updatedAt: '2026-09-20T01:00:00.000Z' });
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    let page = metadata.listOpenLoopUserActionReceiptsPage({ limit: 10 });
    assert.equal(page.actions.length, 1);
    assert.equal(page.actions[0].logicalOperationId, 'fictional-defer');
    assert.equal(page.actions[0].loop.revision, 2);
    assert.equal(page.actions[0].current, true);
    assert.equal(page.hasMore, false);
    assert.equal(metadata.getCurrentOpenLoopUserActionReceipt(created.loop.loopId).logicalOperationId, 'fictional-defer');
    const deferIntent = metadata.getOpenLoopUserActionReceipt('fictional-defer').followUpIntent;
    assert.equal(deferIntent.action, 'create');
    assert.equal(deferIntent.logicalOperationId, openLoopReminderOperationId('fictional-defer'));
    assert.equal(deferIntent.loopRevision, 2);
    assert.equal(deferIntent.declaration.schedule.at, '2026-10-02T00:00:00.000Z');

    metadata.createSourceReference({ version: 1, referenceId: openLoopReminderReferenceId(created.loop.loopId),
      topicId: 'fictional-renovation', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule',
      externalSourceId: 'fictional-native-reminder', observedRevision: 'native-revision-before-payment' });

    metadata.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'fictional-paid', loopId: created.loop.loopId,
      expectedRevision: 2, paymentState: 'paid', actorId: 'fictional-operator', rationale: 'Fictional settlement confirmed.',
      updatedAt: '2026-09-20T02:00:00.000Z' });
    page = metadata.listOpenLoopUserActionReceiptsPage({ limit: 1 });
    assert.equal(page.hasMore, true);
    assert.equal(page.actions[0].current, false);
    const next = metadata.listOpenLoopUserActionReceiptsPage({ limit: 1, cursor: page.nextCursor });
    assert.equal(next.actions.length, 1);
    assert.equal(next.actions[0].logicalOperationId, 'fictional-paid');
    assert.equal(next.actions[0].current, true);
    assert.equal(next.actions[0].loop.paymentState, 'paid');
    assert.equal(metadata.getCurrentOpenLoopUserActionReceipt(created.loop.loopId).logicalOperationId, 'fictional-paid');
    const paidIntent = metadata.getOpenLoopUserActionReceipt('fictional-paid').followUpIntent;
    assert.equal(paidIntent.action, 'cancel');
    assert.equal(paidIntent.expectedConfigRevision, 'native-revision-before-payment');
    assert.equal(paidIntent.logicalOperationId, openLoopReminderOperationId('fictional-paid'));
    let nativeUpdates = 0;
    const coordinator = createOpenLoopReminderCoordinator({ metadata, gateway: { async request(method) {
      if (method === 'cron.get') return { id: 'fictional-native-reminder', configRevision: 'external-revision-after-decision', enabled: true,
        schedule: { kind: 'at', at: '2026-10-02T00:00:00.000Z' } };
      if (method === 'cron.update') { nativeUpdates += 1; throw new Error('stale decision should not update native Cron'); }
      throw new Error(`unexpected Scheduler method: ${method}`);
    } } });
    await assert.rejects(() => coordinator.reconcileAccepted({ loop: next.actions[0].loop, followUpIntent: paidIntent }),
      error => error.code === 'conflict');
    assert.equal(nativeUpdates, 0, 'a newer native Scheduler revision must not be overwritten');
    assert.equal(metadata.getOpenLoop(created.loop.loopId).paymentState, 'paid', 'Scheduler conflict cannot undo the accepted assertion');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a newer paid decision fences an older create that was waiting for native Cron', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-decision-competing-worker-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    metadata.createTopic({ topicId: 'fictional-race-topic', paraCategory: 'project', lifecycle: 'active' });
    const created = metadata.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'fictional-race-intake', message: {
      schemaVersion: 1, channel: 'email', source: { system: 'fictional-mail', externalId: 'fictional-race-invoice', version: 'v1' },
      occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', historicalBaseline: false,
      topicId: 'fictional-race-topic', disposition: 'confirmed-obligation', requestKind: 'payment', explicitRequest: true,
      summary: 'Pay fictional racing invoice', payee: 'Fictional Builder', purpose: 'fictional work', amount: 10000,
      currency: 'AUD', dueAt: '2026-10-01T00:00:00.000Z', invoiceId: 'FICTIONAL-RACE',
      attachmentIds: ['fictional-attachment'], evidenceSelectors: ['attachment:1:invoice-number']
    } });
    const defer = metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-race-defer',
      loopId: created.loop.loopId, expectedRevision: 1, decision: 'defer', reviewAt: '2026-10-02T00:00:00.000Z',
      actorId: 'fictional-operator', rationale: 'Wait for the fictional update.', updatedAt: '2026-09-20T01:00:00.000Z' });
    const jobs = new Map();
    let releaseAdd;
    let enteredAdd;
    const addEntered = new Promise(resolve => { enteredAdd = resolve; });
    const addReleased = new Promise(resolve => { releaseAdd = resolve; });
    const gateway = { async request(method, params) {
      if (method === 'cron.list') return { jobs: [...jobs.values()].map(job => structuredClone(job)) };
      if (method === 'cron.add') {
        enteredAdd();
        await addReleased;
        const job = { ...structuredClone(params), configRevision: 'fictional-native-r1' };
        jobs.set(job.id, job);
        return { created: true, job: structuredClone(job) };
      }
      if (method === 'cron.get') return structuredClone(jobs.get(params.id));
      if (method === 'cron.update') {
        const current = jobs.get(params.id);
        assert.equal(current.configRevision, params.expectedConfigRevision);
        const job = { ...current, ...structuredClone(params.patch), configRevision: 'fictional-native-r2' };
        jobs.set(job.id, job);
        return structuredClone(job);
      }
      throw new Error(`unexpected fictional Cron method ${method}`);
    } };
    const coordinator = createOpenLoopReminderCoordinator({ metadata, gateway });
    const older = coordinator.reconcileAccepted({ loop: defer.loop, followUpIntent: defer.followUpIntent });
    await addEntered;
    const paid = metadata.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'fictional-race-paid',
      loopId: created.loop.loopId, expectedRevision: 2, paymentState: 'paid', actorId: 'fictional-operator',
      rationale: 'Fictional settlement confirmed.', updatedAt: '2026-09-20T02:00:00.000Z' });
    releaseAdd();
    await older;
    assert.equal(metadata.getOpenLoop(created.loop.loopId).paymentState, 'paid');
    assert.equal([...jobs.values()].every(job => job.enabled === false), true, 'stale worker must not leave an active Reminder after paid');
    assert.notEqual(paid.followUpIntent.action, 'none', 'newer decision must retain recoverable follow-up for the in-flight create');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a newer corrected date retimes the one in-flight create instead of publishing its stale date', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-decision-corrected-race-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    metadata.createTopic({ topicId: 'fictional-correction-topic', paraCategory: 'project', lifecycle: 'active' });
    const created = metadata.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'fictional-correction-intake', message: {
      schemaVersion: 1, channel: 'email', source: { system: 'fictional-mail', externalId: 'fictional-correction-invoice', version: 'v1' },
      occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', historicalBaseline: false,
      topicId: 'fictional-correction-topic', disposition: 'confirmed-obligation', requestKind: 'payment', explicitRequest: true,
      summary: 'Pay fictional corrected invoice', payee: 'Fictional Builder', purpose: 'fictional work', amount: 10000,
      currency: 'AUD', dueAt: '2026-10-01T00:00:00.000Z', invoiceId: 'FICTIONAL-CORRECTED',
      attachmentIds: ['fictional-attachment'], evidenceSelectors: ['attachment:1:invoice-number']
    } });
    const defer = metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-correction-defer',
      loopId: created.loop.loopId, expectedRevision: 1, decision: 'defer', reviewAt: '2026-10-02T00:00:00.000Z',
      actorId: 'fictional-operator', rationale: 'Wait for the fictional update.', updatedAt: '2026-09-20T01:00:00.000Z' });
    const jobs = new Map();
    let releaseAdd; let enteredAdd;
    const addEntered = new Promise(resolve => { enteredAdd = resolve; });
    const addReleased = new Promise(resolve => { releaseAdd = resolve; });
    let adds = 0; let updates = 0;
    const gateway = { async request(method, params) {
      if (method === 'cron.list') return { jobs: [...jobs.values()].map(job => structuredClone(job)) };
      if (method === 'cron.add') {
        adds += 1; enteredAdd(); await addReleased;
        const job = { ...structuredClone(params), configRevision: 'fictional-native-r1' };
        jobs.set(job.id, job); return { created: true, job: structuredClone(job) };
      }
      if (method === 'cron.get') return structuredClone(jobs.get(params.id));
      if (method === 'cron.update') {
        updates += 1;
        const current = jobs.get(params.id);
        assert.equal(current.configRevision, params.expectedConfigRevision);
        const job = { ...current, ...structuredClone(params.patch), configRevision: 'fictional-native-r2' };
        jobs.set(job.id, job); return structuredClone(job);
      }
      throw new Error(`unexpected fictional Cron method ${method}`);
    } };
    const coordinator = createOpenLoopReminderCoordinator({ metadata, gateway });
    const older = coordinator.reconcileAccepted({ loop: defer.loop, followUpIntent: defer.followUpIntent });
    await addEntered;
    const corrected = metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-correction-date',
      loopId: created.loop.loopId, expectedRevision: 2, decision: 'correct-date', dueAt: '2026-10-06T00:00:00.000Z',
      actorId: 'fictional-operator', rationale: 'Fictional bill date corrected.', updatedAt: '2026-09-20T02:00:00.000Z' });
    assert.equal(corrected.followUpIntent.action, 'reschedule-pending-create');
    releaseAdd();
    await older;
    assert.equal(adds, 1);
    assert.equal(updates, 1);
    assert.equal([...jobs.values()][0]?.schedule?.at, '2026-10-06T00:00:00.000Z');
    assert.equal(metadata.getOperation(corrected.followUpIntent.logicalOperationId)?.state, 'applied');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a newer paid decision conditionally disables an older native reschedule that completes late', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-decision-update-race-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    metadata.createTopic({ topicId: 'fictional-update-race-topic', paraCategory: 'project', lifecycle: 'active' });
    const created = metadata.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'fictional-update-race-intake', message: {
      schemaVersion: 1, channel: 'email', source: { system: 'fictional-mail', externalId: 'fictional-update-race-invoice', version: 'v1' },
      occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', historicalBaseline: false,
      topicId: 'fictional-update-race-topic', disposition: 'confirmed-obligation', requestKind: 'payment', explicitRequest: true,
      summary: 'Pay fictional update-race invoice', payee: 'Fictional Builder', purpose: 'fictional work', amount: 10000,
      currency: 'AUD', dueAt: '2026-10-01T00:00:00.000Z', invoiceId: 'FICTIONAL-UPDATE-RACE',
      attachmentIds: ['fictional-attachment'], evidenceSelectors: ['attachment:1:invoice-number']
    } });
    const referenceId = openLoopReminderReferenceId(created.loop.loopId);
    metadata.createSourceReference({ version: 1, referenceId, topicId: 'fictional-update-race-topic',
      sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: 'fictional-update-native',
      observedRevision: 'fictional-r1' });
    const defer = metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-update-race-defer',
      loopId: created.loop.loopId, expectedRevision: 1, decision: 'defer', reviewAt: '2026-10-02T00:00:00.000Z',
      actorId: 'fictional-operator', rationale: 'Wait for the fictional update.', updatedAt: '2026-09-20T01:00:00.000Z' });
    assert.equal(defer.followUpIntent.action, 'reschedule');
    let job = { id: 'fictional-update-native', configRevision: 'fictional-r1', enabled: true,
      schedule: { kind: 'at', at: '2026-10-01T00:00:00.000Z' } };
    let releaseUpdate; let enteredUpdate;
    const updateEntered = new Promise(resolve => { enteredUpdate = resolve; });
    const updateReleased = new Promise(resolve => { releaseUpdate = resolve; });
    const updates = [];
    const gateway = { async request(method, params) {
      if (method === 'cron.get') return structuredClone(job);
      if (method === 'cron.update') {
        updates.push(structuredClone(params));
        if (updates.length === 1) { enteredUpdate(); await updateReleased; }
        assert.equal(params.expectedConfigRevision, job.configRevision, 'every native mutation must use its exact observed revision');
        job = { ...job, ...structuredClone(params.patch), configRevision: `fictional-r${updates.length + 1}` };
        return structuredClone(job);
      }
      throw new Error(`unexpected fictional Cron method ${method}`);
    } };
    const coordinator = createOpenLoopReminderCoordinator({ metadata, gateway });
    const older = coordinator.reconcileAccepted({ loop: defer.loop, followUpIntent: defer.followUpIntent });
    await updateEntered;
    const paid = metadata.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'fictional-update-race-paid',
      loopId: created.loop.loopId, expectedRevision: 2, paymentState: 'paid', actorId: 'fictional-operator',
      rationale: 'Fictional settlement confirmed.', updatedAt: '2026-09-20T02:00:00.000Z' });
    assert.equal(paid.followUpIntent.action, 'cancel-after-update');
    assert.equal(paid.followUpIntent.expectedConfigRevision, 'fictional-r1');
    const waiting = await coordinator.reconcileAccepted({ loop: paid.loop, followUpIntent: paid.followUpIntent });
    assert.equal(waiting.status, 'pending', 'the newer decision cannot guess an in-flight native revision');
    assert.equal(updates.length, 1);
    releaseUpdate();
    await older;
    assert.equal(job.enabled, false, 'the late worker must not leave the paid bill scheduled');
    assert.equal(updates.length, 2);
    assert.equal(updates[1].expectedConfigRevision, 'fictional-r2');
    assert.equal(metadata.getOpenLoop(created.loop.loopId).paymentState, 'paid');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SIGKILL after decision commit leaves one resumable Reminder plan for a fresh process',
  { skip: process.platform !== 'linux' && 'actual SIGKILL/reopen requires the supported Linux runtime', timeout: 30_000 }, async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-decision-kill-'));
    const fixturePath = fileURLToPath(new URL('./fixtures/open-loop-decision-process-death.mjs', import.meta.url));
    const launch = mode => {
      const child = spawn(process.execPath, [fixturePath, stateDir, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      return { child, exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr }))) };
    };
    const message = (child, type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture did not reach ${type}`)), 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', value => {
        if (value?.type === type) { clearTimeout(timer); resolve(value); }
        if (value?.type === 'failed') { clearTimeout(timer); reject(new Error(value.message)); }
      });
    });
    let committed; let resumed;
    try {
      committed = launch('commit');
      const accepted = await message(committed.child, 'accepted');
      committed.child.kill('SIGKILL');
      const killed = await committed.exited;
      assert.deepEqual({ code: killed.code, signal: killed.signal }, { code: null, signal: 'SIGKILL' }, killed.stderr);
      const inspection = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
      try {
        const receipt = inspection.getOpenLoopUserActionReceipt(accepted.operationId);
        assert.equal(receipt.loop.loopId, accepted.loopId);
        assert.equal(receipt.followUpIntent.action, 'create');
        assert.equal(inspection.getOperation(receipt.followUpIntent.logicalOperationId), null, 'no native effect began before death');
      } finally { inspection.close(); }
      resumed = launch('resume');
      const completed = await message(resumed.child, 'completed');
      const exit = await resumed.exited;
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null }, exit.stderr);
      assert.deepEqual({ status: completed.status, jobCount: completed.jobCount, scheduleAt: completed.scheduleAt, operationState: completed.operationState },
        { status: 'applied', jobCount: 1, scheduleAt: '2026-10-02T00:00:00.000Z', operationState: 'applied' });
    } finally {
      if (committed?.child.exitCode === null && committed.child.signalCode === null) committed.child.kill('SIGKILL');
      if (resumed?.child.exitCode === null && resumed.child.signalCode === null) resumed.child.kill('SIGKILL');
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

test('SIGKILL after targeted interpretation commit resumes only its follow-up and preserves a clear sibling',
  { skip: process.platform !== 'linux' && 'actual SIGKILL/reopen requires the supported Linux runtime', timeout: 30_000 }, async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-interpretation-kill-'));
    const fixturePath = fileURLToPath(new URL('./fixtures/open-loop-decision-process-death.mjs', import.meta.url));
    const launch = mode => {
      const child = spawn(process.execPath, [fixturePath, stateDir, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      return { child, exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr }))) };
    };
    const message = (child, type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture did not reach ${type}`)), 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', value => {
        if (value?.type === type) { clearTimeout(timer); resolve(value); }
        if (value?.type === 'failed') { clearTimeout(timer); reject(new Error(value.message)); }
      });
    });
    let committed; let resumed;
    try {
      committed = launch('commit-interpreted');
      const accepted = await message(committed.child, 'accepted');
      committed.child.kill('SIGKILL');
      assert.deepEqual({ code: (await committed.exited).code, signal: committed.child.signalCode }, { code: null, signal: 'SIGKILL' });
      const inspection = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
      try {
        const receipt = inspection.getOpenLoopUserActionReceipt(accepted.operationId);
        assert.equal(receipt.loop.loopId, accepted.loopId);
        assert.equal(receipt.followUpIntent.action, 'create');
        assert.equal(inspection.getOperation(receipt.followUpIntent.logicalOperationId), null);
        assert.equal(inspection.getOpenLoop(accepted.siblingId).revision, accepted.siblingRevision);
        const evidence = receipt.loop.evidenceObservationIds.map(id => inspection.getOpenLoopObservation(id))
          .find(item => item.source.kind === 'processor-interpretation');
        assert.equal(evidence.facts.provenance, 'targeted-interpretation');
        assert.equal(evidence.facts.interpretationOf, evidence.facts.resolvesClarificationId);
      } finally { inspection.close(); }
      resumed = launch('resume');
      const completed = await message(resumed.child, 'completed');
      const exit = await resumed.exited;
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null }, exit.stderr);
      assert.deepEqual({ status: completed.status, jobCount: completed.jobCount, operationState: completed.operationState },
        { status: 'applied', jobCount: 1, operationState: 'applied' });
      const after = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
      try { assert.equal(after.getOpenLoop(accepted.siblingId).revision, accepted.siblingRevision); }
      finally { after.close(); }
    } finally {
      if (committed?.child.exitCode === null && committed.child.signalCode === null) committed.child.kill('SIGKILL');
      if (resumed?.child.exitCode === null && resumed.child.signalCode === null) resumed.child.kill('SIGKILL');
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

test('SIGKILL after native create and disable effects recovers one exact paid Reminder without redispatch',
  { skip: process.platform !== 'linux' && 'actual SIGKILL/reopen requires the supported Linux runtime', timeout: 30_000 }, async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-decision-native-kill-'));
    const fixturePath = fileURLToPath(new URL('./fixtures/open-loop-decision-process-death.mjs', import.meta.url));
    const children = [];
    let paidLoopId;
    const launch = mode => {
      const child = spawn(process.execPath, [fixturePath, stateDir, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      return { child, exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr }))) };
    };
    const message = (child, type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture did not reach ${type}`)), 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', value => {
        if (value?.type === type) { clearTimeout(timer); resolve(value); }
        if (value?.type === 'failed') { clearTimeout(timer); reject(new Error(value.message)); }
      });
    });
    try {
      const committed = launch('commit');
      await message(committed.child, 'accepted');
      committed.child.kill('SIGKILL');
      assert.equal((await committed.exited).signal, 'SIGKILL');

      const effect = launch('effect');
      const accepted = await message(effect.child, 'native-accepted');
      assert.equal(accepted.id, openLoopReminderOperationId('10000000-0000-4000-8000-000000000031'));
      effect.child.kill('SIGKILL');
      assert.equal((await effect.exited).signal, 'SIGKILL');

      const inspection = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
      try {
        assert.equal(inspection.getOperation(accepted.id)?.state, 'pending');
        const defer = inspection.getOpenLoopUserActionReceipt('10000000-0000-4000-8000-000000000031');
        paidLoopId = defer.loop.loopId;
        assert.equal(inspection.getSourceReference(openLoopReminderReferenceId(defer.loop.loopId)), null);
        const paid = inspection.recordOpenLoopPaymentStatus({ schemaVersion: 1,
          logicalOperationId: '10000000-0000-4000-8000-000000000032', loopId: defer.loop.loopId,
          expectedRevision: defer.loop.revision, paymentState: 'paid', actorId: 'fictional-operator',
          rationale: 'Fictional invoice paid after the earlier process died.', updatedAt: '2026-09-20T02:00:00.000Z' });
        assert.equal(paid.followUpIntent.action, 'cancel-pending-create');
        assert.equal(paid.followUpIntent.predecessor.logicalOperationId, accepted.id);
      } finally { inspection.close(); }

      const cancellation = launch('paid-effect');
      const cancelled = await message(cancellation.child, 'native-update-accepted');
      assert.equal(cancelled.id, accepted.id);
      cancellation.child.kill('SIGKILL');
      assert.equal((await cancellation.exited).signal, 'SIGKILL');
      const pending = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
      try {
        const paidAction = pending.getCurrentOpenLoopUserActionReceipt(paidLoopId);
        assert.equal(pending.getOperation(paidAction.followUpIntent.logicalOperationId)?.state, 'pending');
      } finally { pending.close(); }

      const recovery = launch('paid-verify');
      const completed = await message(recovery.child, 'completed');
      assert.deepEqual({ status: completed.status, jobCount: completed.jobCount, enabled: completed.enabled, operationState: completed.operationState },
        { status: 'applied', jobCount: 1, enabled: false, operationState: 'applied' });
      assert.deepEqual({ code: (await recovery.exited).code, signal: recovery.child.signalCode }, { code: 0, signal: null });
      const final = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
      try {
        assert.equal(final.getOperation(accepted.id)?.state, 'applied');
        assert.equal(final.getOpenLoopUserActionReceipt('10000000-0000-4000-8000-000000000032')?.loop.paymentState, 'paid');
      } finally { final.close(); }
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
