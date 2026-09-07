/** Close an open-list row through the supplied real pointer/keyboard driver. */
export async function closeOpenConversation(row, { activate, keyboard, timeout }) {
  await activate(row.getByRole('button', { name: 'Close', exact: true }), keyboard);
  // Enter/click finishes before the asynchronous mutation and catalog readback.
  // That readback legitimately moves focus to the filter when removing the row.
  // Do not start a new keyboard traversal with a stale pre-readback focus order.
  await row.waitFor({ state: 'detached', timeout });
}
