import assert from 'node:assert/strict';
import test from 'node:test';
import { hasKeyboardFocusIndicator, hasSuccessfulBrowserResponse, observeBrowserResponse, observedBrowserResponseStatus, recordBounded } from '../src/browser-evidence.mjs';

test('records a successful browser response observation', async () => {
  const recorded = [];
  const response = { status: () => 200 };
  const observed = await observeBrowserResponse(Promise.resolve(response), (error) => recorded.push(error));

  assert.deepEqual(observed, { observed: true, value: response });
  assert.deepEqual(recorded, []);
});

test('settles a failed browser response observation without an unhandled rejection', async () => {
  const failure = new Error('browser page closed');
  const recorded = [];
  const observed = await observeBrowserResponse(Promise.reject(failure), (error) => recorded.push(error));

  assert.deepEqual(observed, { observed: false, value: undefined });
  assert.deepEqual(recorded, [failure]);
});

test('settles a failed browser response when diagnostics are intentionally omitted', async () => {
  const observed = await observeBrowserResponse(Promise.reject(new Error('fictional browser response failed')));
  assert.deepEqual(observed, { observed: false, value: undefined });
});

test('caps browser evidence and leaves a single truncation marker', () => {
  const evidence = [];
  for (const value of ['one', 'two', 'three', 'four']) recordBounded(evidence, value, 3);

  assert.deepEqual(evidence, ['one', 'two', '[truncated]']);
});

test('keyboard focus evidence recognises a focus-only shadow without accepting an ordinary decoration', () => {
  const ring = 'rgb(220, 70, 60) 0px 0px 0px 2px';
  const evidence = { outline: 'none', focusVisible: true, boxShadow: ring, baselineBoxShadow: 'none' };
  assert.equal(hasKeyboardFocusIndicator(evidence), true);
  assert.equal(hasKeyboardFocusIndicator({ ...evidence, baselineBoxShadow: ring }), false);
  assert.equal(hasKeyboardFocusIndicator({ ...evidence, focusVisible: false }), false);
  assert.equal(hasKeyboardFocusIndicator({ ...evidence, boxShadow: 'none' }), false);
  assert.equal(hasKeyboardFocusIndicator({ outline: 'solid' }), true);
  assert.equal(hasKeyboardFocusIndicator({ nativeComposite: true }), true);
  assert.equal(hasKeyboardFocusIndicator({ nativeTextCaret: true, focusVisible: true }), true);
  assert.equal(hasKeyboardFocusIndicator({ nativeTextCaret: true, focusVisible: false }), false);
});

test('keyboard focus evidence recognises changed background shape but not an unchanged or transparent fill', () => {
  const evidence = { focusVisible: true, backgroundColor: 'rgb(30, 60, 120)', baselineBackgroundColor: 'rgba(0, 0, 0, 0)' };
  assert.equal(hasKeyboardFocusIndicator(evidence), true);
  assert.equal(hasKeyboardFocusIndicator({ ...evidence, focusVisible: false }), false);
  assert.equal(hasKeyboardFocusIndicator({ ...evidence, baselineBackgroundColor: evidence.backgroundColor }), false);
  assert.equal(hasKeyboardFocusIndicator({ ...evidence, backgroundColor: 'rgba(0, 0, 0, 0)', baselineBackgroundColor: 'rgb(30, 60, 120)' }), false);
});

test('accepts only an observed successful browser response', () => {
  const ok = { observed: true, value: { ok: () => true, status: () => 200 } };
  const rejected = { observed: false, value: undefined };
  const forbidden = { observed: true, value: { ok: () => false, status: () => 401 } };

  assert.equal(hasSuccessfulBrowserResponse(ok), true);
  assert.equal(observedBrowserResponseStatus(ok), 200);
  assert.equal(hasSuccessfulBrowserResponse(rejected), false);
  assert.equal(observedBrowserResponseStatus(rejected), undefined);
  assert.equal(hasSuccessfulBrowserResponse(forbidden), false);
  assert.equal(observedBrowserResponseStatus(forbidden), 401);
});
