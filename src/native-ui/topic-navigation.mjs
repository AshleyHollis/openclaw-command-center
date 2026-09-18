/** Resolve plugin-owned membership, then let OpenClaw own the native Chat view. */
export function createNativeTopicNavigation(host) {
  let generation = 0;
  const requireIdentity = (...values) => {
    if (values.some((value) => typeof value !== 'string' || !value.trim())) throw new Error('Topic Conversation identity is required.');
  };
  const assertCurrentConnection = () => {
    host.signal.throwIfAborted();
    if (!host.connection.connected || !host.connection.canRead) throw new Error('An authenticated readable connection is required.');
  };
  const assertCurrent = (current) => {
    host.signal.throwIfAborted();
    if (current !== generation) throw new DOMException('A newer Topic navigation replaced this request.', 'AbortError');
  };
  async function request(method, params, current) {
    try { return await host.request(method, params); }
    catch (error) { assertCurrent(current); throw error; }
  }
  async function open({ topicId, referenceId, expectedSessionId }, current = ++generation) {
      const target = await resolve({ topicId, referenceId, expectedSessionId }, current);
      // The native Files action opens this exact Chat with its Topic explorer.
      // Older hosts still retain their existing Chat-only navigation contract.
      if (typeof host.sessions.openFiles === 'function') host.sessions.openFiles(target);
      else host.sessions.openChat(target);
      return Object.freeze({ referenceId, sessionId: expectedSessionId });
  }
  async function resolve({ topicId, referenceId, expectedSessionId }, current = ++generation) {
      requireIdentity(topicId, referenceId, expectedSessionId);
      assertCurrentConnection();
      // Native Chat receives only the key issued by the authenticated host
      // resolver. The resolver rechecks the exact persisted Topic link and
      // expected Session identity immediately before navigation.
      const response = await request('command-center.v1.sessions.resolve-native', {
        schemaVersion: 1, topicId, referenceId, expectedSessionId
      }, current);
      assertCurrent(current);
      assertCurrentConnection();
      const target = response?.result ?? response;
      const agent = /^agent:([^:]+):.+$/.exec(target?.sessionKey ?? '');
      if (!agent || Object.keys(target ?? {}).some((key) => key !== 'sessionKey')) {
        throw new Error('The exact Topic Conversation is unavailable.');
      }
      // This identifier is derived only from the exact key returned by the
      // authenticated resolver; it is navigation context, not a lookup key.
      return { sessionKey: target.sessionKey, agentId: agent[1] };
  }
  async function selectOpenConversation(topicId, preferred, current) {
    const response = await request('command-center.v1.sessions.browse', { schemaVersion: 1, topicId, includeClosed: false }, current);
    assertCurrent(current); assertCurrentConnection();
    const catalog = response?.result ?? response;
    const candidates = catalog?.conversations?.filter((item) => item?.status === 'open' && typeof item.referenceId === 'string' && typeof item.sessionId === 'string');
    const primary = candidates?.filter((item) => item.isPrimary === true);
    if (catalog?.topicId !== topicId || primary?.length !== 1) throw new Error('The exact Primary Conversation is unavailable.');
    const match = preferred && candidates.find((item) => item.referenceId === preferred.referenceId && item.sessionId === preferred.sessionId);
    return match ?? primary[0];
  }
  return Object.freeze({
    cancel() { generation += 1; },
    open: (input) => open(input),
    async openPrimary(topicId) {
      requireIdentity(topicId);
      assertCurrentConnection();
      const current = ++generation;
      const primary = await selectOpenConversation(topicId, null, current);
      return open({ topicId, referenceId: primary.referenceId, expectedSessionId: primary.sessionId }, current);
    },
    async openPreferred(topicId, preferred) {
      requireIdentity(topicId);
      const current = ++generation;
      const chosen = await selectOpenConversation(topicId, preferred, current);
      return open({ topicId, referenceId: chosen.referenceId, expectedSessionId: chosen.sessionId }, current);
    },
    async openPrimaryFiles(topicId) {
      requireIdentity(topicId);
      assertCurrentConnection();
      const current = ++generation;
      const primary = await selectOpenConversation(topicId, null, current);
      const target = await resolve({ topicId, referenceId: primary.referenceId, expectedSessionId: primary.sessionId }, current);
      if (typeof host.sessions.openFiles !== 'function') throw new Error('This OpenClaw host cannot open the native Files pane.');
      host.sessions.openFiles({ sessionKey: target.sessionKey, agentId: target.agentId });
    }
  });
}
