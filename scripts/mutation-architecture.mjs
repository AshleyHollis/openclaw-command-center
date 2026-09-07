import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WRITE_METHODS } from '../src/bridge/contracts.mjs';

const prefix = 'command-center.v1.';
const transport = (file) => /^src\/(?:native-ui|ui|bridge)\//u.test(file) || /^src\/.*(?:http|http-route)\.mjs$/u.test(file);

/** Architecture guardrail, not a JavaScript security sandbox or proof of atomicity. */
export function auditMutationArchitecture({ files, writeMethods, owners, httpSurfaces = [], nativeWriteRoutes = [], httpCommands = [] }) {
  const errors = [];
  const commands = new Map();
  const modules = new Set();
  for (const owner of owners) {
    if (!owner.id || !files.has(owner.module)) errors.push(`missing owner module: ${owner.id}`);
    modules.add(owner.module);
    if (!Array.isArray(owner.tests) || !owner.tests.length) errors.push(`missing regression inventory: ${owner.id}`);
    for (const file of owner.tests ?? []) if (!files.has(file)) errors.push(`missing regression: ${owner.id}: ${file}`);
    for (const command of owner.commands ?? []) {
      const method = `${prefix}${command}`;
      if (commands.has(method)) errors.push(`multiple owners: ${method}`);
      commands.set(method, owner.id);
    }
  }
  for (const method of writeMethods) if (!commands.has(method)) errors.push(`unowned write: ${method}`);
  for (const method of commands.keys()) if (!writeMethods.includes(method)) errors.push(`unregistered catalogue command: ${method}`);
  const ownerIds = new Set(owners.map((owner) => owner.id));
  const httpKey = (route, action) => `${route}#${action}`;
  const actualHttp = new Set();
  const actualRoutes = new Set();
  for (const surface of httpSurfaces) {
    if (actualRoutes.has(surface.route)) errors.push(`multiple HTTP surfaces: ${surface.route}`);
    actualRoutes.add(surface.route);
    if (!files.has(surface.module)) errors.push(`missing HTTP module: ${surface.module}`);
    if (!nativeWriteRoutes.includes(surface.route)) errors.push(`undeclared HTTP write route: ${surface.route}`);
    for (const action of surface.actions) actualHttp.add(httpKey(surface.route, action));
  }
  for (const route of nativeWriteRoutes) if (!actualRoutes.has(route)) errors.push(`uninventoried HTTP write route: ${route}`);
  const documentedHttp = new Set();
  for (const command of httpCommands) {
    const key = httpKey(command.route, command.action);
    if (documentedHttp.has(key)) errors.push(`multiple HTTP owners: ${key}`);
    documentedHttp.add(key);
    if (!ownerIds.has(command.owner)) errors.push(`unknown HTTP owner: ${key}: ${command.owner}`);
    if (!['write', 'reconcile', 'prepare'].includes(command.mode)) errors.push(`invalid HTTP mode: ${key}`);
    if (!actualHttp.has(key)) errors.push(`unregistered HTTP action: ${key}`);
  }
  for (const key of actualHttp) if (!documentedHttp.has(key)) errors.push(`unowned HTTP action: ${key}`);
  for (const [file, source] of files) {
    if (!transport(file)) continue;
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (/^(?:node:)?(?:fs(?:\/promises)?|sqlite|child_process)$/u.test(specifier) || specifier === 'openclaw/plugin-sdk/sqlite-runtime') errors.push(`${file}: forbidden effect import ${specifier}`);
      const resolved = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier;
      if (modules.has(resolved) || resolved.startsWith('src/metadata/')) errors.push(`${file}: transport imports owning implementation ${resolved}`);
    }
    if (/\bmetadata\s*(?:\?\.|\.)\s*(?:create|update|set|save|record|delete|remove|begin|complete|apply|relocate)[A-Z]\w*/u.test(source)
      || /\bmetadata\s*(?:\?\.)?\[\s*['"](?:create|update|set|save|record|delete|remove|begin|complete|apply|relocate)[A-Z]\w*['"]\s*\]/u.test(source)) errors.push(`${file}: direct metadata mutation outside owning command`);
    // A route's action vocabulary may legitimately match native method names.
    // Reject literal dispatch arguments/envelopes, not comparisons or action keys.
    if (/(?:\b[\w$.]+\s*\(\s*|\bmethod\s*:\s*)['"](?:cron\.(?:add|update|remove|run)|sessions\.(?:create|patch|reset|delete)|chat\.send)['"]/u.test(source)) errors.push(`${file}: direct native mutation outside owning command`);
  }
  return errors;
}

export async function checkMutationArchitecture(root) {
  const directory = root instanceof URL ? fileURLToPath(root) : path.resolve(root);
  const files = new Map();
  async function collect(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile() && file.endsWith('.mjs')) files.set(file, await readFile(path.join(directory, file), 'utf8'));
    }
  }
  await collect('src'); await collect('test');
  const catalogue = JSON.parse(await readFile(path.join(directory, 'docs/architecture/mutation-owners.json'), 'utf8'));
  if (catalogue.schemaVersion !== 1 || !Array.isArray(catalogue.owners)) throw new Error('Invalid mutation owner catalogue.');
  const manifest = JSON.parse(await readFile(path.join(directory, 'openclaw.plugin.json'), 'utf8'));
  const nativeWriteRoutes = manifest.controlUi.httpRoutes.filter((route) => route.method !== 'GET').map((route) => route.path);
  const moduleAt = (relative) => import(pathToFileURL(path.join(directory, relative)).href);
  const [topics, page, analysis, dashboard, search] = await Promise.all([
    moduleAt('src/topics/http.mjs'), moduleAt('src/topics/page-http.mjs'), moduleAt('src/topics/analysis-http.mjs'),
    moduleAt('src/dashboard/http-route.mjs'), moduleAt('src/search/http-route.mjs')
  ]);
  // These are the validators' actual vocabularies, not a second handwritten list
  // of actions. $request names the whole-body Search command only in this audit.
  const httpSurfaces = [
    { route: '/plugins/command-center/api/topics/actions', module: 'src/topics/http.mjs', actions: Object.keys(topics.topicActions) },
    { route: '/plugins/command-center/api/topic/actions', module: 'src/topics/page-http.mjs', actions: Object.keys(page.topicPageActionFields) },
    { route: '/plugins/command-center/api/topic-analysis/actions', module: 'src/topics/analysis-http.mjs', actions: analysis.TOPIC_ANALYSIS_ACTIONS },
    { route: '/plugins/command-center/api/dashboard/actions', module: 'src/dashboard/http-route.mjs', actions: dashboard.dashboardActions },
    { route: search.searchRebuildRoute, module: 'src/search/http-route.mjs', actions: ['$request'] }
  ];
  const errors = auditMutationArchitecture({ files, writeMethods: WRITE_METHODS, owners: catalogue.owners, httpSurfaces, nativeWriteRoutes, httpCommands: catalogue.httpCommands });
  if (errors.length) throw new AggregateError(errors.map((error) => new Error(error)), errors.join('\n'));
  return { commands: WRITE_METHODS.length, owners: catalogue.owners.length, httpRoutes: httpSurfaces.length, httpActions: httpSurfaces.reduce((count, surface) => count + surface.actions.length, 0) };
}
