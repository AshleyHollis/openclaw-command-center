import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const sha = /^[a-f0-9]{40}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const bareDigest = /^[a-f0-9]{64}$/u;
export const candidateRepositories = Object.freeze({
  commandCenter: 'https://github.com/AshleyHollis/openclaw-command-center.git',
  openClaw: 'https://github.com/AshleyHollis/openclaw.git'
});
const fail = (message) => { throw Object.assign(new Error(message), { code: 'candidate-pair-invalid' }); };

function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(',');
}

function validPair(body) {
  const cc = body.commandCenter;
  const host = body.openClaw;
  return body.formatVersion === 1 && body.kind === 'development-candidate' &&
    exactKeys(body, ['formatVersion', 'kind', 'commandCenter', 'openClaw', 'fixtureDigest']) &&
    exactKeys(cc, ['repository', 'sourceCommit', 'inputTreeDigest', 'overlayDigest', 'buildDigest', 'archiveSha256']) &&
    cc.repository === candidateRepositories.commandCenter && sha.test(cc.sourceCommit) && digest.test(cc.inputTreeDigest) &&
    (cc.overlayDigest === null || digest.test(cc.overlayDigest)) &&
    bareDigest.test(cc.buildDigest) && bareDigest.test(cc.archiveSha256) &&
    exactKeys(host, ['repository', 'sourceCommit', 'packageVersion', 'packageDigest', 'runtimeDigest', 'sourceDigest', 'executableDigest', 'contractDigest']) &&
    host.repository === candidateRepositories.openClaw && sha.test(host.sourceCommit) && typeof host.packageVersion === 'string' &&
    /^\d{4}\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(host.packageVersion) &&
    ['packageDigest', 'runtimeDigest', 'sourceDigest', 'executableDigest', 'contractDigest'].every(key => digest.test(host[key])) &&
    digest.test(body.fixtureDigest);
}

/** A candidate descriptor is a content-addressed qualification input, never a release receipt. */
export function sealCandidatePair(body) {
  if (!validPair(body)) fail('Candidate pair fields are incomplete or unexpected');
  const cc = body.commandCenter;
  const host = body.openClaw;
  const copy = {
    formatVersion: 1, kind: 'development-candidate',
    commandCenter: { repository: cc.repository, sourceCommit: cc.sourceCommit, inputTreeDigest: cc.inputTreeDigest,
      overlayDigest: cc.overlayDigest, buildDigest: cc.buildDigest, archiveSha256: cc.archiveSha256 },
    openClaw: { repository: host.repository, sourceCommit: host.sourceCommit, packageVersion: host.packageVersion,
      packageDigest: host.packageDigest, runtimeDigest: host.runtimeDigest, sourceDigest: host.sourceDigest,
      executableDigest: host.executableDigest, contractDigest: host.contractDigest },
    fixtureDigest: body.fixtureDigest
  };
  const seal = `sha256:${createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
  Object.freeze(copy.commandCenter);
  Object.freeze(copy.openClaw);
  return Object.freeze({ ...copy, seal, releaseQualified: false });
}

export function parseCandidatePair(value) {
  const pair = typeof value === 'string' ? JSON.parse(value) : value;
  if (!exactKeys(pair, ['formatVersion', 'kind', 'commandCenter', 'openClaw', 'fixtureDigest', 'seal', 'releaseQualified']) ||
    pair.releaseQualified !== false || !digest.test(pair.seal)) fail('Candidate pair is not a closed development descriptor');
  const { seal, releaseQualified: _releaseQualified, ...body } = pair;
  const expected = sealCandidatePair(body);
  if (expected.seal !== seal) fail('Candidate pair seal differs from its contents');
  return expected;
}

/** Bind independently retained package/build receipts before candidate host launch. */
export function assertCandidatePairEvidence(pairValue, { inputTreeReceipt, buildReceipt, artifactReceipt, hostDescriptor }) {
  const pair = parseCandidatePair(pairValue);
  const cc = pair.commandCenter;
  const host = pair.openClaw;
  if (inputTreeReceipt?.repository !== cc.repository || inputTreeReceipt.sourceCommit !== cc.sourceCommit ||
    inputTreeReceipt.inputTreeDigest !== cc.inputTreeDigest || inputTreeReceipt.overlayDigest !== cc.overlayDigest ||
    buildReceipt?.formatVersion !== 1 || buildReceipt.digest !== cc.buildDigest ||
    artifactReceipt?.formatVersion !== 1 || artifactReceipt?.kind !== 'command-center-plugin-artifact' ||
    artifactReceipt.pluginId !== 'command-center' ||
    artifactReceipt.sourceCommit !== cc.sourceCommit || artifactReceipt.buildDigest !== cc.buildDigest ||
    artifactReceipt.archive?.sha256 !== cc.archiveSha256 ||
    hostDescriptor?.schemaVersion !== 2 || hostDescriptor.commit !== host.sourceCommit ||
    hostDescriptor.integrity?.packageDigest !== host.packageDigest ||
    hostDescriptor.integrity?.runtimeDigest !== host.runtimeDigest ||
    hostDescriptor.integrity?.sourceDigest !== host.sourceDigest ||
    hostDescriptor.integrity?.executableDigest !== host.executableDigest ||
    hostDescriptor.integrity?.contractDigest !== host.contractDigest) fail('Candidate pair does not match independently retained build and host receipts');
  return pair;
}

async function archiveDigest(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('Candidate archive path must be absolute');
  const status = await lstat(filename);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 128 * 1024 * 1024) fail('Candidate archive is not a bounded regular file');
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

export async function assertCandidateArchiveBytes(pairValue, { pluginArchivePath, hostArchivePath }) {
  const pair = parseCandidatePair(pairValue);
  const [plugin, host] = await Promise.all([archiveDigest(pluginArchivePath), archiveDigest(hostArchivePath)]);
  if (plugin !== pair.commandCenter.archiveSha256 || `sha256:${host}` !== pair.openClaw.packageDigest) fail('Candidate archive bytes differ from the pair');
}
