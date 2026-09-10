/** Operator-triggered setup through the domain owner; never runs on activation. */
export function createTopicGroupSetup({ host, document, topicId, signal, presented }) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn--sm';
  button.textContent = 'Organize Conversations in native group';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const container = document.createElement('div'); container.append(button, status);
  let busy = false;
  let generation = 0;
  const allowed = () => !signal.aborted && presented() && host.connection.connected && host.connection.canRead && host.connection.canWrite;
  const sync = () => { if (!allowed()) generation++; button.disabled = busy || !allowed(); };
  const unsubscribe = host.subscribe(sync);
  button.addEventListener('click', async () => {
    if (!allowed() || busy) return;
    const pending = ++generation;
    const current = () => pending === generation && allowed();
    busy = true; sync(); status.textContent = 'Checking existing Topic Conversations…';
    let applied = 0;
    try {
      const response = await host.request('command-center.v1.sessions.group-preview', { schemaVersion: 1, topicId });
      if (!current()) return;
      const plan = response?.result ?? response;
      if (plan?.topicId !== topicId || !Array.isArray(plan.members) || !Number.isSafeInteger(plan.revision) || !plan.name) throw new Error('The exact group setup plan is unavailable.');
      const eligible = plan.members.filter(member => member.eligible === true);
      for (const member of eligible) {
        if (!current()) return;
        status.textContent = `Organizing ${applied + 1} of ${eligible.length} Conversations…`;
        const logicalOperationId = crypto.randomUUID();
        const response = await host.request('command-center.v1.sessions.group', { schemaVersion: 1, topicId, logicalOperationId,
          referenceId: member.referenceId, expectedSessionId: member.sessionId, expectedLifecycleRevision: member.lifecycleRevision,
          expectedTopicRevision: plan.revision, name: plan.name });
        if (!current()) return;
        const receipt = response?.result ?? response;
        if (receipt?.status !== 'applied' || receipt.logicalOperationId !== logicalOperationId || receipt.value?.referenceId !== member.referenceId || receipt.value?.sessionId !== member.sessionId || receipt.value?.topicId !== topicId || receipt.value?.name !== plan.name) throw new Error('Grouping has an uncertain result. Inspect native Sessions before running setup again.');
        applied++;
      }
      await host.sessions.refresh();
      if (current()) status.textContent = `${applied} Conversations organized. ${plan.members.length - eligible.length} left unchanged. Existing groups and Notes bindings were preserved.`;
    } catch (error) {
      if (current()) status.textContent = `${applied} Conversations confirmed. Setup stopped: ${host.redact(error?.message || 'outcome unknown')}. Inspect native Sessions before trying again.`;
    } finally { busy = false; if (!signal.aborted) sync(); }
  }, { signal });
  sync();
  return { container, dispose() { generation++; unsubscribe(); } };
}
