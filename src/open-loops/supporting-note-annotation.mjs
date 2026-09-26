import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const nonBlank = value => typeof value === 'string' && value.trim() !== '';

export function supportingNoteOperationId(decisionOperationId) {
  if (!nonBlank(decisionOperationId)) throw new TypeError('A decision operation ID is required.');
  const bytes = createHash('sha256').update(`${decisionOperationId}\u0000supporting-note-edit`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decisionDescription(observation) {
  const facts = observation?.facts;
  if (facts?.operationKind === 'payment-status') {
    if (!nonBlank(facts.paymentState)) throw new TypeError('A payment decision requires its recorded state.');
    return `Payment status: ${facts.paymentState} (your assertion; Command Center made no payment).`;
  }
  switch (facts?.decision) {
    case 'confirm': return 'Obligation confirmed.';
    case 'defer': return `Review deferred until ${facts.reviewAt}.`;
    case 'correct-date': return `Accepted due date corrected to ${facts.dueAt ?? `${facts.dueDate} (${facts.dueTimeZone})`}.`;
    case 'dismiss': return 'Suggestion dismissed.';
    case 'resolve': return 'Item marked resolved.';
    default: throw new TypeError('The exact recorded decision is unavailable.');
  }
}

// This pure transformation never reads or writes a Note. The caller must use
// the saved target's exact revision with the authoritative Note owner, and
// must durably retain these desired bytes before dispatching that write.
export function prepareSupportingNoteAnnotation({ text, loopId, observation } = {}) {
  if (typeof text !== 'string' || !nonBlank(loopId) || !nonBlank(observation?.observationId)
    || !nonBlank(observation?.facts?.rationale) || !nonBlank(observation?.occurredAt)) {
    throw new TypeError('A supporting Note annotation requires exact Note text and decision evidence.');
  }
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const markerId = hash(loopId).slice(0, 24);
  const markerPrefix = `<!-- command-center:open-loop:${markerId}:sha256:`;
  const endMarker = `<!-- /command-center:open-loop:${markerId} -->`;
  const rationale = observation.facts.rationale.replace(/\r\n?/gu, '\n').split('\n').map(line => `> ${line}`).join(lineEnding);
  const body = [decisionDescription(observation), `Recorded ${observation.occurredAt}.`, 'Reason:', rationale, ''].join(lineEnding);
  const startMarker = `${markerPrefix}${hash(body)} -->`;
  const block = `${startMarker}${lineEnding}${body}${endMarker}`;
  const starts = [...text.matchAll(new RegExp(`${markerPrefix}([a-f0-9]{64}) -->`, 'gu'))];
  const ends = [...text.matchAll(new RegExp(endMarker, 'gu'))];
  if (!starts.length && !ends.length) {
    const separator = text === '' ? '' : text.endsWith('\n') ? lineEnding : `${lineEnding}${lineEnding}`;
    return Object.freeze({ disposition: 'created', markerId, text: `${text}${separator}${block}${lineEnding}` });
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index <= starts[0].index) {
    throw new Error('The managed supporting Note block is missing or ambiguous.');
  }
  const oldBodyStart = starts[0].index + starts[0][0].length + lineEnding.length;
  if (text.slice(starts[0].index + starts[0][0].length, oldBodyStart) !== lineEnding) {
    throw new Error('The managed supporting Note block changed outside its recorded format.');
  }
  const oldBody = text.slice(oldBodyStart, ends[0].index);
  if (hash(oldBody) !== starts[0][1]) throw new Error('The managed supporting Note block was edited; preserve that edit for review.');
  const nextText = `${text.slice(0, starts[0].index)}${block}${text.slice(ends[0].index + endMarker.length)}`;
  return Object.freeze({ disposition: nextText === text ? 'unchanged' : 'updated', markerId, text: nextText });
}
