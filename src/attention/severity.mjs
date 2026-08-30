import { ATTENTION_SEVERITIES } from './contracts.mjs';

const ranks = Object.freeze({ Routine: 0, High: 1, Critical: 2 });
const criticalFacts = new Set(['active-data-loss', 'active-security-exposure', 'confirmed-integrity-failure', 'unrecoverable-state', 'ambiguous-application', 'partial-application']);
const highFacts = new Set(['blocked-work', 'failed-operation', 'degraded-service', 'total-service-outage', 'unavailable-service', 'breached-deadline']);

function factNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const facts = Array.isArray(value.facts) ? value.facts : Object.entries(value).filter(([, present]) => present === true).map(([name]) => name);
  return facts.filter((fact) => typeof fact === 'string');
}

export function deriveSeverity(evidenceFacts = {}, { verified = true } = {}) {
  if (!verified) return 'Routine';
  const facts = factNames(evidenceFacts);
  if (facts.some((fact) => criticalFacts.has(fact))) return 'Critical';
  if (facts.some((fact) => highFacts.has(fact))) return 'High';
  return 'Routine';
}

export function maxSeverity(left, right) {
  return ranks[right] > ranks[left] ? right : left;
}

export function severityRank(value) {
  if (!Object.hasOwn(ranks, value)) throw new TypeError(`Unknown severity ${value}`);
  return ranks[value];
}

export function isHigherSeverity(left, right) {
  return severityRank(left) > severityRank(right);
}

export { ATTENTION_SEVERITIES };
