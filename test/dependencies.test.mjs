import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import * as playwrightCore from 'playwright-core';

test('declares static ESM imports for playwright and playwright-core', () => {
  assert.equal(typeof chromium.launch, 'function');
  assert.equal(typeof playwrightCore.chromium.launch, 'function');
});
