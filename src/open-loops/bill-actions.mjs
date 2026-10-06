import { validatedOutlookWebLink } from '../native-ui/outlook-web-link.mjs';
import { resolvePaymentPredecessor } from './payment-identity.mjs';
import { billActionDigest } from '../metadata/bill-actions.mjs';
import { loadIntakeSourceAccount } from './intake-accounting.mjs';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';
import { sourceError } from '../sources/errors.mjs';

const fail = (code, message) => { throw sourceError(code, message); };
const text = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.length > 1000) fail('invalid-request', `${name} is invalid.`); return value; };
function envelope(input, fields) {
  if (!input || input.schemaVersion !== 1 || Object.keys(input).some(key => !['schemaVersion', 'loopId', ...fields].includes(key))) fail('invalid-request', 'Bill action request has unsupported fields.');
  text(input.loopId, 'loopId');
  if (fields.includes('logicalOperationId')) assertLogicalOperationId(input.logicalOperationId);
}

export function createBillActionAdapter({ metadata, nativeRequest, authorize, readEvidence, now = () => new Date().toISOString() }) {
  if (![nativeRequest, authorize, readEvidence].every(value => typeof value === 'function') || !metadata?.reserveBillActionBinding) throw new TypeError('Bill actions require their durable metadata, authenticated native transport and current evidence owner.');
  const publicationSnapshots = new WeakMap(), predecessorSnapshots = new WeakMap();
  function authority(loopId, write = false) {
    const value = authorize({ loopId, write });
    if (value?.then || write && (typeof value?.principalId !== 'string' || !value.principalId.trim())) fail('unauthenticated', 'Bill authority must be synchronous and attest the operator.');
    return value?.principalId;
  }
  function admitted(loopId) {
    const loop = metadata.getOpenLoop(loopId);
    if (!loop || loop.kind !== 'payment' || loop.state !== 'confirmed') fail('unavailable', 'The accepted explicit email payment action is unavailable.');
    const candidates = loop.evidenceObservationIds.map(id => metadata.getOpenLoopObservation(id)).filter(observation => observation?.source.system === 'command-center-capture' && observation.source.kind === 'email' && !observation.historicalBaseline && observation.facts.provenance === 'explicit' && observation.facts.obligationKind === 'payment');
    if (!candidates.length) fail('unavailable', 'Exact admitted email evidence is unavailable.');
    const accepted = candidates.map(observation => {
      const account = loadIntakeSourceAccount(metadata, { sourceKind: 'email', sourceExternalId: observation.source.externalId, sourceVersion: observation.facts.sourceVersion });
      const obligation = account?.plan.acceptedExtraction.obligations.find(item => item.obligationId === observation.facts.obligationId);
      const outcome = account?.account.outcomes.find(item => item.outcomeId === observation.facts.obligationId);
      if (obligation?.paymentIdentity !== undefined || observation.facts.paymentIdentity !== undefined) {
        if (billActionDigest(obligation?.paymentIdentity ?? null) !== billActionDigest(observation.facts.paymentIdentity ?? null)) fail('conflict', 'Accepted payment identity does not match its captured evidence.');
      }
      return obligation?.classification === 'obligation' && obligation.obligationKind === 'payment' && obligation.provenance === 'explicit' && outcome?.status === 'applied' && outcome.loopId === loopId ? { observation, obligation } : null;
    }).filter(Boolean);
    if (!accepted.length) fail('unavailable', 'A durable accepted email outcome is required.');
    const keys = new Set(accepted.map(({ observation }) => observation.facts.correlationId ? JSON.stringify([observation.facts.correlationNamespace, observation.facts.correlationId]) : JSON.stringify([observation.source.externalId, observation.facts.obligationId])));
    if (keys.size !== 1) fail('conflict', 'Ambiguous action correlation requires review.');
    const selected = accepted.sort((a, b) => Date.parse(b.observation.observedAt) - Date.parse(a.observation.observedAt))[0];
    const facts = selected.observation.facts, reference = metadata.getSourceReference(facts.sourceReferenceId ?? '');
    if (!facts.sourceReferenceId || !facts.sourcePath || !facts.sourceReferenceVersion || reference?.topicId !== loop.topicId || reference.sourceKind !== 'note' || reference.observedRevision !== facts.sourceReferenceVersion) fail('unavailable', 'The exact accepted retained Note binding is unavailable.');
    return { loop, ...selected, semanticKey: [...keys][0] };
  }
  function commitFence(value, write) {
    const authorityValue = authorize({ loopId: value.loop.loopId, write, observation: value.observation });
    if (authorityValue?.then || authorityValue?.principalId !== value.principalId) fail('unauthenticated', 'The original bill operator authority changed.');
    if (value.admissionPredecessor) predecessorFence(value.admissionPredecessor, value);
    const latest = admitted(value.loop.loopId);
    if (latest.loop.revision !== value.loop.revision || latest.observation.observationId !== value.observation.observationId) fail('conflict', 'The accepted action evidence changed during the request.');
  }
  async function current(loopId, write = false) {
    const principalId = authority(loopId, write);
    const value = admitted(loopId);
    const evidence = await readEvidence(value);
    authority(loopId, write);
    const latest = admitted(loopId);
    if (latest.loop.revision !== value.loop.revision || latest.observation.observationId !== value.observation.observationId || !evidence?.available || evidence.topicId !== latest.loop.topicId) fail('unavailable', 'Current authorized exact evidence is unavailable.');
    return { ...latest, evidence, principalId };
  }
  function bindingFor(value) {
    const exact = metadata.getBillActionBinding(value.loop.loopId);
    const matching = metadata.listBillActionBindings().filter(item => item.semanticKey === value.semanticKey);
    if (matching.length > 1 || exact && matching[0]?.actionId !== exact.actionId) fail('conflict', 'Ambiguous native binding requires review.');
    if (!exact && matching.length) fail('conflict', 'Another legacy action owns this correlation; explicit identity review is required.');
    // Topic changes resolve the persisted semantic binding, never create anew.
    const binding = exact ?? matching[0] ?? null;
    if (binding && binding.meaningDigest !== meaning(value)) fail('conflict', 'The accepted bill meaning changed and requires review.');
    return binding;
  }
  function meaning(value) {
    const fields = ['amount', 'currency', 'payee', 'purpose', 'invoiceId', 'accountId', 'dueAt', 'dueDate', 'dueTimeZone'];
    const legacy = Object.fromEntries(fields.filter(key => value.obligation[key] !== undefined || value.observation.facts[key] !== undefined).map(key => [key, value.obligation[key] ?? value.observation.facts[key]]));
    return billActionDigest({ ...legacy, ...(value.obligation.paymentIdentity === undefined ? {} : { paymentIdentity: value.obligation.paymentIdentity }) });
  }
  function predecessorFence(predecessor, value) {
    const relation = value.obligation.paymentIdentity.predecessor;
    const fresh = resolvePaymentPredecessor({ metadata, loadAccount: loadIntakeSourceAccount, relation, actionLoopId: value.loop.loopId, semanticKey: value.semanticKey });
    const auth = authorize({ loopId: fresh.loop.loopId, write: false, observation: fresh.observation });
    if (auth?.then || auth?.principalId !== value.principalId || fresh.loop.revision !== predecessor.loop.revision) fail('unavailable', 'Original predecessor evidence or authority changed.');
  }
  function sourceCurrent(value, evidence) {
    if (evidence?.source?.kind !== 'outlook') return evidence.source;
    const locator = metadata.getEmailReaderLocator(value.observation.source.externalId, value.observation.facts.sourceVersion);
    let url;
    try { url = locator?.status === 'available' ? validatedOutlookWebLink(locator.webLink) : null; } catch { /* Refuse a replaced exact destination. */ }
    if (url === evidence.source.url) return evidence.source;
    if (evidence.retainedNote?.kind === 'note') return evidence.retainedNote;
    fail('unavailable', 'The exact source destination changed during publication.');
  }
  async function currentPredecessor(value) {
    const relation = value.obligation.paymentIdentity?.predecessor;
    if (!relation) return null;
    const predecessor = resolvePaymentPredecessor({ metadata, loadAccount: loadIntakeSourceAccount, relation, actionLoopId: value.loop.loopId, semanticKey: value.semanticKey });
    predecessorFence(predecessor, value);
    const evidence = await readEvidence(predecessor);
    predecessorFence(predecessor, value);
    if (!evidence?.available || evidence.topicId !== predecessor.loop.topicId) fail('unavailable', 'Exact predecessor evidence is unavailable.');
    return { ...predecessor, evidence };
  }
  async function projectPredecessor(value) {
    if (!value.obligation.paymentIdentity?.predecessor) return undefined;
    try {
      const predecessor = await currentPredecessor(value);
      const binding = metadata.getBillActionBinding(predecessor.loop.loopId);
      let native = { availability: 'unavailable' };
      if (binding?.cardId) {
        try { const card = await cardFor(predecessor.loop.loopId, binding); native = { availability: 'available', status: card.status, updatedAt: card.updatedAt }; }
        catch { /* Native unavailability never manufactures copied status. */ }
      }
      const evidence = await readEvidence(predecessor);
      predecessorFence(predecessor, value);
      if (!evidence?.available || evidence.topicId !== predecessor.loop.topicId) return undefined;
      const row = { ...value.obligation.paymentIdentity.predecessor, title: predecessor.obligation.title, source: sourceCurrent(predecessor, evidence), native };
      predecessorSnapshots.set(row, predecessor);
      return row;
    } catch { return undefined; }
  }
  async function cardFor(loopId, binding, write = false) {
    authority(loopId, write);
    const result = await nativeRequest('workboard.cards.list', { boardId: binding.boardId });
    authority(loopId, write);
    if (!Array.isArray(result?.cards)) fail('unavailable', 'Native Workboard read is unavailable.');
    const matches = result.cards.filter(card => card.id === binding.cardId);
    if (matches.length !== 1) fail('unavailable', 'The exact native card is unavailable.');
    const card = matches[0], automation = card.metadata?.automation;
    if (automation?.tenant !== binding.tenantId || (automation.boardId ?? 'default') !== binding.boardId || automation.idempotencyKey !== binding.createIntent.idempotencyKey || !Number.isFinite(card.updatedAt)) fail('conflict', 'Native tenant, board or action correlation changed.');
    return card;
  }
  async function read({ loopId }) {
    const value = await current(loopId), binding = bindingFor(value);
    if (!binding?.cardId) {
      const row = { schemaVersion: 1, loopId, title: value.obligation.title, topicId: value.loop.topicId, availability: 'unavailable', outcome: 'unavailable', source: value.evidence.source, reason: 'Native action is not admitted.' };
      publicationSnapshots.set(row, { value, binding });
      return row;
    }
    const card = await cardFor(loopId, binding);
    await current(loopId);
    commitFence(value, false);
    const freshBinding = metadata.getBillActionBinding(binding.actionId);
    if (freshBinding.eligibilityRevision !== binding.eligibilityRevision) fail('conflict', 'Later eligibility changed during the read.');
    authority(loopId);
    let predecessor = await projectPredecessor(value);
    const finalCurrent = await current(loopId);
    commitFence(value, false);
    const source = sourceCurrent(value, finalCurrent.evidence);
    if (predecessor) {
      try {
        const original = predecessorSnapshots.get(predecessor);
        predecessorFence(original, value);
        predecessor.source = sourceCurrent(original, { source: predecessor.source });
      } catch { predecessor = undefined; }
    }
    if (metadata.getBillActionBinding(binding.actionId)?.eligibilityRevision !== binding.eligibilityRevision) fail('conflict', 'Later eligibility changed during predecessor read.');
    const unresolved = metadata.listOperations().filter(item => ['bill-action.handle.v1', 'bill-action.defer.v1'].includes(item.operationKind) && ['pending', 'unknown'].includes(item.state)).map(item => JSON.parse(item.resultIdentity)).find(item => item.actionId === binding.actionId);
    if (unresolved && unresolved.actorId !== authority(loopId)) fail('unavailable', 'An operation owned by another operator requires reconciliation.');
    const eligibility = { revision: binding.eligibilityRevision, reviewAt: binding.reviewAt, timeZone: binding.timeZone ?? null, offsetMinutes: binding.offsetMinutes ?? null, eligible: !unresolved && card.status === 'todo' && (!binding.reviewAt || Date.parse(now()) >= Date.parse(binding.reviewAt)) };
    const row = { schemaVersion: 1, loopId, actionId: binding.actionId, title: value.obligation.title, topicId: value.loop.topicId, availability: 'available', outcome: card.status === 'done' ? 'handled-observed' : unresolved ? 'unknown' : card.status === 'todo' ? 'pending' : 'conflict', ...(unresolved ? { pendingOperation: { logicalOperationId: unresolved.logicalOperationId, kind: unresolved.action, intent: unresolved.action === 'handle' ? { schemaVersion: 1, loopId: unresolved.loopId, logicalOperationId: unresolved.logicalOperationId, expectedUpdatedAt: unresolved.expectedUpdatedAt } : { schemaVersion: 1, loopId: unresolved.loopId, logicalOperationId: unresolved.logicalOperationId, expectedEligibilityRevision: unresolved.expectedEligibilityRevision, reviewAt: unresolved.reviewAt, timeZone: unresolved.timeZone, offsetMinutes: unresolved.offsetMinutes } } } : {}), ...(predecessor ? { predecessor } : {}), reason: 'Accepted explicit email payment request', deadline: value.obligation.dueAt ? { known: true, instant: value.obligation.dueAt, provenance: 'accepted-source' } : { known: false }, source, sourceIdentity: { externalId: value.observation.source.externalId, version: value.observation.facts.sourceVersion, outcomeId: value.observation.facts.obligationId, observationId: value.observation.observationId }, binding: { tenantId: binding.tenantId, boardId: binding.boardId, cardId: binding.cardId, idempotencyKey: binding.createIntent.idempotencyKey }, native: { status: card.status, updatedAt: card.updatedAt, ...(Number.isFinite(card.completedAt) ? { completedAt: card.completedAt } : {}), events: (card.events ?? []).filter(event => typeof event.id === 'string' && typeof event.kind === 'string' && Number.isFinite(event.at)).map(({ id, kind, at, fromStatus, toStatus }) => ({ id, kind, at, ...(fromStatus ? { fromStatus } : {}), ...(toStatus ? { toStatus } : {}) })) }, eligibility };
    publicationSnapshots.set(row, { value, binding, unresolvedId: unresolved?.logicalOperationId });
    return row;
  }
  async function admit(input) {
    envelope(input, ['tenantId', 'boardId', 'logicalOperationId']);
    text(input.tenantId, 'tenantId'); text(input.boardId, 'boardId');
    const value = await current(input.loopId, true);
    let binding = bindingFor(value);
    if (binding) {
      if (binding.tenantId !== input.tenantId || binding.boardId !== input.boardId) fail('intent-mismatch', 'The action already belongs to another native scope.');
      const prior = metadata.getOperation(input.logicalOperationId);
      if (prior && (prior.operationKind !== 'bill-action.admit.v1' || JSON.parse(prior.resultIdentity).actionId !== binding.actionId || JSON.parse(prior.resultIdentity).actorId !== authority(input.loopId, true))) fail('intent-mismatch', 'The admission operation ID belongs to a different immutable intent.');
      if (!binding.cardId && binding.actorId !== authority(input.loopId, true)) fail('unavailable', 'The original operator must reconcile the pending admission.');
    } else {
      if (value.obligation.paymentIdentity?.predecessor) value.admissionPredecessor = await currentPredecessor(value);
      const createIntent = { title: value.obligation.title, status: 'todo', tenant: input.tenantId, boardId: input.boardId, idempotencyKey: `cc-bill:${billActionDigest([value.semanticKey, input.tenantId, input.boardId])}` };
      binding = metadata.reserveBillActionBinding({ schemaVersion: 1, actionId: value.loop.loopId, semanticKey: value.semanticKey, meaningDigest: meaning(value), tenantId: input.tenantId, boardId: input.boardId, logicalOperationId: input.logicalOperationId, actorId: authority(input.loopId, true), createIntent, source: { externalId: value.observation.source.externalId, version: value.observation.facts.sourceVersion, outcomeId: value.observation.facts.obligationId } }, () => commitFence(value, true));
    }
    if (!binding?.cardId && value.obligation.paymentIdentity?.predecessor) value.admissionPredecessor = await currentPredecessor(value);
    if (!binding.cardId) {
      const result = await nativeRequest('workboard.cards.create', binding.createIntent, { assertCurrent: () => commitFence(value, true) });
      await current(input.loopId, true);
      const card = result?.card, automation = card?.metadata?.automation;
      if (!card?.id || card.title !== binding.createIntent.title || automation?.tenant !== binding.tenantId || (automation?.boardId ?? 'default') !== binding.boardId || automation?.idempotencyKey !== binding.createIntent.idempotencyKey) fail('conflict', 'Native create did not verify the exact retained create intent.');
      metadata.settleBillActionBinding({ actionId: binding.actionId, cardId: card.id }, () => commitFence(value, true));
    }
    return read(input);
  }
  async function handle(input) {
    envelope(input, ['logicalOperationId', 'expectedUpdatedAt']);
    if (!Number.isFinite(input.expectedUpdatedAt)) fail('invalid-request', 'Original native revision is required.');
    const value = await current(input.loopId, true), binding = bindingFor(value);
    if (!binding?.cardId) fail('unavailable', 'Native binding is unavailable.');
    const intent = { ...input, actorId: authority(input.loopId, true), sourceIdentity: { observationId: value.observation.observationId, sourceVersion: value.observation.facts.sourceVersion, loopRevision: value.loop.revision }, action: 'handle', actionId: binding.actionId, cardId: binding.cardId, boardId: binding.boardId, tenantId: binding.tenantId, patch: { status: 'done' } };
    const operation = metadata.beginBillActionOperation(intent, () => commitFence(value, true));
    if (!['pending', 'unknown'].includes(operation.state)) return operation;
    const card = await cardFor(input.loopId, binding, true);
    await current(input.loopId, true);
    commitFence(value, true);
    if (card.status === 'done') return metadata.settleBillActionOperation({ logicalOperationId: input.logicalOperationId, outcome: 'handled-observed' }, () => commitFence(value, true));
    if (card.status !== 'todo' || card.updatedAt !== input.expectedUpdatedAt) return metadata.settleBillActionOperation({ logicalOperationId: input.logicalOperationId, outcome: 'conflict' }, () => commitFence(value, true));
    try { await nativeRequest('workboard.cards.update', { id: binding.cardId, patch: { status: 'done' }, expectedUpdatedAt: input.expectedUpdatedAt }, { assertCurrent: () => commitFence(value, true) }); }
    catch (error) {
      authority(input.loopId, true);
      const conflict = ['workboard_conflict', 'conflict'].includes(error?.code) || error?.details?.type === 'workboard_card_conflict';
      return metadata.settleBillActionOperation({ logicalOperationId: input.logicalOperationId, outcome: conflict ? 'conflict' : 'unknown' }, () => commitFence(value, true));
    }
    return reconcile(input);
  }
  async function defer(input) {
    envelope(input, ['logicalOperationId', 'expectedEligibilityRevision', 'reviewAt', 'timeZone', 'offsetMinutes']);
    if (!Number.isSafeInteger(input.expectedEligibilityRevision) || input.expectedEligibilityRevision < 0 || typeof input.reviewAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(input.reviewAt) || !Number.isFinite(Date.parse(input.reviewAt)) || !Number.isInteger(input.offsetMinutes) || typeof input.timeZone !== 'string' || !input.timeZone.trim()) fail('invalid-request', 'Later requires an exact UTC instant, explicit zone, offset and eligibility revision.');
    const canonicalInstant = input.reviewAt.includes('.') ? input.reviewAt : input.reviewAt.replace('Z', '.000Z');
    if (new Date(input.reviewAt).toISOString() !== canonicalInstant) fail('invalid-request', 'Later calendar date is invalid.');
    try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(new Date(input.reviewAt)); } catch { fail('invalid-request', 'Later timezone is invalid.'); }
    const zoneOffset = new Intl.DateTimeFormat('en', { timeZone: input.timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(input.reviewAt)).find(part => part.type === 'timeZoneName').value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(zoneOffset);
    const offset = zoneOffset === 'GMT' ? 0 : match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1) : NaN;
    if (offset !== input.offsetMinutes) fail('invalid-request', 'Later timezone offset differs from the selected instant.');
    const existing = metadata.getBillActionOperation(input.logicalOperationId);
    if (!existing && Date.parse(input.reviewAt) <= Date.parse(now())) fail('invalid-request', 'A new Later choice must be in the future.');
    const value = await current(input.loopId, true), binding = bindingFor(value);
    if (!binding?.cardId) fail('unavailable', 'Native binding is unavailable.');
    const operation = metadata.beginBillActionOperation({ ...input, actorId: authority(input.loopId, true), sourceIdentity: { observationId: value.observation.observationId, sourceVersion: value.observation.facts.sourceVersion, loopRevision: value.loop.revision }, reviewAt: new Date(input.reviewAt).toISOString(), action: 'defer', actionId: binding.actionId, cardId: binding.cardId, boardId: binding.boardId, tenantId: binding.tenantId }, () => commitFence(value, true));
    if (operation.state === 'applied') return operation;
    const card = await cardFor(input.loopId, binding, true);
    commitFence(value, true);
    await current(input.loopId, true);
    if (!existing && Date.parse(input.reviewAt) <= Date.parse(now())) return metadata.settleBillActionOperation({ logicalOperationId: input.logicalOperationId, outcome: 'conflict' }, () => commitFence(value, true));
    if (card.status !== 'todo') return metadata.settleBillActionOperation({ logicalOperationId: input.logicalOperationId, outcome: card.status === 'done' ? 'handled-observed' : 'conflict' }, () => commitFence(value, true));
    try { return metadata.commitBillActionDefer(input, () => commitFence(value, true)); }
    catch (error) {
      if (error.code !== 'conflict') throw error;
      return metadata.settleBillActionOperation({ logicalOperationId: input.logicalOperationId, outcome: 'conflict' }, () => commitFence(value, true));
    }
  }
  async function reconcile(input) {
    envelope({ schemaVersion: 1, loopId: input.loopId, logicalOperationId: input.logicalOperationId }, ['logicalOperationId']);
    const operation = metadata.getBillActionOperation(input.logicalOperationId);
    if (!operation || operation.loopId !== input.loopId) fail('not-found', 'The exact submitted operation is unavailable.');
    if (operation.actorId !== authority(input.loopId)) fail('unavailable', 'The submitted operation belongs to another operator.');
    const value = await current(input.loopId), binding = bindingFor(value);
    if (!binding || binding.actionId !== operation.actionId) fail('conflict', 'Submitted action binding changed.');
    const card = await cardFor(input.loopId, binding);
    await current(input.loopId);
    if (!['pending', 'unknown'].includes(operation.state)) return operation;
    return metadata.settleBillActionOperation({ logicalOperationId: input.logicalOperationId, outcome: card.status === 'done' ? 'handled-observed' : 'unknown' }, () => commitFence(value, false));
  }
  function publishRow(row) {
    const snapshot = publicationSnapshots.get(row);
    if (!snapshot) fail('unavailable', 'The exact row publication snapshot is unavailable.');
    const { value, binding, unresolvedId } = snapshot;
    commitFence(value, false);
    const currentBinding = bindingFor(admitted(row.loopId));
    if (currentBinding?.cardId !== binding?.cardId || currentBinding?.tenantId !== binding?.tenantId || currentBinding?.boardId !== binding?.boardId || currentBinding?.eligibilityRevision !== binding?.eligibilityRevision) fail('conflict', 'The native binding or Later eligibility changed before list publication.');
    const pending = metadata.listOperations().filter(item => ['bill-action.handle.v1', 'bill-action.defer.v1'].includes(item.operationKind) && ['pending', 'unknown'].includes(item.state)).map(item => JSON.parse(item.resultIdentity)).find(item => item.actionId === binding?.actionId);
    if (pending?.logicalOperationId !== unresolvedId) fail('conflict', 'The submitted choice changed before list publication.');
    row.source = sourceCurrent(value, { source: row.source });
    if (row.predecessor) {
      try {
        const original = predecessorSnapshots.get(row.predecessor);
        if (!original) fail('unavailable', 'The original predecessor publication snapshot is unavailable.');
        predecessorFence(original, value);
        row.predecessor.source = sourceCurrent(original, { source: row.predecessor.source });
      } catch { delete row.predecessor; }
    }
    if (row.eligibility) row.eligibility.eligible = !pending && row.native.status === 'todo' && (!binding.reviewAt || Date.parse(now()) >= Date.parse(binding.reviewAt));
    return row;
  }
  async function list({ topicId, offset = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('invalid-request', 'Bill action page is invalid.');
    const collected = [], rows = [], errors = [];
    const unavailable = error => errors.push({ availability: 'unavailable', outcome: 'unavailable', code: error.code ?? 'unavailable' });
    for (const binding of metadata.listBillActionBindings()) {
      try { collected.push(await read({ loopId: binding.actionId })); }
      catch (error) { unavailable(error); }
    }
    // No await after this fence: every row is checked after all other row reads.
    for (const row of collected) {
      try { const value = publishRow(row); if (!topicId || value.topicId === topicId) rows.push(value); }
      catch (error) { unavailable(error); }
    }
    return { schemaVersion: 1, rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit, coverage: errors.length ? 'partial' : 'bound-actions-only', unavailableCount: errors.length, observedAt: now() };
  }
  const publicCommand = command => async input => {
    try { return await command(input); }
    catch (error) {
      const code = error.code === 'invalid-value' ? 'invalid-request' : error.code;
      if (['invalid-request', 'intent-mismatch', 'conflict', 'not-found', 'unavailable', 'unauthenticated', 'capability-unavailable', 'read-only'].includes(code)) throw sourceError(code === 'read-only' ? 'unavailable' : code, error.message);
      throw error;
    }
  };
  return Object.freeze(Object.fromEntries(Object.entries({ read, list, admit, handle, defer, reconcile }).map(([name, command]) => [name, publicCommand(command)])));
}
