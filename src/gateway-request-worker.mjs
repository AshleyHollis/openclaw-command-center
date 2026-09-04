function stoppedError() {
  return Object.assign(new Error('The trusted Gateway request worker is stopped.'), { code: 'gateway-worker-stopped' });
}

export function createGatewayRequestWorker({ gateway } = {}) {
  if (typeof gateway?.request !== 'function') throw new TypeError('A Gateway request capability is required.');

  const pending = [];
  let wake;
  let stopped = false;
  let stopPromise;

  const waitForWork = () => new Promise((resolve) => { wake = resolve; });
  const worker = (async () => {
    while (!stopped) {
      if (pending.length === 0) {
        await waitForWork();
        continue;
      }
      const item = pending.shift();
      try {
        item.resolve(await gateway.request(item.method, item.params, item.options));
      } catch (error) {
        item.reject(error);
      }
    }
    const error = stoppedError();
    for (const item of pending.splice(0)) item.reject(error);
  })();

  return Object.freeze({
    request(method, params, options) {
      if (stopped) return Promise.reject(stoppedError());
      const result = new Promise((resolve, reject) => pending.push({ method, params, options, resolve, reject }));
      wake?.();
      wake = undefined;
      return result;
    },
    close() {
      if (stopPromise) return stopPromise;
      stopped = true;
      wake?.();
      wake = undefined;
      stopPromise = worker;
      return stopPromise;
    }
  });
}
