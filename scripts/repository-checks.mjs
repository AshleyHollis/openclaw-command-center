import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDeclarativeMirror } from '../src/compatibility.mjs';
import { build, distRoot } from '../src/build.mjs';
import { scanRepositorySafety } from '../src/safety.mjs';
import { validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';
import { repositoryArtifactCheckPhases, runIndependentCheckPhases } from './check-phases.mjs';
import { checkMutationArchitecture } from './mutation-architecture.mjs';

export async function runRepositoryChecks({ purpose = 'qualification' } = {}) {
  if (!['qualification', 'capture-prerequisites'].includes(purpose)) throw new Error('Unsupported repository check purpose');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await checkMutationArchitecture(root);
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
  if (pluginManifest.id !== 'command-center' || pluginManifest.controlUi?.entry !== 'dist/native-ui/entry.mjs') throw new Error('Plugin identity or native entry drift');
  if (pluginManifest.activation?.onStartup !== true) throw new Error('Route-registering plugin must activate at Gateway startup');
  if (Object.keys(pluginManifest.controlUi).some((key) => !['entry', 'httpRoutes'].includes(key))) throw new Error('Native Control UI declaration contains unsupported fields');
  // These are the approved native transport boundaries, not arbitrary URLs or
  // legacy iframe grants. Backend admission independently intersects this list.
  const nativeHttpRoutes = [
    { path: '/plugins/command-center/api/topic-analysis', method: 'GET', maxRequestBytes: 0, maxResponseBytes: 262144 },
    { path: '/plugins/command-center/api/dashboard/actions', method: 'POST', maxRequestBytes: 32768, maxResponseBytes: 32768 },
    { path: '/plugins/command-center/api/topics/actions', method: 'POST', maxRequestBytes: 32768, maxResponseBytes: 32768 },
    { path: '/plugins/command-center/api/topic/actions', method: 'POST', maxRequestBytes: 12582912, maxResponseBytes: 32768 },
    { path: '/plugins/command-center/api/search/rebuild', method: 'POST', maxRequestBytes: 2048, maxResponseBytes: 4096 },
    { path: '/plugins/command-center/api/topic-analysis/actions', method: 'POST', maxRequestBytes: 65536, maxResponseBytes: 262144 }
  ];
  if (pluginManifest.controlUi.httpRoutes !== undefined && JSON.stringify(pluginManifest.controlUi.httpRoutes) !== JSON.stringify(nativeHttpRoutes)) throw new Error('Native Control UI HTTP route boundary drift');
  if (!Array.isArray(packageJson.openclaw?.extensions) || !packageJson.openclaw.extensions.includes('./dist/plugin.mjs')) throw new Error('OpenClaw extension discovery must name the built plugin entry');
  const pinnedPackageVersion = '2026.9.6';
  if (packageJson.peerDependencies?.openclaw !== pinnedPackageVersion || packageJson.devDependencies?.openclaw !== pinnedPackageVersion) throw new Error('OpenClaw host peer and development packages must be pinned exactly');
  if (packageJson.openclaw?.compat?.pluginApi !== '=2026.9.6') throw new Error('OpenClaw plugin API must match the current authenticated host exactly');
  if (packageLock.packages?.['']?.peerDependencies?.openclaw !== pinnedPackageVersion || packageLock.packages?.['']?.devDependencies?.openclaw !== pinnedPackageVersion || packageLock.packages?.['node_modules/openclaw']?.version !== pinnedPackageVersion) throw new Error('OpenClaw lockfile peer and development packages must match the pinned host package');
  if (packageLock.packages?.['node_modules/openclaw']?.dependencies?.['@openclaw/ai'] !== pinnedPackageVersion || packageLock.packages?.['node_modules/@openclaw/ai']?.version !== pinnedPackageVersion) throw new Error('OpenClaw lockfile dependency graph must match the stable host package');
  for (const [name, version] of Object.entries(packageLock.packages['node_modules/openclaw'].dependencies)) {
    const locked = packageLock.packages[`node_modules/${name}`] ?? packageLock.packages[`node_modules/openclaw/node_modules/${name}`];
    if (locked?.version !== version) throw new Error(`OpenClaw lockfile dependency ${name} does not match the stable host package`);
  }
  if (!pluginManifest.configSchema || typeof pluginManifest.configSchema !== 'object' || Array.isArray(pluginManifest.configSchema)) throw new Error('Plugin configSchema must be an object');
  const buildReceipt = await build();
  const phases = repositoryArtifactCheckPhases(purpose, {
    verifyBaseline: async () => {
      const baselineText = await readFile(path.join(root, 'test', 'fixtures', 'release-performance-baseline.native-workspace.v3.json'), 'utf8');
      const normalizedDigest = createHash('sha256').update(baselineText.replace(/\r\n/gu, '\n')).digest('hex');
      if (normalizedDigest !== '55d39b3694c49126f0d4ec74c0a00ad656fc6d32d48c5cc3a2b2eee8cc0fb8a8') throw new Error('Historical native performance baseline bytes changed');
      validateReleasePerformanceBaseline(JSON.parse(baselineText));
    },
    scanGenerated: async () => await scanRepositorySafety(root, {
      generated: [distRoot],
      // These exact immutable artifacts are copied from lockfile-pinned
      // browser packages and included in the sealed build receipt. Their
      // minified parser fixtures can resemble credentials to text heuristics.
      trustedContent: [
        path.join(distRoot, 'vendor', 'pdf.mjs'),
        path.join(distRoot, 'vendor', 'pdf.worker.mjs'),
        path.join(distRoot, 'native-ui', 'vendor', 'markdown-it.mjs'),
        path.join(distRoot, 'native-ui', 'vendor', 'purify.es.mjs'),
        path.join(distRoot, 'native-ui', 'vendor', 'pdf.mjs'),
        path.join(distRoot, 'native-ui', 'vendor', 'pdf.worker.mjs'),
        // This ESM resource map is generated solely from the same pinned
        // PDF.js package. Its binary CMaps/fonts can resemble credentials to
        // text heuristics; receipt, path and filesystem checks still apply.
        path.join(distRoot, 'native-ui', 'vendor', 'pdf-resources.mjs')
      ]
    })
  });
  await runIndependentCheckPhases(phases);
  return Object.freeze({ purpose, buildDigest: buildReceipt.digest, artifactChecks: Object.freeze(phases.map(phase => phase.id)) });
}
