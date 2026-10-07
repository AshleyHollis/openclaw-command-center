// Native transient requests are the only admission evidence. Workboard status,
// progress_card, notifications and prose never become human-action requests.
export async function readPlanHumanRequests({ card, nativeRequest, assertCurrent, now = Date.now }) {
  assertCurrent();
  if (card.status === 'done' || !card.sessionKey?.trim() || !card.runId?.trim()) return { availability: 'available', eligible: false, requests: [] };
  const matches = request => request.sessionKey === card.sessionKey && request.runId === card.runId;
  const pending = request => typeof request.id === 'string' && Number.isFinite(request.createdAtMs) && Number.isFinite(request.expiresAtMs) && request.expiresAtMs > now();
  try {
    const questions = await nativeRequest('question.list', {}); assertCurrent();
    const approvals = await nativeRequest('exec.approval.list', {}); assertCurrent();
    if (!Array.isArray(questions?.questions) || !Array.isArray(approvals)) throw new Error('Native human requests unavailable');
    const requests = [];
    for (const request of questions.questions) if (request.status === 'pending' && matches(request) && pending(request)) requests.push({ id: request.id, kind: 'question', createdAtMs: request.createdAtMs, expiresAtMs: request.expiresAtMs });
    for (const request of approvals) if (request.approvalKind === 'exec' && matches(request.request ?? {}) && pending(request)) requests.push({ id: request.id, kind: 'execution-approval', createdAtMs: request.createdAtMs, expiresAtMs: request.expiresAtMs });
    return { availability: 'available', eligible: requests.length > 0, requests };
  } catch {
    assertCurrent(); return { availability: 'unavailable', eligible: false, requests: [] };
  }
}
