import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.env.COMMAND_CENTER_NATIVE_UI_ROOT ?? path.resolve('src/native-ui');
const plugin = (await import(pathToFileURL(path.join(root, 'entry.mjs')).href)).default;

test('Command Center groups its destinations without moving the PARA session replacement', () => {
  const controller = new AbortController();
  const registrations = new Map();
  const selections = new Map();
  const register = kind => value => {
    registrations.set(`${kind}:${value.id}`, value);
    return () => registrations.delete(`${kind}:${value.id}`);
  };
  const dispose = plugin.activate({ signal: controller.signal, ui: {
    registerPage: register('page'), registerNavigation: register('navigation'),
    registerReplacement: register('replacement'),
    selectReplacement: (surface, id) => selections.set(surface, id)
  } });
  const destinations = [...registrations.entries()].filter(([key]) => key.startsWith('navigation:'))
    .map(([, value]) => value).sort((a, b) => a.order - b.order);
  assert.deepEqual(destinations.map(item => [item.label, item.page.id, item.group]), [
    ['Dashboard', 'attention', { id: 'workspace', label: 'Command Center' }],
    ['Planner', 'planner', { id: 'workspace', label: 'Command Center' }],
    ['Manage Topics', 'topics', { id: 'workspace', label: 'Command Center' }],
    ['Imported History', 'histories', { id: 'workspace', label: 'Command Center' }]
  ]);
  assert.equal(registrations.get('replacement:topic-sidebar').surface, 'session-list');
  assert.equal(selections.get('session-list'), 'topic-sidebar');
  assert.equal(registrations.get('replacement:topic-sidebar').group, undefined);
  dispose();
  assert.equal(registrations.size, 0);
  assert.equal(selections.get('session-list'), null);
});
