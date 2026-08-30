import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSuccessfulBrowserResponse, observeBrowserResponse, observedBrowserResponseStatus, recordBounded } from '../src/browser-evidence.mjs';

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

test('caps browser evidence and leaves a single truncation marker', () => {
  const evidence = [];
  for (const value of ['one', 'two', 'three', 'four']) recordBounded(evidence, value, 3);

  assert.deepEqual(evidence, ['one', 'two', '[truncated]']);
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
