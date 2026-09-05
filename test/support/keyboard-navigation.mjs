import assert from 'node:assert/strict';
import { hasKeyboardFocusIndicator } from '../../src/browser-evidence.mjs';
import { afterKeyboardPaint } from './keyboard-paint.mjs';

export async function tabTo(locator, { reverse = false, limit = 240 } = {}) {
  await locator.waitFor({ state: 'visible' });
  const page = locator.page();
  const order = await locator.evaluate((target) => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      return !node.disabled && node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
    };
    // Use native tabIndex semantics, including implicit controls such as summary.
    const tabbable = (node) => visible(node) && (node.tabIndex >= 0 || ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
    const tabbables = [...document.querySelectorAll('*')].filter(tabbable);
    window.__acceptanceKeyboardBaselines = new WeakMap(tabbables.map((node) => {
      const style = getComputedStyle(node);
      return [node, { boxShadow: style.boxShadow, backgroundColor: style.backgroundColor }];
    }));
    return {
      count: tabbables.length,
      current: tabbables.indexOf(document.activeElement),
      target: tabbables.indexOf(target),
      inDialog: Boolean(target.closest('dialog[open]')),
      targetState: {
        name: target.id || target.getAttribute('aria-label') || target.getAttribute('name') || target.tagName,
        disabled: Boolean(target.disabled),
        tabIndex: target.tabIndex,
        rects: target.getClientRects().length,
        hiddenAncestor: target.closest('[hidden], [inert]')?.id || target.closest('[hidden], [inert]')?.tagName || null,
        display: getComputedStyle(target).display,
        visibility: getComputedStyle(target).visibility
      }
    };
  });
  assert.notEqual(order.target, -1, `Requested keyboard target is absent from the sequential focus order: ${JSON.stringify(order.targetState)}`);
  if (order.current === order.target) return;
  if (order.current < 0) await locator.evaluate((target) => {
    const body = target.ownerDocument.body;
    const previousTabIndex = body.getAttribute('tabindex');
    body.setAttribute('tabindex', '-1');
    body.focus({ preventScroll: true });
    if (previousTabIndex === null) body.removeAttribute('tabindex');
    else body.setAttribute('tabindex', previousTabIndex);
  });
  const backwards = reverse || (order.current >= 0 && order.target < order.current);
  assert.ok(order.count <= limit, 'Sequential keyboard traversal exceeded its bounded focus path.');
  const invisibleFocus = [];
  for (let step = 1; step <= limit; step += 1) {
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
    const paint = await locator.evaluate(afterKeyboardPaint);
    const state = await locator.evaluate((target) => {
      const visible = (node) => {
        const style = getComputedStyle(node);
        return !node.disabled && node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
      };
      const tabbable = (node) => visible(node) && (node.tabIndex >= 0 || ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
      const tabbables = [...document.querySelectorAll('*')].filter(tabbable);
      const active = document.activeElement;
      const nativeComposite = active instanceof HTMLInputElement && ['date', 'datetime-local', 'month', 'time', 'week'].includes(active.type);
      const style = active ? getComputedStyle(active) : null;
      const baseline = window.__acceptanceKeyboardBaselines?.get(active);
      const editableText = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(active.type);
      const nativeTextCaret = editableText && !active.readOnly && style?.caretColor !== 'transparent' && style?.caretColor !== 'rgba(0, 0, 0, 0)';
      return { index: tabbables.indexOf(active), name: active?.id || active?.getAttribute?.('aria-label') || active?.tagName || 'unknown', target: active === target, hidden: Boolean(active?.closest?.('[hidden], [inert]')) || active?.getClientRects?.().length === 0, outline: style?.outlineStyle ?? 'none', focusVisible: Boolean(active?.matches(':focus-visible')), boxShadow: style?.boxShadow, baselineBoxShadow: baseline?.boxShadow, backgroundColor: style?.backgroundColor, baselineBackgroundColor: baseline?.backgroundColor, nativeTextCaret, nativeComposite, escapedDialog: Boolean(target.closest('dialog[open]')) && !active?.closest?.('dialog[open]') };
    });
    assert.notEqual(state.index, -1, `Sequential keyboard focus left the mounted shell: ${JSON.stringify({ target: order.targetState.name, step, backwards, active: state.name, paint })}`);
    assert.equal(state.hidden, false, 'Sequential keyboard focus entered hidden or inert content.');
    if (!hasKeyboardFocusIndicator(state)) {
      const control = await locator.evaluate(() => {
        const active = document.activeElement;
        return { tag: active?.tagName, className: active?.className, role: active?.getAttribute('role'), contentEditable: active?.isContentEditable };
      });
      invisibleFocus.push({ ...control, ...state });
    }
    assert.equal(state.escapedDialog, false, 'Sequential keyboard focus escaped an open modal dialog.');
    if (state.target) {
      assert.deepEqual(invisibleFocus, [], `Sequential keyboard focus must remain visible throughout the path: ${JSON.stringify(invisibleFocus)}`);
      return;
    }
  }
  throw new Error(`Sequential keyboard traversal did not reach ${await locator.getAttribute('id') || await locator.getAttribute('aria-label') || 'the requested control'}.`);
}
