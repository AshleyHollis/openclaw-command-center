import assert from 'node:assert/strict';
import { hasKeyboardFocusIndicator } from '../../src/browser-evidence.mjs';
import { afterKeyboardPaint } from './keyboard-paint.mjs';

function readKeyboardFocus(target, prepare = false) {
  const parent = (node) => node?.assignedSlot ?? node?.parentElement ?? node?.getRootNode()?.host ?? null;
  const ancestor = (node, selector) => {
    for (let current = node; current; current = parent(current)) if (current.matches?.(selector)) return current;
    return null;
  };
  const visible = (node) => {
    const style = getComputedStyle(node);
    return !node.matches(':disabled') && node.getClientRects().length > 0 && style.display !== 'none'
      && !['hidden', 'collapse'].includes(style.visibility) && !ancestor(node, '[hidden], [inert]');
  };
  const tabbable = (node) => visible(node) && (node.tabIndex >= 0 || ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
  const tabbables = [];
  const visit = (node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (tabbable(node)) tabbables.push(node);
    // Hosts and slots establish composed order; do not also walk undistributed
    // light children or replaced slot fallback. Closed roots remain opaque.
    if (node.shadowRoot) {
      if (node.hasAttribute('tabindex') && node.tabIndex < 0) return;
      for (const child of node.shadowRoot.children) visit(child);
    } else if (node instanceof HTMLSlotElement) {
      for (const child of node.assignedElements({ flatten: true })) visit(child);
    } else {
      for (const child of node.children) visit(child);
    }
  };
  visit(document.documentElement);
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (prepare) {
    const previousBaselines = window.__acceptanceKeyboardBaselines;
    window.__acceptanceKeyboardBaselines = new WeakMap(tabbables.map((node) => {
      const style = getComputedStyle(node);
      return [node, node === active && previousBaselines?.has(node) ? previousBaselines.get(node) : { boxShadow: style.boxShadow, backgroundColor: style.backgroundColor }];
    }));
    const hiddenAncestor = ancestor(target, '[hidden], [inert]');
    return {
      count: tabbables.length,
      current: tabbables.indexOf(active),
      target: tabbables.indexOf(target),
      inDialog: Boolean(ancestor(target, 'dialog[open]')),
      targetState: {
        name: target.id || target.getAttribute('aria-label') || target.getAttribute('name') || target.tagName,
        disabled: target.matches(':disabled'), tabIndex: target.tabIndex, rects: target.getClientRects().length,
        hiddenAncestor: hiddenAncestor?.id || hiddenAncestor?.tagName || null,
        display: getComputedStyle(target).display, visibility: getComputedStyle(target).visibility
      }
    };
  }
  window.__acceptanceKeyboardIds ??= new WeakMap();
  window.__acceptanceKeyboardNextId ??= 0;
  if (active && !window.__acceptanceKeyboardIds.has(active)) window.__acceptanceKeyboardIds.set(active, ++window.__acceptanceKeyboardNextId);
  const focusOrder = tabbables.map(node => {
    if (!window.__acceptanceKeyboardIds.has(node)) window.__acceptanceKeyboardIds.set(node, ++window.__acceptanceKeyboardNextId);
    return window.__acceptanceKeyboardIds.get(node);
  }).join(',');
  const nativeComposite = active instanceof HTMLInputElement && ['date', 'datetime-local', 'month', 'time', 'week'].includes(active.type);
  const style = active ? getComputedStyle(active) : null;
  const accessibleName = active?.getAttribute('aria-label')?.trim() || (active?.getAttribute('aria-labelledby') ?? '').split(/\s+/u).map((id) => active.getRootNode().getElementById(id)?.textContent?.trim() ?? '').join(' ').trim() || active?.labels?.[0]?.textContent?.trim() || active?.textContent?.trim() || active?.getAttribute('title')?.trim();
  const baseline = window.__acceptanceKeyboardBaselines?.get(active);
  const editableText = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(active.type);
  const nativeTextCaret = editableText && !active.readOnly && style?.caretColor !== 'transparent' && style?.caretColor !== 'rgba(0, 0, 0, 0)';
  const targetDialog = ancestor(target, 'dialog[open]');
  return { focusOrder, accessibleName, identity: window.__acceptanceKeyboardIds.get(active), body: active === document.body, disabled: Boolean(active?.matches(':disabled')), index: tabbables.indexOf(active), name: active?.id || active?.getAttribute?.('aria-label') || active?.tagName || 'unknown', target: active === target, hidden: !active || !visible(active), outline: parseFloat(style?.outlineWidth ?? '0') > 0 && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style?.outlineColor) ? style?.outlineStyle : 'none', focusVisible: Boolean(active?.matches(':focus-visible')), boxShadow: style?.boxShadow, baselineBoxShadow: baseline?.boxShadow, backgroundColor: style?.backgroundColor, baselineBackgroundColor: baseline?.backgroundColor, nativeTextCaret, nativeComposite, escapedDialog: Boolean(targetDialog) && ancestor(active, 'dialog[open]') !== targetDialog };
}

function requireVisibleFocus(state, indicatorDeferred = false) {
  assert.ok(state.accessibleName, `Keyboard traversal reached an unnamed control: ${state.name}`);
  assert.equal(state.body || state.hidden || state.disabled, false, 'Keyboard focus must be on visible, enabled content, not the document body.');
  assert.ok(indicatorDeferred || hasKeyboardFocusIndicator(state), `Keyboard focus must remain visible: ${JSON.stringify(state)}`);
}

export async function assertKeyboardFocus(frame) {
  await frame.locator('body').evaluate(afterKeyboardPaint);
  const state = await frame.evaluate(readKeyboardFocus);
  requireVisibleFocus(state);
  return state;
}

export async function tabTo(locator, { reverse = false, limit, deferredIndicator } = {}) {
  if (deferredIndicator) assert.equal(typeof deferredIndicator.record, 'function', 'A focus-indicator deferral must be recorded.');
  await locator.waitFor({ state: 'visible' });
  const page = locator.page();
  const order = await locator.evaluate(readKeyboardFocus, true);
  assert.notEqual(order.target, -1, `Requested keyboard target is absent from the sequential focus order: ${JSON.stringify(order.targetState)}`);
  if (order.current === order.target) {
    await locator.evaluate(afterKeyboardPaint);
    const state = await locator.evaluate(readKeyboardFocus);
    requireVisibleFocus(state);
    assert.equal(state.target, true, 'Focus must remain on the exact requested keyboard target after paint.');
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
  const traversal = [];
  let previousIdentity; let nativeSegments = 0;
  for (let step = 1; step <= budget; step += 1) {
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
    const paint = await locator.evaluate(afterKeyboardPaint);
    const state = await locator.evaluate(readKeyboardFocus);
    assert.notEqual(state.index, -1, `Sequential keyboard focus left the mounted shell: ${JSON.stringify({ target: order.targetState.name, step, backwards, active: state.name, paint })}`);
    if (traversal.length < 64) traversal.push({ step, name: state.name, index: state.index, identity: state.identity, target: state.target, paint });
    // An explicitly scoped release deferral may cover an intermediate stop,
    // never the requested target, names, visibility, ordering or modal safety.
    let indicatorDeferred = false;
    if (deferredIndicator && !state.target && state.focusVisible && !hasKeyboardFocusIndicator(state)
      && await deferredIndicator.locator.count() === 1) {
      indicatorDeferred = await deferredIndicator.locator.evaluate((node, identity) => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active === node && window.__acceptanceKeyboardIds?.get(node) === identity;
      }, state.identity);
    }
    requireVisibleFocus(state, indicatorDeferred);
    if (indicatorDeferred) deferredIndicator.record();
    assert.equal(state.escapedDialog, false, 'Sequential keyboard focus escaped an open modal dialog.');
    if (state.target) return;
    const sameComposite = state.nativeComposite && previousIdentity === state.identity;
    nativeSegments = sameComposite ? nativeSegments + 1 : 0;
    // Closing a keyboard-opened popup legitimately returns to its trigger.
    // A cycle repeats the focus destination AND the available sequential order.
    const visit = `${state.identity}:${state.focusOrder}`;
    assert.ok((sameComposite && nativeSegments < 8) || !visited.has(visit), `Sequential keyboard traversal cycled before reaching ${order.targetState.name}: ${JSON.stringify({ order, backwards, traversal })}`);
    visited.add(visit); previousIdentity = state.identity;
  }
  throw new Error(`Sequential keyboard traversal did not reach ${order.targetState.name} within its bounded focus path.`);
}
