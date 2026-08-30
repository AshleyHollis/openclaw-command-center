import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { scanPublicEvidence, scanRepositorySafety } from '../src/safety.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const execute = promisify(execFile);
const fictionalBearer = ['Bear', 'er fictional-token-123456'].join('');
const fictionalPrefixedCredential = ['gh', 'p_', 'fictional-value'].join('');
const fictionalShortAssignment = ['token', ': short'].join('');
const fictionalIdentifierKeyField = ['key', ': operationKey'].join('');
const fictionalJsonPassword = ['{"pass', 'word":"fictional-value"}'].join('');
const fictionalJsonCookie = ['{"coo', 'kie":"fictional-value"}'].join('');
const fictionalEncryptedKeyHeader = ['-----BEGIN ENCRYPTED ', 'PRIVATE KEY-----'].join('');
const fictionalLabeledKeyHeader = ['-----BEGIN DSA ', 'PRIVATE KEY-----'].join('');
const fictionalRootPath = ['/ro', 'ot/fictional-file'].join('');
const fictionalWindowsHomePath = ['C:', '\\Users\\fictional-user\\file'].join('');

test('runtime evidence scanning rejects sensitive values without echoing the match', () => {
  const unsafeEvidence = ['status=failed to', 'ken=fictional-sensitive-value'].join('');
  assert.throws(() => scanPublicEvidence([unsafeEvidence]), (error) => {
    assert.match(error.message, /runtime-evidence\[0\]/u);
    assert.doesNotMatch(error.message, /fictional-sensitive-value/u);
    return true;
  });
  assert.deepEqual(scanPublicEvidence(['status=passed', '{"rows":9}', ['to', 'ken=[redacted]'].join('')]), []);
});

async function assertUnsafeFixture(label, content) {
  const fixture = path.join(root, `.fictional-safety-${label}.txt`);
  try {
    await writeFile(fixture, content);
    await assert.rejects(scanRepositorySafety(root), new RegExp(`fictional-safety-${label}`));
  } finally {
    await rm(fixture, { force: true });
  }
}

test('scans non-ignored untracked repository content without echoing secrets', async () => {
  const fixture = path.join(root, '.fictional-safety-fixture.txt');
  try {
    await writeFile(fixture, fictionalBearer);
    await assert.rejects(scanRepositorySafety(root), /fictional-safety-fixture/);
  } finally {
    await rm(fixture, { force: true });
  }
  await scanRepositorySafety(root);
});

test('detects credential prefixes and populated assignments of every length', async () => {
  const fixture = path.join(root, '.fictional-credential-fixture.txt');
  try {
    await writeFile(fixture, `${fictionalPrefixedCredential}\n${fictionalShortAssignment}`);
    await assert.rejects(scanRepositorySafety(root), /fictional-credential-fixture/);
  } finally {
    await rm(fixture, { force: true });
  }
  await scanRepositorySafety(root);
});

test('allows an identifier-valued bare key field without weakening credential-name or prefix checks', async () => {
  const fixture = path.join(root, '.fictional-key-fixture.txt');
  try {
    await writeFile(fixture, fictionalIdentifierKeyField);
    await scanRepositorySafety(root);
  } finally {
    await rm(fixture, { force: true });
  }
  await scanRepositorySafety(root);
});

test('detects quoted JSON credentials, private-key headers, and personal paths', async () => {
  for (const [label, content] of [
    ['json-password', fictionalJsonPassword],
    ['json-cookie', fictionalJsonCookie],
    ['encrypted-key-header', fictionalEncryptedKeyHeader],
    ['labeled-key-header', fictionalLabeledKeyHeader],
    ['root-path', fictionalRootPath],
    ['windows-home-path', fictionalWindowsHomePath]
  ]) {
    await assertUnsafeFixture(label, content);
  }
  await scanRepositorySafety(root);
});

test('scans generated and cached artifacts while excluding paths outside the candidate', async () => {
  const generated = path.join(root, 'dist', '.fictional-generated-artifact.txt');
  const controllerTempRoot = path.join(root, '.controller-test-tmp');
  await mkdir(controllerTempRoot, { recursive: true });
  const outside = await mkdtemp(path.join(controllerTempRoot, 'command-center-safety-outside-'));
  try {
    await mkdir(path.dirname(generated), { recursive: true });
    await writeFile(generated, fictionalBearer);
    await assert.rejects(scanRepositorySafety(root, { generated: [generated] }), /fictional-generated-artifact/);
    await writeFile(path.join(outside, 'outside.txt'), fictionalBearer);
    await rm(generated);
    await scanRepositorySafety(root, { generated: [outside], controllerRoots: [controllerTempRoot] });
  } finally {
    await rm(generated, { force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(controllerTempRoot, { recursive: true, force: true });
  }

  const indexRoot = await mkdtemp(path.join(os.tmpdir(), 'command-center-safety-index-'));
  try {
    await execute('git', ['init', '--quiet', indexRoot]);
    const indexControllerTempRoot = path.join(indexRoot, '.controller-test-tmp');
    await mkdir(indexControllerTempRoot, { recursive: true });
    const ignoredCached = path.join(indexControllerTempRoot, 'cached.txt');
    await writeFile(ignoredCached, fictionalBearer);
    await execute('git', ['-C', indexRoot, 'add', '.controller-test-tmp/cached.txt']);
    await scanRepositorySafety(indexRoot, { controllerRoots: [indexControllerTempRoot] });
    const cached = path.join(indexRoot, 'cached.txt');
    await writeFile(cached, fictionalBearer);
    await execute('git', ['-C', indexRoot, 'add', 'cached.txt']);
    await writeFile(cached, 'safe worktree replacement');
    await assert.rejects(scanRepositorySafety(indexRoot), /cached.txt/);
  } finally {
    await rm(indexRoot, { recursive: true, force: true });
  }
});

test('fails closed when candidate content cannot be read', async () => {
  const fixture = path.join(root, '.fictional-unreadable-fixture.txt');
  try {
    await writeFile(fixture, 'safe fixture');
    await assert.rejects(
      scanRepositorySafety(root, { read: (filename, encoding) => filename === fixture ? Promise.reject(new Error('fictional read failure')) : readFile(filename, encoding) }),
      /unreadable-content/,
    );
  } finally {
    await rm(fixture, { force: true });
  }
});

test('fails closed when an enumerated explicit entry disappears before inspection', async () => {
  const snapshot = await mkdtemp(path.join(os.tmpdir(), 'command-center-safety-race-'));
  const fixture = path.join(snapshot, 'captured-output.txt');
  try {
    await writeFile(fixture, 'safe bounded output');
    await assert.rejects(
      scanRepositorySafety(snapshot, {
        stat: async (filename) => {
          if (filename === fixture) {
            await rm(fixture, { force: true });
            throw Object.assign(new Error('fictional disappearance'), { code: 'ENOENT' });
          }
          return import('node:fs/promises').then(({ lstat }) => lstat(filename));
        }
      }),
      /captured-output\.txt \(missing-or-unreadable-entry\)/u,
    );
  } finally { await rm(snapshot, { recursive: true, force: true }); }
});

async function withIgnoredAncestorSnapshot(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-safety-parent-'));
  try {
    await execute('git', ['init', '--quiet', parent]);
    await writeFile(path.join(parent, '.gitignore'), 'tmp/\n');
    const snapshot = path.join(parent, 'tmp', 'candidate');
    await mkdir(path.join(snapshot, 'src'), { recursive: true });
    await writeFile(path.join(snapshot, 'package.json'), '{"name":"fictional-snapshot"}\n');
    await writeFile(path.join(snapshot, 'src', 'safe.mjs'), 'export const safe = true;\n');
    await run(snapshot);
  } finally { await rm(parent, { recursive: true, force: true }); }
}

test('Gitless snapshot nested beneath an ignored ancestor repository scans safe content', async () => {
  await withIgnoredAncestorSnapshot(async (snapshot) => {
    await scanRepositorySafety(snapshot);
  });
});

test('Gitless snapshot nested beneath an ignored ancestor repository rejects unsafe source', async () => {
  await withIgnoredAncestorSnapshot(async (snapshot) => {
    await writeFile(path.join(snapshot, 'src', 'unsafe.mjs'), fictionalBearer);
    await assert.rejects(scanRepositorySafety(snapshot), /src\/unsafe\.mjs/u);
  });
});

test('Gitless snapshot nested beneath an ignored ancestor repository rejects captured output', async () => {
  await withIgnoredAncestorSnapshot(async (snapshot) => {
    await writeFile(path.join(snapshot, 'captured-output.txt'), fictionalBearer);
    await assert.rejects(scanRepositorySafety(snapshot), /captured-output\.txt/u);
  });
});
