import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { hasKeyboardFocusIndicator } from '../src/browser-evidence.mjs';
import { afterKeyboardPaint } from './support/keyboard-paint.mjs';
import { assertKeyboardFocus, tabTo } from './support/keyboard-navigation.mjs';

test('already-focused shadow target cannot pass after focus moves during its paint wait', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<x-shell></x-shell>');
    await page.locator('x-shell').evaluate((host) => {
      host.attachShadow({ mode: 'open' }).innerHTML = '<style>button { outline: 3px solid blue; background: white; } #target { transition: background-color 60s; } button:focus { background: red; }</style><button id="target">Original target</button><button id="other">Other visible control</button>';
      const target = host.shadowRoot.querySelector('#target');
      const other = host.shadowRoot.querySelector('#other');
      getComputedStyle(target).backgroundColor;
      target.focus();
      const animations = target.getAnimations();
      if (animations.length !== 1 || !(animations[0] instanceof CSSTransition)) throw new Error('The real focus transition was not created.');
      animations[0].pause();
      window.focusTransition = animations[0];
      // Observe the real browser paint query without replacing its result.
      // This barrier lets the test finish a paused CSS transition only once
      // the helper is waiting on it, rather than racing a wall-clock delay.
      const getAnimations = target.getAnimations.bind(target);
      target.getAnimations = (...args) => { window.paintObserved = true; return getAnimations(...args); };
      target.addEventListener('transitionend', () => other.focus(), { once: true });
    });
    const pending = tabTo(page.locator('#target'));
    const outcome = assert.rejects(pending, /exact requested keyboard target/);
    await page.waitForFunction(() => window.paintObserved === true);
    await page.evaluate(() => window.focusTransition.finish());
    await outcome;
    assert.equal((await assertKeyboardFocus(page)).name, 'other');
  } finally { await browser.close(); }
});

test('keyboard traversal follows nested open roots and assigned slots forward and backward', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.setContent('<button id="before">Before shell</button><x-shell><button id="later" slot="last">Later slot</button><button id="slotted" slot="first">First slot</button><button>Unassigned</button></x-shell><button id="after">After shell</button>');
    await page.evaluate(() => {
      const style = '<style>button:focus-visible { outline: 3px solid blue; }</style>';
      const shell = document.querySelector('x-shell').attachShadow({ mode: 'open' });
      shell.innerHTML = `${style}<button id="shadow-first">Shadow first</button><slot name="first"></slot><x-inner></x-inner><slot name="last"></slot><button id="shadow-last">Shadow last</button>`;
      shell.querySelector('x-inner').attachShadow({ mode: 'open' }).innerHTML = `${style}<button id="nested">Nested target</button>`;
      window.focusTrace = [];
      document.addEventListener('focusin', (event) => window.focusTrace.push(event.composedPath()[0].id));
    });
    await tabTo(page.locator('#before'));
    await tabTo(page.locator('#nested'), { limit: 3 });
    assert.equal((await assertKeyboardFocus(page)).name, 'nested');
    await tabTo(page.locator('#slotted'), { reverse: true, limit: 1 });
    await tabTo(page.locator('#shadow-last'), { limit: 3 });
    await tabTo(page.locator('#after'), { limit: 1 });
    assert.deepEqual((await page.evaluate(() => window.focusTrace)).filter(Boolean), ['before', 'shadow-first', 'slotted', 'nested', 'slotted', 'nested', 'later', 'shadow-last', 'after']);
  } finally { await browser.close(); }
});

test('same-shadow labelled controls wait for their painted focus and reject a missing indicator', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.setContent('<span id="control-label">Wrong document label</span><x-shell></x-shell>');
    await page.locator('x-shell').evaluate((host) => {
      host.attachShadow({ mode: 'open' }).innerHTML = `<style>
        button { background: transparent; border: 0; outline: none; transition: background-color 20ms 300ms; }
        button:focus-visible { background: rgb(20, 30, 200); }
        #missing:focus-visible { background: transparent; }
        </style><span id="control-label">Same shadow label</span><button id="painted" aria-labelledby="control-label"></button><button id="missing">Missing shadow indicator</button>`;
    });
    await tabTo(page.locator('#painted'));
    const painted = await assertKeyboardFocus(page);
    assert.equal(painted.accessibleName, 'Same shadow label');
    assert.equal(painted.backgroundColor, 'rgb(20, 30, 200)');
    await assert.rejects(tabTo(page.locator('#missing')), /Keyboard focus must remain visible/);
    await page.locator('#painted').evaluate((node) => {
      node.style.transition = 'none';
      getComputedStyle(node).backgroundColor;
      node.style.transition = 'background-color 20ms 60s';
    });
    await assert.rejects(tabTo(page.locator('#painted'), { reverse: true }), /Keyboard focus transition did not settle within 1000ms/);
  } finally { await browser.close(); }
});

test('composed hidden and inert ancestors exclude slotted and nested keyboard targets', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button>Before shell</button><x-shell><button id="slotted">Slotted target</button></x-shell>');
    await page.locator('x-shell').evaluate((host) => {
      host.attachShadow({ mode: 'open' }).innerHTML = '<section inert><slot></slot></section><x-inner></x-inner>';
      host.shadowRoot.querySelector('x-inner').attachShadow({ mode: 'open' }).innerHTML = '<button id="nested">Nested target</button>';
    });
    await assert.rejects(tabTo(page.locator('#slotted')), /absent from the sequential focus order/);
    await page.locator('x-shell').evaluate((host) => { host.inert = true; });
    await assert.rejects(tabTo(page.locator('#nested')), /absent from the sequential focus order/);
    await page.locator('x-shell').evaluate((host) => { host.inert = false; host.hidden = true; host.style.display = 'block'; });
    await assert.rejects(tabTo(page.locator('#nested')), /absent from the sequential focus order/);
  } finally { await browser.close(); }
});

test('shadow dialogs retain keyboard traversal and a composed escape fails the audit', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="outside">Outside dialog</button><x-shell></x-shell>');
    await page.locator('x-shell').evaluate((host) => {
      host.attachShadow({ mode: 'open' }).innerHTML = '<dialog open><button id="first">First dialog action</button><x-inner></x-inner></dialog>';
      host.shadowRoot.querySelector('x-inner').attachShadow({ mode: 'open' }).innerHTML = '<button id="target">Nested dialog action</button>';
    });
    await tabTo(page.locator('#outside'));
    await tabTo(page.locator('#first'));
    await tabTo(page.locator('#target'), { limit: 1 });
    await tabTo(page.locator('#first'), { reverse: true, limit: 1 });
    // Deliberately broken application handler: the audit must reject an escape
    // across shadow ancestry, rather than treating it as a normal outside stop.
    await page.locator('#first').evaluate((node) => node.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') { event.preventDefault(); document.querySelector('#outside').focus(); }
    }));
    await assert.rejects(tabTo(page.locator('#target')), /escaped an open modal dialog/);
  } finally { await browser.close(); }
});

test('plain iframe date and time segments retain bounded forward and backward traversal', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button>Host navigation</button><iframe title="Fictional keyboard fixture"></iframe>');
    const frame = page.frames()[1];
    await frame.setContent('<button id="before">Before date</button><label>Date<input type="date" value="2026-09-06"></label><label>Time<input type="time" value="12:30"></label><button id="after">After time</button>');
    await tabTo(frame.locator('#before'));
    await tabTo(frame.locator('#after'));
    assert.equal((await assertKeyboardFocus(frame)).name, 'after');
    await tabTo(frame.locator('#before'), { reverse: true });
    assert.equal((await assertKeyboardFocus(frame)).name, 'before');
  } finally { await browser.close(); }
});

test('keyboard evidence observes painted reduced-motion focus and still rejects missing indicators', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.setContent(`<style>
      button { background: transparent; outline: none; border: 0; transition: background-color 20ms 120ms; }
      button:focus-visible { background: color-mix(in srgb, #bcbcc0 7%, transparent); }
      #missing:focus-visible { background: transparent; }
      @media (prefers-reduced-motion: reduce) { * { transition-duration: 0.01ms !important; } }
      </style><button id="painted">Fictional conversation</button><button id="missing">Missing indicator</button>`);
    for (const id of ['painted', 'missing']) {
      const target = page.locator(`#${id}`);
      const baselineBackgroundColor = await target.evaluate((node) => getComputedStyle(node).backgroundColor);
      await page.keyboard.press('Tab');
      // Reset the transition inside one render task to make its initial frame deterministic.
      await target.evaluate((node) => { node.blur(); getComputedStyle(node).backgroundColor; node.focus(); getComputedStyle(node).backgroundColor; });
      await target.evaluate(afterKeyboardPaint);
      const state = await target.evaluate((node) => ({ focused: document.activeElement === node, outline: getComputedStyle(node).outlineStyle, focusVisible: node.matches(':focus-visible'), backgroundColor: getComputedStyle(node).backgroundColor }));
      assert.equal(state.focused, true);
      assert.equal(hasKeyboardFocusIndicator({ ...state, baselineBackgroundColor }), id === 'painted', JSON.stringify(state));
    }
    await page.addStyleTag({ content: '#painted { transition-delay: 60s; }' });
    const stalled = page.locator('#painted');
    await stalled.focus();
    await assert.rejects(stalled.evaluate(afterKeyboardPaint), /Keyboard focus transition did not settle within 1000ms/);
  } finally { await browser.close(); }
});
