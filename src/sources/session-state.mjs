export const SESSION_STATUSES = Object.freeze(['open', 'closed']);

export function sessionStateFor(metadata, referenceId) {
  return metadata?.getSessionState?.(referenceId) ?? null;
}
export function assertPrimaryMayClose(state) {
  if (state?.isPrimary === true) {
    const error = new Error('The Primary Session cannot be closed until another Session is Primary.');
    error.code = 'primary-session';
    throw error;
  }
}
