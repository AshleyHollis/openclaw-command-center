import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const owner = process.env.COMMAND_CENTER_REHEARSAL_PRIMARY_OWNER === 'provisioning' ? 'provisioning' : 'bootstrap';
for (const boundary of ['before', 'after']) test(`${owner} first Primary process death ${boundary} native commit preserves truthful recovery`, { timeout: 300_000 }, async t => {
  assert.equal(process.platform, 'linux');
  const fixture = fileURLToPath(new URL(owner === 'provisioning' ? './provisioning-primary-crash-child.mjs' : './topic-bootstrap-crash-child.mjs', import.meta.url));
  const env = { ...process.env, COMMAND_CENTER_REHEARSAL_STATE_DIR: path.join(process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR, boundary) };
  async function run(mode) {
    const child = spawn(process.execPath, [fixture, mode, boundary], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; let reached = false; let expired = false;
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const expire = () => { expired = true; child.kill('SIGKILL'); };
    let timer = setTimeout(expire, 120_000);
    child.on('message', message => {
      if (message?.phase === 'sdk-ready') { clearTimeout(timer); timer = setTimeout(expire, 45_000); }
      if (message?.boundary === `native-primary-${boundary}-commit`) { reached = true; child.kill('SIGKILL'); }
    });
    t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
    const result = await closed; clearTimeout(timer);
    assert.equal(expired, false, `Owned child exceeded its readiness/operation bound: ${output}`);
    return { result, reached, output };
  }
  const crash = await run('crash');
  assert.equal(crash.reached, true, crash.output);
  assert.deepEqual(crash.result, { code: null, signal: 'SIGKILL' }, crash.output);
  const resumed = await run('resume');
  assert.deepEqual(resumed.result, { code: 0, signal: null }, resumed.output);
  assert.match(resumed.output, new RegExp(`verified ${owner} ${boundary}-commit recovery`));
});
