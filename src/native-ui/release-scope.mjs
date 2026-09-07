// Keep the browser asset self-contained. The build writes the same projection
// from the root release policy, so native assets never resolve outside the
// host's declared UI asset directory.
export const FIRST_LIVE_FEATURES = Object.freeze({
  topics: true, noteRead: true, conversations: true,
  noteWrite: false, topicProvisioning: false, structuralChanges: false,
  search: false, dashboard: false, scheduler: false, analysis: false,
  notifications: false, noteMaintenance: false
});
