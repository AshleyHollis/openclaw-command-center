/**
 * Attach failure handling immediately so a browser teardown cannot turn a
 * missing response into an unhandled rejection before diagnostics are read.
 */
export function observeBrowserResponse(response, recordFailure = () => {}) {
  return Promise.resolve(response).then(
    (value) => ({ observed: true, value }),
    (error) => {
      recordFailure(error);
      return { observed: false, value: undefined };
    }
  );
}

export function hasSuccessfulBrowserResponse(observation) {
  return observation.observed && observation.value.ok();
}

export function observedBrowserResponseStatus(observation) {
  return observation.observed ? observation.value.status() : undefined;
}

/** Recognise focus rendering mechanisms; contrast and layout need their own audits. */
export function hasKeyboardFocusIndicator({ outline = 'none', nativeComposite = false, nativeTextCaret = false, focusVisible = false, boxShadow, baselineBoxShadow, backgroundColor, baselineBackgroundColor }) {
  const changed = (value, baseline) => typeof value === 'string' && typeof baseline === 'string' && value !== baseline;
  const visibleBackground = typeof backgroundColor === 'string' && backgroundColor !== 'transparent' && !/(?:,|\/)\s*0(?:\.0+)?\)$/u.test(backgroundColor);
  return outline !== 'none' || nativeComposite || (focusVisible && (nativeTextCaret ||
    (boxShadow !== 'none' && changed(boxShadow, baselineBoxShadow)) ||
    (visibleBackground && changed(backgroundColor, baselineBackgroundColor))));
}

/** Keep failure diagnostics useful without retaining an unbounded page trace. */
export function recordBounded(collection, value, limit = 100) {
  const finalValueIndex = Math.max(0, limit - 1);
  if (collection.length < finalValueIndex) {
    collection.push(value);
  } else if (collection.length === finalValueIndex) {
    collection.push('[truncated]');
  }
}
