/**
 * Regression tests for the five audited issues: incomplete local index, user-facing errors,
 * rate-limit IP spoofing, timeout budget and caching, and screen-reader announcements.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromGoogle, validLocalIndex } from '../docs/lib/normalise.js';
import { sanitizeReport, parseLocation, parseProfile } from '../docs/lib/validate.js';
import { getAirReport, fetchGoogleAir as fetchGoogleAirBrowser, isCacheable } from '../docs/lib/airQuality.js';
import { buildPrompt } from '../docs/lib/prompt.js';
import { buildRuleAdvice } from '../docs/lib/rules.js';
import {
  AppError,
  GENERIC_ERROR_MESSAGE,
  UpstreamError,
  ValidationError,
  describeForLog,
  toUserMessage,
} from '../docs/lib/errors.js';
import { localIndexText, announcementText } from '../docs/views.js';
import { clientIp, createRateLimiter, UNKNOWN_CLIENT, isIpAddress } from '../supabase/functions/_shared/http.js';
import {
  createAirDataHandler,
  fetchGoogleAir as fetchGoogleAirServer,
} from '../supabase/functions/air-data/handler.js';
import * as aqi from '../docs/lib/aqi.js';
import { mockFetch, googleResponse } from './fixtures.js';

const ORIGIN = 'https://pavithran-p12.github.io';
const AIR_DATA = 'https://x.supabase.co/functions/v1/air-data';
const silent = { error: () => {}, info: () => {} };

/** A fetch that resolves after `ms` unless its AbortSignal fires first (like real fetch). */
function slowFetch(ms, response) {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(url, init)), ms);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal.reason ?? new Error('aborted'));
      });
    });
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const googleCurrent = {
  dateTime: '2026-11-26T04:00:00Z',
  indexes: [{ code: 'ind_cpcb', displayName: 'AQI (IN)', aqi: 300, category: 'Very poor', dominantPollutant: 'pm25' }],
  pollutants: [{ code: 'pm25', concentration: { value: 140, units: 'MICROGRAMS_PER_CUBIC_METER' } }],
};
const googleHours = (n, offset = 0) => ({
  hourlyForecasts: Array.from({ length: n }, (_, i) => ({
    dateTime: new Date(Date.UTC(2026, 10, 26, i + offset)).toISOString(),
    pollutants: [{ code: 'pm25', concentration: { value: 90, units: 'MICROGRAMS_PER_CUBIC_METER' } }],
  })),
});

describe('Issue 1: incomplete local index', () => {
  test('validLocalIndex keeps only complete indexes', () => {
    assert.deepEqual(validLocalIndex({ code: 'ind_cpcb', name: 'AQI (IN)', aqi: 124, category: 'Moderate' }), {
      code: 'ind_cpcb',
      name: 'AQI (IN)',
      aqi: 124,
      category: 'Moderate',
    });
    assert.equal(validLocalIndex({ name: 'AQI (IN)', aqi: 124 }), null, 'missing category');
    assert.equal(validLocalIndex({ aqi: 124, category: 'Moderate' }), null, 'missing name');
    assert.equal(validLocalIndex({ name: ' ', aqi: 124, category: 'Moderate' }), null, 'blank name');
    assert.equal(validLocalIndex({ name: 'AQI (IN)', aqi: '124', category: 'Moderate' }), null, 'non-numeric value');
    assert.equal(validLocalIndex(null), null);
  });

  test('fromGoogle drops a partial local index but keeps the main pollutant', () => {
    const g = structuredClone(googleResponse);
    delete g.current.localIndex.category;
    const air = fromGoogle(g, { offsetSeconds: 19800 });
    assert.equal(air.localIndex, null);
    assert.equal(air.dominant.key, 'pm2_5');
  });

  test('fromGoogle survives incomplete responses', () => {
    assert.equal(fromGoogle({}), null);
    assert.equal(fromGoogle({ current: {} }), null);
    assert.equal(fromGoogle({ current: { pollutants: 'oops' } }), null);
    const noHourly = structuredClone(googleResponse);
    delete noHourly.hourly;
    const air = fromGoogle(noHourly, { offsetSeconds: 19800 });
    assert.deepEqual(air.forecast, []);
    assert.deepEqual(air.cleanestHours, []);
  });

  test('the server sanitiser drops an incomplete local index', () => {
    const report = { place: { name: 'X' }, air: { usAqi: 100, localIndex: { name: 'AQI (IN)', aqi: 90 } } };
    assert.equal(sanitizeReport(report, aqi).air.localIndex, null);
  });

  test('localIndexText never shows "undefined"', () => {
    assert.equal(localIndexText({ name: 'AQI (IN)', aqi: 124 }), '');
    assert.equal(localIndexText({ aqi: 124, category: 'Moderate' }), '');
    assert.equal(localIndexText(null), '');
    assert.equal(
      localIndexText({ code: 'ind_cpcb', name: 'AQI (IN)', aqi: 124, category: 'Moderate air quality' }),
      "India's official index (NAQI) reads 124: moderate air quality.",
    );
    assert.equal(
      localIndexText({ code: 'usa_epa', name: 'AQI (US)', aqi: 40, category: 'Good' }),
      'The local index (AQI (US)) reads 40: good.',
    );
  });
});

describe('Issue 2: user-facing errors', () => {
  test('known app errors show their own message', () => {
    assert.equal(toUserMessage(new ValidationError('Please enter a city name.')), 'Please enter a city name.');
    assert.equal(toUserMessage(new UpstreamError('We couldn\'t find "Narnia".', 404)), 'We couldn\'t find "Narnia".');
    assert.ok(new ValidationError('x') instanceof AppError);
  });

  test('unexpected errors show a generic message', () => {
    assert.equal(
      toUserMessage(new TypeError("Cannot read properties of undefined (reading 'x')")),
      GENERIC_ERROR_MESSAGE,
    );
    assert.equal(toUserMessage('boom'), GENERIC_ERROR_MESSAGE);
    assert.equal(toUserMessage(undefined), GENERIC_ERROR_MESSAGE);
  });

  test('log summaries strip URLs, key-like values and stacks', () => {
    const err = new Error('fetch https://airquality.googleapis.com/v1/x?key=AIzaSECRET failed; token=abc123');
    const log = describeForLog(err);
    assert.equal(log.name, 'Error');
    assert.doesNotMatch(JSON.stringify(log), /googleapis|AIzaSECRET|abc123|at\s/);
    assert.ok(!('stack' in log));
    assert.equal(describeForLog(new UpstreamError('x', 404)).status, 404);
  });

  test('real failures surface as app errors with friendly text', async () => {
    assert.throws(
      () => parseLocation({ city: 'a' }),
      (e) => e instanceof AppError,
    );
    await assert.rejects(getAirReport({ city: 'Nowhere' }, mockFetch({ geocode: {} })), (e) => {
      assert.ok(e instanceof AppError);
      assert.doesNotMatch(toUserMessage(e), /http|undefined/);
      return true;
    });
    await assert.rejects(getAirReport({ city: 'Delhi' }, mockFetch({ fail: true })), (e) => e instanceof UpstreamError);
    const garbled = async () => ({ ok: true, status: 200, json: async () => JSON.parse('not json') });
    await assert.rejects(
      getAirReport({ city: 'Delhi' }, garbled),
      (e) => e instanceof UpstreamError && /could not read/.test(e.message),
    );
  });
});

describe('Issue 3: rate-limit key cannot be spoofed', () => {
  const req = (headers) => new Request('https://x.example/', { headers });

  test('uses the platform headers, never X-Forwarded-For', () => {
    assert.equal(
      clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })),
      '203.0.113.7',
    );
    assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '9.9.9.9' })), '203.0.113.8');
    assert.equal(clientIp(req({ 'x-forwarded-for': '9.9.9.9' })), UNKNOWN_CLIENT, 'XFF alone is not trusted');
    assert.equal(clientIp(req({})), UNKNOWN_CLIENT);
  });

  test('ignores malformed values in trusted headers', () => {
    assert.equal(clientIp(req({ 'cf-connecting-ip': '1.2.3.4, 5.6.7.8', 'x-real-ip': '203.0.113.9' })), '203.0.113.9');
    assert.equal(clientIp(req({ 'cf-connecting-ip': 'evil' })), UNKNOWN_CLIENT);
    assert.equal(isIpAddress('2001:db8::1'), true);
    assert.equal(isIpAddress('999.1.1.1'), false);
  });

  test('rotating X-Forwarded-For does not escape the limit', async () => {
    const handle = createAirDataHandler({
      apiKey: 'k',
      allowedOrigins: [ORIGIN],
      logger: silent,
      rateLimiter: createRateLimiter({ limit: 2 }),
      fetchImpl: async (url) => json(url.includes('current') ? googleCurrent : googleHours(48)),
    });
    const send = (xff) =>
      handle(
        new Request(AIR_DATA, {
          method: 'POST',
          headers: { origin: ORIGIN, 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': xff },
          body: JSON.stringify({ latitude: 13, longitude: 80 }),
        }),
      );
    assert.equal((await send('10.0.0.1')).status, 200);
    assert.equal((await send('10.0.0.2')).status, 200);
    assert.equal((await send('10.0.0.3')).status, 429, 'a new spoofed XFF is still the same client');
  });
});

describe('Issue 4: timeout budget and caching', () => {
  test('a slow forecast returns current conditions within budget, marked incomplete', async () => {
    const started = Date.now();
    const data = await fetchGoogleAirServer({
      latitude: 13,
      longitude: 80,
      apiKey: 'k',
      budgetMs: 80,
      logger: silent,
      fetchImpl: (url, init) =>
        url.includes('current')
          ? Promise.resolve(json(googleCurrent))
          : slowFetch(1000, () => json(googleHours(48)))(url, init),
    });
    assert.ok(Date.now() - started < 500, 'aborted at the budget, not after the slow call');
    assert.equal(data.current.localIndex.aqi, 300);
    assert.equal(data.hourly.length, 0);
    assert.equal(data.forecastComplete, false);
  });

  test('slow current conditions fail fast with a 502', async () => {
    const handle = createAirDataHandler({
      apiKey: 'k',
      allowedOrigins: [ORIGIN],
      logger: silent,
      budgetMs: 60,
      fetchImpl: slowFetch(1000, () => json(googleCurrent)),
    });
    const started = Date.now();
    const res = await handle(
      new Request(AIR_DATA, {
        method: 'POST',
        headers: { origin: ORIGIN },
        body: JSON.stringify({ latitude: 1, longitude: 1 }),
      }),
    );
    assert.equal(res.status, 502);
    assert.ok(Date.now() - started < 500);
  });

  test('a failed second forecast page keeps the first page', async () => {
    let page = 0;
    const data = await fetchGoogleAirServer({
      latitude: 13,
      longitude: 80,
      apiKey: 'k',
      logger: silent,
      fetchImpl: async (url) => {
        if (url.includes('current')) return json(googleCurrent);
        page += 1;
        return page === 1 ? json({ ...googleHours(24), nextPageToken: 't' }) : json({}, 503);
      },
    });
    assert.equal(data.hourly.length, 24);
    assert.equal(data.forecastComplete, true);
  });

  test('incomplete answers are not cached; complete ones are', async () => {
    let forecastOk = false;
    const fetchImpl = async (url) =>
      url.includes('current') ? json(googleCurrent) : forecastOk ? json(googleHours(48)) : json({}, 503);
    const handle = createAirDataHandler({ apiKey: 'k', allowedOrigins: [ORIGIN], logger: silent, fetchImpl });
    const send = () =>
      handle(
        new Request(AIR_DATA, {
          method: 'POST',
          headers: { origin: ORIGIN },
          body: JSON.stringify({ latitude: 13, longitude: 80 }),
        }),
      );
    assert.equal((await send()).headers.get('x-cache'), 'MISS');
    forecastOk = true;
    assert.equal((await send()).headers.get('x-cache'), 'MISS', 'the partial answer was not cached');
    assert.equal((await send()).headers.get('x-cache'), 'HIT');
  });

  test('the browser gives up on a slow air-data call and falls back, labelled', async () => {
    const base = mockFetch({ google: googleResponse });
    const fetchImpl = (url, init) =>
      String(url).includes('air-data') ? slowFetch(1000, () => json(googleResponse))(url, init) : base(url, init);
    const started = Date.now();
    assert.equal(
      await fetchGoogleAirBrowser(AIR_DATA, { latitude: 1, longitude: 2 }, { fetchImpl, timeoutMs: 50 }),
      null,
    );
    assert.ok(Date.now() - started < 500);

    const report = await getAirReport({ city: 'Delhi' }, fetchImpl, { airDataUrl: AIR_DATA, airDataTimeoutMs: 50 });
    assert.equal(report.air.source.provider, 'open-meteo');
    assert.equal(report.air.source.fallback, true);
    assert.match(report.air.source.fallbackReason, /wasn't available/);
    assert.equal(sanitizeReport(report, aqi).air.source.fallback, undefined, 'the server re-derives labels');
  });

  test('only complete, non-fallback reports are cacheable in the browser', async () => {
    const good = await getAirReport({ city: 'Delhi' }, mockFetch({ google: googleResponse }), { airDataUrl: AIR_DATA });
    assert.equal(isCacheable(good), true);
    const fallback = await getAirReport({ city: 'Delhi' }, mockFetch({ google: null }), { airDataUrl: AIR_DATA });
    assert.equal(isCacheable(fallback), false);
    const partial = structuredClone(good);
    partial.air.forecast = partial.air.forecast.slice(0, 5);
    assert.equal(isCacheable(partial), false);
  });

  test('no forecast is never described as "no improvement"', async () => {
    const report = await getAirReport({ city: 'Delhi' }, mockFetch({ google: { ...googleResponse, hourly: [] } }), {
      airDataUrl: AIR_DATA,
    });
    assert.deepEqual(report.air.cleanestHours, []);
    const prompt = buildPrompt(sanitizeReport(report, aqi), parseProfile({}));
    assert.match(prompt, /No hourly forecast is available/);
    const advice = buildRuleAdvice(report, parseProfile({}));
    assert.ok(advice.routine.some((s) => /no hourly forecast/i.test(s.why)));
  });
});

describe('Issue 5: screen-reader announcements', () => {
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
