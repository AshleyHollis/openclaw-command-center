/**
 * Attach failure handling immediately so a browser teardown cannot turn a
 * missing response into an unhandled rejection before diagnostics are read.
 */
export function observeBrowserResponse(response, recordFailure) {
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

/** Keep failure diagnostics useful without retaining an unbounded page trace. */
export function recordBounded(collection, value, limit = 100) {
  const finalValueIndex = Math.max(0, limit - 1);
  if (collection.length < finalValueIndex) {
    collection.push(value);
  } else if (collection.length === finalValueIndex) {
    collection.push('[truncated]');
  }
}
