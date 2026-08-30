import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixtureEnvironment } from '../src/fixtures.mjs';

const guard = new URL('../src/isolated-child-guard.mjs', import.meta.url);

function runGuardedChild(manifestPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', guard.pathname, '--input-type=module', '--eval', `
      import dns from 'node:dns';
      const attempts = [
        async () => dns.promises.resolve4('example.invalid'),
        async () => new dns.Resolver().resolve4('example.invalid'),
        async () => fetch('https://example.invalid/'),
        async () => { new WebSocket('wss://example.invalid/'); }
      ];
      let rejected = 0;
      for (const attempt of attempts) {
        try { await attempt(); } catch { rejected += 1; }
      }
      if (rejected !== attempts.length) process.exitCode = 1;
      process.stdout.write(String(rejected));
    `], {
      env: { PATH: process.env.PATH, [fixtureEnvironment]: manifestPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('guard covers promise DNS, WebSocket, and network-only transport surfaces', async () => {
  const source = await readFile(new URL('../src/isolated-child-guard.mjs', import.meta.url), 'utf8');
  assert.match(source, /dns\.promises/);
  assert.match(source, /globalThis\.WebSocket/);
  assert.doesNotMatch(source, /node:child_process|subprocess-/);
  assert.match(source, /syncBuiltinESMExports/);
});

test('guarded child records and blocks network egress before dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-child-guard-'));
  const trafficLog = path.join(root, 'traffic.jsonl');
  const manifestPath = path.join(root, 'fixture-manifest.json');
  try {
    await writeFile(manifestPath, `${JSON.stringify({ trafficLog })}\n`);
    const result = await runGuardedChild(manifestPath);
    assert.equal(result.code, 0, result.stderr);
    const entries = (await readFile(trafficLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => entry.source), [
      'dns-promises-resolve4',
      'dns-resolver-resolve4',
      'fetch',
      'websocket'
    ]);
    assert.ok(entries.every((entry) => entry.permitted === false));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
