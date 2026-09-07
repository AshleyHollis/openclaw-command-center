import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { assertBuiltDigest, digestFileName } from './build.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = ['LICENSE', 'openclaw.plugin.json', 'package.json'];
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sorted = files => files.sort((a, b) => a.path.localeCompare(b.path));

function validMember(name) {
  return typeof name === 'string' && !name.includes('\\') && !name.includes('\0') &&
    !name.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':')) &&
    (rootFiles.includes(name) || name.startsWith('dist/'));
}

async function canonicalDirectory(directory) {
  if (!path.isAbsolute(directory) || path.resolve(await realpath(directory)) !== path.resolve(directory)) fail('artifact-directory-unsafe');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('artifact-directory-unsafe');
}

// Publication runs under the caller's exclusive operation lock in a private,
// trusted directory. Same-UID hostile processes are outside this boundary;
// native Node fallbacks do not promise kernel-atomic tree publication.
async function publicationParent(directory) {
  await canonicalDirectory(directory);
  const stat = await lstat(directory);
  if (process.platform !== 'linux' || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('artifact-parent-not-private');
  return async () => {
    await canonicalDirectory(directory);
    const current = await lstat(directory);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.uid !== stat.uid || current.mode !== stat.mode) fail('artifact-parent-changed');
  };
}

async function readMember(filename) {
  if (path.resolve(await realpath(filename)) !== path.resolve(filename)) fail('artifact-member-unsafe');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) fail('artifact-member-unsafe');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(offset) !== before.size || ['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs'].some(key => before[key] !== after[key])) fail('artifact-member-changed');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function inventory(root, packageOnly = false) {
  await canonicalDirectory(root);
  const files = []; const names = new Set(); let total = 0;
  async function visit(relative = '') {
    const entries = packageOnly && !relative ? [...rootFiles, 'dist'] : await readdir(path.join(root, relative));
    for (const name of entries) {
      const member = relative ? `${relative}/${name}` : name;
      const filename = path.join(root, member);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) fail('artifact-member-unsafe');
      if (stat.isDirectory()) {
        if (member !== 'dist' && !member.startsWith('dist/')) fail('artifact-member-unexpected');
        await visit(member);
      } else {
        if (!stat.isFile() || !validMember(member)) fail('artifact-member-unsafe');
        const key = member.normalize('NFC').toLowerCase();
        if (names.has(key)) fail('artifact-member-duplicate');
        names.add(key);
        const bytes = await readMember(filename); total += bytes.length;
        if (total > MAX_BYTES || files.length >= MAX_FILES) fail('artifact-size-limit');
        files.push({ path: member, sizeBytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  await visit();
  return sorted(files);
}

async function validateManifests(root, buildDigest) {
  const parse = async name => JSON.parse((await readMember(path.join(root, name))).toString('utf8'));
  const pkg = await parse('package.json'); const plugin = await parse('openclaw.plugin.json');
  const tuple = await parse('dist/compatibility-tuple.json');
  const built = await parse(`dist/${digestFileName}`);
  if (pkg.name !== 'openclaw-command-center' || pkg.type !== 'module' || plugin.id !== 'command-center' ||
      plugin.entry !== 'dist/plugin.mjs' || plugin.version !== pkg.version || tuple.package?.version !== pkg.version ||
      !isDeepStrictEqual(pkg.openclaw?.extensions, ['./dist/plugin.mjs']) ||
      pkg.openclaw?.compat?.pluginApi !== tuple.pluginApi?.range ||
      !isDeepStrictEqual(pkg.commandCenter?.compatibilityTuple, tuple) || built.digest !== buildDigest) fail('artifact-manifest-mismatch');
  if (!isDeepStrictEqual(await readMember(path.join(root, 'openclaw.plugin.json')), await readMember(path.join(root, 'dist/plugin-manifest.json')))) fail('artifact-manifest-mismatch');
  const config = (await readMember(path.join(root, 'dist/plugin-config.mjs'))).toString('utf8');
  if (config !== `export const pluginConfigSchema = ${JSON.stringify(plugin.configSchema)};\n`) fail('artifact-manifest-mismatch');
  return { name: pkg.name, version: pkg.version };
}

async function copyMembers(root, destination, files) {
  const { root: bindRoot } = await import('openclaw/plugin-sdk/file-access-runtime');
  const target = await bindRoot(destination, { symlinks: 'reject', hardlinks: 'reject', mkdir: true, mode: 0o644 });
  for (const file of files) {
    const bytes = await readMember(path.join(root, file.path));
    if (bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256) fail('artifact-member-changed');
    await target.create(file.path, bytes);
  }
  // Package directories must be traversable by the sandbox UID regardless of
  // the operator's umask. Only this newly reserved tree is normalized, using
  // directory descriptors; the private publication parent is left unchanged.
  const directories = new Set(['']);
  for (const file of files) {
    let directory = path.posix.dirname(file.path);
    while (directory !== '.') { directories.add(directory); directory = path.posix.dirname(directory); }
  }
  for (const relative of directories) {
    const filename = relative ? await target.resolve(relative) : destination;
    const handle = await open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isDirectory()) fail('artifact-directory-unsafe');
      await handle.chmod(0o755);
    } finally { await handle.close(); }
  }
}

function assertReceipt(receipt) {
  if (receipt?.formatVersion !== 1 || receipt.kind !== 'command-center-plugin-artifact' || receipt.pluginId !== 'command-center' ||
      !/^[a-f0-9]{64}$/.test(receipt.buildDigest) || !/^[a-f0-9]{64}$/.test(receipt.archive?.sha256) ||
      !Number.isSafeInteger(receipt.archive.sizeBytes) || receipt.archive.sizeBytes < 1 || receipt.archive.sizeBytes > MAX_BYTES ||
      !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > MAX_FILES) fail('artifact-receipt-invalid');
  const seen = new Set(); let total = 0;
  for (const member of receipt.files) {
    if (!validMember(member.path) || !/^[a-f0-9]{64}$/.test(member.sha256) || !Number.isSafeInteger(member.sizeBytes) || member.sizeBytes < 0) fail('artifact-receipt-invalid');
    const key = member.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) fail('artifact-receipt-invalid');
    seen.add(key); total += member.sizeBytes;
    if (total > MAX_BYTES) fail('artifact-size-limit');
  }
  for (const name of [...rootFiles, `dist/${digestFileName}`, 'dist/plugin.mjs', 'dist/plugin-manifest.json', 'dist/plugin-config.mjs', 'dist/compatibility-tuple.json']) {
    if (!seen.has(name.toLowerCase())) fail('artifact-receipt-invalid');
  }
}

/** The caller supplies the independently retained receipt, never the archive's declaration. */
export async function verifyPluginArtifact({ archivePath, expectedReceipt, destinationDirectory }) {
  const receipt = structuredClone(expectedReceipt); assertReceipt(receipt);
  if (!path.isAbsolute(destinationDirectory) || path.resolve(destinationDirectory) !== destinationDirectory) fail('artifact-layout-invalid');
  const assertParent = await publicationParent(path.dirname(destinationDirectory));
  if (await lstat(destinationDirectory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) fail('artifact-destination-exists');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'command-center-verify-'));
  try {
    const bytes = await readMember(archivePath);
    if (bytes.length !== receipt.archive.sizeBytes || hash(bytes) !== receipt.archive.sha256) fail('artifact-archive-mismatch');
    const archive = path.join(scratch, 'plugin.tgz');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    const extracted = path.join(scratch, 'extracted'); await mkdir(extracted, { mode: 0o700 });
    const members = new Map(receipt.files.map(file => [`package/${file.path}`, file]));
    const directories = new Set(['package']);
    for (const name of members.keys()) {
      let directory = path.posix.dirname(name);
      while (directory !== '.') { directories.add(directory); directory = path.posix.dirname(directory); }
    }
    const { extractArchive } = await import('openclaw/plugin-sdk/archive');
    await extractArchive({ archivePath: archive, destDir: extracted, timeoutMs: 60_000, stripComponents: 0, entryModes: 'clamp',
      limits: { maxArchiveBytes: MAX_BYTES, maxExtractedBytes: MAX_BYTES, maxEntryBytes: MAX_BYTES, maxEntries: MAX_FILES * 2 },
      onFiltered: 'reject-archive', entryFilter: entry => {
        if (entry.kind === 'directory' && directories.has(entry.path)) return 'extract';
        const member = members.get(entry.path);
        return entry.kind === 'file' && member && entry.size === member.sizeBytes ? 'extract' : 'skip';
      } });
    const root = path.join(extracted, 'package');
    if (!isDeepStrictEqual(await inventory(root), receipt.files) ||
        !isDeepStrictEqual(await validateManifests(root, receipt.buildDigest), receipt.package)) fail('artifact-content-mismatch');
    // Exclusive destination creation is the admission point. Existing directories
    // are never replaced; a partial copy has no successful verification result.
    await assertParent();
    await mkdir(destinationDirectory, { mode: 0o755 });
    await copyMembers(root, destinationDirectory, receipt.files);
    if (!isDeepStrictEqual(await inventory(destinationDirectory), receipt.files)) fail('artifact-content-mismatch');
    return destinationDirectory;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Pack only a sealed build and its matching manifests; never execute lifecycle scripts. */
export async function packagePluginArtifact({ expectedBuildReceipt, outputDirectory }) {
  if (process.platform !== 'linux') fail('artifact-linux-required');
  if (!path.isAbsolute(outputDirectory) || path.resolve(outputDirectory) !== outputDirectory ||
      ['dist', 'src'].some(name => outputDirectory === path.join(sourceRoot, name) || outputDirectory.startsWith(`${path.join(sourceRoot, name)}${path.sep}`))) fail('artifact-layout-invalid');
  const build = structuredClone(expectedBuildReceipt);
  await assertBuiltDigest(build);
  const assertParent = await publicationParent(path.dirname(outputDirectory));
  const files = await inventory(sourceRoot, true);
  const pkg = await validateManifests(sourceRoot, build.digest);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'command-center-pack-'));
  try {
    const staged = path.join(scratch, 'package'); await mkdir(staged, { mode: 0o755 });
    await copyMembers(sourceRoot, staged, files);
    await chmod(staged, 0o755);
    await assertBuiltDigest(build);
    if (!isDeepStrictEqual(await inventory(sourceRoot, true), files)) fail('artifact-member-changed');
    const userConfig = path.join(scratch, 'user.npmrc'); const globalConfig = path.join(scratch, 'global.npmrc');
    await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 });
    await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
    const { stdout } = await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', scratch,
      '--cache', path.join(scratch, 'cache'), '--userconfig', userConfig, '--globalconfig', globalConfig],
    { cwd: staged, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const packed = JSON.parse(stdout);
    if (packed.length !== 1 || !/^[a-zA-Z0-9._-]+\.tgz$/.test(packed[0].filename)) fail('artifact-pack-result-invalid');
    const archivePath = path.join(scratch, packed[0].filename);
    const archiveBytes = await readMember(archivePath);
    const receipt = { formatVersion: 1, kind: 'command-center-plugin-artifact', package: pkg, pluginId: 'command-center',
      buildDigest: build.digest, files, archive: { sha256: hash(archiveBytes), sizeBytes: archiveBytes.length } };
    await verifyPluginArtifact({ archivePath, expectedReceipt: receipt, destinationDirectory: path.join(scratch, 'verified') });
    await assertBuiltDigest(build);
    if (!isDeepStrictEqual(await inventory(sourceRoot, true), files)) fail('artifact-member-changed');
    await assertParent();
    await mkdir(outputDirectory, { mode: 0o700 });
    const publishedArchive = path.join(outputDirectory, 'command-center.tgz');
    const receiptPath = path.join(outputDirectory, 'receipt.json');
    const { root: bindRoot } = await import('openclaw/plugin-sdk/file-access-runtime');
    const output = await bindRoot(outputDirectory, { symlinks: 'reject', hardlinks: 'reject', mode: 0o600 });
    await output.create('command-center.tgz', archiveBytes);
    await output.create('receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
    return { archivePath: publishedArchive, receiptPath, receipt };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
