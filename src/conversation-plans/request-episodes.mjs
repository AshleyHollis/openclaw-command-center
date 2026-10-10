import { PLAN_REQUEST_CAPABILITY, PLAN_REQUEST_REASON } from '../attention/source-policy.mjs';
import { planDigest, validatePlan } from './contract.mjs';
import { sourceError } from '../sources/errors.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const kinds = new Set(['question', 'execution-approval', 'requested-result-review']);
const fail = message => { throw sourceError('conflict', message); };
const terminal = state => ['Resolved', 'Withdrawn'].includes(state);
const publicationContexts = new WeakMap();
function requestIdentity(request) {
  if (!request || Object.keys(request).some(key => !['id', 'kind', 'createdAtMs', 'expiresAtMs', 'requestRevision'].includes(key)) || typeof request.id !== 'string' || !request.id.trim() || request.id.length > 500 || !kinds.has(request.kind) || !Number.isSafeInteger(request.createdAtMs) || request.createdAtMs < 0 || !(request.kind === 'requested-result-review' && request.expiresAtMs === null) && (!Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs < request.createdAtMs) || typeof request.requestRevision !== 'string' || !request.requestRevision.trim()) fail('Exact native request identity is unavailable.');
  return structuredClone(request);
}

// This adapter owns no executor/queue/response API. It publishes references
// through current plan reads, reusing existing Attention episode transactions.
export function createPlanRequestEpisodeOwner({ metadata, attention, verifyRequest, now = Date.now }) {
  if (!metadata?.getConversationPlan || !attention?.ownerEpisodes || typeof verifyRequest !== 'function') throw new TypeError('Existing plan, Attention and native request owners are required.');
  let proofs = publicationContexts.get(attention);
  if (!proofs) {
    proofs = new AsyncLocalStorage(); publicationContexts.set(attention, proofs);
    attention.registerSourceCapability({ sourceCapabilityId: PLAN_REQUEST_CAPABILITY, sourceKind: 'operational', monitoring: false, actions: [], ownerScoped: true, terminalSubject: true,
    verifyTransition(occurrence) {
      const proof = proofs.getStore(); if (!proof || planDigest(occurrence) !== planDigest(proof.occurrence)) fail('Native request publication evidence is unavailable.');
      proof.guard(); return proof.state !== 'pending';
    },
    deriveEvidence(occurrence) { const proof = proofs.getStore(); if (!proof || planDigest(occurrence) !== planDigest(proof.occurrence)) fail('Native request evidence is unavailable.'); proof.guard(); return proof.facts; }
    });
  }
  function guardFor(input, card, principalId, assertCurrent) {
    return () => {
      if (typeof assertCurrent !== 'function' || assertCurrent()?.then) throw sourceError('unauthenticated', 'Current native request authority must be synchronous.');
      const binding = metadata.getConversationPlan(input.source), scope = card.metadata?.automation;
      if (!binding || binding.principalId !== principalId || planDigest(binding.input) !== planDigest(input) || binding.cardId !== card.id || scope?.tenant !== input.destination.tenantId || (scope?.boardId ?? 'default') !== input.destination.boardId) fail('Native request is not bound to this accepted plan and operator.');
    };
  }
  async function project({ input: request, card, principalId, observation, assertCurrent }) {
    const input = validatePlan(request), guard = guardFor(input, card, principalId, assertCurrent); guard();
    const planKey = planDigest({ source: input.source, destination: input.destination, cardId: card.id, principalId });
    const known = attention.ownerEpisodes(PLAN_REQUEST_CAPABILITY, guard).filter(episode => episode.evidenceFacts.planKey === planKey && episode.evidenceFacts.principalId === principalId);
    const latest = new Map();
    for (const episode of known) if (!latest.has(episode.stableSubjectId) || latest.get(episode.stableSubjectId).generation < episode.generation) latest.set(episode.stableSubjectId, episode);
    const candidates = new Map();
    for (const candidate of observation?.requests ?? []) {
      // List candidates are locators only. The exact native owner verifies all
      // immutable request facts before any Attention admission.
      if (!candidate || !kinds.has(candidate.kind) || typeof candidate.id !== 'string') fail('Unsupported native human-request candidate.');
      const key = `${candidate.kind}:${candidate.id}`;
      if (candidates.has(key)) fail('Ambiguous native human-request candidate.');
      candidates.set(key, { candidate, existing: null });
    }
    for (const episode of latest.values()) {
      const facts = episode.evidenceFacts, key = `${facts.kind}:${facts.requestId}`;
      const candidate = { id: facts.requestId, kind: facts.kind, createdAtMs: facts.createdAtMs, expiresAtMs: facts.expiresAtMs, requestRevision: facts.requestRevision };
      if (candidates.has(key)) candidates.get(key).existing = episode;
      else if (!terminal(episode.state)) candidates.set(key, { candidate, existing: episode });
    }
    const requests = []; let unavailableCount = 0;
    for (const { candidate, existing } of candidates.values()) {
      guard();
      let proof;
      try { proof = await verifyRequest({ input, card, request: candidate, known: !!existing,
        requestLink: existing ? { sessionKey: existing.evidenceFacts.sessionKey, runId: existing.evidenceFacts.runId } : undefined,
        assertCurrent: guard }); } catch { guard(); unavailableCount++; continue; }
      guard();
      if (proof?.availability !== 'available') { unavailableCount++; continue; }
      if (!['pending', 'resolved', 'withdrawn'].includes(proof.state) || !Number.isSafeInteger(proof.observedAtMs)) fail('Native request state proof is invalid.');
      const exact = requestIdentity(proof.request);
      if (exact.id !== candidate.id || exact.kind !== candidate.kind) fail('Native request owner returned another request.');
      if (existing && planDigest(exact) !== planDigest({ id: existing.evidenceFacts.requestId, kind: existing.evidenceFacts.kind, createdAtMs: existing.evidenceFacts.createdAtMs, expiresAtMs: existing.evidenceFacts.expiresAtMs, requestRevision: existing.evidenceFacts.requestRevision })) fail('Native request identity changed under its accepted identity.');
      const stableSubjectId = planDigest({ planKey, kind: exact.kind, id: exact.id });
      const facts = { planKey, principalId, cardId: card.id, sessionKey: existing?.evidenceFacts.sessionKey ?? card.sessionKey ?? '', runId: existing?.evidenceFacts.runId ?? card.runId ?? '', requestId: exact.id, kind: exact.kind, createdAtMs: exact.createdAtMs, expiresAtMs: exact.expiresAtMs, requestRevision: exact.requestRevision };
      const occurrence = { schemaVersion: 1, sourceCapabilityId: PLAN_REQUEST_CAPABILITY, stableSubjectId, attentionReason: PLAN_REQUEST_REASON,
        occurrenceId: `${stableSubjectId}:${proof.state}`, occurrenceVersion: planDigest(exact), occurredAt: new Date(exact.createdAtMs).toISOString(),
        topicId: input.source.topicId, sourceReferenceId: input.source.referenceId, evidenceFacts: {},
        ...(proof.state === 'pending' ? {} : { transitionEvidence: { state: proof.state } }) };
      // Terminal identity/timestamp is reused from its first durable receipt.
      // Repeated reads never rewrite a terminal occurrence with a later clock.
      if (existing && terminal(existing.state)) continue;
      const result = await proofs.run({ occurrence, facts, guard, state: proof.state }, () => attention.ingest(occurrence, { assertCurrent: guard }));
      guard();
      if (proof.state === 'pending' && result.episode?.state === 'Active' && (exact.kind === 'requested-result-review' && exact.expiresAtMs === null || exact.expiresAtMs > now())) requests.push({ ...exact, episodeId: result.episode.episodeId, episodeRevision: result.episode.revision, episodeState: result.episode.state });
    }
    guard();
    return { availability: unavailableCount ? 'partial' : observation?.availability === 'unavailable' ? 'unavailable' : 'available', eligible: requests.length > 0, requests, unavailableCount,
      resultReviewAvailability: observation?.resultReviewAvailability ?? 'unqualified' };
  }
  return Object.freeze({ project });
}
