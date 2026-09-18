import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyFixtureGroupStopped(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') throw new Error('Process-group rehearsals require Linux/WSL');
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(-child.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(20);
  }
  throw new Error('Fixture process-group shutdown is unverified; retain owned state');
}

// Call only for a child this fixture spawned; POSIX children must own a group.
export function stopFixtureProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function waitForFixtureClose(child, { timeoutMs = 180_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let failure;
    const stop = () => {
      try { stopFixtureProcessTree(child); }
      catch (error) { failure ??= error; }
    };
    const abort = () => { failure ??= signal.reason ?? new Error('Fixture process cancelled'); stop(); };
    const timer = setTimeout(() => { failure ??= new Error('Fixture process timed out'); stop(); }, timeoutMs);
    child.once('error', error => { failure ??= error; });
    // A closed leader can leave a live group holding its streams and state.
    child.once('exit', stop);
    child.once('close', (code, terminationSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code, signal: terminationSignal });
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
