import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDeclarativeMirror } from '../src/compatibility.mjs';
import { build, distRoot } from '../src/build.mjs';
import { scanRepositorySafety } from '../src/safety.mjs';
import { assertPerformanceBaselineBuildIdentity, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';
import { runIndependentCheckPhases } from './check-phases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
assertDeclarativeMirror(packageJson.commandCenter?.compatibilityTuple);
const runtimeSourceGraph = packageJson.commandCenter?.runtimeCapability?.sourceGraph;
if (packageJson.commandCenter?.runtimeCapability?.id !== 'openclaw-control-ui-v1' || runtimeSourceGraph !== './runtime-capability.source-graph.json') throw new Error('Control UI runtime capability source graph drift');
const graph = JSON.parse(await readFile(path.join(root, runtimeSourceGraph), 'utf8'));
if (graph.formatVersion !== 1 || graph.contract !== './src/runtime-capability.json' || !Array.isArray(graph.sources)) throw new Error('Control UI runtime capability source graph is unreadable');
for (const source of graph.sources) await readFile(path.join(root, source), 'utf8');
if (!(await readFile(path.join(root, graph.contract), 'utf8')).includes('pluginFrameGrants')) throw new Error('Control UI runtime capability source graph is unreadable');
if (JSON.stringify(packageLock.packages?.['']?.commandCenter) !== JSON.stringify(packageJson.commandCenter)) throw new Error('Lockfile Command Center metadata mirror drift');
const pluginManifest = JSON.parse(await readFile(path.join(root, 'openclaw.plugin.json'), 'utf8'));
if (pluginManifest.id !== 'command-center' || pluginManifest.controlUi?.routeId !== 'command-center') throw new Error('Plugin identity or route drift');
if (pluginManifest.activation?.onStartup !== true) throw new Error('Route-registering plugin must activate at Gateway startup');
if (pluginManifest.controlUi?.sandbox !== 'allow-scripts') throw new Error('Plugin must retain the scripts-only sandbox');
if (!Array.isArray(packageJson.openclaw?.extensions) || !packageJson.openclaw.extensions.includes('./dist/plugin.mjs')) throw new Error('OpenClaw extension discovery must name the built plugin entry');
const pinnedPackageVersion = '2026.8.2';
if (packageJson.dependencies?.openclaw !== pinnedPackageVersion) throw new Error('OpenClaw host package must be pinned exactly');
if (packageJson.openclaw?.compat?.pluginApi !== '=2026.8.2') throw new Error('OpenClaw plugin API must match the current authenticated host exactly');
if (packageLock.packages?.['']?.dependencies?.openclaw !== pinnedPackageVersion || packageLock.packages?.['node_modules/openclaw']?.version !== pinnedPackageVersion) throw new Error('OpenClaw lockfile package must match the pinned host package');
if (packageLock.packages?.['node_modules/openclaw']?.dependencies?.['@openclaw/ai'] !== pinnedPackageVersion || packageLock.packages?.['node_modules/@openclaw/ai']?.version !== pinnedPackageVersion) throw new Error('OpenClaw lockfile dependency graph must match the stable host package');
for (const [name, version] of Object.entries(packageLock.packages['node_modules/openclaw'].dependencies)) if (packageLock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`OpenClaw lockfile dependency ${name} does not match the stable host package`);
if (!pluginManifest.configSchema || typeof pluginManifest.configSchema !== 'object' || Array.isArray(pluginManifest.configSchema)) throw new Error('Plugin configSchema must be an object');
const buildReceipt = await build();
await runIndependentCheckPhases([
  { id: 'performance-baseline', run: async () => {
    const performanceBaseline = validateReleasePerformanceBaseline(JSON.parse(await readFile(path.join(root, 'test', 'fixtures', 'release-performance-baseline.v1.json'), 'utf8')));
    assertPerformanceBaselineBuildIdentity(performanceBaseline, `sha256:${buildReceipt.digest}`);
  } },
  { id: 'generated-artifact-safety', run: async () => await scanRepositorySafety(root, { generated: [distRoot] }) }
]);
process.stdout.write('Command Center checks passed\n');
