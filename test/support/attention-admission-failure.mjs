import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { boundedHostEvidence, withDeadline } from './real-host-runtime.mjs';

// One failure observation, before disposable state is removed. These readers
// perform no mutation or retry, and no source body, binding row or credential
// is retained. Unknown observations remain unknown.
export async function captureAttentionAdmissionFailure({ readBinding, readNativeCards, diagnostics }) {
  const result = { schemaVersion: 1, bindingPresent: null, bindingCardIdPresent: null, nativeRead: 'unknown', correlatedCardCount: null, correlatedStatuses: [] };
  let binding;
  try {
    binding = await readBinding();
    result.bindingPresent = Boolean(binding);
    result.bindingCardIdPresent = binding ? Boolean(binding.cardId) : null;
  } catch { result.bindingObservation = 'unavailable'; }
  try {
    const cards = await readNativeCards();
    if (!Array.isArray(cards)) throw new Error('Native read omitted cards.');
    result.nativeRead = 'available';
    if (binding?.createIntent?.idempotencyKey) {
      const matches = cards.filter(card => card.metadata?.automation?.tenant === binding.tenantId
        && (card.metadata.automation.boardId ?? 'default') === binding.boardId
        && card.metadata.automation.idempotencyKey === binding.createIntent.idempotencyKey);
      result.correlatedCardCount = matches.length;
      result.correlatedStatuses = matches.slice(0, 5).map(card => ['triage', 'backlog', 'todo', 'ready', 'scheduled', 'running', 'review', 'blocked', 'done'].includes(card.status) ? card.status : 'unknown');
    }
  } catch { result.nativeRead = 'unavailable'; }
  result.phase = result.bindingPresent === false ? 'before-binding-reservation'
    : result.bindingCardIdPresent === true ? 'after-binding-settlement'
      : result.correlatedCardCount > 0 ? 'native-card-observed-before-binding-settlement'
        : result.bindingPresent === true ? 'binding-reserved-native-effect-unconfirmed' : 'unknown';
  result.host = boundedHostEvidence(diagnostics);
  return result;
}

export async function persistAttentionAdmissionFailure({ observation, diagnostics, outputDrained, evidenceDirectory }) {
  let hostOutputComplete = false;
  try {
    if (typeof outputDrained?.then !== 'function') throw new Error('Host drain evidence unavailable.');
    await withDeadline('Attention failure host output drain', () => outputDrained, 2_000);
    hostOutputComplete = true;
  } catch { /* Preserve the original rejection and honestly mark partial output. */ }
  const result = { ...observation, hostOutputComplete, host: boundedHostEvidence(diagnostics) };
  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(path.join(evidenceDirectory, 'attention-admission-failure.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  }
  return result;
}
