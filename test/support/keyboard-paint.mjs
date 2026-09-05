/** Browser-evaluated synchronization before collecting keyboard focus evidence. */
export async function afterKeyboardPaint(target) {
  const view = target.ownerDocument.defaultView;
  // Even reduced-motion transitions start at their old value until a render.
  // Cross a paint opportunity, without disabling styles or accepting a retry.
  await new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
}
