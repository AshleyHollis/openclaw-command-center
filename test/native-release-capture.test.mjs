import assert from 'node:assert/strict';
import test from 'node:test';
import { runNativeReleaseCapture } from './support/first-live-native-release.mjs';
import * as nativeRelease from './support/first-live-native-release.mjs';
import { FINALIZATION_PHASES, RELEASE_ROW_IDS } from '../src/acceptance-report.mjs';
import { RELEASE_MEASUREMENTS, releasePerformanceIdentity } from '../src/performance-baseline.mjs';

// These fictional runner doubles test the orchestration boundary only. They
// neither launch OpenClaw nor qualify any native/runtime acceptance frontier.
const digest = 'a'.repeat(64);
const revision = 'fictional-native-revision';
const names = ['primary', 'keyboard', 'secure', 'bridgeDenied', 'sourceUnavailable', 'combinedDegraded', 'hostMismatch', 'buildMismatch', 'pluginApiMismatch', 'bridgeProtocolMismatch', 'bindingMismatch', 'foreignRestoration', 'schemaMismatch', 'restoration', 'scale'];
const bridge = { protocolVersion: 1, writeGrant: false, observedFromAuthenticatedAction: true, action: 'conversations.create', httpStatus: 422, errorCode: 'capability-unavailable' };
const source = { capability: 'sessions', available: false, bindingObserved: true };
const runtime = { mode: 'recovery-only', safeReadObserved: true, mutationRejected: true, mountedUiObserved: true, unsupportedControlsAbsent: true, nativeActivationObserved: true, revision };

function fixtures() {
  const degraded = { schemaVersion: 2, mode: 'degraded', safeReadObserved: true, mutationRejected: true };
  return {
    primary: {
      startup: { hostReceipt: { ...releasePerformanceIdentity.hostReceipt }, startupMigrationVerified: true, routeGrantObserved: true,
        nativeUi: { pluginId: 'command-center', revision, activationObserved: true, authenticatedHttpObserved: true } },
      primary: { schemaVersion: 2, topicId: 'fictional-topic', authoritativeReadback: { existingTopics: true, primarySession: true, conversation: true, note: true, chatSend: true, conversationAfterRestart: true },
        actions: ['existing-topic-open', 'note-read', 'native-chat-open', 'native-chat-send', 'conversation-create', 'conversation-replay', 'conversation-refresh', 'native-return'] }
    },
    keyboard: { schemaVersion: 2, viewport: { width: 1440, height: 900 }, keyboardOnly: true, forcedColors: true, reducedMotion: true, focusRestored: true, announcements: true, colorIndependent: true, noPageOverflow: true,
      states: ['topics-navigation', 'notes-list', 'note-reader', 'native-chat-handoff', 'conversation-create', 'unknown-creation', 'source-unavailable', 'permission-refused'] },
    secure: { secureOrigin: 'https://command-center.fictional.ts.net:443', actualTlsLoad: true, fictionalTailnetHost: 'command-center.fictional.ts.net', loopbackResolution: '127.0.0.1', nativeActivationObserved: true, revision },
    bridgeDenied: { ...degraded, bridge: { ...bridge } },
    sourceUnavailable: { ...degraded, source: { ...source } },
    combinedDegraded: { ...degraded, combinedGrantDenied: true, bridge: { ...bridge }, source: { ...source } },
    ...Object.fromEntries([['hostMismatch', 'host'], ['buildMismatch', 'build'], ['bridgeProtocolMismatch', 'bridge-protocol']].map(([id, kind]) => [id, { kind, ...runtime, restoredStatePreserved: true, recoveryArtifactsPreserved: true, compatibilityRefusalObserved: true }])),
    pluginApiMismatch: { kind: 'plugin-api', activationRejected: true, mutationRejected: true, startupRejected: false, nativeUnavailableObserved: true, mountedUiObserved: false, unsupportedControlsAbsent: true, restoredStatePreserved: true, recoveryArtifactsPreserved: true },
    bindingMismatch: { kind: 'binding', ...runtime, mode: 'degraded', bindingObserved: true, bindingPreserved: true, recoveryArtifactsPreserved: true },
    foreignRestoration: { kind: 'database-identity', ...runtime, restoredStateValidated: true, foreignOwnershipRefused: true, databaseBytesPreserved: true, recoveryArtifactsPreserved: true },
    schemaMismatch: { schemaVersion: 1, ...runtime, mutationsRejected: true, futureSchemaBytesPreserved: true, recoveryArtifactsPreserved: true, mismatches: ['schema'] },
    restoration: { snapshotId: 'fictional-snapshot', writesBlocked: true, exactIdentityValidated: true, postValidationMutation: true, beforeCommitBytesPreserved: true, afterCommitBytesPreserved: true, realStartupValidated: true, existingTopicVerified: true, authoritativeNoteRead: true, readOnlyNotesObserved: true, retainedConversationCreation: true, exactNativeChatHandoff: true, nativeActivationObserved: true, revision },
    scale: { observations: { startupReadinessMs: 100.2, topicsLoadMs: 20.1, topicOpenMs: 30.5, chatSendMs: 40.1, conversationCreateMs: 50.1, largeNoteReadMs: 60.2, conversationNextPageMs: 70.3, noteNextPageMs: 80.4 },
      fixtureCounts: { largeNoteBytes: 8388609, conversations: 101, noteFiles: 5000, conversationMessages: 5000 },
      conversationPage: { firstPageCount: 50, secondPageCount: 50, thirdPageCount: 1, unique: true, orderPreserved: true },
      notes: { largeNoteBytes: 8388609, readOnly: true, paginationVerified: true },
      browser: { engine: 'chromium', playwrightVersion: '1.62.1', version: 'fictional-browser-1' }, viewport: { width: 1440, height: 900 } }
  };
}

function finalize(onFinalization) {
  for (const phase of FINALIZATION_PHASES) {
    onFinalization({ phase, status: 'started' });
    onFinalization({ phase, status: 'passed' });
  }
}

function setup() {
  const evidence = fixtures();
  const events = [];
  let active = 0;
  let maximumActive = 0;
  const runners = Object.fromEntries(names.map(id => [id, async ({ signal, onFinalization }) => {
    assert.equal(signal.aborted, false);
    events.push(`start:${id}`);
    if (id === 'scale') assert.equal(active, 0, 'Performance must have exclusive resources');
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setImmediate(resolve));
    finalize(onFinalization);
    active -= 1;
    events.push(`stop:${id}`);
    return evidence[id];
  }]));
  const { schemaVersion: _version, commit: _commit, ...integrity } = releasePerformanceIdentity.hostReceipt;
  const options = { descriptor: { integrity }, buildReceipt: { digest }, capturePerformanceBaseline: true, runners,
    onProgress: event => events.push(event), scanArtifacts: async () => {
      assert.equal(active, 0);
      assert.equal(events.includes('stop:scale'), true);
      events.push('scan');
      return { repository: true, generated: true, capturedOutput: true };
    } };
  return { options, evidence, events, maximumActive: () => maximumActive };
}

test('pure orchestration: all fifteen unique participants yield exactly nine coherent rows after exclusive scale and final privacy scan', async () => {
  const state = setup();
  const { report, capturedBaseline } = await runNativeReleaseCapture(state.options);
  assert.equal(report.outcome, 'passed');
  assert.deepEqual(report.rows.map(row => row.id), RELEASE_ROW_IDS);
  assert.equal(report.rows.length, 9);
  assert.equal(state.maximumActive(), 2);
  assert.deepEqual(state.events.filter(event => event?.status === 'passed').map(event => event.id).sort(), [...names].sort());
  assert.equal(state.events.at(-1), 'scan');
  assert.equal(capturedBaseline.capture.successfulRunOrdinal, 1);
  assert.equal(capturedBaseline.thresholds.startupReadinessMs, 101);
  assert.equal(capturedBaseline.thresholds.topicsLoadMs, 21);
  assert.deepEqual(capturedBaseline.browser, state.evidence.scale.browser);
  assert.deepEqual(report.performanceBaseline, capturedBaseline);
  assert.equal(report.rows[6].evidence.schemaVersion, 2);
  assert.deepEqual(report.rows[7].evidence.boundaries, { beforeCommit: true, afterCommitBeforeManifest: true });
  assert.equal(report.finalization.every(entry => entry.outcome === 'passed'), true);
});

function prerequisiteOptions(state) {
  const { scale: _scale, ...runners } = state.options.runners;
  const { capturePerformanceBaseline: _capture, ...options } = state.options;
  return { ...options, runners, scanArtifacts: async ({ participantEvidence, rowEvidence }) => {
    assert.equal(Object.keys(participantEvidence).length, 14);
    assert.equal(rowEvidence.length, 7);
    assert.equal(state.events.includes('start:scale'), false);
    return { repository: true, generated: true, capturedOutput: true };
  } };
}

test('pure orchestration: failed performance retains every numeric comparison without accepting or replacing the baseline', async () => {
  const seed = setup();
  const { capturedBaseline } = await runNativeReleaseCapture(seed.options);
  const before = JSON.stringify(capturedBaseline);
  const state = setup();
  state.options.capturePerformanceBaseline = false;
  state.options.baseline = capturedBaseline;
  state.evidence.scale.observations.startupReadinessMs = 152.5;
  state.evidence.scale.observations.chatSendMs = 92.5;
  await assert.rejects(runNativeReleaseCapture(state.options), error => {
    assert.match(error.message, /frozen performance budget/u);
    const comparison = JSON.parse(error.message.split('; performance-comparison=')[1]);
    assert.deepEqual(Object.keys(comparison), RELEASE_MEASUREMENTS);
    assert.deepEqual(comparison.startupReadinessMs, { observedMs: 152.5, limitMs: 151 });
    assert.deepEqual(comparison.chatSendMs, { observedMs: 92.5, limitMs: 91 });
    assert.match(error.cause.message, /startupReadinessMs exceeds/u);
    return true;
  });
  assert.equal(JSON.stringify(capturedBaseline), before);
  assert.equal(state.events.at(-1), 'scan');
});

test('pure orchestration: malformed timing diagnostics never echo nonnumeric evidence', async () => {
  const { capturedBaseline } = await runNativeReleaseCapture(setup().options);
  const state = setup();
  state.options.capturePerformanceBaseline = false;
  state.options.baseline = capturedBaseline;
  state.evidence.scale.observations.startupReadinessMs = 'fictional-private-content';
  await assert.rejects(runNativeReleaseCapture(state.options), error => {
    const comparison = JSON.parse(error.message.split('; performance-comparison=')[1]);
    assert.equal(comparison.startupReadinessMs.observedMs, null);
    assert.doesNotMatch(error.message, /fictional-private-content/u);
    return true;
  });
});

test('pure orchestration: early prerequisites run fourteen participants in two lanes without claiming release or performance', async () => {
  const state = setup();
  const result = await nativeRelease.runNativeReleasePrerequisites(prerequisiteOptions(state));
  assert.equal(result.kind, 'native-release-prerequisites');
  assert.equal(result.performanceQualified, false);
  assert.equal(result.buildDigest, digest);
  assert.equal(result.rows.length, 7);
  assert.equal(Object.keys(result.finalization).length, 14);
  assert.equal(state.maximumActive(), 2);
  assert.equal('report' in result, false);
  assert.equal('performanceBaseline' in result, false);
});

test('pure orchestration: prerequisite entry refuses scale, capture options and failed privacy', async () => {
  const state = setup();
  const options = prerequisiteOptions(state);
  await assert.rejects(nativeRelease.runNativeReleasePrerequisites({ ...options, runners: state.options.runners }), /fourteen/u);
  await assert.rejects(nativeRelease.runNativeReleasePrerequisites({ ...options, capturePerformanceBaseline: true }), /cannot capture/u);
  assert.equal(state.events.length, 0);
  await assert.rejects(nativeRelease.runNativeReleasePrerequisites({ ...options,
    scanArtifacts: async () => ({ repository: true, generated: true, capturedOutput: false }) }), /capturedOutput/u);
  assert.equal(state.events.includes('start:scale'), false);
});

test('pure orchestration: a compatibility producer from another native revision cannot qualify the sealed candidate', async () => {
  const state = setup();
  state.evidence.bindingMismatch.revision = 'another-fictional-candidate';
  await assert.rejects(runNativeReleaseCapture(state.options), /revision/u);
  assert.equal(state.events.includes('start:scale'), false);
  assert.equal(state.events.includes('scan'), false);
});

test('pure orchestration: incomplete desktop proof prevents expensive scale before report assembly', async () => {
  const state = setup();
  state.evidence.primary.primary.authoritativeReadback.chatSend = false;
  await assert.rejects(runNativeReleaseCapture(state.options), /authoritativeReadback/u);
  assert.equal(state.events.includes('start:scale'), false);
});

test('pure orchestration: safe ordinary failures collect independent diagnostics but never run scale or claim a release', async () => {
  const state = setup();
  state.options.runners.primary = async ({ onFinalization }) => {
    finalize(onFinalization);
    throw new Error('fictional primary refusal');
  };
  await assert.rejects(runNativeReleaseCapture(state.options), error => {
    assert.equal(error.fatalAcceptanceCleanup, undefined);
    assert.equal(error.outcomes.length, 14);
    assert.equal(new Set(error.outcomes.map(entry => entry.id)).size, 14);
    assert.deepEqual(error.outcomes.find(entry => entry.id === 'primary'), { id: 'primary', status: 'failed' });
    return /primary/u.test(error.message);
  });
  assert.equal(state.events.includes('stop:schemaMismatch'), true);
  assert.equal(state.events.includes('start:scale'), false);
  assert.equal(state.events.includes('scan'), false);
});

for (const id of names) {
  test(`pure orchestration: ${id} cannot succeed without its own six terminal callbacks`, async () => {
    const state = setup();
    state.options.runners[id] = async () => state.evidence[id];
    await assert.rejects(runNativeReleaseCapture(state.options), error => error.fatalAcceptanceCleanup === true && error.outcomes.some(entry => entry.id === id && entry.status === 'failed'));
    assert.equal(state.events.includes('scan'), false);
    if (id !== 'scale') assert.equal(state.events.includes('start:scale'), false);
  });
}

for (const variant of ['duplicate', 'out-of-order', 'shutdown-failed', 'traffic-failed']) {
  test(`pure orchestration: ${variant} finalization cannot be promoted from a successful helper return`, async () => {
    const state = setup();
    state.options.runners.primary = async ({ onFinalization }) => {
      const phases = [...FINALIZATION_PHASES];
      if (variant === 'out-of-order') [phases[0], phases[1]] = [phases[1], phases[0]];
      for (const phase of phases) onFinalization({ phase, status: (variant === 'shutdown-failed' && phase === 'host-stop') || (variant === 'traffic-failed' && phase === 'host-traffic') ? 'failed' : 'passed' });
      if (variant === 'duplicate') onFinalization({ phase: 'build-digest', status: 'passed' });
      return state.evidence.primary;
    };
    await assert.rejects(runNativeReleaseCapture(state.options), error => error.outcomes.some(entry => entry.id === 'primary' && entry.status === 'failed'));
    assert.equal(state.events.includes('start:scale'), false);
    assert.equal(state.events.includes('scan'), false);
  });
}

test('pure orchestration: fatal cleanup waits for the other active lane and admits no later work', async () => {
  const state = setup();
  let peerStopped = false;
  state.options.runners.primary = async ({ onFinalization }) => {
    await new Promise(resolve => setImmediate(resolve));
    finalize(onFinalization);
    peerStopped = true;
    return state.evidence.primary;
  };
  state.options.runners.hostMismatch = async () => state.evidence.hostMismatch;
  await assert.rejects(runNativeReleaseCapture(state.options), error => error.fatalAcceptanceCleanup === true);
  assert.equal(peerStopped, true);
  assert.equal(state.events.includes('start:keyboard'), false);
  assert.equal(state.events.includes('start:scale'), false);
  assert.equal(state.events.includes('scan'), false);
});

test('pure orchestration: an unsettled cancellation is fatal and never starts another batch', async () => {
  const state = setup();
  let release;
  let wasAborted = false;
  state.options.runners.primary = async ({ signal, onFinalization }) => {
    await new Promise(resolve => { release = resolve; });
    wasAborted = signal.aborted;
    finalize(onFinalization);
    return state.evidence.primary;
  };
  try {
    await assert.rejects(runNativeReleaseCapture({ ...state.options, timeoutMs: 20, cleanupTimeoutMs: 20 }), error => error.fatalAcceptanceCleanup === true);
    assert.equal(state.events.includes('start:keyboard'), false);
    assert.equal(state.events.includes('start:scale'), false);
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wasAborted, true);
  assert.equal(state.events.includes('scan'), false);
});

test('pure orchestration: failed shutdown during timeout cleanup fences the next pair', async () => {
  const state = setup();
  state.options.runners.primary = async ({ signal, onFinalization }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    for (const phase of FINALIZATION_PHASES) onFinalization({ phase, status: phase === 'host-stop' ? 'failed' : 'passed' });
    return state.evidence.primary;
  };
  await assert.rejects(runNativeReleaseCapture({ ...state.options, timeoutMs: 10, cleanupTimeoutMs: 100 }), error => error.fatalAcceptanceCleanup === true);
  assert.equal(state.events.includes('start:keyboard'), false);
  assert.equal(state.events.includes('start:scale'), false);
  assert.equal(state.events.includes('scan'), false);
});

test('pure orchestration: expected plugin rejection may be a stopped host, but neither rejection branch can omit its actual proof', async () => {
  const state = setup();
  state.evidence.pluginApiMismatch = { kind: 'plugin-api', activationRejected: true, mutationRejected: true, startupRejected: true, hostStoppedObserved: true, mountedUiObserved: false, restoredStatePreserved: true, recoveryArtifactsPreserved: true };
  assert.equal((await runNativeReleaseCapture(state.options)).report.outcome, 'passed');
  const missing = setup();
  delete missing.evidence.pluginApiMismatch.nativeUnavailableObserved;
  await assert.rejects(runNativeReleaseCapture(missing.options), /nativeUnavailableObserved/u);
  assert.equal(missing.events.includes('start:scale'), false);
});

test('pure orchestration: the final artifact scan must complete after teardown and cannot be replaced with a success flag', async () => {
  const state = setup();
  state.options.scanArtifacts = async ({ participantEvidence, rowEvidence, signal }) => {
    assert.equal(signal.aborted, false);
    assert.equal(Object.keys(participantEvidence).length, 15);
    assert.equal(rowEvidence.length, 8);
    assert.equal(state.events.includes('stop:scale'), true);
    return { repository: true, generated: true, capturedOutput: false };
  };
  await assert.rejects(runNativeReleaseCapture(state.options), /capturedOutput/u);
});

test('pure orchestration: a pinned baseline is reused without recapture and binds the actual browser and observations', async () => {
  const first = await runNativeReleaseCapture(setup().options);
  const state = setup();
  const reused = await runNativeReleaseCapture({ ...state.options, capturePerformanceBaseline: false, baseline: first.capturedBaseline });
  assert.equal(reused.capturedBaseline, undefined);
  assert.deepEqual(reused.report.performanceBaseline, first.capturedBaseline);
  const otherBrowser = setup();
  otherBrowser.evidence.scale.browser.version = 'fictional-browser-2';
  await assert.rejects(runNativeReleaseCapture({ ...otherBrowser.options, capturePerformanceBaseline: false, baseline: first.capturedBaseline }), /browser/u);
  const slower = setup();
  slower.evidence.scale.observations.topicsLoadMs = 72;
  await assert.rejects(runNativeReleaseCapture({ ...slower.options, capturePerformanceBaseline: false, baseline: first.capturedBaseline }), /frozen performance budget/u);
  const recapture = setup();
  await assert.rejects(runNativeReleaseCapture({ ...recapture.options, baseline: first.capturedBaseline }), /must not replace/u);
  assert.equal(recapture.events.length, 0);
});

test('pure orchestration: missing producer counts and false restoration evidence cannot be filled from defaults', async () => {
  const counts = setup();
  delete counts.evidence.scale.fixtureCounts.conversationMessages;
  await assert.rejects(runNativeReleaseCapture(counts.options), /conversationMessages/u);
  const restored = setup();
  restored.evidence.restoration.beforeCommitBytesPreserved = false;
  await assert.rejects(runNativeReleaseCapture(restored.options), /boundaries/u);
});

test('pure orchestration: closed participant configuration and exact startup identity are mandatory', async () => {
  const omitted = setup();
  delete omitted.options.runners.foreignRestoration;
  await assert.rejects(runNativeReleaseCapture(omitted.options), /fifteen/u);
  assert.equal(omitted.events.length, 0);
  const stale = setup();
  stale.evidence.primary.startup.hostReceipt.sourceDigest = `sha256:${'f'.repeat(64)}`;
  await assert.rejects(runNativeReleaseCapture(stale.options), /pinned host receipt/u);
  assert.equal(stale.events.includes('start:scale'), false);
});

test('pure orchestration: an observer exception cannot bypass the active peer teardown barrier', async () => {
  const state = setup();
  let stopped = false;
  state.options.runners.primary = async ({ onFinalization }) => {
    await new Promise(resolve => setImmediate(resolve));
    finalize(onFinalization);
    stopped = true;
    return state.evidence.primary;
  };
  state.options.onProgress = ({ id, status }) => {
    if (id === 'hostMismatch' && status === 'started') throw new Error('fictional progress sink failure');
  };
  await assert.rejects(runNativeReleaseCapture(state.options));
  assert.equal(stopped, true);
  assert.equal(state.events.includes('start:keyboard'), false);
  assert.equal(state.events.includes('start:scale'), false);
});
