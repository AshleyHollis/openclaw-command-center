// Closed vocabulary for private candidate smoke diagnostics. Never include exception data.
const stages = new Set(['input', 'initial-host-launch', 'initial-readiness', 'plugin-read',
  'notification-setup', 'machine-ingress', 'attention-check', 'installed-world-setup',
  'installed-live-launch', 'installed-dev-launch', 'installed-session', 'installed-producer',
  'installed-attention', 'installed-handoff', 'installed-browser', 'browser-preflight',
  'browser-launch', 'browser-managed-ready', 'browser-page-ready',
  'browser-first-navigation', 'browser-attention-link', 'browser-unauthenticated',
  'browser-authenticated-chat', 'browser-stale', 'browser-resolve', 'installed-resolution',
  'host-restart', 'restart-readiness', 'clear-check', 'final-checks', 'cleanup']);

export function createCandidateSmokeStages(write) {
  let current = 'input';
  let failed;
  const emit = (event, stage) => write(JSON.stringify({ kind: 'candidate-smoke-stage', event, stage }) + '\n');
  return {
    stage(value) {
      current = stages.has(value) ? value : 'input';
      emit('start', current);
    },
    failure() {
      if (!failed) { failed = current; emit('failure', failed); }
    },
    cleanupFailure() { emit('cleanup-failure', 'cleanup'); }
  };
}

// Run every cleanup even after one fails; the original journey error takes precedence.
export async function runCandidateSmokeCleanup(tasks, primaryFailed, report) {
  let cleanupFailure;
  let cleanupFailed = false;
  report.stage('cleanup');
  for (const task of tasks) {
    try { await task(); }
    catch (error) {
      report.cleanupFailure();
      if (!cleanupFailed) { cleanupFailure = error; cleanupFailed = true; }
    }
  }
  if (!primaryFailed && cleanupFailed) throw cleanupFailure;
}
