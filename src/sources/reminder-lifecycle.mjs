// Native scheduler state is translated into Attention in this module only.
// Scheduler delivery and user acknowledgement remain distinct lifecycles.
export async function reconcileReminderAttention({ topicId, rows, attention, now, completeInventory = true }) {
  if (!attention?.ingest) return rows;
  const configuredNow = typeof now === 'function' ? now() : now;
  const configuredNowMs = typeof configuredNow === 'number' ? configuredNow : Date.parse(configuredNow);
  const observedNowMs = Number.isFinite(configuredNowMs) ? configuredNowMs : Date.now();
  const observedAt = new Date(observedNowMs).toISOString();
  const returnedIds = new Set();
  for (const row of rows) {
    const externalId = row.sourceReference.externalSourceId;
    returnedIds.add(externalId);
    const schedule = row?.job?.schedule;
    const dueAt = schedule?.kind === 'at' ? Date.parse(schedule.at) : Number(row?.job?.state?.nextRunAtMs);
    const occurrenceVersion = row.job.configRevision ?? row.sourceReference.observedRevision;
    const context = attention.sourceOccurrenceContext?.({ sourceCapabilityId: 'reminders', stableSubjectId: externalId, attentionReason: 'reminder-due' });
    // Native Cron disables a successfully delivered one-shot. Delivery is
    // not user acknowledgement: retain Attention until its existing episode
    // is explicitly terminal, including when first observed after delivery.
    const lastRunAtMs = row.job.state?.lastRunAtMs;
    const deliveredOneShot = row.job.enabled === false && schedule?.kind === 'at'
      && Number.isFinite(lastRunAtMs) && lastRunAtMs >= dueAt && lastRunAtMs <= observedNowMs
      && (row.job.state?.lastRunStatus ?? row.job.state?.lastStatus) === 'ok';
    const acknowledged = context && ['Resolved', 'Withdrawn'].includes(context.state);
    const due = Number.isFinite(dueAt) && dueAt <= observedNowMs
      && (row.job.enabled !== false || (deliveredOneShot && !acknowledged));
    if (due) {
      const generation = context && ['Resolved', 'Withdrawn'].includes(context.state) ? context.generation + 1 : context?.generation ?? 1;
      await attention.ingest({
        schemaVersion: 1,
        sourceCapabilityId: 'reminders',
        stableSubjectId: externalId,
        attentionReason: 'reminder-due',
        occurrenceId: `reminder:${externalId}:generation:${generation}:revision:${occurrenceVersion ?? 'unversioned'}`,
        ...(occurrenceVersion ? { occurrenceVersion: String(occurrenceVersion) } : {}),
        occurredAt: observedAt,
        topicId,
        sourceReferenceId: row.sourceReference.referenceId,
        evidenceFacts: { reminderDue: true, explicitTimed: schedule?.kind === 'at', dueAt: Number.isFinite(dueAt) ? new Date(dueAt).toISOString() : observedAt },
        ...(occurrenceVersion ? { transitionEvidence: { verifiedSource: 'scheduler-readback', version: String(occurrenceVersion), state: 'active' } } : {})
      });
    } else if (context && context.state !== 'Snoozed' && !['Resolved', 'Withdrawn'].includes(context.state)) {
      await attention.ingest({
        schemaVersion: 1,
        sourceCapabilityId: 'reminders',
        stableSubjectId: externalId,
        attentionReason: 'reminder-due',
        occurrenceId: `reminder:${externalId}:terminal:${occurrenceVersion ?? 'unversioned'}`,
        ...(occurrenceVersion ? { occurrenceVersion: String(occurrenceVersion) } : {}),
        occurredAt: observedAt,
        topicId,
        sourceReferenceId: row.sourceReference.referenceId,
        evidenceFacts: { reminderDue: false },
        transitionEvidence: { verifiedSource: 'scheduler-readback', ...(occurrenceVersion ? { version: String(occurrenceVersion) } : {}), state: row?.job?.enabled === false ? 'resolved' : 'withdrawn' }
      });
    }
  }
  // A single mutation receipt proves only that row, not absence of siblings.
  for (const episode of completeInventory ? attention.allEpisodes?.() ?? [] : []) {
    if (episode.topicId !== topicId || episode.sourceCapabilityId !== 'reminders' || ['Resolved', 'Withdrawn'].includes(episode.state) || returnedIds.has(episode.stableSubjectId)) continue;
    await attention.ingest({ schemaVersion: 1, sourceCapabilityId: 'reminders', stableSubjectId: episode.stableSubjectId, attentionReason: episode.attentionReason, occurrenceId: `reminder:${episode.stableSubjectId}:missing:${observedAt}`, occurredAt: observedAt, topicId, sourceReferenceId: episode.sourceReferenceId, evidenceFacts: { reminderDue: false }, transitionEvidence: { verifiedSource: 'scheduler-readback', state: 'withdrawn' } });
  }
  return rows;
}

export function reminderActionApplied(actionId, job, parameters) {
  if (actionId === 'reminder.complete') return job?.enabled === false;
  if (actionId === 'reminder.snooze') return job?.enabled === true && job.schedule?.kind === 'at' && job.schedule.at === parameters.until;
  return false;
}
