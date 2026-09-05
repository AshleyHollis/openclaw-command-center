import assert from 'node:assert/strict';
import { hasKeyboardFocusIndicator } from '../../src/browser-evidence.mjs';
import { afterKeyboardPaint } from './keyboard-paint.mjs';

function readKeyboardFocus(target) {
      const visible = (node) => {
        const style = getComputedStyle(node);
        return !node.disabled && node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
      };
      const tabbable = (node) => visible(node) && (node.tabIndex >= 0 || ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
      const tabbables = [...document.querySelectorAll('*')].filter(tabbable);
      const active = document.activeElement;
      window.__acceptanceKeyboardIds ??= new WeakMap();
      window.__acceptanceKeyboardNextId ??= 0;
      if (active && !window.__acceptanceKeyboardIds.has(active)) window.__acceptanceKeyboardIds.set(active, ++window.__acceptanceKeyboardNextId);
      const nativeComposite = active instanceof HTMLInputElement && ['date', 'datetime-local', 'month', 'time', 'week'].includes(active.type);
      const style = active ? getComputedStyle(active) : null;
      const accessibleName = active?.getAttribute('aria-label')?.trim() || (active?.getAttribute('aria-labelledby') ?? '').split(/\s+/u).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim() || active?.labels?.[0]?.textContent?.trim() || active?.textContent?.trim() || active?.getAttribute('title')?.trim();
      const baseline = window.__acceptanceKeyboardBaselines?.get(active);
      const editableText = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(active.type);
      const nativeTextCaret = editableText && !active.readOnly && style?.caretColor !== 'transparent' && style?.caretColor !== 'rgba(0, 0, 0, 0)';
      return { accessibleName, identity: window.__acceptanceKeyboardIds.get(active), body: active === document.body, disabled: Boolean(active?.disabled), index: tabbables.indexOf(active), name: active?.id || active?.getAttribute?.('aria-label') || active?.tagName || 'unknown', target: active === target, hidden: Boolean(active?.closest?.('[hidden], [inert]')) || active?.getClientRects?.().length === 0, outline: parseFloat(style?.outlineWidth ?? '0') > 0 && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style?.outlineColor) ? style?.outlineStyle : 'none', focusVisible: Boolean(active?.matches(':focus-visible')), boxShadow: style?.boxShadow, baselineBoxShadow: baseline?.boxShadow, backgroundColor: style?.backgroundColor, baselineBackgroundColor: baseline?.backgroundColor, nativeTextCaret, nativeComposite, escapedDialog: Boolean(target?.closest?.('dialog[open]')) && !active?.closest?.('dialog[open]') };
}

function requireVisibleFocus(state) {
  assert.ok(state.accessibleName, `Keyboard traversal reached an unnamed control: ${state.name}`);
  assert.equal(state.body || state.hidden || state.disabled, false, 'Keyboard focus must be on visible, enabled content, not the document body.');
  assert.ok(hasKeyboardFocusIndicator(state), `Keyboard focus must remain visible: ${JSON.stringify(state)}`);
}

export async function assertKeyboardFocus(frame) {
  await frame.locator('body').evaluate(afterKeyboardPaint);
  const state = await frame.evaluate(readKeyboardFocus);
  requireVisibleFocus(state);
  return state;
}

export async function tabTo(locator, { reverse = false, limit } = {}) {
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
    const previousBaselines = window.__acceptanceKeyboardBaselines;
    window.__acceptanceKeyboardBaselines = new WeakMap(tabbables.map((node) => {
      const style = getComputedStyle(node);
      return [node, node === document.activeElement && previousBaselines?.has(node) ? previousBaselines.get(node) : { boxShadow: style.boxShadow, backgroundColor: style.backgroundColor }];
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
  if (order.current === order.target) {
    await locator.evaluate(afterKeyboardPaint);
    requireVisibleFocus(await locator.evaluate(readKeyboardFocus));
    return;
  }
  if (order.current < 0) await locator.evaluate((target) => {
    const body = target.ownerDocument.body;
    const previousTabIndex = body.getAttribute('tabindex');
    body.setAttribute('tabindex', '-1');
    body.focus({ preventScroll: true });
    if (previousTabIndex === null) body.removeAttribute('tabindex');
    else body.setAttribute('tabindex', previousTabIndex);
  });
  const backwards = reverse || (order.current >= 0 && order.target < order.current);
  // Bound the actual path, not the size of an unrelated collection. Native
  // date/time fields have several internal segments sharing one DOM identity.
  const budget = limit ?? order.count * 8 + 1;
  const visited = new Set();
  let previousIdentity; let nativeSegments = 0;
  for (let step = 1; step <= budget; step += 1) {
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
    const paint = await locator.evaluate(afterKeyboardPaint);
    const state = await locator.evaluate(readKeyboardFocus);
    assert.notEqual(state.index, -1, `Sequential keyboard focus left the mounted shell: ${JSON.stringify({ target: order.targetState.name, step, backwards, active: state.name, paint })}`);
    requireVisibleFocus(state);
    assert.equal(state.escapedDialog, false, 'Sequential keyboard focus escaped an open modal dialog.');
    if (state.target) return;
    const sameComposite = state.nativeComposite && previousIdentity === state.identity;
    nativeSegments = sameComposite ? nativeSegments + 1 : 0;
    assert.ok((sameComposite && nativeSegments < 8) || !visited.has(state.identity), `Sequential keyboard traversal cycled before reaching ${order.targetState.name}.`);
    visited.add(state.identity); previousIdentity = state.identity;
  }
  throw new Error(`Sequential keyboard traversal did not reach ${order.targetState.name} within its bounded focus path.`);
}
