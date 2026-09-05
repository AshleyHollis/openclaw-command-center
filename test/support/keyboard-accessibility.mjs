import assert from 'node:assert/strict';
import { assertKeyboardFocus, tabTo } from './keyboard-navigation.mjs';

// Shared real-browser input and accessibility audit policy. Mobile qualification
// is opt-in; keyboard, names, focus, dialogs and overflow remain desktop gates.
export async function assertNoFrameOverflow(frame, label) {
  const audit = await frame.evaluate(() => {
    const selectors = ['html', 'body', 'main', '#dashboard', '.dashboard-panel', '#topic-groups', '.topic-group', '#topic-exceptions', '#topic-workspace', '.workspace-layout', '.workspace-layout > [data-pane]', 'dialog[open]', '.evidence-scroll', '.card-list', '#activity', '#conversation-list', '#chat-messages', '#notes-tree', '.note-editor', '.markdown-preview', '.search-grid', '#notes-results', '#conversations-results', '#workspace-notes-results', '#workspace-conversations-results', '#topic-review-groups'];
    const nodes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
    const visible = nodes.filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]') && node.clientWidth > 0;
    });
    return {
      checked: visible.map((node) => node.id || node.getAttribute('data-pane') || node.className || node.tagName),
      overflowing: visible.filter((node) => node.scrollWidth > node.clientWidth).map((node) => ({ name: node.id || node.getAttribute('data-pane') || node.className || node.tagName, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }))
    };
  });
  assert.ok(audit.checked.length > 0, `${label} did not audit any visible layout containers`);
  assert.deepEqual(audit.overflowing, [], `${label} has pane-level horizontal overflow`);
}

export async function activate(locator, keyboard = false, key = 'Enter') {
  if (keyboard) {
    await locator.scrollIntoViewIfNeeded();
    await tabTo(locator);
    await locator.page().keyboard.press(key);
  }
  else await locator.click();
}

export async function enterText(locator, value, keyboard = false) {
  if (!keyboard) return locator.fill(value);
  await tabTo(locator);
  await locator.page().keyboard.press('ControlOrMeta+A');
  await locator.page().keyboard.type(value);
}

export async function chooseOption(locator, value, keyboard = false) {
  if (!keyboard) return locator.selectOption(value);
  const index = await locator.locator('option').evaluateAll((options, target) => options.findIndex((option) => option.value === target), value);
  assert.ok(index >= 0, `Missing keyboard-select option ${value}`);
  await tabTo(locator);
  await locator.page().keyboard.press('Home');
  for (let position = 0; position < index; position += 1) await locator.page().keyboard.press('ArrowDown');
  await locator.page().keyboard.press('Enter');
  assert.equal(await locator.inputValue(), value);
}

export async function auditDynamicAccessibilityState(frame, page, width, label, keyboard) {
  const responsive = await assertResponsiveFrame(frame, page, width);
  if (keyboard) await assertKeyboardFocus(frame);
  const state = await frame.evaluate((keyboardMode) => {
    const visible = (node) => node.getClientRects().length > 0 && !node.closest('[hidden], [inert]') && getComputedStyle(node).visibility !== 'hidden';
    const modal = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].filter(visible).at(-1);
    const accessibleLabel = (node) => node.getAttribute('aria-label')?.trim() || (node.getAttribute('aria-labelledby') ?? '').split(/\s+/u).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
    const active = document.activeElement;
    const style = active instanceof HTMLElement ? getComputedStyle(active) : null;
    return {
      modalLabelled: !modal || ((modal instanceof HTMLDialogElement && modal.matches(':modal') || modal.getAttribute('aria-modal') === 'true') && Boolean(accessibleLabel(modal))),
      focusInModal: !modal || modal.contains(active),
      focusVisible: !keyboardMode || (active instanceof HTMLElement && active !== document.body && style?.outlineStyle !== 'none'),
      liveRegions: [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')].map((node) => node.textContent?.trim() ?? ''),
      colorIndependent: [...document.querySelectorAll('[aria-selected], [aria-current], [aria-checked], [data-status]')].filter((node) => {
        const nodeStyle = getComputedStyle(node);
        return visible(node) && nodeStyle.display !== 'none';
      }).every((node) => Boolean(node.textContent?.trim() || accessibleLabel(node))),
      reducedMotion: !matchMedia('(prefers-reduced-motion: reduce)').matches || [...document.querySelectorAll('*')].every((node) => {
        const nodeStyle = getComputedStyle(node);
        return parseFloat(nodeStyle.animationDuration || '0') <= 0.001 && parseFloat(nodeStyle.transitionDuration || '0') <= 0.001 && nodeStyle.scrollBehavior !== 'smooth';
      }),
      reducedMotionPreference: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forcedColorsPreference: matchMedia('(forced-colors: active)').matches,
      headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .filter((node) => {
          const headingStyle = getComputedStyle(node);
          return headingStyle.display !== 'none' && headingStyle.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
        })
        .map((node) => Number(node.tagName.slice(1)))
    };
  }, keyboard);
  assert.equal(state.modalLabelled, true, `${label} dialog is not labelled`);
  assert.equal(state.focusInModal, true, `${label} focus escaped its modal dialog`);
  assert.equal(state.focusVisible, true, `${label} has no visible keyboard focus`);
  assert.ok(state.liveRegions.length > 0, `${label} has no live status announcement region`);
  assert.equal(state.colorIndependent, true, `${label} conveys state only by color`);
  assert.equal(state.reducedMotion, true, `${label} retains motion under reduced-motion preference`);
  for (let index = 1; index < state.headings.length; index += 1) assert.ok(state.headings[index] - state.headings[index - 1] <= 1, `${label} skips a heading level`);
  return Object.freeze({ label, colorIndependent: state.colorIndependent, reducedMotion: state.reducedMotion, reducedMotionPreference: state.reducedMotionPreference, forcedColorsPreference: state.forcedColorsPreference, minimumTargetCssPx: responsive.minimumTargetCssPx, noPageOverflow: responsive.noPageOverflow, modalLabelled: state.modalLabelled });
}

export async function assertResponsiveFrame(frame, page, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px page has horizontal overflow`);
  await assertNoFrameOverflow(frame, `${width}px responsive frame`);
  const interactive = await frame.locator('button, input, select, textarea, a').evaluateAll((nodes) => nodes.filter((node) => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0 && !node.closest('[hidden], [inert]');
  }).map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, name: node.getAttribute('aria-label') || node.labels?.[0]?.textContent?.trim() || node.textContent?.trim().slice(0, 80) || node.getAttribute('title') })));
  for (const node of interactive) {
    assert.ok(node.name, `${width}px interactive target has no observable name`);
    if (width <= 320) assert.ok(node.width >= 44 && node.height >= 44, `${width}px interactive target is below 44px: ${node.name}`);
  }
  assert.equal(await frame.locator('h1').count(), 1);
  assert.equal(await frame.locator('dialog#evidence-dialog, dialog#note-action-dialog, dialog#command-dialog').count(), 3, 'All application dialogs must remain present for the modal audit');
  return Object.freeze({ minimumTargetCssPx: Math.min(...interactive.map((node) => Math.min(node.width, node.height))), noPageOverflow: true });
}

export async function assertKeyboardAccessibility(frame, page, { mobile = false, evidence = frame.getByRole('button', { name: 'View evidence', exact: true }).first() } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  try {
    assert.equal(await frame.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(forced-colors: active)').matches), true);
    await tabTo(evidence);
    await page.keyboard.press('Enter');
    assert.equal(await frame.locator('#evidence-dialog').getAttribute('open'), '');
    assert.equal(await frame.getByRole('dialog', { name: /evidence/iu }).getAttribute('aria-modal'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await evidence.evaluate((node) => document.activeElement === node), true, 'Escape must restore the exact Evidence invoker');
    await assertKeyboardFocus(frame);
    await page.keyboard.press('Shift+Tab');
    await assertKeyboardFocus(frame);
    assert.equal(await evidence.evaluate((node) => document.activeElement === node), false, 'Reverse Tab must leave the Evidence invoker');
    if (mobile) {
      await page.setViewportSize({ width: 320, height: 900 });
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '400% reflow at a 320 CSS-pixel content width has page-level overflow');
      await assertResponsiveFrame(frame, page, 320);
    }
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
  }
}
