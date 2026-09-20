export async function inspectTopicDiscoverability({ metadata, topics, sources, signal }) {
  const destination = await topics.listDestinationVerified();
  const active = metadata.listTopics().filter(topic => topic.lifecycle === 'active' && ['project', 'area', 'resource'].includes(topic.paraCategory));
  const visible = [...Object.values(destination.activeGroups).flat(), ...destination.recovery.filter(topic => topic.lifecycle === 'active' && ['project', 'area', 'resource'].includes(topic.paraCategory))];
  const visibleIds = new Set(visible.map(topic => topic.topicId));
  const recoveryBySourceKind = {};
  for (const topic of destination.recovery) for (const item of topic.recovery.filter(row => row.state === 'required')) recoveryBySourceKind[item.sourceKind] = (recoveryBySourceKind[item.sourceKind] ?? 0) + 1;
  let primaryVerified = 0;
  for (const topic of active) {
    signal?.throwIfAborted();
    try {
      const catalog = await sources.sessionsList({ schemaVersion: 1, topicId: topic.topicId, includeClosed: false });
      if (catalog.conversations.filter(row => row.isPrimary === true && row.status === 'open').length === 1) primaryVerified += 1;
    } catch { /* The aggregate below reports the bounded failure. */ }
  }
  const summary = Object.freeze({ schemaVersion: 1, activeTopics: active.length, visibleTopics: visibleIds.size,
    recoveryTopics: destination.recovery.filter(topic => topic.lifecycle === 'active').length, recoveryBySourceKind,
    primaryConversationsVerified: primaryVerified, primaryConversationsMissing: active.length - primaryVerified,
    widespreadIdentityFailure: active.length > 0 && (recoveryBySourceKind.note_folder ?? 0) >= Math.ceil(active.length / 2) });
  if (active.length === 0 || visibleIds.size !== active.length || summary.recoveryTopics > 0 || primaryVerified !== active.length) {
    throw Object.assign(new Error('topic-discoverability-unhealthy'), { code: 'topic-discoverability-unhealthy', summary });
  }
  return Object.freeze({ phase: 'healthy', ...summary });
}
