import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { descriptorEnvironment, parseHostDescriptor, verifyHost } from '../src/host-harness.mjs';

const sdkEnvironment = 'COMMAND_CENTER_TEST_SQLITE_RUNTIME';
const loader = new URL('../test/fixtures/note-runtime-loader.mjs', import.meta.url).href;

// Test-only resolution. The controller owns fixture preparation; this launcher
// verifies its existing receipt once, then children use the real public SDK.
export async function prepareTestRuntimeEnvironment(environment = process.env, verificationOptions) {
  const result = { ...environment };
  if (environment[descriptorEnvironment]) {
    const host = await verifyHost(parseHostDescriptor(environment[descriptorEnvironment]), verificationOptions);
    const manifest = JSON.parse(await readFile(path.join(host.checkout, 'package.json'), 'utf8'));
    const entry = manifest.exports?.['./plugin-sdk/sqlite-runtime'];
    // The pinned host declares a default export, not a conditional resolver.
    // Inspect its lexical path before Node follows links or existing test hooks.
    const exported = typeof entry === 'string' ? entry
      : entry && !Array.isArray(entry) && Object.keys(entry).every(key => ['default', 'types'].includes(key)) ? entry.default : null;
    if (typeof exported !== 'string' || !exported.startsWith('./')) throw new Error('Test SDK requires the pinned public default export.');
    const target = path.resolve(host.checkout, exported);
    const relative = path.relative(host.checkout, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Test SDK export escapes the verified host.');
    let current = host.checkout;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Test SDK export contains a symlink.');
    }
    if (!(await lstat(target)).isFile() || await realpath(target) !== target) throw new Error('Test SDK export is not a regular verified host file.');
    const url = pathToFileURL(target).href;
    if (environment[sdkEnvironment] && environment[sdkEnvironment] !== url) throw new Error('Test SDK override conflicts with the verified host.');
    result[sdkEnvironment] = url;
  }
  if (result[sdkEnvironment]) result.NODE_OPTIONS = [result.NODE_OPTIONS, `--import=${loader}`].filter(Boolean).join(' ');
  return result;
}
