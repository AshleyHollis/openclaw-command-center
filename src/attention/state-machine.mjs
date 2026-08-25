import { ATTENTION_STATES } from './contracts.mjs';

const legal = Object.freeze({
  Active: Object.freeze(['Snoozed', 'Action running', 'Resolved', 'Withdrawn']),
  Snoozed: Object.freeze(['Active', 'Action running', 'Resolved', 'Withdrawn']),
  'Action running': Object.freeze(['Active', 'Snoozed', 'Resolved', 'Withdrawn']),
  Resolved: Object.freeze([]),
  Withdrawn: Object.freeze([])
});

export function canTransition(from, to) {
  return ATTENTION_STATES.includes(from) && legal[from].includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`Illegal Attention transition: ${from} -> ${to}`);
  return to;
}

export function legalTransitions(from) {
  if (!ATTENTION_STATES.includes(from)) throw new TypeError(`Unknown Attention state: ${from}`);
  return [...legal[from]];
}

export { legal as ATTENTION_TRANSITIONS };
