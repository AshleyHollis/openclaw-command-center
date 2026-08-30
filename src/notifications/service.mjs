import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';
import { createNotificationCandidate, validateNotificationCandidate } from './candidate.mjs';
import { DEFAULT_NOTIFICATION_SETTINGS, normalizeNotificationSettings, settingKeys } from './settings.mjs';
import { isQuietHours, policySlots } from './policy.mjs';

const ONE_DAY_MS = 86_400_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SEVERITY_RANK = Object.freeze({ Reminder: 1, High: 2, Critical: 3 });

function nowMs(value) {
  const result = typeof value === 'function' ? value() : value;
  if (Number.isSafeInteger(result)) return result;
  const parsed = Date.parse(result);
  if (!Number.isSafeInteger(parsed)) throw sourceError('invalid-request', 'Notification clock is invalid.');
  return parsed;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mapSettings(row, fallback = DEFAULT_NOTIFICATION_SETTINGS) {
  if (!row) return Object.freeze({ ...fallback });
  return Object.freeze({
    settingsId: 'global',
    dueReminders: row.due_reminders === 1,
    importantItems: row.important_items === 1,
    criticalRealerts: row.critical_realerts === 1,
    quietHoursEnabled: row.quiet_hours_enabled === 1,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    timeZone: row.time_zone,
    genericPreview: row.generic_preview === 1,
    revision: row.revision,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at_ms).toISOString()
  });
}

function episodeKind(episode) {
  return episode?.sourceCapabilityId === 'reminders' || episode?.sourceKind === 'reminder' ? 'reminder' : 'attention';
}

function localDateKey(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  return parts.filter((part) => part.type !== 'literal').map((part) => part.value).join('-');
}

function episodeSeverity(episode) {
  if (episodeKind(episode) === 'reminder') return 'Reminder';
  return ['High', 'Critical'].includes(episode?.severity) ? episode.severity : null;
}

function explicitReminder(episode) {
  return episode?.evidenceFacts?.explicitTimed === true || episode?.evidenceFacts?.snoozeReturn === true;
}

function activeEpisode(episode) {
  return episode?.state === 'Active' && !episode?.terminalAt && episodeSeverity(episode) !== null;
}

function schedulingSettings(settings) {
  return { ...settings, dueReminders: true, importantItems: true, criticalRealerts: true };
}

function settingsRow(settings, updatedAtMs) {
  return [
    settings.dueReminders ? 1 : 0,
    settings.importantItems ? 1 : 0,
    settings.criticalRealerts ? 1 : 0,
    settings.quietHoursEnabled ? 1 : 0,
    settings.quietHoursStart,
    settings.quietHoursEnd,
    settings.timeZone,
    settings.genericPreview ? 1 : 0,
    settings.revision,
    new Date(updatedAtMs).toISOString()
  ];
}

function safeOperationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw sourceError('invalid-request', 'logicalOperationId must be a canonical UUID.');
  if (value.length > 128) throw sourceError('invalid-request', 'logicalOperationId is too long.');
  return value;
}

export function createNotificationService({ metadata, attentionService, sourceService, emitter, now = () => Date.now(), timeZone = 'UTC', logger } = {}) {
  if (!metadata?.databasePath) throw new TypeError('A durable metadata service is required for notifications.');
  const db = new DatabaseSync(metadata.databasePath);
  let closed = false;
  let retainedBinding = emitter?.emit && emitter?.clear ? emitter : undefined;

  function assertOpen() {
    if (closed) throw new Error('Notification service is closed.');
  }

  function getSettings() {
    assertOpen();
    let row = db.prepare('SELECT * FROM notification_settings WHERE settings_id = ?').get('global');
    if (!row) {
      const defaults = normalizeNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, timeZone });
      const updatedAtMs = nowMs(now);
      db.prepare('INSERT INTO notification_settings (settings_id, due_reminders, important_items, critical_realerts, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, time_zone, generic_preview, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('global', ...settingsRow(defaults, updatedAtMs));
      row = db.prepare('SELECT * FROM notification_settings WHERE settings_id = ?').get('global');
    }
    return mapSettings(row);
  }

  function updateSettings(input = {}) {
    assertOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw sourceError('invalid-request', 'Notification settings action must be an object.');
    const allowed = ['schemaVersion', 'logicalOperationId', 'expectedRevision', 'settings'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw sourceError('invalid-request', 'Notification settings action contains unsupported fields.');
    if (input.schemaVersion !== 1) throw sourceError('unsupported-version', 'Notification settings schemaVersion must be 1.');
    const logicalOperationId = safeOperationId(input.logicalOperationId);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw sourceError('invalid-request', 'expectedRevision must be a positive integer.');
    if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) throw sourceError('invalid-request', 'settings must be an object.');
    if (Object.keys(input.settings).some((field) => !settingKeys.includes(field))) throw sourceError('invalid-request', 'Notification settings update contains unsupported fields.');
    const normalizedPatch = normalizeNotificationSettings(input.settings);
    const proposed = Object.fromEntries(Object.keys(input.settings).map((field) => [field, normalizedPatch[field]]));
    const intentDigest = digest({ operation: 'notification.settings.update', expectedRevision: input.expectedRevision, settings: proposed });
    const clock = nowMs(now);
    getSettings();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existingOperation = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(logicalOperationId);
      if (existingOperation) {
        if (existingOperation.intent_digest !== intentDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different notification settings intent.');
        if (existingOperation.state === 'applied') {
          db.exec('COMMIT');
          try {
            const replay = JSON.parse(existingOperation.result_identity ?? '');
            if (replay && typeof replay === 'object' && !Array.isArray(replay)) return Object.freeze(replay);
          } catch { /* older operation rows retain only the global identity */ }
          return getSettings();
        }
      }
      const current = db.prepare('SELECT * FROM notification_settings WHERE settings_id = ?').get('global');
      const currentSettings = mapSettings(current);
      if (currentSettings.revision !== input.expectedRevision) throw sourceError('conflict', 'Notification settings revision is stale.', { currentRevision: currentSettings.revision });
      const next = normalizeNotificationSettings({ ...currentSettings, ...proposed, revision: currentSettings.revision + 1, updatedAt: new Date(clock).toISOString() });
      db.prepare('UPDATE notification_settings SET due_reminders = ?, important_items = ?, critical_realerts = ?, quiet_hours_enabled = ?, quiet_hours_start = ?, quiet_hours_end = ?, time_zone = ?, generic_preview = ?, revision = ?, updated_at = ? WHERE settings_id = ?').run(...settingsRow(next, clock), 'global');
      if (existingOperation) {
        db.prepare('UPDATE operation_journal SET state = ?, result_status = ?, result_identity = ?, observed_revision = ?, updated_at = ? WHERE logical_operation_id = ?').run('applied', 'applied', JSON.stringify(next), String(next.revision), new Date(clock).toISOString(), logicalOperationId);
      } else {
        db.prepare('INSERT INTO operation_journal (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(logicalOperationId, logicalOperationId, intentDigest, 'notification.settings.update', 'applied', 'applied', JSON.stringify(next), String(next.revision), new Date(clock).toISOString(), new Date(clock).toISOString());
      }
      db.exec('COMMIT');
      return next;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original conflict or validation failure */ }
      throw error;
    }
  }

  function rows(table, where = '', parameters = []) {
    return db.prepare(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY updated_at_ms DESC, rowid DESC`).all(...parameters);
  }

  function latestEpoch(episodeId) {
    return db.prepare('SELECT * FROM notification_policy_epochs WHERE episode_id = ? ORDER BY generation DESC LIMIT 1').get(episodeId) ?? null;
  }

  function createEpoch(episode, severity, activationAtMs, currentSettings, clock) {
    const prior = latestEpoch(episode.episodeId);
    const resumesReminder = prior?.state === 'paused' && severity === 'Reminder' && episodeKind(episode) === 'reminder';
    if (prior && SEVERITY_RANK[prior.severity] >= SEVERITY_RANK[severity] && prior.state !== 'terminal' && !resumesReminder) return prior;
    if (prior && SEVERITY_RANK[prior.severity] < SEVERITY_RANK[severity]) db.prepare("UPDATE notification_slots SET status = 'cancelled', updated_at_ms = ? WHERE epoch_id = ? AND status IN ('scheduled', 'queued')").run(clock, prior.epoch_id);
    const generation = prior ? prior.generation + 1 : 1;
    const epochId = `epoch-${digest({ episodeId: episode.episodeId, generation, severity }).slice(0, 48)}`;
    db.prepare('INSERT INTO notification_policy_epochs (epoch_id, episode_id, severity, generation, activation_at_ms, active_accumulated_ms, state, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(epochId, episode.episodeId, severity, generation, activationAtMs, 0, 'active', clock, clock);
    const slots = policySlots({ severity, activationAtMs, explicitTimed: explicitReminder(episode) || resumesReminder, kind: episodeKind(episode), settings: schedulingSettings(currentSettings) });
    for (const slot of slots) {
      const slotId = `slot-${digest({ epochId, slotKind: slot.slotKind }).slice(0, 48)}`;
      db.prepare('INSERT INTO notification_slots (slot_id, epoch_id, episode_id, slot_kind, due_at_ms, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(slotId, epochId, episode.episodeId, slot.slotKind, slot.dueAtMs, 'scheduled', clock, clock);
    }
    return db.prepare('SELECT * FROM notification_policy_epochs WHERE epoch_id = ?').get(epochId);
  }

  function updateEpoch(epoch, episode, clock) {
    const state = activeEpisode(episode) ? 'active' : episode?.state === 'Snoozed' ? 'paused' : 'terminal';
    const wasPaused = epoch.state === 'paused';
    const previousAt = Number(epoch.updated_at_ms);
    const episodeUpdatedAt = Date.parse(episode?.updatedAt ?? '');
    const activeEnd = state === 'active' ? clock : Number.isSafeInteger(episodeUpdatedAt) ? Math.min(clock, episodeUpdatedAt) : clock;
    const additional = epoch.state === 'active' ? Math.max(0, activeEnd - previousAt) : 0;
    const accumulated = Number(epoch.active_accumulated_ms) + additional;
    db.prepare('UPDATE notification_policy_epochs SET active_accumulated_ms = ?, state = ?, updated_at_ms = ? WHERE epoch_id = ?').run(accumulated, state, clock, epoch.epoch_id);
    if (state === 'paused') db.prepare("UPDATE notification_slots SET status = 'cancelled', updated_at_ms = ? WHERE epoch_id = ? AND status IN ('scheduled', 'queued')").run(clock, epoch.epoch_id);
    if (episodeSeverity(episode) === 'High' && state === 'active' && wasPaused) {
      const remaining = Math.max(0, 4 * 60 * 60 * 1000 - accumulated);
      db.prepare("UPDATE notification_slots SET status = 'scheduled', due_at_ms = ?, updated_at_ms = ? WHERE epoch_id = ? AND slot_kind = 'high-repeat' AND status IN ('scheduled', 'cancelled')").run(clock + remaining, clock, epoch.epoch_id);
      const returnSlot = db.prepare("SELECT slot_id FROM notification_slots WHERE epoch_id = ? AND slot_kind = 'snooze-return'").get(epoch.epoch_id);
      if (!returnSlot) {
        const slotId = `slot-${digest({ epochId: epoch.epoch_id, slotKind: 'snooze-return' }).slice(0, 48)}`;
        db.prepare('INSERT INTO notification_slots (slot_id, epoch_id, episode_id, slot_kind, due_at_ms, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(slotId, epoch.epoch_id, episode.episodeId, 'snooze-return', clock, 'scheduled', clock, clock);
      }
    }
    return db.prepare('SELECT * FROM notification_policy_epochs WHERE epoch_id = ?').get(epoch.epoch_id);
  }

  async function clearEpisode(episodeId, clock, binding) {
    db.prepare("UPDATE notification_slots SET status = 'cancelled', updated_at_ms = ? WHERE episode_id = ? AND status IN ('scheduled', 'queued')").run(clock, episodeId);
    const logicalOperationIds = db.prepare(`
      SELECT logical_operation_id FROM notification_emissions
      WHERE episode_id = ? AND logical_operation_id IS NOT NULL AND status NOT IN ('cleared', 'suppressed')
      UNION
      SELECT logical_operation_id FROM notification_slots
      WHERE episode_id = ? AND status = 'emitted' AND logical_operation_id IS NOT NULL
    `).all(episodeId, episodeId).map((row) => row.logical_operation_id).filter((value) => typeof value === 'string' && value !== '');
    if (!logicalOperationIds.length) return true;
    let allCleared = true;
    for (const notificationLogicalOperationId of logicalOperationIds) {
      const clearOperationId = `clear-${digest({ episodeId, notificationLogicalOperationId }).slice(0, 48)}`;
      const existing = db.prepare('SELECT * FROM notification_clear_operations WHERE logical_operation_id = ?').get(clearOperationId);
      if (existing?.status === 'cleared') continue;
      const attemptCount = Number(existing?.attempt_count ?? 0) + 1;
      if (!existing) db.prepare('INSERT INTO notification_clear_operations (logical_operation_id, episode_id, status, attempt_count, updated_at_ms) VALUES (?, ?, ?, ?, ?)').run(clearOperationId, episodeId, 'pending', attemptCount, clock);
      else db.prepare('UPDATE notification_clear_operations SET status = ?, attempt_count = ?, updated_at_ms = ? WHERE logical_operation_id = ?').run('pending', attemptCount, clock, clearOperationId);
      if (!binding?.clear) { allCleared = false; continue; }
      try {
        const result = await binding.clear({ version: 1, logicalOperationId: notificationLogicalOperationId });
        const outcome = result?.status ?? result?.outcome;
        const succeeded = result?.cleared !== false && !['failed', 'partial', 'ambiguous'].includes(outcome);
        db.prepare('UPDATE notification_clear_operations SET status = ?, updated_at_ms = ? WHERE logical_operation_id = ?').run(succeeded ? 'cleared' : outcome === 'partial' ? 'partial' : 'ambiguous', clock, clearOperationId);
        if (succeeded) db.prepare("UPDATE notification_emissions SET status = 'cleared', updated_at_ms = ? WHERE episode_id = ? AND logical_operation_id = ? AND status NOT IN ('suppressed', 'expired')").run(clock, episodeId, notificationLogicalOperationId);
        if (!succeeded) allCleared = false;
      } catch {
        db.prepare('UPDATE notification_clear_operations SET status = ?, updated_at_ms = ? WHERE logical_operation_id = ?').run('ambiguous', clock, clearOperationId);
        allCleared = false;
      }
    }
    return allCleared;
  }

  function captureCurrentOperatorBinding() {
    assertOpen();
    try {
      if (typeof emitter?.bindCurrentOperator !== 'function') return retainedBinding !== undefined;
      const captured = emitter.bindCurrentOperator();
      retainedBinding = captured?.emit && captured?.clear ? captured : undefined;
      return retainedBinding !== undefined;
    } catch { retainedBinding = undefined; return false; }
  }

  async function emitSlot(slot, episode, epoch, currentSettings, clock, binding, kind = episodeKind(episode)) {
    if (!binding?.emit) return false;
    const candidateKind = kind === 'reminder' ? `reminder-${slot.slot_kind}` : `${kind}-${slot.slot_kind}`;
    const identityCandidate = createNotificationCandidate({ episodeId: episode.episodeId, severity: epoch.severity, kind: candidateKind, epochId: epoch.epoch_id, nowMs: clock, genericPreview: currentSettings.genericPreview });
    const existing = db.prepare('SELECT * FROM notification_emissions WHERE emission_id = ?').get(identityCandidate.emissionId);
    if (existing?.status === 'sent') return false;
    const genericPreview = existing ? existing.generic_preview === 1 : currentSettings.genericPreview;
    const identity = createNotificationCandidate({ episodeId: episode.episodeId, severity: epoch.severity, kind: candidateKind, epochId: epoch.epoch_id, nowMs: clock, genericPreview });
    const stableCandidate = existing ? createNotificationCandidate({ episodeId: episode.episodeId, severity: epoch.severity, kind: candidateKind, epochId: epoch.epoch_id, nowMs: existing.emitted_at_ms, genericPreview }) : identity;
    const candidate = stableCandidate;
    if (!validateNotificationCandidate(candidate, { nowMs: clock })) return false;
    if (!existing) db.prepare('INSERT INTO notification_emissions (emission_id, epoch_id, episode_id, logical_operation_id, emitted_at_ms, expires_at_ms, generic_preview, summary_count, status, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(candidate.emissionId, epoch.epoch_id, episode.episodeId, candidate.logicalOperationId, clock, candidate.expiresAtMs, genericPreview ? 1 : 0, 0, 'ambiguous', clock);
    try {
      const result = await binding.emit(candidate);
      const status = result?.status;
      if (status && status !== 'sent') {
        const durableStatus = ['partial', 'failed', 'ambiguous'].includes(status) || status === 'rate-limited' ? (status === 'rate-limited' ? 'failed' : status) : 'suppressed';
        db.prepare('UPDATE notification_emissions SET status = ?, updated_at_ms = ? WHERE emission_id = ?').run(durableStatus, clock, candidate.emissionId);
        return false;
      }
      db.prepare('UPDATE notification_emissions SET status = ?, updated_at_ms = ? WHERE emission_id = ?').run('sent', clock, candidate.emissionId);
      db.prepare('UPDATE notification_slots SET status = ?, logical_operation_id = ?, emission_id = ?, emitted_at_ms = ?, updated_at_ms = ? WHERE slot_id = ?').run('emitted', candidate.logicalOperationId, candidate.emissionId, clock, clock, slot.slot_id);
      return true;
    } catch (error) {
      logger?.warn?.('Command Center notification emission remains retryable.', error);
      return false;
    }
  }

  async function emitQuietSummary(queued, episodes, currentSettings, clock, binding) {
    const eligible = queued.filter((slot) => episodes.some((episode) => episode.episodeId === slot.episode_id && activeEpisode(episode)));
    if (!eligible.length || !binding?.emit) return false;
    const oldest = eligible.slice().sort((left, right) => left.due_at_ms - right.due_at_ms || left.episode_id.localeCompare(right.episode_id))[0];
    const episode = episodes.find((item) => item.episodeId === oldest.episode_id);
    const epoch = db.prepare('SELECT * FROM notification_policy_epochs WHERE epoch_id = ?').get(oldest.epoch_id);
    if (!episode || !epoch) return false;
    const uniqueCount = new Set(eligible.map((slot) => slot.episode_id)).size;
    const summaryEpochId = `quiet-${localDateKey(clock, currentSettings.timeZone)}`;
    const existing = db.prepare('SELECT * FROM notification_emissions WHERE emission_id = ?').get(createNotificationCandidate({ episodeId: episode.episodeId, severity: 'High', kind: 'quiet-summary', epochId: summaryEpochId, nowMs: clock, genericPreview: currentSettings.genericPreview, summaryCount: uniqueCount }).emissionId);
    const genericPreview = existing ? existing.generic_preview === 1 : currentSettings.genericPreview;
    const summaryCount = existing ? existing.summary_count : uniqueCount;
    const candidate = createNotificationCandidate({ episodeId: episode.episodeId, severity: 'High', kind: 'quiet-summary', epochId: summaryEpochId, nowMs: clock, genericPreview, summaryCount });
    if (!validateNotificationCandidate(candidate, { nowMs: clock })) return false;
    if (!existing || existing.status !== 'sent') {
      const stableCandidate = existing ? createNotificationCandidate({ episodeId: episode.episodeId, severity: 'High', kind: 'quiet-summary', epochId: summaryEpochId, nowMs: existing.emitted_at_ms, genericPreview, summaryCount }) : candidate;
      if (!validateNotificationCandidate(stableCandidate, { nowMs: clock })) return false;
      if (!existing) db.prepare('INSERT INTO notification_emissions (emission_id, epoch_id, episode_id, logical_operation_id, emitted_at_ms, expires_at_ms, generic_preview, summary_count, status, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(stableCandidate.emissionId, summaryEpochId, episode.episodeId, stableCandidate.logicalOperationId, stableCandidate.expiresAtMs - ONE_DAY_MS, stableCandidate.expiresAtMs, genericPreview ? 1 : 0, summaryCount, 'ambiguous', clock);
      try {
        const result = await binding.emit(stableCandidate);
        const status = result?.status;
        if (status && status !== 'sent') {
          const durableStatus = ['partial', 'failed', 'ambiguous'].includes(status) ? status : 'suppressed';
          db.prepare('UPDATE notification_emissions SET status = ?, updated_at_ms = ? WHERE emission_id = ?').run(durableStatus, clock, stableCandidate.emissionId);
          return false;
        }
        db.prepare('UPDATE notification_emissions SET status = ?, updated_at_ms = ? WHERE emission_id = ?').run('sent', clock, stableCandidate.emissionId);
      }
      catch { return false; }
    }
    const summaryCandidate = existing && existing.status === 'sent' ? createNotificationCandidate({ episodeId: episode.episodeId, severity: 'High', kind: 'quiet-summary', epochId: summaryEpochId, nowMs: existing.emitted_at_ms, genericPreview, summaryCount }) : candidate;
    for (const slot of eligible) db.prepare('UPDATE notification_slots SET status = ?, logical_operation_id = ?, emission_id = ?, emitted_at_ms = ?, updated_at_ms = ? WHERE slot_id = ?').run('emitted', summaryCandidate.logicalOperationId, summaryCandidate.emissionId, clock, clock, slot.slot_id);
    return true;
  }

  async function reconcile() {
    assertOpen();
    const clock = nowMs(now);
    const currentSettings = getSettings();
    try { attentionService?.list?.({ schemaVersion: 1, now: new Date(clock).toISOString() }); } catch { /* lifecycle reads remain best-effort */ }
    const episodes = attentionService?.allEpisodes?.() ?? [];
    const binding = retainedBinding;
    const activeIds = new Set();
    for (const episode of episodes) {
      const severity = episodeSeverity(episode);
      if (!severity) continue;
      if (activeEpisode(episode)) {
        activeIds.add(episode.episodeId);
        const previous = latestEpoch(episode.episodeId);
        const activationAtMs = previous?.state === 'paused' && severity === 'Reminder' ? clock : previous && SEVERITY_RANK[previous.severity] < SEVERITY_RANK[severity] ? clock : Number.isSafeInteger(Date.parse(episode.attentionSince)) ? Date.parse(episode.attentionSince) : clock;
        const epoch = updateEpoch(createEpoch(episode, severity, activationAtMs, currentSettings, clock), episode, clock);
        const due = rows('notification_slots', "epoch_id = ? AND status IN ('scheduled', 'queued') AND due_at_ms <= ?", [epoch.epoch_id, clock]);
        const queued = [];
        for (const slot of due) {
          const categoryEnabled = epoch.severity === 'Reminder' ? currentSettings.dueReminders : epoch.severity === 'Critical' ? (slot.slot_kind === 'critical-immediate' ? currentSettings.importantItems : currentSettings.criticalRealerts) : currentSettings.importantItems;
          // Settings suppress delivery at the host boundary. Keep the durable
          // slot scheduled so re-enabling a category does not rewrite its
          // fixed policy timing or lose a not-yet-delivered candidate.
          if (!categoryEnabled) continue;
          const quiet = isQuietHours(clock, currentSettings);
          const bypass = slot.slot_kind.startsWith('critical-') || slot.slot_kind === 'reminder-explicit' || slot.slot_kind === 'snooze-return';
          if (!bypass && quiet) { db.prepare("UPDATE notification_slots SET status = 'queued', queued_at_ms = COALESCE(queued_at_ms, ?), updated_at_ms = ? WHERE slot_id = ?").run(clock, clock, slot.slot_id); queued.push(slot); continue; }
          if (!bypass && !quiet && (slot.status === 'queued' || isQuietHours(slot.due_at_ms, currentSettings))) {
            db.prepare("UPDATE notification_slots SET status = 'queued', queued_at_ms = COALESCE(queued_at_ms, ?), updated_at_ms = ? WHERE slot_id = ?").run(clock, clock, slot.slot_id);
            queued.push(slot);
            continue;
          }
          await emitSlot(slot, episode, epoch, currentSettings, clock, binding);
        }
      } else if (episode?.state === 'Snoozed') {
        for (const epoch of rows('notification_policy_epochs', 'episode_id = ?', [episode.episodeId])) updateEpoch(epoch, episode, clock);
        await clearEpisode(episode.episodeId, clock, binding);
      } else {
        for (const epoch of rows('notification_policy_epochs', 'episode_id = ?', [episode.episodeId])) {
          db.prepare("UPDATE notification_policy_epochs SET state = 'terminal', updated_at_ms = ? WHERE epoch_id = ?").run(clock, epoch.epoch_id);
        }
        await clearEpisode(episode.episodeId, clock, binding);
      }
    }
    if (!isQuietHours(clock, currentSettings)) {
      const queued = rows('notification_slots', "status = 'queued'");
      if (currentSettings.quietHoursEnabled) await emitQuietSummary(queued, episodes, currentSettings, clock, binding);
      else for (const slot of queued) {
        const episode = episodes.find((item) => item.episodeId === slot.episode_id);
        const epoch = db.prepare('SELECT * FROM notification_policy_epochs WHERE epoch_id = ?').get(slot.epoch_id);
        if (episode && epoch && activeEpisode(episode)) await emitSlot(slot, episode, epoch, currentSettings, clock, binding);
      }
    }
    db.prepare("UPDATE notification_emissions SET status = 'expired', updated_at_ms = ? WHERE status IN ('sent', 'ambiguous') AND expires_at_ms <= ?").run(clock, clock);
    return Object.freeze({ settings: currentSettings, activeEpisodeIds: Object.freeze([...activeIds]), emitted: rows('notification_emissions'), queued: rows('notification_slots', "status = 'queued'") });
  }

  function inspect() {
    assertOpen();
    return Object.freeze({ settings: getSettings(), epochs: Object.freeze(rows('notification_policy_epochs')), slots: Object.freeze(rows('notification_slots')), emissions: Object.freeze(rows('notification_emissions')), clears: Object.freeze(rows('notification_clear_operations')) });
  }

  return Object.freeze({ getSettings, updateSettings, captureCurrentOperatorBinding, reconcile, inspect, close() { if (!closed) { closed = true; retainedBinding = undefined; db.close(); } } });
}

export { ONE_DAY_MS, UUID_PATTERN };
