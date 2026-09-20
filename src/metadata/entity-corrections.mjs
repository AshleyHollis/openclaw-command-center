import { createHash } from 'node:crypto';

const actions = new Set(['confirm', 'reject', 'replace']);
const hash = value => createHash('sha256').update(value).digest('hex');

export function installEntityCorrections(service, { ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  const object = (value, field) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('entity-correction-invalid', `${field} must be an object`); return value; };
  const closed = (value, keys) => { if (Object.keys(value).some(key => !keys.includes(key))) fail('entity-correction-invalid'); return value; };
  const text = (value, field, maximum = 500) => { if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail('entity-correction-invalid', `${field} must be a non-blank string`); return value.trim(); };
  const entity = (value, field) => {
    const candidate = closed(object(value, field), ['kind', 'id', 'label']);
    return Object.freeze({ kind: text(candidate.kind, `${field}.kind`, 80), id: text(candidate.id, `${field}.id`, 300), ...(candidate.label === undefined ? {} : { label: text(candidate.label, `${field}.label`, 200) }) });
  };
  const sameEntity = (left, right) => left?.kind === right?.kind && left?.id === right?.id;

  service.recordEntityCorrection = input => {
    const value = closed(object(input, 'input'), ['schemaVersion', 'logicalOperationId', 'correction']);
    if (value.schemaVersion !== 1) fail('entity-correction-invalid');
    const logicalOperationId = text(value.logicalOperationId, 'logicalOperationId', 300);
    const correction = closed(object(value.correction, 'correction'), ['schemaVersion', 'correctionId', 'targetObservationId', 'targetEntity', 'action', 'replacementEntity', 'actorId', 'rationale', 'correctedAt']);
    if (correction.schemaVersion !== 1 || !actions.has(correction.action)) fail('entity-correction-invalid');
    const correctionId = text(correction.correctionId, 'correctionId', 300);
    const targetObservationId = text(correction.targetObservationId, 'targetObservationId', 300);
    const targetEntity = entity(correction.targetEntity, 'targetEntity');
    const replacementEntity = correction.replacementEntity === undefined ? undefined : entity(correction.replacementEntity, 'replacementEntity');
    if ((correction.action === 'replace') !== (replacementEntity !== undefined) || replacementEntity && sameEntity(targetEntity, replacementEntity)) fail('entity-correction-invalid');
    const actorId = text(correction.actorId, 'actorId', 200);
    const rationale = text(correction.rationale, 'rationale', 2000);
    const correctedAt = text(correction.correctedAt, 'correctedAt', 64);
    if (Number.isNaN(Date.parse(correctedAt))) fail('entity-correction-invalid');
    const target = service.getOpenLoopObservation(targetObservationId);
    if (!target) fail('entity-correction-target-missing');
    if (!target.entityRefs.some(candidate => sameEntity(candidate, targetEntity))) fail('entity-correction-target-mismatch');
    const facts = { correctionId, targetObservationId, targetEntity, action: correction.action, ...(replacementEntity === undefined ? {} : { replacementEntity }), actorId, rationale };
    const version = `sha256:${hash(JSON.stringify(facts))}`;
    const observation = {
      schemaVersion: 1,
      observationId: `entity-correction:${hash(`${correctionId}\u0000${version}`).slice(0, 40)}`,
      source: { system: 'command-center', kind: 'entity-correction', externalId: correctionId, version },
      type: 'decision-evidence',
      occurredAt: correctedAt,
      observedAt: correctedAt,
      historicalBaseline: false,
      ...(target.topicId === undefined ? {} : { topicId: target.topicId }),
      entityRefs: [targetEntity, ...(replacementEntity === undefined ? [] : [replacementEntity])],
      facts
    };
    const alreadyRecorded = service.getOpenLoopObservation(observation.observationId) !== null;
    const result = service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: `entity-correction:${hash(logicalOperationId).slice(0, 40)}`, observation });
    return Object.freeze({ schemaVersion: 1, disposition: alreadyRecorded || result.disposition === 'duplicate' ? 'duplicate' : 'applied', observation: result.observation, resolution: service.resolveEntityRefs(targetObservationId) });
  };

  service.resolveEntityRefs = targetObservationId => {
    const target = service.getOpenLoopObservation(text(targetObservationId, 'targetObservationId', 300));
    if (!target) return null;
    const resolved = new Map(target.entityRefs.map(item => [`${item.kind}\u0000${item.id}`, { ...item, status: 'source-claimed', correctionObservationId: null }]));
    const replacementsByTarget = new Map();
    const corrections = service.listEntityCorrections(target.observationId);
    for (const correction of corrections) {
      const facts = correction.facts;
      const key = `${facts.targetEntity.kind}\u0000${facts.targetEntity.id}`;
      const current = resolved.get(key);
      if (!current) continue;
      for (const replacementKey of replacementsByTarget.get(key) ?? []) {
        const replacement = resolved.get(replacementKey);
        if (replacement) resolved.set(replacementKey, { ...replacement, status: 'rejected', correctionObservationId: correction.observationId });
      }
      if (facts.action === 'confirm') resolved.set(key, { ...current, status: 'confirmed', correctionObservationId: correction.observationId });
      else {
        resolved.set(key, { ...current, status: 'rejected', correctionObservationId: correction.observationId });
        if (facts.action === 'replace') {
          const replacement = facts.replacementEntity;
          const replacementKey = `${replacement.kind}\u0000${replacement.id}`;
          resolved.set(replacementKey, { ...replacement, status: 'confirmed', correctionObservationId: correction.observationId });
          const replacementKeys = replacementsByTarget.get(key) ?? new Set();
          replacementKeys.add(replacementKey);
          replacementsByTarget.set(key, replacementKeys);
        }
      }
    }
    return Object.freeze({ schemaVersion: 1, observation: target, entities: Object.freeze([...resolved.values()].map(Object.freeze)), corrections: Object.freeze(corrections) });
  };
}
