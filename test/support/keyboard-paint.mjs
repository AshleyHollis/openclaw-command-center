/** Browser-evaluated synchronization before collecting keyboard focus evidence. */
export async function afterKeyboardPaint(target) {
  const view = target.ownerDocument.defaultView;
  const focused = target.ownerDocument.activeElement;
  const before = { tag: focused?.tagName, id: focused?.id, className: typeof focused?.className === 'string' ? focused.className : undefined };
  // Even reduced-motion transitions start at their old value until a render.
  // Cross a paint opportunity, without disabling styles or accepting a retry.
  await new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
  return { before, connected: Boolean(focused?.isConnected), unchanged: target.ownerDocument.activeElement === focused };
}
