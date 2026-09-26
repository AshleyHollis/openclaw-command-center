import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { paraCategories } from '../metadata/schema.mjs';
import { sourceError } from '../sources/errors.mjs';
import { enrollNoteFolderIdentity, readNoteFolderIdentity, inspectNoteFolderCandidate, withBootstrapNoteFolder } from '../sources/note-folder-identity.mjs';
import { ownsNoteFilesystem, withNoteFilesystemOwner } from '../sources/note-filesystem-owner.mjs';

export const PARA_DIRECTORY_NAMES = Object.freeze({ project: 'Projects', area: 'Areas', resource: 'Resources', archive: 'Archive' });
export const ACTIVE_PARA_CATEGORIES = Object.freeze(['project', 'area', 'resource']);
let hostDirectoryPublisher;
const publisherBindings = [];
export function setHostDurableDirectoryPublisher(publisher) {
  const binding = { publisher: typeof publisher === 'function' ? publisher : undefined, active: true };
  publisherBindings.push(binding); hostDirectoryPublisher = binding.publisher;
  return () => {
    if (!binding.active) return;
    binding.active = false;
    while (publisherBindings.at(-1)?.active === false) publisherBindings.pop();
    hostDirectoryPublisher = publisherBindings.at(-1)?.publisher;
  };
}

function nonBlank(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw sourceError('invalid-request', `${field} must be a non-blank string.`);
  return value;
}

export function validateTopicName(value) {
  const name = nonBlank(value, 'name').trim().normalize('NFC');
  if (Buffer.byteLength(name, 'utf8') > 255) throw sourceError('invalid-request', 'Topic name exceeds the 255-byte limit.');
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name) || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw sourceError('invalid-request', 'Topic name must be one safe exact folder name without path separators or control characters.');
  }
  return name;
}

export function validateParaCategory(value, { allowArchive = true } = {}) {
  if (!paraCategories.includes(value) || (!allowArchive && value === 'archive')) throw sourceError('invalid-request', 'Unsupported PARA Category.');
  return value;
}

export function conventionalFolderPath(noteVaultRoot, paraCategory, name) {
  if (typeof noteVaultRoot !== 'string' || !path.isAbsolute(noteVaultRoot)) throw sourceError('capability-unavailable', 'A configured absolute noteVaultRoot is required before provisioning Topics.');
  const category = validateParaCategory(paraCategory);
  const exactName = validateTopicName(name);
  const root = path.resolve(noteVaultRoot);
  const result = path.resolve(root, PARA_DIRECTORY_NAMES[category], exactName);
  const relative = path.relative(root, result);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw sourceError('unsafe-path', 'The conventional Note Folder escaped noteVaultRoot.');
  return result;
}

export function conventionalSessionLabel(_topicId, name) {
  return validateTopicName(name);
}

function configuredRoots({ noteVaultRoot, noteVaultRoots } = {}) {
  const values = noteVaultRoots ?? (noteVaultRoot === undefined ? [] : [noteVaultRoot]);
  if (!Array.isArray(values) || values.length === 0) throw sourceError('capability-unavailable', 'At least one configured absolute Note root is required before provisioning Topics.');
  const roots = values.map((value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw sourceError('capability-unavailable', 'Every configured Note root must be absolute.');
    return path.resolve(value);
  });
  if (new Set(roots).size !== roots.length) throw sourceError('invalid-request', 'Configured Note roots must be unique.');
  return roots;
}

function safeCaseFold(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function selectedRoots(options) {
  const roots = configuredRoots(options);
  if (options.folderPath === undefined) return roots;
  const candidate = options.folderPath;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) throw sourceError('unsafe-path', 'An explicit Note Folder must be canonical and absolute.');
  const category = validateParaCategory(options.paraCategory);
  const selected = roots.filter(root => {
    const relative = path.relative(root, candidate);
    const parts = relative.split(path.sep);
    return !path.isAbsolute(relative) && parts.length === 2 && safeCaseFold(parts[0]) === safeCaseFold(PARA_DIRECTORY_NAMES[category]) && validateTopicName(parts[1]) === parts[1];
  });
  if (selected.length !== 1) throw sourceError('unsafe-path', 'The explicit Note Folder must belong to one configured PARA root.');
  return selected;
}

export function resolveProvisioningFolderPath(options) {
  const roots = selectedRoots(options);
  return options.folderPath ?? conventionalFolderPath(roots[0], options.paraCategory, options.name);
}

async function enrollCandidate(candidate, options) {
  if (options.assertCurrent === undefined) return enrollNoteFolderIdentity(candidate.path);
  options.assertCurrent();
  const witness = await inspectNoteFolderCandidate(candidate.path);
  return withBootstrapNoteFolder(candidate.path, { expectedDirectoryIdentity: witness.directoryIdentity,
    expectedIdentity: witness.markerIdentity, markerId: options.enrollmentOperationId, assertCurrent: options.assertCurrent }, held => held.identity);
}

function similarName(left, right) {
  return safeCaseFold(left) === safeCaseFold(right) || left.trim() === right.trim();
}

function ownedLocator(metadata, candidate) {
  const locator = (metadata?.listSourceLocators?.() ?? []).find((item) => item.locator === candidate);
  if (locator) {
    const reference = metadata?.getSourceReference?.(locator.referenceId);
    return { ...locator, topicId: reference?.topicId };
  }
  return (metadata?.listSourceReferences?.() ?? []).find((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder' && reference.externalSourceId === candidate);
}

export async function findConventionalFolder(options = {}) {
  const roots = selectedRoots(options);
  const candidates = [];
  for (const root of roots) {
    const exactPath = options.folderPath ?? conventionalFolderPath(root, options.paraCategory, options.name);
    const rootStat = await lstat(root).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw sourceError('capability-unavailable', 'Every configured Note root must be an existing real directory.');
    if (await realpath(root) !== root) throw sourceError('unsafe-path', 'A configured Note root cannot be a path alias.');
    const categoryPath = path.dirname(exactPath);
    const categoryName = path.basename(categoryPath);
    const rootEntries = await readdir(root, { withFileTypes: true });
    const similarCategories = rootEntries.filter((entry) => similarName(entry.name, categoryName));
    if (similarCategories.length > 1 || (similarCategories.length === 1 && similarCategories[0].name !== categoryName)) throw sourceError('conflict', 'A case- or Unicode-similar PARA directory prevents conservative creation or adoption.');
    const exactName = path.basename(exactPath);
    const categoryStat = await lstat(categoryPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (categoryStat && (!categoryStat.isDirectory() || categoryStat.isSymbolicLink())) throw sourceError('unsafe-path', 'The conventional PARA directory is not a real directory.');
    const entries = categoryStat ? await readdir(categoryPath, { withFileTypes: true }) : [];
    const similar = entries.filter((entry) => similarName(entry.name, exactName));
    if (similar.length > 1 || (similar.length === 1 && similar[0].name !== exactName)) throw sourceError('conflict', 'A case- or Unicode-similar Note Folder prevents conservative adoption.');
    const stat = await lstat(exactPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw sourceError('unsafe-path', 'The conventional Note Folder must be a real directory.');
    if (await realpath(exactPath) !== exactPath) throw sourceError('unsafe-path', 'The conventional Note Folder cannot be a path alias.');
    const owner = ownedLocator(options.metadata, exactPath);
    if (owner && owner.topicId !== options.topicId) throw sourceError('conflict', 'The exact conventional Note Folder is already owned by another Topic.');
    const revision = await readNoteFolderIdentity(exactPath).catch((error) => { if (error.code === 'source-recovery') return null; throw error; });
    candidates.push({ path: exactPath, exactName, status: 'existing', ownership: 'adopted', revision });
  }
  if (candidates.length > 1) throw sourceError('conflict', 'Multiple configured Note roots contain the exact conventional Note Folder.');
  if (candidates.length === 1) return Object.freeze(candidates[0]);
  const exactPath = options.folderPath ?? conventionalFolderPath(roots[0], options.paraCategory, options.name);
  return Object.freeze({ path: exactPath, exactName: path.basename(exactPath), status: 'missing', ownership: null });
}

export async function ensureConventionalFolder(options = {}) {
  if (!ownsNoteFilesystem(options.metadata)) return withNoteFilesystemOwner(options.metadata, () => ensureConventionalFolder(options));
  if (options.enrollmentOperationId && options.metadata?.prepareConditionalFolderCreation) return ensureConditionalFolder(options);
  const candidate = await findConventionalFolder(options);
  options.assertCurrent?.();
  if (candidate.status === 'existing') return Object.freeze({ ...candidate, revision: await enrollCandidate(candidate, options) });
  const categoryPath = path.dirname(candidate.path);
  await mkdir(categoryPath, { recursive: true, mode: 0o700 });
  const category = await open(categoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : null;
    if (!descriptorRoot) throw sourceError('capability-unavailable', 'Descriptor-anchored folder creation is unavailable.');
    options.assertCurrent?.();
    await mkdir(path.join(descriptorRoot, String(category.fd), path.basename(candidate.path)), { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await findConventionalFolder(options);
    return Object.freeze({ ...existing, revision: await enrollCandidate(existing, options) });
  } finally { await category.close(); }
  const stat = await lstat(candidate.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw sourceError('unsafe-path', 'The created Note Folder is not a real directory.');
  return Object.freeze({ ...candidate, status: 'created', ownership: 'created', revision: await enrollCandidate(candidate, options) });
}

async function ensureConditionalFolder(options) {
  const parentOperationId = options.enrollmentOperationId;
  const metadata = options.metadata;
  const check = options.assertCurrent;
  if (typeof check !== 'function') throw sourceError('provisioning-authority-unavailable', 'Conditional folder creation requires current authority.');
  const target = resolveProvisioningFolderPath(options);
  const receipt = metadata.getConditionalFolderCreation(parentOperationId);
  if (!receipt) {
    const candidate = await findConventionalFolder(options);
    check();
    if (candidate.status === 'existing') return Object.freeze({ ...candidate, revision: await enrollCandidate(candidate, options) });
    const stagePath = path.join(path.dirname(target), `.command-center-provisioning-${parentOperationId}-${randomUUID()}`);
    metadata.prepareConditionalFolderCreation({ parentOperationId, expectedTopicRevision: 0, stagePath }, check);
  }
  let current = metadata.getConditionalFolderCreation(parentOperationId);
  if (current.finalPath !== target || current.operationId !== parentOperationId) throw sourceError('source-recovery', 'The folder creation receipt does not match this operation.');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (current.phase === 'prepared') {
    if (await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)))
      throw sourceError('source-recovery', 'The reserved operation destination was claimed before publication.');
    const stageStat = await lstat(current.stagePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    // An unrecorded directory cannot be attributed to this operation after a crash.
    if (stageStat) throw sourceError('source-recovery', 'The unrecorded staging folder requires exact recovery.');
    check();
    await mkdir(current.stagePath, { mode: 0o700 });
    await enrollCandidate({ path: current.stagePath }, options);
    const witness = await inspectNoteFolderCandidate(current.stagePath);
    check();
    current = metadata.identifyConditionalFolderCreation({ parentOperationId, stagePath: current.stagePath,
      directoryIdentity: witness.directoryIdentity, markerIdentity: witness.markerIdentity }, check);
  }
  const exact = async (candidatePath) => {
    const witness = await inspectNoteFolderCandidate(candidatePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!witness || witness.directoryIdentity !== current.directoryIdentity || witness.markerIdentity !== current.markerIdentity)
      throw sourceError('source-recovery', 'The operation-created folder identity changed.');
    return witness;
  };
  const finalStat = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const stagedStat = await lstat(current.stagePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (finalStat && stagedStat) throw sourceError('source-recovery', 'Both staged and final folders exist for one operation.');
  if (finalStat) await exact(target);
  else {
    if (current.phase === 'published') throw sourceError('source-recovery', 'The published operation folder is missing.');
    await exact(current.stagePath);
    const stageStat = await lstat(current.stagePath, { bigint: true });
    const publishDurableDirectoryNoReplace = hostDirectoryPublisher ??
      (await import('openclaw/plugin-sdk/file-access-runtime')).publishDurableDirectoryNoReplace;
    if (typeof publishDurableDirectoryNoReplace !== 'function')
      throw sourceError('capability-unavailable', 'The native directory publication capability is unavailable.');
    check();
    publishDurableDirectoryNoReplace({ stagedDir: current.stagePath, targetDir: target,
      expectedIdentity: { dev: stageStat.dev, ino: stageStat.ino }, assertBeforeMutation: check });
    await exact(target);
  }
  if (current.phase !== 'published') current = metadata.publishConditionalFolderCreation({ parentOperationId,
    stagePath: current.stagePath, directoryIdentity: current.directoryIdentity, markerIdentity: current.markerIdentity }, check);
  check();
  return Object.freeze({ path: target, exactName: path.basename(target), status: 'created', ownership: 'created', revision: current.markerIdentity });
}

export function sourceConventionManaged(states, aspect) {
  return states?.find((state) => state.aspect === aspect)?.state === 'managed';
}

export const noteFolderPath = conventionalFolderPath;
export const resolveConventionalFolder = findConventionalFolder;
export const ensureNoteFolder = ensureConventionalFolder;
