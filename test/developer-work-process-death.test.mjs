import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAttentionService } from '../src/attention/service.mjs';
import { createDeveloperWorkService } from '../src/developer-work/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const capabilities = { notes: false, sessions: false, scheduler: false, activity: true, analysis: false, attention: true, search: false };

test('accepted but unprojected evidence survives actual producer process death', { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-developer-crash-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/developer-work-receipt-child.mjs', import.meta.url)), stateDir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let childClosed = false;
  const closed = new Promise(resolve => child.once('close', value => { childClosed = true; resolve(value); }));
  let stderr = '';
  child.stderr.on('data', part => { stderr += part; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Receipt child did not reach its boundary: ${stderr.slice(0, 1000)}`)), 10_000);
      child.stdout.on('data', part => { if (String(part).includes('boundary-reached')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Receipt child exited early (${code}): ${stderr.slice(0, 1000)}`)); });
    });
    assert.equal(child.kill('SIGKILL'), true);
    await closed;
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
    const attention = createAttentionService({ metadata });
    try {
      assert.equal(metadata.listPendingDeveloperEvents({}).length, 1);
      const work = createDeveloperWorkService({ metadata, attention });
      try {
        await work.drain();
        assert.equal(metadata.listPendingDeveloperEvents({}).length, 0);
        assert.deepEqual(attention.list().episodes.map(row => row.evidenceFacts.requestId), ['crash-review']);
        await work.drain();
        assert.equal(attention.list().episodes.length, 1);
      } finally { work.close(); }
    } finally { attention.close(); metadata.close(); }
  } finally {
    if (!childClosed) { child.kill('SIGKILL'); await closed; }
    if (path.dirname(stateDir) !== os.tmpdir() || !path.basename(stateDir).startsWith('cc-developer-crash-')) throw new Error('Refusing unsafe test cleanup path');
    await rm(stateDir, { recursive: true, force: true });
  }
});
