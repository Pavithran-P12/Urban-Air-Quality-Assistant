/**
 * Screen-reader announcements: one polite live region, focusable results heading, short summary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { announcementText } from '../docs/views.js';

describe('announcements: live region and focus', () => {
  const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

  test('exactly one live region, and it is the short announcer', () => {
    const live = html.match(/aria-live="[^"]+"/g) ?? [];
    assert.equal(live.length, 1);
    assert.match(html, /<p id="announcer" class="sr-only" role="status" aria-live="polite" aria-atomic="true"><\/p>/);
  });

  test('the results section is not a live region and its heading can take focus', () => {
    const section = html.match(/<section id="results"[^>]*>/)[0];
    assert.doesNotMatch(section, /aria-live|aria-busy|tabindex/);
    assert.match(section, /aria-labelledby="aqi-place"/);
    assert.match(html, /<h2 class="sky-place" id="aqi-place" tabindex="-1">/);
  });

  test('no duplicate status regions', () => {
    assert.equal((html.match(/role="status"/g) ?? []).length, 1);
    assert.doesNotMatch(html.match(/<p class="loading-text"[^>]*>/)[0], /role=/);
  });

  test('announcement names the place, AQI and level', () => {
    assert.equal(
      announcementText({ name: 'Chennai, Tamil Nadu, India' }, { usAqi: 160, category: { label: 'Unhealthy' } }),
      'Results for Chennai, Tamil Nadu, India: US AQI 160, Unhealthy.',
    );
    assert.equal(
      announcementText({ name: 'X' }, { usAqi: 20, category: { label: 'Unknown' } }),
      'Results for X: US AQI 20.',
    );
    assert.equal(announcementText(null, null), 'Results ready.');
  });
});
