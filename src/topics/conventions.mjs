import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { paraCategories } from '../metadata/schema.mjs';
import { sourceError } from '../sources/errors.mjs';

export const PARA_DIRECTORY_NAMES = Object.freeze({ project: 'Projects', area: 'Areas', resource: 'Resources', archive: 'Archive' });
export const ACTIVE_PARA_CATEGORIES = Object.freeze(['project', 'area', 'resource']);

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
  const roots = configuredRoots(options);
  const candidates = [];
  for (const root of roots) {
    const exactPath = conventionalFolderPath(root, options.paraCategory, options.name);
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
    candidates.push({ path: exactPath, exactName, status: 'existing', ownership: 'adopted', revision: `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}` });
  }
  if (candidates.length > 1) throw sourceError('conflict', 'Multiple configured Note roots contain the exact conventional Note Folder.');
  if (candidates.length === 1) return Object.freeze(candidates[0]);
  const exactPath = conventionalFolderPath(roots[0], options.paraCategory, options.name);
  return Object.freeze({ path: exactPath, exactName: path.basename(exactPath), status: 'missing', ownership: null });
}

export async function ensureConventionalFolder(options = {}) {
  const candidate = await findConventionalFolder(options);
  if (candidate.status === 'existing') return candidate;
  const categoryPath = path.dirname(candidate.path);
  await mkdir(categoryPath, { recursive: true, mode: 0o700 });
  const category = await open(categoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : null;
    if (!descriptorRoot) throw sourceError('capability-unavailable', 'Descriptor-anchored folder creation is unavailable.');
    await mkdir(path.join(descriptorRoot, String(category.fd), path.basename(candidate.path)), { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return findConventionalFolder(options);
  } finally { await category.close(); }
  const stat = await lstat(candidate.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw sourceError('unsafe-path', 'The created Note Folder is not a real directory.');
  return Object.freeze({ ...candidate, status: 'created', ownership: 'created', revision: `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}` });
}

export function sourceConventionManaged(states, aspect) {
  return states?.find((state) => state.aspect === aspect)?.state === 'managed';
}

export const noteFolderPath = conventionalFolderPath;
export const resolveConventionalFolder = findConventionalFolder;
export const ensureNoteFolder = ensureConventionalFolder;
