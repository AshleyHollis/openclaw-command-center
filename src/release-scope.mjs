import { SourceServiceError } from './sources/errors.mjs';

// ADR 0004: a build-owned policy, never a caller/configuration opt-in.
export const FIRST_LIVE_FEATURES = Object.freeze({
  topics: true, noteRead: true, conversations: true, topicDocuments: false,
  noteWrite: false, topicProvisioning: false, structuralChanges: false,
  search: false, dashboard: true, scheduler: true, analysis: false,
  notifications: false, noteMaintenance: false
});

// The ownership catalogue deliberately retains deferred tools so their domain
// rules and regression inventory cannot disappear. The sealed first-release
// manifest exposes neither tool; this mapping is the explicit audit bridge
// between those two facts.
export const FIRST_LIVE_DEFERRED_NATIVE_TOOLS = Object.freeze({
  command_center_file_topic_attachment: 'topicDocuments',
  command_center_update_working_note: 'noteMaintenance'
});

export const FIRST_LIVE_COMMANDS = Object.freeze({
  bridge: Object.freeze([
    'command-center.v1.histories.list', 'command-center.v1.histories.read', 'command-center.v1.histories.attachment-read',
    'command-center.v1.sources.status', 'command-center.v1.migration.status',
    'command-center.v1.migration.review-failures', 'command-center.v1.topics.list',
    'command-center.v1.topics.get', 'command-center.v1.topics.recovery.status',
    'command-center.v1.topics.recovery.verify',
    'command-center.v1.notes.browse', 'command-center.v1.notes.read',
    'command-center.v1.sessions.browse', 'command-center.v1.sessions.navigate', 'command-center.v1.sessions.create',
    'command-center.v1.sessions.resolve-native', 'command-center.v1.sessions.topic-context',
    'command-center.v1.sessions.group-preview', 'command-center.v1.sessions.group',
    'command-center.v1.sessions.assign-topic',
    'command-center.v1.reminders.list', 'command-center.v1.reminders.create',
    'command-center.v1.reminders.snooze', 'command-center.v1.reminders.complete',
    'command-center.v1.schedules.list', 'command-center.v1.schedules.get',
    'command-center.v1.schedules.create', 'command-center.v1.schedules.update',
    'command-center.v1.schedules.set-enabled', 'command-center.v1.schedules.run',
    'command-center.v1.attention.list', 'command-center.v1.attention.get',
    'command-center.v1.attention.act', 'command-center.v1.activity.list',
    'command-center.v1.activity.get', 'command-center.v1.dashboard.get',
    'command-center.v1.open-loops.list', 'command-center.v1.open-loops.get',
    'command-center.v1.open-loops.intake-selected', 'command-center.v1.open-loops.decide',
    'command-center.v1.open-loops.payment-status',
    'command-center.v1.open-loops.renovation-requirement',
    'command-center.v1.open-loops.renovation-purchase',
    'command-center.v1.open-loops.renovation-purchase-correction',
    'command-center.v1.open-loops.renovation-replacement',
    'command-center.v1.open-loops.renovation-fulfilment',
    'command-center.v1.open-loops.renovation-stage',
    'command-center.v1.open-loops.renovation-stage-prerequisites',
    'command-center.v1.open-loops.renovation-decision-conflict',
    'command-center.v1.open-loops.renovation-decision-revise'
  ]),
  topicAction: Object.freeze(['conversations.create', 'conversations.creation.inspect', 'conversations.creation.reconcile', 'conversations.creation.acknowledge'])
});

export function assertFirstLiveCommand(surface, command) {
  if (!Object.hasOwn(FIRST_LIVE_COMMANDS, surface) || !FIRST_LIVE_COMMANDS[surface].includes(command)) {
    throw new SourceServiceError('feature-unavailable', 'This feature is not available in the first live release.', { retryable: false });
  }
}

export function assertFirstLiveTopicAction(body) {
  assertFirstLiveCommand('topicAction', body?.action);
  if (Object.hasOwn(body, 'authoritativeSession')) {
    throw new SourceServiceError('invalid-request', 'Conversation creation must use the authenticated native host, not a caller-supplied Session result.');
  }
}
