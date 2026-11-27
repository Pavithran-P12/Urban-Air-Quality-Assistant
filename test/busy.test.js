/**
 * The busy state: quick cities cannot change the city mid-search, and the loading line says when a
 * backup source is being tried, announced once.
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLoadingStatus, lockSearchControls, SLOW_NOTICE_MS, SLOW_NOTICE_TEXT } from '../docs/busy.js';
import { SERVER_BUDGET_MS } from '../supabase/functions/air-data/handler.js';

const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../docs/styles.css', import.meta.url), 'utf8');

describe('busy state: search controls are locked while a search runs', () => {
  /** A stand-in button that records its attributes. */
  const fakeButton = () => {
    const attrs = new Map();
    return {
      attrs,
      disabled: false,
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: (k) => attrs.delete(k),
    };
  };
  const controls = () => ({ cityInput: { readOnly: false }, buttons: [fakeButton(), fakeButton(), fakeButton()] });

  test('locking makes the city box read-only and marks every quick button aria-disabled', () => {
    const c = controls();
    lockSearchControls(c, true);
    assert.equal(c.cityInput.readOnly, true);
    assert.ok(c.buttons.every((b) => b.attrs.get('aria-disabled') === 'true'));
  });

  test('buttons are never natively disabled, so they stay in the Tab order', () => {
    const c = controls();
    lockSearchControls(c, true);
    assert.ok(c.buttons.every((b) => b.disabled === false));
  });

  test('unlocking removes the attribute', () => {
    const c = controls();
    lockSearchControls(c, true);
    lockSearchControls(c, false);
    assert.equal(c.cityInput.readOnly, false);
    assert.ok(c.buttons.every((b) => !b.attrs.has('aria-disabled')));
  });

  test('every quick city and "use where I am" share the class the lock uses', () => {
    const quick = html.match(/<button[^>]*class="quick-city"[^>]*>/g) ?? [];
    assert.equal(quick.length, 6, 'five cities plus "use where I am"');
    assert.ok(quick.some((b) => b.includes('id="locate"')));
  });

  test('click handlers ignore taps while busy, including a late location answer', () => {
    const app = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
    const guards = app.match(/if \(busy\) return;/g) ?? [];
    // run(), quick-city click, locate click, and the geolocation success callback.
    assert.ok(guards.length >= 4, `expected 4 busy guards, found ${guards.length}`);
  });

  test('the disabled state is visibly different', () => {
    const disabled = css.match(/\.quick-city\[aria-disabled='true'\]\s*{([^}]*)}/)?.[1] ?? '';
    assert.match(disabled, /text-decoration:\s*none/);
    assert.match(disabled, /cursor:\s*not-allowed/);
    assert.match(disabled, /color:\s*var\(--ink-soft\)/);
    assert.match(css, /\.search input:read-only\s*{[^}]*background:\s*var\(--paper\)/);
  });

  test('locked text still meets WCAG AA contrast (4.5:1)', () => {
    const hex = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1];
    const lum = (h) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    assert.ok(ratio(hex('ink-soft'), hex('paper')) >= 4.5);
  });
});

describe('busy state: slow-search notice', () => {
  let rendered;
  let announced;
  let status;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    rendered = [];
    announced = [];
    status = createLoadingStatus({ render: (t) => rendered.push(t), announce: (t) => announced.push(t) });
  });
  afterEach(() => mock.timers.reset());

  test('the notice matches the air-data function budget, so "trying a backup" is true by then', () => {
    assert.equal(SLOW_NOTICE_MS, 9_000);
    assert.equal(SLOW_NOTICE_MS, SERVER_BUDGET_MS);
    assert.equal(SLOW_NOTICE_TEXT, 'Still checking… trying a backup source.');
  });

  test('nothing changes before 9 s', () => {
    status.checking('Checking the air…');
    mock.timers.tick(SLOW_NOTICE_MS - 1);
    assert.deepEqual(announced, ['Checking the air…']);
    assert.equal(status.text, 'Checking the air…');
  });

  test('at 9 s the visible line and the live region both switch, exactly once', () => {
    status.checking('Checking the air…');
    mock.timers.tick(SLOW_NOTICE_MS);
    mock.timers.tick(60_000);
    assert.deepEqual(rendered, ['Checking the air…', SLOW_NOTICE_TEXT]);
    assert.deepEqual(announced, ['Checking the air…', SLOW_NOTICE_TEXT]);
  });

  test('a fast data step never shows the notice', () => {
    status.checking('Checking the air…');
    mock.timers.tick(3_000);
    status.step('Writing your plan…');
    mock.timers.tick(60_000);
    assert.deepEqual(announced, ['Checking the air…', 'Writing your plan…']);
  });

  test('a slow AI step does not trigger it (only the data step can be on a backup)', () => {
    status.checking('Checking the air…');
    mock.timers.tick(1_000);
    status.step('Writing your plan…');
    mock.timers.tick(25_000);
    assert.ok(!announced.includes(SLOW_NOTICE_TEXT));
  });

  test('worst case announces three status lines, no duplicates', () => {
    status.checking('Checking the air…');
    mock.timers.tick(25_000);
    status.step('Writing your plan…');
    mock.timers.tick(25_000);
    status.stop();
    assert.deepEqual(announced, ['Checking the air…', SLOW_NOTICE_TEXT, 'Writing your plan…']);
    assert.equal(new Set(announced).size, announced.length);
  });

  test('repeating the same text does not re-announce it', () => {
    status.step('Writing your plan…');
    status.step('Writing your plan…');
    assert.deepEqual(announced, ['Writing your plan…']);
  });

  test('an error stops the timer, and the next search announces again', () => {
    status.checking('Checking the air…');
    mock.timers.tick(2_000);
    status.stop();
    mock.timers.tick(60_000);
    assert.deepEqual(announced, ['Checking the air…']);
    status.checking('Checking the air…');
    assert.deepEqual(announced, ['Checking the air…', 'Checking the air…']);
  });

  test('the page still has exactly one live region, and the loading line is not one', () => {
    assert.equal((html.match(/aria-live=/g) ?? []).length, 1);
    assert.equal((html.match(/role="status"/g) ?? []).length, 1);
    assert.match(html, /<p class="loading-text" id="loading-text">/);
  });
});
