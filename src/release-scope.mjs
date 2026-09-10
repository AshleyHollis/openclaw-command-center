import { SourceServiceError } from './sources/errors.mjs';

// ADR 0004: a build-owned policy, never a caller/configuration opt-in.
export const FIRST_LIVE_FEATURES = Object.freeze({
  topics: true, noteRead: true, conversations: true,
  noteWrite: false, topicProvisioning: false, structuralChanges: false,
  search: false, dashboard: false, scheduler: false, analysis: false,
  notifications: false, noteMaintenance: false
});

export const FIRST_LIVE_COMMANDS = Object.freeze({
  bridge: Object.freeze([
    'command-center.v1.histories.list', 'command-center.v1.histories.read', 'command-center.v1.histories.attachment-read',
    'command-center.v1.sources.status', 'command-center.v1.migration.status',
    'command-center.v1.migration.review-failures', 'command-center.v1.topics.list',
    'command-center.v1.topics.get', 'command-center.v1.topics.recovery.status',
    'command-center.v1.notes.browse', 'command-center.v1.notes.read',
    'command-center.v1.sessions.browse', 'command-center.v1.sessions.navigate', 'command-center.v1.sessions.create',
    'command-center.v1.sessions.resolve-native', 'command-center.v1.sessions.topic-context',
    'command-center.v1.sessions.group-preview', 'command-center.v1.sessions.group'
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
