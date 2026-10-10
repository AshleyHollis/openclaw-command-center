// ENABLED TEST CANDIDATE: isolated fictional qualification only; no production admission.
import { SourceServiceError } from './sources/errors.mjs';

// ADR 0004: a build-owned policy, never a caller/configuration opt-in.
export const FIRST_LIVE_FEATURES = Object.freeze({
  topics: true, noteRead: true, conversations: true, topicDocuments: true,
  noteWrite: false, topicProvisioning: false, structuralChanges: false,
  search: false, topicNoteRecall: true, dashboard: true, scheduler: true, analysis: false,
  notifications: false, noteMaintenance: false, acceptedChatCapture: false, noteProposals: true,
  // Following Attention candidate: native admission prerequisite reviewed; isolated package qualification required before deployment.
  billActions: true, conversationPlans: true
});

// The ownership catalogue deliberately retains deferred tools so their domain
// rules and regression inventory cannot disappear. The sealed first-release
// manifest exposes neither tool; this mapping is the explicit audit bridge
// between those two facts.
export const FIRST_LIVE_DEFERRED_NATIVE_TOOLS = Object.freeze({
  command_center_update_working_note: 'noteMaintenance'
});

export const FIRST_LIVE_COMMANDS = Object.freeze({
  bridge: Object.freeze([
    'command-center.v1.conversation-plans.messages', 'command-center.v1.conversation-plans.track',
    'command-center.v1.conversation-plans.reconcile', 'command-center.v1.conversation-plans.list',
    'command-center.v1.bill-actions.list', 'command-center.v1.bill-actions.read',
    'command-center.v1.bill-actions.admit', 'command-center.v1.bill-actions.handle',
    'command-center.v1.bill-actions.defer', 'command-center.v1.bill-actions.reconcile',
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
    'command-center.v1.open-loops.list', 'command-center.v1.open-loops.get', 'command-center.v1.open-loops.capture',
    'command-center.v1.open-loops.intake-selected', 'command-center.v1.open-loops.decide', 'command-center.v1.open-loops.clarify', 'command-center.v1.open-loops.interpret-clarification', 'command-center.v1.open-loops.resume-follow-up',
    'command-center.v1.open-loops.payment-status',
    'command-center.v1.open-loops.organize',
    'command-center.v1.open-loops.renovation-requirement',
    'command-center.v1.open-loops.renovation-purchase',
    'command-center.v1.open-loops.renovation-purchase-correction',
    'command-center.v1.open-loops.renovation-replacement',
    'command-center.v1.open-loops.renovation-fulfilment',
    'command-center.v1.open-loops.renovation-stage',
    'command-center.v1.open-loops.renovation-stage-prerequisites',
    'command-center.v1.open-loops.renovation-decision-conflict',
    'command-center.v1.open-loops.renovation-decision-revise',
    'command-center.v1.briefings.set-read', 'command-center.v1.routines.decide'
  ]),
  topicAction: Object.freeze(['documents.attachments.list', 'documents.attachment.review', 'documents.attachment.prepare', 'documents.attachment.file', 'documents.attachment.check', 'documents.attachment.reopen', 'conversations.create', 'conversations.creation.inspect', 'conversations.creation.reconcile', 'conversations.creation.acknowledge'])
});

export function assertFirstLiveCommand(surface, command) {
  if (surface === 'bridge' && FIRST_LIVE_FEATURES.acceptedChatCapture &&
      ['command-center.v1.chat-capture.accept', 'command-center.v1.chat-capture.load', 'command-center.v1.chat-capture.replay'].includes(command)) return;
  if (surface === 'bridge' && FIRST_LIVE_FEATURES.noteProposals && ['prepare', 'context', 'publish', 'inspect', 'discard'].some(action => command === `command-center.v1.notes.proposals.${action}`)) return;
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
