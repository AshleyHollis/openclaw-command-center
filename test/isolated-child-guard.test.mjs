import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixtureEnvironment } from '../src/fixtures.mjs';

const guard = new URL('../src/isolated-child-guard.mjs', import.meta.url);

function runGuardedChild(manifestPath, script = `
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
    `) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', guard.pathname, '--input-type=module', '--eval', script], {
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

test('guarded child permits an admitted loopback fetch through Node socket internals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-child-guard-loopback-'));
  const trafficLog = path.join(root, 'traffic.jsonl');
  const manifestPath = path.join(root, 'fixture-manifest.json');
  const server = createServer((_request, response) => response.end('loopback-ok'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await writeFile(manifestPath, `${JSON.stringify({ trafficLog })}\n`);
    const result = await runGuardedChild(manifestPath, `
      const response = await fetch('http://127.0.0.1:${address.port}/');
      process.stdout.write(await response.text());
    `);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'loopback-ok');
    const entries = (await readFile(trafficLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.source === 'fetch' && entry.destination === '127.0.0.1'));
    assert.ok(entries.some((entry) => entry.source === 'net' && entry.destination === '127.0.0.1'));
    assert.ok(entries.every((entry) => entry.permitted === true));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
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

test('guarded child does not require an IPC root for network-only isolation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-child-guard-no-ipc-'));
  const trafficLog = path.join(root, 'traffic.jsonl');
  const manifestPath = path.join(root, 'fixture-manifest.json');
  try {
    await writeFile(manifestPath, `${JSON.stringify({ trafficLog })}\n`);
    const result = await runGuardedChild(manifestPath, `
      try { await fetch('https://example.invalid/'); } catch {}
      process.stdout.write('blocked');
    `);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'blocked');
    const entries = (await readFile(trafficLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.some((entry) => entry.source === 'fetch' && entry.permitted === false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
