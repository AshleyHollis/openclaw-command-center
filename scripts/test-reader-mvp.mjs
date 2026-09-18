import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { selectReaderMvpTestFiles } from '../src/test-selection.mjs';
import { prepareTestRuntimeEnvironment } from './test-runtime.mjs';
import { runTestLanes } from './test-lanes.mjs';

const files = selectReaderMvpTestFiles(readdirSync(new URL('../test/', import.meta.url)));
if (files.length === 0) throw new Error('No reader-MVP tests were selected.');
const environment = await prepareTestRuntimeEnvironment();
const nativeUiPage = 'test/native-ui-page.test.mjs';
const result = runTestLanes(files.filter(file => file !== nativeUiPage), { env: environment });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status;

// This fixture is a table of isolated browser journeys. Run each one in its
// own Node process: parallel execution shares neither browser nor fixture
// globals, and a deferred scenario cannot mask the specific reader outcome.
const readerUiScenarios = [
  'native Chat handoff', 'initial connection', 'reconnection', 'hidden retained view',
  'Topic Notes', 'Note pagination', 'Note snapshot mismatch', 'Note tree filter',
  'Note selection superseded', 'Original attachments', 'Topic Conversations',
  'Topic histories', 'Malformed Topic Conversations', 'Note cancels Chat', 'Old Chat error',
  'Notes panel', 'Missing panel promotion', 'Unbound panel', 'Late panel context',
  'Late panel Note', 'Replaced panel Session', 'Replaced panel document', 'Group setup'
];
for (const scenario of readerUiScenarios) {
  const escaped = scenario.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const outcome = spawnSync(process.execPath, ['--test', '--test-name-pattern', `^native Topics: ${escaped}$`, nativeUiPage], {
    stdio: 'inherit', env: environment
  });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0 || outcome.signal) {
    process.exitCode ||= outcome.status && outcome.status > 0 ? outcome.status : 1;
    break;
  }
}
