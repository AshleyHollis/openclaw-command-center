/** Browser-evaluated synchronization before collecting keyboard focus evidence. */
export async function afterKeyboardPaint(target) {
  const view = target.ownerDocument.defaultView;
  const focused = target.ownerDocument.activeElement;
  const before = { tag: focused?.tagName, id: focused?.id, className: typeof focused?.className === 'string' ? focused.className : undefined };
  // A render opportunity starts transitions; it does not prove they completed,
  // even at reduced-motion durations under a throttled evaluator.
  await new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
  const transitions = focused?.getAnimations().filter((animation) => animation instanceof view.CSSTransition) ?? [];
  if (transitions.length) {
    let timer;
    try {
      await Promise.race([
        Promise.all(transitions.map((animation) => animation.finished.catch((error) => { if (error.name !== 'AbortError') throw error; }))),
        new Promise((_, reject) => { timer = view.setTimeout(() => reject(new Error('Keyboard focus transition did not settle within 1000ms.')), 1000); })
      ]);
    } finally { view.clearTimeout(timer); }
    await new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
  }
  return { before, connected: Boolean(focused?.isConnected), unchanged: target.ownerDocument.activeElement === focused };
}
