import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ACCEPTANCE_REPORT_VERSION, RELEASE_ROW_IDS } from '../src/acceptance-report.mjs';
import { RELEASE_MEASUREMENTS, RELEASE_PERFORMANCE_BASELINE_VERSION } from '../src/performance-baseline.mjs';
import { resolveRealHostAcceptancePlan } from '../src/test-selection.mjs';

test('desktop-first release requires keyboard evidence and versions its changed report contract', () => {
  assert.equal(ACCEPTANCE_REPORT_VERSION, 2);
  assert.equal(RELEASE_ROW_IDS.includes('desktop-keyboard-journey'), true);
  assert.equal(RELEASE_ROW_IDS.includes('mobile-accessibility-journey'), false);
  assert.equal(resolveRealHostAcceptancePlan('combined-journey').scenarioIds.includes('desktop-keyboard-journey'), true);
});

test('mobile remains explicit opt-in rather than a silent pass in either non-performance lane', () => {
  const ids = ['diagnostic-ui-data', 'diagnostic-security-recovery'].flatMap((name) => resolveRealHostAcceptancePlan(name).isolatedSliceIds);
  assert.equal(ids.includes('fresh-mobile'), false);
  assert.equal(ids.length, 16);
  assert.deepEqual(resolveRealHostAcceptancePlan('diagnostic-mobile').isolatedSliceIds, ['fresh-mobile']);
  assert.ok(resolveRealHostAcceptancePlan('mobile-primary-journey').scenarioIds.includes('mobile-accessibility-journey'));
  assert.ok(resolveRealHostAcceptancePlan('desktop-keyboard-journey').scenarioIds.includes('desktop-keyboard-journey'));
});

test('desktop performance retains all nine non-mobile measurements under a new baseline version', () => {
  assert.equal(RELEASE_PERFORMANCE_BASELINE_VERSION, 2);
  assert.deepEqual(RELEASE_MEASUREMENTS, ['startupReadinessMs', 'dashboardLoadMs', 'topicOpenCreateMs', 'chatSendMs', 'conversationLifecycleMs', 'largeNoteLifecycleMs', 'indexedSearchMs', 'activityNextPageMs', 'topicReviewApplyMs']);
});

test('canonical runtime keeps mobile fixtures optional and review at the desktop viewport', async () => {
  const source = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  assert.match(source, /isolatedSliceIds\?\.includes\('fresh-mobile'\)/u);
  const start = source.indexOf("await collectScenario('desktop-primary-journey-review'");
  const review = source.slice(start, source.indexOf('const finalizationErrors', start));
  assert.match(review, /width: 1440, height: 900/u);
  assert.doesNotMatch(review, /width: 320|page, 320/u);
  assert.match(source, /assertKeyboardAccessibility\(frame, page, \{ mobile: mobileQualification, evidence: auditEvidence \}\)/u);
});

test('focused full-corpus setup retains verified counts needed by the scale receipt', async () => {
  const source = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("await collectScenario('focused-control-ui-search-projection'");
  const setup = source.slice(start, source.indexOf("scenarioResult('focused-control-ui-search-projection')", start));
  assert.ok(/if \(fullCorpus\) releaseState\.realizedSearchCounts =/u.test(setup), 'focused scale setup must retain observed counts before constructing its receipt');
  assert.ok(/notes: verified\.topicRowCounts\.notes\[RELEASE_SCALE_TOPIC_ID\]/u.test(setup));
  assert.ok(/conversationMessages: verified\.topicRowCounts\.conversationMessages\[RELEASE_SCALE_TOPIC_ID\]/u.test(setup));
});

test('desktop keyboard records its observed Reminder status announcements for the release gate', async () => {
  const source = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const mobileQualification');
  const journey = source.slice(start, source.indexOf("await collectScenario('desktop-primary-journey-review'", start)).replace(/\r\n/gu, '\n');
  for (const message of ['Item snoozed.', 'Reminder Complete accepted.']) {
    const observation = `await waitForFrameText(frame, '#dashboard-feedback', '${message}');`;
    const recording = `keyboardJourney.announcementTransitions.push('${message}');`;
    assert.ok(journey.includes(`${observation}\n      ${recording}`), `record the verified ${message} transition, not an invented release count`);
  }
});

test('complete capture closes the primary world before launching independent worlds', async () => {
  const source = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  const review = source.indexOf("await collectScenario('desktop-primary-journey-review'");
  const finalize = source.indexOf('const finalizationErrors = await finalizeAcceptanceJourney', review);
  const independent = source.indexOf('await Promise.all([...isolatedSlices.keys()]', review);
  assert.ok(finalize > review && independent > finalize, 'completed primary resources must not overlap independent fixtures');
  assert.ok(source.indexOf('let privacyEvidence', independent) > independent, 'coherent qualification still follows every fixture');
});
