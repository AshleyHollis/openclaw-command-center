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
      requireIdentity(topicId, referenceId, expectedSessionId);
      assertCurrentConnection();
      const response = await request('command-center.v1.sessions.navigate', {
        schemaVersion: 1, topicId, referenceId, nativeChat: true
      }, current);
      assertCurrent(current);
      assertCurrentConnection();
      const target = response?.result ?? response;
      const agent = /^agent:([^:]+):.+$/.exec(target?.sessionKey ?? '');
      if (!agent || target?.sessionId !== expectedSessionId || target?.sourceReference?.topicId !== topicId || target?.sourceReference?.referenceId !== referenceId) {
        throw new Error('The exact Topic Conversation is unavailable.');
      }
      host.sessions.open({ sessionKey: target.sessionKey, agentId: agent[1] });
  }
  return Object.freeze({
    cancel() { generation += 1; },
    open: (input) => open(input),
    async openPrimary(topicId) {
      requireIdentity(topicId);
      assertCurrentConnection();
      const current = ++generation;
      const response = await request('command-center.v1.sessions.browse', { schemaVersion: 1, topicId, includeClosed: false }, current);
      assertCurrent(current);
      assertCurrentConnection();
      const catalog = response?.result ?? response;
      const primary = catalog?.conversations?.filter((item) => item.isPrimary === true && item.status === 'open');
      // The public catalog owns Topic scope; its sanitized rows omit topicId.
      if (catalog?.topicId !== topicId || primary?.length !== 1) throw new Error('The exact Primary Conversation is unavailable.');
      return open({ topicId, referenceId: primary[0].referenceId, expectedSessionId: primary[0].sessionId }, current);
    }
  });
}
