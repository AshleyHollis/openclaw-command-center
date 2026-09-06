/** Data owned by one plugin activation, independent of each view's scoped host. */
export function createNativeState(signal) {
  const state = { drafts: new Map(), creations: new Map(), listeners: new Set(), active: !signal?.aborted,
    retire() { state.active = false; state.drafts.clear(); state.creations.clear(); state.listeners.clear(); signal?.removeEventListener('abort', state.retire); } };
  signal?.addEventListener('abort', state.retire, { once: true });
  return state;
}

export function subscribeNativeState(state, listener) {
  const listeners = state.listeners; listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishNativeState(state) {
  if (!state.active) return;
  for (const listener of state.listeners) listener();
}

/** The retained draft, exact input and current attempt are one activation owner. */
export function beginNativeNoteOperation(state, key, draft, input) {
  if (!state.active || state.drafts.get(key) !== draft || draft.operation || draft.path !== input.path) throw new Error('The exact Note draft is no longer available.');
  const operation = { input: Object.freeze({ ...input }), text: draft.text, attempt: null, unknown: false };
  draft.operation = operation; draft.error = '';
  return operation;
}

export async function settleNativeNoteOperation({ state, key, draft, operation, host, signal, reconcile = false }) {
  const creating = operation.input.action === 'notes.create';
  const outcomeLabel = creating ? 'creation' : 'save';
  const owns = () => state.active && state.drafts.get(key) === draft && draft.operation === operation && draft.path === operation.input.path;
  if (!owns() || operation.attempt) return null;
  const attempt = {}; operation.attempt = attempt; operation.checking = reconcile;
  const current = () => owns() && operation.attempt === attempt;
  const interrupted = () => {
    if (!current()) return;
    operation.unknown = true; operation.attempt = null; operation.checking = false;
    draft.error = `The outcome is unknown. Check ${outcomeLabel} outcome before another write.`;
    publishNativeState(state);
  };
  signal.addEventListener('abort', interrupted, { once: true });
  try {
    if (signal.aborted) { interrupted(); return null; }
    const input = reconcile ? { ...operation.input, action: `${operation.input.action}.reconcile` } : operation.input;
    const response = await nativeMutation(host, '/plugins/command-center/api/topic/actions', input, signal, { reconcile });
    if (signal.aborted || !host.connection.connected || !host.connection.canRead || !host.connection.canWrite) { interrupted(); return null; }
    if (!current()) return null;
    const result = reconcile ? response.result : response;
    const outcome = reconcile ? response.status : 'applied';
    const exactReference = creating && outcome === 'applied'
      ? typeof result?.referenceId === 'string' && result.referenceId.length > 0 && result.referenceId !== input.referenceId
      : result?.referenceId === input.referenceId;
    if (result?.action !== input.action || result?.topicId !== input.topicId || !exactReference || result?.path !== input.path || (outcome === 'applied' && (typeof result?.revision !== 'string' || !result.revision))) throw Object.assign(new Error(`The exact Note receipt is incomplete; check ${outcomeLabel} outcome before another write.`), { unknownOutcome: true });
    if (outcome === 'applied') { draft.baseText = operation.text; draft.baseRevision = result.revision; draft.version++; }
    if (creating && outcome === 'applied') draft.created = result;
    draft.operation = null; draft.error = outcome === 'not-applied' ? `The ${outcomeLabel} was not applied. Your draft is retained; ${creating ? 'Create' : 'Save'} Note makes a new explicit attempt.` : '';
    return { status: outcome, result, text: operation.text };
  } catch (error) {
    if (!current()) return null;
    if (error.unknownOutcome || reconcile) operation.unknown = true;
    else draft.operation = null;
    draft.error = host.redact(error.message);
    return null;
  } finally {
    signal.removeEventListener('abort', interrupted);
    if (current()) { operation.attempt = null; operation.checking = false; }
    if (state.active && state.drafts.get(key) === draft) publishNativeState(state);
  }
}

export function encodeNoteText(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 8 * 1024 * 1024 + 1) throw new Error('The Note exceeds the supported 8 MiB content limit.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** One explicit write, with host-owned authentication and no transport retries. */
async function nativeResponse(host, path, input, signal) {
  signal.throwIfAborted();
  if (!host.connection.connected || !host.connection.canWrite || typeof host.httpRequest !== 'function') throw new Error('Connect with write access and native HTTP support to make changes.');
  if (!['/plugins/command-center/api/topics/actions', '/plugins/command-center/api/topic/actions'].includes(path)) throw new Error('Unsupported mutation route.');
  const body = JSON.stringify(input);
  if (new TextEncoder().encode(body).length > 12 * 1024 * 1024) throw new Error('The request exceeds the supported size.');
  let response;
  let value;
  const unknown = () => Object.assign(new Error('The outcome is unknown. The operation identity is retained; Source Recovery is required before another write.'), { unknownOutcome: true });
  try {
    response = await host.httpRequest({ method: 'POST', path, body }, { signal });
    if (typeof response?.body !== 'string' || new TextEncoder().encode(response.body).length > 1024 * 1024) throw unknown();
    value = JSON.parse(response.body);
  } catch { throw unknown(); }
  if (value?.schemaVersion !== 1) throw unknown();
  if (value.status === 'error' && [400, 403, 409].includes(response.status) && ['invalid-request', 'conflict', 'primary-session', 'forbidden', 'permission-denied'].includes(value.code)) {
    throw Object.assign(new Error(value.code === 'conflict' ? 'Newer authoritative state conflicts with this draft. Reload the authoritative Note or refresh the Topic before trying again.' : 'The action was refused. Check the fields and current write access.'), { code: value.code });
  }
  if (response.status !== 200) throw unknown();
  return { value, unknown };
}

export async function nativeMutation(host, path, input, signal, { reconcile = false } = {}) {
  const { value, unknown } = await nativeResponse(host, path, input, signal);
  if (!(reconcile ? ['applied', 'not-applied'].includes(value.status) : value.status === 'applied') || value.logicalOperationId !== input.logicalOperationId) throw unknown();
  return reconcile ? { status: value.status, result: value.result } : value.result;
}

/** Closed recovery commands never redispatch the original creation intent. */
export async function nativeCreationRecovery(host, input, signal) {
  const statuses = {
    'conversations.creation.inspect': ['clear', 'blocked', 'unknown', 'applied'],
    'conversations.creation.reconcile': ['unknown', 'applied'],
    'conversations.creation.acknowledge': ['acknowledged']
  };
  if (!statuses[input.action]) throw new Error('Unsupported Conversation recovery action.');
  const { value, unknown } = await nativeResponse(host, '/plugins/command-center/api/topic/actions', input, signal);
  if (!statuses[input.action].includes(value.status) || value.result?.action !== input.action || value.result?.topicId !== input.topicId) throw unknown();
  const owns = ['unknown', 'applied', 'acknowledged'].includes(value.status);
  if (owns && (typeof value.logicalOperationId !== 'string' || !value.logicalOperationId)) throw unknown();
  if (input.logicalOperationId && value.logicalOperationId !== input.logicalOperationId) throw unknown();
  if (['applied', 'acknowledged'].includes(value.status) && (typeof value.result.referenceId !== 'string' || !value.result.referenceId)) throw unknown();
  if (input.referenceId && value.result.referenceId !== input.referenceId) throw unknown();
  if (input.action.endsWith('.inspect') && owns && (!Number.isInteger(value.result.expectedTopicRevision) || value.result.expectedTopicRevision < 0 || value.result.label !== undefined && typeof value.result.label !== 'string')) throw unknown();
  return value;
}
