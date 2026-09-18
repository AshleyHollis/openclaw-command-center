import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { openNativeSessionRoster } from './support/first-live-native-scale.mjs';

// Locator orchestration only; the real-host roster-only diagnostic exercises
// the same helper against the actual native sidebar and authenticated host.
function navigation({ pinned = false, failure } = {}) {
  const events = [];
  let visible = pinned;
  const sessions = {
    isVisible: async () => visible,
    click: async () => { assert.equal(visible, true); events.push('sessions'); }
  };
  const roster = { waitFor: async () => events.push('roster-ready') };
  const sidebar = { getByRole(role, options) {
    assert.equal(options.exact, true);
    if (role === 'link' && options.name === 'Sessions') return sessions;
    assert.equal(role, 'button');
    assert.equal(options.name, 'Edit pinned items');
    return { click: async () => { events.push('menu'); if (failure) throw failure; visible = true; } };
  } };
  const page = { locator(selector) {
    if (selector === 'openclaw-app-sidebar') return sidebar;
    assert.equal(selector, 'openclaw-sessions-page');
    return roster;
  } };
  return { page, roster, events };
}

test('unpinned Sessions uses the native menu before opening the roster', async () => {
  const state = navigation();
  assert.equal(await openNativeSessionRoster(state.page), state.roster);
  assert.deepEqual(state.events, ['menu', 'sessions', 'roster-ready']);
});

test('pinned Sessions opens directly without editing sidebar preferences', async () => {
  const state = navigation({ pinned: true });
  await openNativeSessionRoster(state.page);
  assert.deepEqual(state.events, ['sessions', 'roster-ready']);
});

test('unavailable native menu fails without a route or permission bypass', async () => {
  const failure = new Error('Fictional native menu unavailable');
  const state = navigation({ failure });
  await assert.rejects(openNativeSessionRoster(state.page), error => error === failure);
  assert.deepEqual(state.events, ['menu']);
});

for (const refusal of ['capture', 'unsealed']) {
  test(`scale diagnostic refuses ${refusal} before opening a host or browser`, () => {
    const env = { ...process.env };
    delete env.COMMAND_CENTER_CAPTURE_PERFORMANCE_BASELINE;
    delete env.COMMAND_CENTER_SEALED_CANDIDATE;
    delete env.COMMAND_CENTER_ISOLATED_HOST;
    if (refusal === 'capture') {
      env.COMMAND_CENTER_CAPTURE_PERFORMANCE_BASELINE = '1';
      env.COMMAND_CENTER_SEALED_CANDIDATE = '1';
    }
    const result = spawnSync(process.execPath, ['scripts/diagnose-native-scale.mjs'], {
      env, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
    assert.match(result.stderr, refusal === 'capture' ? /Scale diagnostics cannot capture a performance baseline/ : /Scale diagnostics require a sealed candidate/);
    assert.equal(result.stdout, '');
  });
}
