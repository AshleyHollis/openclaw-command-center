const SNAPSHOT_LIMIT = 100;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Plugin HTTP routes can become reachable just before OpenClaw starts the
 * registered service. Keep the first authenticated shell request attached to
 * that same startup instead of permanently rendering the host's error page.
 */
export async function loadInitialTopicDestination(service, { attempts = 20, delay = () => wait(100) } = {}) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await service.topics.listDestinationPageVerified({ cursor: 0, limit: SNAPSHOT_LIMIT });
    } catch (error) {
      failure = error;
      if (!/Topic service is not ready/u.test(String(error?.message ?? error)) || attempt === attempts - 1) throw error;
      await delay();
    }
  }
  throw failure;
}

function publicDiagnostic(value = {}) {
  return {
    topicId: value.topicId,
    referenceId: value.referenceId,
    sourceKind: value.sourceKind,
    expectedIdentity: value.expectedIdentity,
    check: value.check,
    status: value.status,
    retryable: value.retryable === true
  };
}

function publicRecovery(value = {}) {
  return {
    recoveryId: value.recoveryId,
    topicId: value.topicId,
    referenceId: value.referenceId,
    sourceKind: value.sourceKind,
    state: value.state,
    diagnostics: (Array.isArray(value.diagnostics) ? value.diagnostics : []).slice(0, 2).map(publicDiagnostic),
    expectedRevision: value.expectedRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function publicTopic(value = {}) {
  return {
    topicId: value.topicId,
    name: value.name,
    revision: value.revision,
    paraCategory: value.paraCategory,
    lifecycle: value.lifecycle,
    health: value.health,
    usable: value.usable === true,
    recovery: (Array.isArray(value.recovery) ? value.recovery : []).slice(0, 4).map(publicRecovery),
    ...(value.provisioningOperationId ? { provisioningOperationId: value.provisioningOperationId } : {})
  };
}

export function publicTopicDestination(value = {}) {
  let remaining = SNAPSHOT_LIMIT;
  const take = (items) => {
    const selected = (Array.isArray(items) ? items : []).slice(0, remaining).map(publicTopic);
    remaining -= selected.length;
    return selected;
  };
  return {
    activeGroups: {
      project: take(value.activeGroups?.project ?? value.groups?.project),
      area: take(value.activeGroups?.area ?? value.groups?.area),
      resource: take(value.activeGroups?.resource ?? value.groups?.resource)
    },
    provisioning: take(value.provisioning),
    recovery: take(value.recovery),
    archived: take(value.archived),
    retired: take(value.retired),
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null
  };
}

export function encodeInitialTopicSnapshot(destination) {
  const json = JSON.stringify({ schemaVersion: 1, status: 'applied', result: publicTopicDestination(destination) });
  return json.replaceAll('&', '\\u0026').replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function injectInitialTopicSnapshot(html, destination) {
  if (typeof html !== 'string' || !html.includes('</head>') || html.includes('command-center-initial-topics')) throw new Error('Command Center shell is not injectable.');
  const script = `<script id="command-center-initial-topics" type="application/json">${encodeInitialTopicSnapshot(destination)}</script>`;
  return html.replace('</head>', `${script}</head>`);
}

export function inlineShellAssets(html, { styles, app }) {
  if (typeof styles !== 'string' || typeof app !== 'string') throw new TypeError('Verified shell assets are required.');
  const safeStyles = styles.replaceAll('</style', '<\\/style');
  const safeApp = app.replaceAll('</script', '<\\/script');
  const withStyles = html.replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${safeStyles}</style>`);
  const result = withStyles.replace('<script defer src="/plugins/command-center/app.js"></script>', `<script>${safeApp}</script>`);
  if (result === html || result.includes('href="/plugins/command-center/styles.css"') || result.includes('src="/plugins/command-center/app.js"')) throw new Error('Command Center shell assets were not inlined.');
  return result;
}
