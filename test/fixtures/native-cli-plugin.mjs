import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { readBuiltReceipt } from '../../src/build.mjs';

export function parseNativeCliSummary(outputs, expectedPlanDigest) {
  const lines = outputs.flatMap(output => stripVTControlCharacters(output).split('\n'))
    .filter(line => line.includes(`"planDigest":"${expectedPlanDigest}"`));
  assert.equal(lines.length, 1, 'native CLI must report exactly one matching plan result');
  return JSON.parse(lines[0].slice(lines[0].indexOf('{')));
}

export async function copyBuiltPluginForNativeCli(stateDir) {
  assert.equal(process.platform, 'linux');
  const pluginRoot = path.join(stateDir, 'candidate-plugin');
  const receipt = await readBuiltReceipt();
  await mkdir(pluginRoot);
  for (const name of ['package.json', 'openclaw.plugin.json', 'dist']) {
    await cp(fileURLToPath(new URL(`../../${name}`, import.meta.url)), path.join(pluginRoot, name), { recursive: true });
  }
  // fs.cp retains /mnt/c's synthetic 0777 modes. Materialize ordinary Linux
  // package modes only on this owned copy; never relax discovery or chmod the
  // authoritative source/host checkout. This is not a prepared release package.
  async function secure(filename) {
    const entry = await lstat(filename);
    assert.equal(entry.isSymbolicLink(), false);
    assert.ok(entry.isFile() || entry.isDirectory());
    await chmod(filename, entry.isDirectory() ? 0o755 : 0o644);
    if (entry.isDirectory()) for (const name of await readdir(filename)) await secure(path.join(filename, name));
  }
  await secure(pluginRoot);
  assert.deepEqual(await readBuiltReceipt(), receipt);
  return pluginRoot;
}
