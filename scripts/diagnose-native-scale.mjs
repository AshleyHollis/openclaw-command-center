import assert from 'node:assert/strict';
import { readBuiltReceipt, assertBuiltDigest } from '../src/build.mjs';
import { parseHostDescriptor, verifyHost } from '../src/host-harness.mjs';
import { runBoundedAcceptanceSlice } from '../src/acceptance-scenario-coordinator.mjs';
import { exerciseNativeJourney } from '../test/support/first-live-native-journey.mjs';

// Diagnostic only: the same authenticated native journey, without measuring or
// writing a baseline. The small mode reproduces the native roster handoff.
assert.equal(process.env.COMMAND_CENTER_CAPTURE_PERFORMANCE_BASELINE, undefined, 'Scale diagnostics cannot capture a performance baseline');
assert.equal(process.env.COMMAND_CENTER_SEALED_CANDIDATE, '1', 'Scale diagnostics require a sealed candidate');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--roster-only');
const rosterOnly = args.length === 1;
const descriptor = parseHostDescriptor();
const buildReceipt = await readBuiltReceipt();
await assertBuiltDigest(buildReceipt);
await verifyHost(descriptor);
const result = await runBoundedAcceptanceSlice('diagnostic-native-scale', signal => exerciseNativeJourney({
  descriptor, buildReceipt, signal, scale: !rosterOnly, scaleDiagnostic: true,
  ...(rosterOnly ? { diagnosticBoundary: 'roster-navigation' } : {}),
  onScaleProgress: value => console.log(`native-scale-stage=${JSON.stringify(value)}`),
  onFinalization: value => console.log(`native-scale-finalization=${JSON.stringify(value)}`)
}), { timeoutMs: 180_000 });
assert.equal(result.performanceQualified, false);
assert.equal(result.observations, undefined);
await assertBuiltDigest(buildReceipt);
console.log(`native-scale-diagnostic=${JSON.stringify({ outcome: 'passed', buildDigest: buildReceipt.digest,
  performanceQualified: false, rosterOnly, fixtureCounts: result.fixtureCounts,
  conversationPage: result.conversationPage, notes: result.notes })}`);
