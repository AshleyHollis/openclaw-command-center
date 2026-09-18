/** Bounded frame waits preserve request callsites and distinguish terminal sockets from timeouts. */
export function createGatewayFrameWaiter(socket, { method, signal, requestSite }) {
  const frames = [];
  return (predicate, timeoutMs = 10_000, phase = 'connect-response') => new Promise((resolve, reject) => {
    const failure = (detail) => new Error(`Authenticated Gateway ${phase} ${detail} for ${method}.`, { cause: requestSite });
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const inspect = (frame) => { if (predicate(frame)) { cleanup(); resolve(frame); return true; } return false; };
    const onMessage = (event) => { let frame; try { frame = JSON.parse(String(event.data)); } catch { return; } frames.push(frame); inspect(frame); };
    const onClose = (event) => fail(failure(`closed (code=${Number.isInteger(event.code) ? event.code : 'unknown'}, clean=${event.wasClean === true})`));
    const onError = () => fail(failure('socket failed'));
    const onAbort = () => fail(signal.reason ?? failure('aborted'));
    const timer = setTimeout(() => fail(failure(`timed out after ${timeoutMs} ms`)), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    if (socket.readyState >= 2) { fail(failure('socket was already closed')); return; }
    for (const frame of frames) if (inspect(frame)) return;
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
