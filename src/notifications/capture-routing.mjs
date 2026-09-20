import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function routeCapturedChange(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('routing input must be an object');
  const allowed = ['schemaVersion', 'subjectId', 'kind', 'change', 'materialFacts', 'processingFailure', 'urgent', 'requiresAction', 'completed', 'dismissed'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || input.schemaVersion !== 1 || typeof input.subjectId !== 'string' || !input.subjectId.trim()) throw new TypeError('routing input is invalid');
  const materialDigest = digest(input.materialFacts ?? {});
  const terminal = input.completed === true || input.dismissed === true;
  const lane = input.processingFailure === true ? 'coverage-failure'
    : terminal ? 'activity'
      : input.requiresAction === true ? 'attention'
        : 'notes-activity';
  const outwardEligible = !terminal && (input.processingFailure === true || input.urgent === true && input.requiresAction === true);
  return Object.freeze({ schemaVersion: 1, subjectId: input.subjectId.trim(), lane, outwardEligible, materialDigest, deduplicationKey: `${input.subjectId.trim()}:${materialDigest}`, reason: input.processingFailure === true ? 'actionable-source-failure' : outwardEligible ? 'urgent-actionable-change' : terminal ? 'terminal-record' : input.requiresAction === true ? 'quiet-actionable-work' : 'routine-knowledge' });
}

export function createNotificationTestSink() {
  const seen = new Map(); const deliveries = [];
  return Object.freeze({
    capture(input) {
      const routed = routeCapturedChange(input);
      const previous = seen.get(routed.subjectId);
      seen.set(routed.subjectId, routed.materialDigest);
      if (routed.outwardEligible && previous !== routed.materialDigest) deliveries.push(routed);
      return Object.freeze({ ...routed, emitted: routed.outwardEligible && previous !== routed.materialDigest });
    },
    list() { return Object.freeze(deliveries.slice()); }
  });
}
