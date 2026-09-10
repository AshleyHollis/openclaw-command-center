import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { copyBuiltPluginForNativeCli } from './native-cli-plugin.mjs';

assert.equal(process.platform, 'linux');
const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
assert.ok(stateDir && process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
const pluginRoot = await copyBuiltPluginForNativeCli(stateDir);
const configPath = path.join(stateDir, 'openclaw.json');
await writeFile(configPath, JSON.stringify({ agents: { defaults: { workspace: path.join(stateDir, 'workspace') } },
  plugins: { allow: ['command-center'], load: { paths: [pluginRoot] }, entries: { 'command-center': { enabled: true } } }
}));
const launcher = path.join(path.dirname(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE), 'openclaw.mjs');
const { stdout } = await promisify(execFile)(process.execPath, [launcher, 'plugins', 'list', '--json'], {
  cwd: stateDir, timeout: 150_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  env: { ...process.env, OPENCLAW_HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: '1', NODE_DISABLE_COMPILE_CACHE: '1' }
});
const report = JSON.parse(stdout);
console.log(JSON.stringify({ entryMode: ((await stat(path.join(pluginRoot, 'dist/plugin.mjs'))).mode & 0o777).toString(8),
  plugin: report.plugins?.find(plugin => plugin.id === 'command-center'), diagnostics: report.diagnostics?.filter(row => row.pluginId === 'command-center') }));
assert.ok(report.plugins?.some(plugin => plugin.id === 'command-center' && plugin.status !== 'error'), 'native CLI must discover the built plugin');
